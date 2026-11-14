/**
 * wavPcmStream.ts: Memory-bounded, frame-aligned RIFF/WAVE streaming PCM reader.
 *
 * - Never calls file.arrayBuffer() on the whole file.
 * - Reads headers and audio payload strictly via file.slice(start, end).arrayBuffer().
 * - Scans arbitrary RIFF chunks (skipping unknown metadata + odd-byte RIFF padding).
 * - Supports mono/stereo 8-bit unsigned PCM, 16/24/32-bit signed PCM, IEEE Float32,
 *   and WAVE_FORMAT_EXTENSIBLE (PCM / IEEE Float subtypes).
 * - Downmixes stereo identically to the main simulation engine: mono = 0.5 * (L + R).
 */

export type WavByteSource = Pick<Blob, 'size' | 'slice'>;

export interface WavFormatInfo {
  audioFormat: number;
  effectiveFormat: 'pcm' | 'float';
  channels: 1 | 2;
  sampleRate: number;
  bitsPerSample: 8 | 16 | 24 | 32;
  validBitsPerSample: number;
  blockAlign: number;
  byteRate: number;
  dataOffset: number;
  dataSize: number;
  totalFrames: number;
  durationSec: number;
  fileSize: number;
}

export interface WavDecodedChunk {
  monoSamples: Float32Array;
  frameCount: number;
  startFrame: number;
  sampleRate: number;
  durationSec: number;
  isLast: boolean;
}

export interface WavChunkStreamOptions {
  chunkDurationSec?: number;
}

export interface WavPcmChunkStream {
  readonly info: WavFormatInfo;
  readonly chunkFrames: number;
  readonly totalChunks: number;
  hasNext(): boolean;
  nextChunk(): Promise<WavDecodedChunk | null>;
}

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

// Standard GUIDs stored in little-endian Windows GUID layout (bytes 24..40 of fmt chunk)
const KSDATAFORMAT_SUBTYPE_PCM = [
  0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];
const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = [
  0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
];

function guidMatches(view: DataView, byteOffset: number, expected: number[]): boolean {
  for (let i = 0; i < 16; i++) {
    if (view.getUint8(byteOffset + i) !== expected[i]) return false;
  }
  return true;
}

function readAsciiFourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

async function readByteSlice(source: WavByteSource, start: number, end: number): Promise<ArrayBuffer> {
  if (start < 0 || end < start || end > source.size) {
    throw new Error(`WAV read out of bounds [${start}, ${end}) for file size ${source.size}.`);
  }
  const slicePromise = source.slice(start, end).arrayBuffer();
  let timerId: ReturnType<typeof setTimeout> | null = null;
  const buf = await Promise.race([
    slicePromise,
    new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        reject(new Error(`Timed out reading WAV byte range [${start}, ${end}).`));
      }, 10_000);
    }),
  ]).finally(() => {
    if (timerId !== null) clearTimeout(timerId);
  });
  if (buf.byteLength !== end - start) {
    throw new Error(`Truncated WAV read: expected ${end - start} bytes, got ${buf.byteLength}.`);
  }
  return buf;
}

/**
 * Parses and validates the RIFF/WAVE header without reading the full file into memory.
 */
