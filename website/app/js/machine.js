// What this PC has for geometry work, and how many geometry kernels may work at once on it. Each kernel is a worker
// of its own: one processor thread, and memory for the part it holds (a few hundred MB, more for big parts). So
// the number comes from the PC's processor threads and its free memory, read when RazorCAD starts (and again when
// another kernel is wanted), not from any one machine's figures.
//
//   machineInfo()    { threads, freeMB, totalMB }: free memory from Windows in the desktop app; in a browser only
//                    roughly (the browser gives its own rounded figure for the PC's memory, at most 8 GB)
//   kernelBudget(m)  kernels at once: a thread each beyond two (the window and the rest of the PC), about 1 GB of
//                    free memory each beyond 2 GB; at least 2 (a drawing or assembly never waits on the part), at
//                    most 16
//   memoryFor(m, n)  whether there is free memory for n more kernels

import { platform } from './platform.js';

export async function machineInfo() {
  const threads = navigator.hardwareConcurrency || 4;
  let freeMB = null, totalMB = null;
  try {
    await platform.ready; // (the desktop app's bridge, which tells the free memory)
    const s = await platform.systemInfo();
    if (s) { freeMB = s.freeMB ?? null; totalMB = s.totalMB ?? null; }
  } catch { /* not known */ }
  if (totalMB == null && navigator.deviceMemory) totalMB = navigator.deviceMemory * 1024;
  return { threads, freeMB, totalMB };
}

// (free memory when known, else three quarters of the PC's: the browser gives only a rounded total)
const freeOf = (m) => m.freeMB ?? (m.totalMB != null ? m.totalMB * 0.75 : 4096);

export function kernelBudget(m) {
  const byCpu = Math.max(1, (m.threads || 4) - 2);
  const byMem = Math.max(1, Math.floor((freeOf(m) - 2048) / 1024));
  return Math.max(2, Math.min(16, byCpu, byMem));
}

export function memoryFor(m, n = 1) {
  return freeOf(m) - n * 1024 >= 1536;
}
