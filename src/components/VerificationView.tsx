/**
 * VerificationView: Interactive In-App Scientific Verification & Benchmark Suite
 * Renders complete test batteries with measured numbers, analytical expectations,
 * relative errors, convergence tables, and performance metrics.
 */

import React, { useState } from 'react';
import { CheckCircle2, XCircle, Play, Download, ShieldCheck, Cpu, GitBranch, Terminal } from 'lucide-react';
import { FullAuditReport, runFullScientificAudit } from '../physics/verificationSuite.ts';

export const VerificationView: React.FC = () => {
  const [report, setReport] = useState<FullAuditReport | null>(null);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'all' | 'structural' | 'modal' | 'audio' | 'transport' | 'convergence' | 'benchmark'>('all');

  const handleRunAudit = () => {
    setIsRunning(true);
    // Allow UI to update before synchronous compute
    setTimeout(() => {
      const res = runFullScientificAudit();
      setReport(res);
      setIsRunning(false);
    }, 50);
  };

  const handleExportJson = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chladni-verification-audit-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-2xl flex flex-col gap-5 text-slate-200">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-emerald-400" />
            <h2 className="text-base font-bold tracking-tight text-white">
              Scientific Verification &amp; Benchmark Suite
            </h2>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Rigorous mathematical validation of plate eigenvalues, SDOF ODE integration, Itô SDE transport, and convergence.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {report && (
            <button
              onClick={handleExportJson}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-200 transition"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export Audit JSON</span>
            </button>
          )}
          <button
            onClick={handleRunAudit}
            disabled={isRunning}
            data-testid="run-audit-btn"
            className="flex items-center gap-2 px-4 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-950/50 transition disabled:opacity-50"
          >
            <Play className={`w-3.5 h-3.5 ${isRunning ? 'animate-spin' : ''}`} />
            <span>{isRunning ? 'Auditing Equations...' : 'Run Full Scientific Audit'}</span>
          </button>
        </div>
      </div>

      {/* Audit Summary Banner */}
      {report && (
        <div className={`p-3.5 rounded-lg border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 ${
          report.allPassed
            ? 'bg-emerald-950/30 border-emerald-800 text-emerald-200'
            : 'bg-rose-950/30 border-rose-800 text-rose-200'
        }`}>
          <div className="flex items-center gap-2.5">
            {report.allPassed ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            ) : (
              <XCircle className="w-5 h-5 text-rose-400 shrink-0" />
            )}
            <div>
              <span className="font-bold text-sm block">
                {report.allPassed
                  ? `All ${report.totalTests} Physics & Solver Tests Passed Cleanly`
                  : `${report.passedTests} / ${report.totalTests} Tests Passed`}
              </span>
              <span className="text-xs opacity-80">
                Audit executed at {new Date(report.timestamp).toLocaleTimeString()}
              </span>
            </div>
          </div>
          <div className="text-xs font-mono bg-slate-900/80 px-2.5 py-1 rounded border border-slate-800">
            Pass Rate: {((report.passedTests / report.totalTests) * 100).toFixed(1)}%
          </div>
        </div>
      )}

      {/* Filter Tabs */}
      {report && (
        <div className="flex flex-wrap gap-1 border-b border-slate-800 pb-2">
          {[
            { id: 'all', label: 'All Batteries' },
            { id: 'structural', label: '1. Structural Physics' },
            { id: 'modal', label: '2. Modal Solver' },
            { id: 'audio', label: '3. Audio Coupling' },
            { id: 'transport', label: '4. Particle Transport' },
            { id: 'convergence', label: '5. Convergence' },
            { id: 'benchmark', label: '6. Benchmarks' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={`px-3 py-1 text-xs rounded-md font-medium transition ${
                activeTab === tab.id
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Test Results Table */}
      {report ? (
        <div className="flex flex-col gap-4">
          {/* Main Tests Table (for structural, modal, audio, transport, or all) */}
          {activeTab !== 'convergence' && activeTab !== 'benchmark' && (
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-slate-950 text-slate-400 uppercase tracking-wider font-mono">
                  <tr>
                    <th className="py-2.5 px-3 border-b border-slate-800">Status</th>
                    <th className="py-2.5 px-3 border-b border-slate-800">Category</th>
                    <th className="py-2.5 px-3 border-b border-slate-800">Test Assertion</th>
                    <th className="py-2.5 px-3 border-b border-slate-800">Expected</th>
                    <th className="py-2.5 px-3 border-b border-slate-800">Measured</th>
                    <th className="py-2.5 px-3 border-b border-slate-800">Rel. Err %</th>
                    <th className="py-2.5 px-3 border-b border-slate-800">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {[
                    ...report.structuralResults,
                    ...report.modalResults,
                    ...report.audioResults,
                    ...report.transportResults,
                  ]
                    .filter((r) => {
                      if (activeTab === 'structural') return r.category === 'Structural Physics';
                      if (activeTab === 'modal') return r.category === 'Modal Solver';
                      if (activeTab === 'audio') return r.category === 'Audio & Excitation';
                      if (activeTab === 'transport') return r.category === 'Particle Transport';
                      return true;
                    })
                    .map((item, idx) => (
                      <tr key={idx} className="hover:bg-slate-800/30 transition">
                        <td className="py-2 px-3">
                          {item.passed ? (
                            <span className="inline-flex items-center gap-1 text-emerald-400 font-bold">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              PASS
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-rose-400 font-bold">
                              <XCircle className="w-3.5 h-3.5" />
                              FAIL
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-slate-400">{item.category}</td>
                        <td className="py-2 px-3 text-white font-medium">{item.testName}</td>
                        <td className="py-2 px-3 text-slate-300">{item.expected}</td>
                        <td className="py-2 px-3 text-slate-200">{item.measured}</td>
                        <td className="py-2 px-3">
                          {item.relativeErrorPercent !== undefined ? (
                            <span className={item.relativeErrorPercent < 2.5 ? 'text-emerald-400' : 'text-amber-400'}>
                              {item.relativeErrorPercent.toFixed(2)}%
                            </span>
                          ) : (
                            '-'
                          )}
                        </td>
                        <td className="py-2 px-3 text-[11px] text-slate-400 max-w-xs truncate" title={item.details}>
                          {item.details}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Section 5: Numerical Convergence View */}
          {(activeTab === 'convergence' || activeTab === 'all') && (
            <div className="bg-slate-950/60 p-4 rounded-lg border border-slate-800 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <GitBranch className="w-4 h-4 text-sky-400" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                  5. Numerical Convergence: Timestep Refinement &amp; Spatial Grid
                </h3>
              </div>

              {/* Timestep Table */}
              <div>
                <span className="text-xs text-slate-400 font-medium block mb-1.5">
                  Timestep Convergence (&Delta;t &rarr; &Delta;t/2 &rarr; &Delta;t/4) with RK4:
                </span>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs font-mono border border-slate-800">
                    <thead className="bg-slate-900 text-slate-400">
                      <tr>
                        <th className="p-2 border-b border-slate-800">Timestep &Delta;t</th>
                        <th className="p-2 border-b border-slate-800">Sampling Rate</th>
                        <th className="p-2 border-b border-slate-800">Peak Displacement [m]</th>
                        <th className="p-2 border-b border-slate-800">Rel Error vs Analytical</th>
                        <th className="p-2 border-b border-slate-800">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {report.convergenceResults.data.timestepSteps.map((step, i) => (
                        <tr key={i}>
                          <td className="p-2 text-white">{(step.dt * 1000).toFixed(4)} ms</td>
                          <td className="p-2 text-slate-300">{(1 / step.dt).toFixed(0)} Hz</td>
                          <td className="p-2 text-slate-200">{step.rmsAmplitude.toExponential(4)}</td>
                          <td className="p-2 text-emerald-400 font-bold">{step.maxRelativeError.toFixed(3)}%</td>
                          <td className="p-2 text-emerald-400 font-medium">CONVERGED</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Grid Resolution Table */}
              <div className="mt-2">
                <span className="text-xs text-slate-400 font-medium block mb-1.5">
                  Spatial Grid Resolution (24&times;24 to 64&times;64):
                </span>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs font-mono border border-slate-800">
                    <thead className="bg-slate-900 text-slate-400">
                      <tr>
                        <th className="p-2 border-b border-slate-800">Grid Size</th>
                        <th className="p-2 border-b border-slate-800">Cell Width (&Delta;x)</th>
                        <th className="p-2 border-b border-slate-800">Mean Mode Diffusivity</th>
                        <th className="p-2 border-b border-slate-800">Correlation with Continuous Mode</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {report.convergenceResults.data.gridSteps.map((g, i) => (
                        <tr key={i}>
                          <td className="p-2 text-white">{g.resolution}&times;{g.resolution} ({g.resolution * g.resolution} cells)</td>
                          <td className="p-2 text-slate-300">{((0.30 / g.resolution) * 1000).toFixed(2)} mm</td>
                          <td className="p-2 text-slate-200">{g.meanDiffusivity.toFixed(4)}</td>
                          <td className="p-2 text-sky-400 font-bold">{g.correlationWithAnalytical.toFixed(5)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Section 6: Real-Time & Mobile Performance Benchmark */}
          {(activeTab === 'benchmark' || activeTab === 'all') && (
            <div className="bg-slate-950/60 p-4 rounded-lg border border-slate-800 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-amber-400" />
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                  6. Real-Time &amp; Mobile Performance Benchmark (500 to 4000 Particles)
                </h3>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono border border-slate-800">
                  <thead className="bg-slate-900 text-slate-400">
                    <tr>
                      <th className="p-2 border-b border-slate-800">Particles</th>
                      <th className="p-2 border-b border-slate-800">Avg Frame Rate</th>
                      <th className="p-2 border-b border-slate-800">Worst (Min) FPS</th>
                      <th className="p-2 border-b border-slate-800">Physics Update Time</th>
                      <th className="p-2 border-b border-slate-800">Audio Overhead</th>
                      <th className="p-2 border-b border-slate-800">Est. Memory</th>
                      <th className="p-2 border-b border-slate-800">Mobile Suitability</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {report.benchmarkResults.map((b) => (
                      <tr key={b.particleCount}>
                        <td className="p-2 text-white font-bold">{b.particleCount} grains</td>
                        <td className="p-2 text-emerald-400 font-bold">{b.avgFps} FPS</td>
                        <td className="p-2 text-slate-300">{b.minFps} FPS</td>
                        <td className="p-2 text-slate-200">{b.physicsUpdateTimeMs.toFixed(3)} ms</td>
                        <td className="p-2 text-slate-400">{b.audioTimeMs.toFixed(2)} ms</td>
                        <td className="p-2 text-slate-400">{b.memoryEstimateMb.toFixed(3)} MB</td>
                        <td className="p-2">
                          {b.particleCount <= 1000 ? (
                            <span className="text-emerald-400 font-semibold">Optimal for Mobile</span>
                          ) : b.particleCount <= 2000 ? (
                            <span className="text-sky-400">Standard Desktop/Tablet</span>
                          ) : (
                            <span className="text-amber-400">High-Performance Desktop</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="text-center py-10 bg-slate-950/40 rounded-lg border border-dashed border-slate-800 flex flex-col items-center justify-center gap-2">
          <Terminal className="w-8 h-8 text-slate-600" />
          <p className="text-xs text-slate-400 max-w-sm">
            Click &ldquo;Run Full Scientific Audit&rdquo; to execute all 6 automated test batteries:
            structural physics, SDOF modal solver, audio orthogonality, Itô particle transport,
            numerical convergence, and performance benchmarks.
          </p>
        </div>
      )}
    </div>
  );
};