export async function parseWavHeader(source: WavByteSource): Promise<WavFormatInfo> {
  if (!source || typeof source.size !== 'number' || typeof source.slice !== 'function') {
    throw new Error('Invalid WAV input source.');
  }
  if (source.size < 44) {
    throw new Error('File is too small to be a valid PCM WAV file.');
  }

  const riffBuf = await readByteSlice(source, 0, 12);
  const riffView = new DataView(riffBuf);
  const riffId = readAsciiFourCC(riffView, 0);
  const waveId = readAsciiFourCC(riffView, 8);
  if (riffId !== 'RIFF' || waveId !== 'WAVE') {
    throw new Error(`Unsupported file container (${riffId}/${waveId}): expected RIFF/WAVE.`);
  }

  interface ParsedFmt {
    audioFormat: number;
    effectiveFormat: 'pcm' | 'float';
    channels: 1 | 2;
    sampleRate: number;
    byteRate: number;
    blockAlign: number;
    bitsPerSample: 8 | 16 | 24 | 32;
    validBitsPerSample: number;
  }

  let fmt: ParsedFmt | null = null;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  let chunksScanned = 0;
  const MAX_HEADER_CHUNKS = 2048;

  while (offset + 8 <= source.size) {
    chunksScanned++;
    if (chunksScanned > MAX_HEADER_CHUNKS) {
      throw new Error('Malformed WAV header: too many metadata chunks before data.');
    }

    const chunkHeaderBuf = await readByteSlice(source, offset, offset + 8);
    const chunkHeaderView = new DataView(chunkHeaderBuf);
    const chunkId = readAsciiFourCC(chunkHeaderView, 0);
    const chunkSize = chunkHeaderView.getUint32(4, true);
    const payloadOffset = offset + 8;

    if (payloadOffset + chunkSize > source.size) {
      throw new Error(
        `Truncated WAV "${chunkId}" chunk: declares ${chunkSize} bytes past end of file (${source.size} bytes).`
      );
    }

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) {
        throw new Error(`Malformed WAV "fmt " chunk (${chunkSize} bytes; expected at least 16).`);
      }
      const fmtReadLen = Math.min(chunkSize, 64);
      const fmtBuf = await readByteSlice(source, payloadOffset, payloadOffset + fmtReadLen);
      const fmtView = new DataView(fmtBuf);

      const audioFormat = fmtView.getUint16(0, true);
      const rawChannels = fmtView.getUint16(2, true);
      const sampleRate = fmtView.getUint32(4, true);
      const byteRate = fmtView.getUint32(8, true);
      const blockAlign = fmtView.getUint16(12, true);
      const rawBits = fmtView.getUint16(14, true);

      let effectiveFormat: 'pcm' | 'float';
      let validBitsPerSample = rawBits;

      if (audioFormat === WAVE_FORMAT_PCM) {
        effectiveFormat = 'pcm';
      } else if (audioFormat === WAVE_FORMAT_IEEE_FLOAT) {
        effectiveFormat = 'float';
      } else if (audioFormat === WAVE_FORMAT_EXTENSIBLE) {
        if (chunkSize < 40) {
          throw new Error('Malformed WAVE_FORMAT_EXTENSIBLE "fmt " chunk (< 40 bytes).');
        }
        validBitsPerSample = fmtView.getUint16(18, true) || rawBits;
        if (guidMatches(fmtView, 24, KSDATAFORMAT_SUBTYPE_PCM)) {
          effectiveFormat = 'pcm';
        } else if (guidMatches(fmtView, 24, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT)) {
          effectiveFormat = 'float';
        } else {
          throw new Error('Unsupported WAVE_FORMAT_EXTENSIBLE subtype: only standard PCM or IEEE Float are supported.');
        }
      } else {
        throw new Error(
          `Unsupported WAV format tag (0x${audioFormat.toString(16).padStart(4, '0')}): only uncompressed PCM and IEEE Float32 are supported.`
        );
      }

      if (rawChannels !== 1 && rawChannels !== 2) {
        throw new Error(`Unsupported WAV channel count (${rawChannels}): only mono and stereo are supported.`);
      }

      if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
        throw new Error(`Unsupported WAV sample rate (${sampleRate} Hz): expected 8,000–192,000 Hz.`);
      }

      if (effectiveFormat === 'pcm') {
        if (rawBits !== 8 && rawBits !== 16 && rawBits !== 24 && rawBits !== 32) {
          throw new Error(`Unsupported PCM bit depth (${rawBits}-bit): expected 8, 16, 24, or 32.`);
        }
      } else {
        if (rawBits !== 32) {
          throw new Error(`Unsupported IEEE Float bit depth (${rawBits}-bit): only 32-bit float is supported.`);
        }
      }

      if (validBitsPerSample <= 0 || validBitsPerSample > rawBits) {
        throw new Error(`Invalid WAV validBitsPerSample (${validBitsPerSample}) for ${rawBits}-bit container.`);
      }

      const expectedBlockAlign = rawChannels * (rawBits / 8);
      if (blockAlign !== expectedBlockAlign) {
        throw new Error(
          `Invalid WAV blockAlign (${blockAlign}): expected ${expectedBlockAlign} for ${rawChannels}ch ${rawBits}-bit audio.`
        );
      }

      fmt = {
        audioFormat,
        effectiveFormat,
        channels: rawChannels,
        sampleRate,
        byteRate,
        blockAlign,
        bitsPerSample: rawBits,
        validBitsPerSample,
      };
    } else if (chunkId === 'data') {
      if (!fmt) {
        throw new Error('Malformed WAV file: "data" chunk appeared before "fmt " chunk.');
      }
      if (chunkSize === 0) {
        throw new Error('WAV "data" chunk is empty (0 bytes).');
      }
      if (chunkSize % fmt.blockAlign !== 0) {
        throw new Error(
          `Truncated PCM frames in WAV "data" chunk: ${chunkSize} bytes is not divisible by blockAlign=${fmt.blockAlign}.`
        );
      }
      dataOffset = payloadOffset;
      dataSize = chunkSize;
      break;
    }

    // RIFF chunks must start on even byte boundaries: skip odd pad byte if declared chunkSize is odd
    const paddedSize = chunkSize + (chunkSize & 1);
    offset = payloadOffset + paddedSize;
  }

  if (!fmt) {
    throw new Error('Malformed WAV file: missing "fmt " header chunk.');
  }
  if (dataOffset < 0 || dataSize <= 0) {
    throw new Error('Malformed WAV file: missing "data" chunk.');
  }

  const totalFrames = dataSize / fmt.blockAlign;
  const durationSec = totalFrames / fmt.sampleRate;

  return {
    audioFormat: fmt.audioFormat,
    effectiveFormat: fmt.effectiveFormat,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    validBitsPerSample: fmt.validBitsPerSample,
    blockAlign: fmt.blockAlign,
    byteRate: fmt.byteRate,
    dataOffset,
    dataSize,
    totalFrames,
    durationSec,
    fileSize: source.size,
  };
}

