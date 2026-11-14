/**
 * videoFileWriter.worker.ts: Dedicated OPFS FileSystemSyncAccessHandle Writer Worker.
 *
 * Streams MediaRecorder output chunks sequentially to disk inside the Origin Private File System
 * with partial-write handling, periodic flushing, bounded pending-write queueing, and explicit cleanup
 * on cancellation or failure. Never accumulates a full recording in RAM.
 */

interface SyncAccessHandleLike {
  write(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number;
  flush(): void;
  close(): void;
  truncate(newSize: number): void;
  getSize?(): number;
}

interface ExtFileSystemFileHandle extends FileSystemFileHandle {
  createSyncAccessHandle?: () => Promise<SyncAccessHandleLike>;
}

export type WorkerInboundMessage =
  | { type: 'INIT'; fileName: string; maxPendingBytes?: number }
  | { type: 'WRITE_CHUNK'; seq: number; buffer: ArrayBuffer }
  | { type: 'FINALIZE' }
  | { type: 'ABORT' };

export type WorkerOutboundMessage =
  | { type: 'READY'; fileName: string }
  | { type: 'CHUNK_ACK'; seq: number; bytesWritten: number; pendingBytes: number }
  | { type: 'FINALIZED'; fileName: string; sizeBytes: number }
  | { type: 'ABORTED' }
  | { type: 'ERROR'; error: string };

const DEFAULT_MAX_PENDING_BYTES = 16 * 1024 * 1024; // 16 MB bounded RAM queue
const PERIODIC_FLUSH_BYTES = 4 * 1024 * 1024; // Flush every 4 MB written

let activeFileName = '';
let rootDir: FileSystemDirectoryHandle | null = null;
let syncHandle: SyncAccessHandleLike | null = null;
let writeOffset = 0;
let unflushedBytes = 0;
let pendingBytes = 0;
let maxPendingBytes = DEFAULT_MAX_PENDING_BYTES;
let operationChain: Promise<void> = Promise.resolve();
let aborted = false;

function postReply(msg: WorkerOutboundMessage): void {
  self.postMessage(msg);
}

function writeFullySequential(handle: SyncAccessHandleLike, bytes: Uint8Array): void {
  let localOffset = 0;
  while (localOffset < bytes.byteLength) {
    const slice = bytes.subarray(localOffset);
    const written = handle.write(slice, { at: writeOffset });
    if (!Number.isFinite(written) || written <= 0) {
      throw new Error(`OPFS write failed or wrote ${written} bytes at offset ${writeOffset}.`);
    }
    localOffset += written;
    writeOffset += written;
  }
}

async function cleanupIncompleteFile(): Promise<void> {
  if (syncHandle) {
    try {
      syncHandle.close();
    } catch {
      // ignore close errors during cleanup
    }
    syncHandle = null;
  }
  if (rootDir && activeFileName) {
    try {
      await rootDir.removeEntry(activeFileName);
    } catch {
      // file may already be deleted
    }
  }
  activeFileName = '';
  writeOffset = 0;
  unflushedBytes = 0;
  pendingBytes = 0;
}

self.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'ABORT') {
    aborted = true;
    operationChain = operationChain
      .catch(() => {})
      .then(async () => {
        await cleanupIncompleteFile();
        postReply({ type: 'ABORTED' });
      });
    return;
  }

  if (msg.type === 'WRITE_CHUNK') {
    pendingBytes += msg.buffer.byteLength;
    if (pendingBytes > maxPendingBytes) {
      aborted = true;
      operationChain = operationChain
        .catch(() => {})
        .then(async () => {
          await cleanupIncompleteFile();
          postReply({
            type: 'ERROR',
            error: `OPFS write queue exceeded ${Math.round(maxPendingBytes / (1024 * 1024))} MB limit; export aborted to protect memory.`,
          });
        });
      return;
    }
  }

  operationChain = operationChain
    .then(async () => {
      if (aborted) return;

      if (msg.type === 'INIT') {
        await cleanupIncompleteFile();
        aborted = false;
        maxPendingBytes = msg.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;

        if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
          throw new Error('Origin Private File System (OPFS) is not available in this Worker.');
        }

        rootDir = await navigator.storage.getDirectory();
        activeFileName = msg.fileName;
        const fileHandle = (await rootDir.getFileHandle(activeFileName, {
          create: true,
        })) as ExtFileSystemFileHandle;

        if (typeof fileHandle.createSyncAccessHandle !== 'function') {
          throw new Error('FileSystemSyncAccessHandle is unavailable in this browser Worker.');
        }

        syncHandle = await fileHandle.createSyncAccessHandle();
        syncHandle.truncate(0);
        writeOffset = 0;
        unflushedBytes = 0;
        pendingBytes = 0;
        postReply({ type: 'READY', fileName: activeFileName });
        return;
      }

      if (msg.type === 'WRITE_CHUNK') {
        if (!syncHandle) {
          throw new Error('OPFS writer received chunk before INIT.');
        }
        const bytes = new Uint8Array(msg.buffer);
        try {
          writeFullySequential(syncHandle, bytes);
          unflushedBytes += bytes.byteLength;
          if (unflushedBytes >= PERIODIC_FLUSH_BYTES) {
            syncHandle.flush();
            unflushedBytes = 0;
          }
          pendingBytes = Math.max(0, pendingBytes - bytes.byteLength);
          postReply({
            type: 'CHUNK_ACK',
            seq: msg.seq,
            bytesWritten: writeOffset,
            pendingBytes,
          });
        } catch (err) {
          pendingBytes = Math.max(0, pendingBytes - bytes.byteLength);
          throw err;
        }
        return;
      }

      if (msg.type === 'FINALIZE') {
        if (!syncHandle) {
          throw new Error('OPFS writer cannot finalize because no file is open.');
        }
        syncHandle.flush();
        const finalSize = typeof syncHandle.getSize === 'function' ? syncHandle.getSize() : writeOffset;
        syncHandle.close();
        syncHandle = null;
        const finishedName = activeFileName;
        postReply({ type: 'FINALIZED', fileName: finishedName, sizeBytes: finalSize });
        return;
      }
    })
    .catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      await cleanupIncompleteFile();
      postReply({ type: 'ERROR', error: message });
    });
};