/**
 * Decodes raw interleaved PCM/Float bytes cleanly into mono Float32Array samples.
 * Applies 0.5 * (L + R) for stereo and preserves mono unchanged.
 */
export function decodePcmBytesToMono(
  bytes: ArrayBuffer,
  info: Pick<WavFormatInfo, 'effectiveFormat' | 'channels' | 'bitsPerSample' | 'blockAlign'>,
  targetOut?: Float32Array
): Float32Array {
  if (bytes.byteLength % info.blockAlign !== 0) {
    throw new Error(
      `Truncated frame slice: ${bytes.byteLength} bytes is not a multiple of blockAlign=${info.blockAlign}.`
    );
  }

  const frameCount = bytes.byteLength / info.blockAlign;
  const out = targetOut && targetOut.length >= frameCount ? targetOut : new Float32Array(frameCount);
  const view = new DataView(bytes);
  const bytesPerSample = info.bitsPerSample / 8;

  const readSampleNormalized = (bytePos: number): number => {
    if (info.effectiveFormat === 'float') {
      const v = view.getFloat32(bytePos, true);
      if (!Number.isFinite(v)) {
        throw new Error('Invalid non-finite sample value encountered in IEEE Float32 WAV data.');
      }
      return v;
    }
    switch (info.bitsPerSample) {
      case 8:
        return (view.getUint8(bytePos) - 128) / 128.0;
      case 16:
        return view.getInt16(bytePos, true) / 32768.0;
      case 24: {
        const b0 = view.getUint8(bytePos);
        const b1 = view.getUint8(bytePos + 1);
        const b2 = view.getUint8(bytePos + 2);
        let v = b0 | (b1 << 8) | (b2 << 16);
        if (v & 0x800000) v |= ~0xffffff;
        return v / 8388608.0;
      }
      case 32:
        return view.getInt32(bytePos, true) / 2147483648.0;
    }
  };

  if (info.channels === 1) {
    for (let f = 0; f < frameCount; f++) {
      out[f] = readSampleNormalized(f * info.blockAlign);
    }
  } else {
    for (let f = 0; f < frameCount; f++) {
      const frameByte = f * info.blockAlign;
      const l = readSampleNormalized(frameByte);
      const r = readSampleNormalized(frameByte + bytesPerSample);
      out[f] = 0.5 * (l + r);
    }
  }

  return out.subarray(0, frameCount);
}

/**
 * Opens an incremental, bounded-memory WAV chunk stream using ~4-second frame-aligned slices.
 */
export async function createWavPcmChunkStream(
  source: WavByteSource,
  options: WavChunkStreamOptions = {}
): Promise<WavPcmChunkStream> {
  const info = await parseWavHeader(source);
  const targetChunkSec = Math.max(0.25, Math.min(8.0, options.chunkDurationSec ?? 4.0));
  const chunkFrames = Math.max(256, Math.round(info.sampleRate * targetChunkSec));
  const totalChunks = Math.max(1, Math.ceil(info.totalFrames / chunkFrames));
  let framesRead = 0;

  return {
    info,
    chunkFrames,
    totalChunks,
    hasNext(): boolean {
      return framesRead < info.totalFrames;
    },
    async nextChunk(): Promise<WavDecodedChunk | null> {
      if (framesRead >= info.totalFrames) {
        return null;
      }
      const startFrame = framesRead;
      const frameCount = Math.min(chunkFrames, info.totalFrames - startFrame);
      const startByte = info.dataOffset + startFrame * info.blockAlign;
      const endByte = startByte + frameCount * info.blockAlign;

      const sliceBuf = await readByteSlice(source, startByte, endByte);
      const monoSamples = decodePcmBytesToMono(sliceBuf, info);
      framesRead += frameCount;

      return {
        monoSamples,
        frameCount,
        startFrame,
        sampleRate: info.sampleRate,
        durationSec: frameCount / info.sampleRate,
        isLast: framesRead >= info.totalFrames,
      };
    },
  };
}
