// Reads a STEP file's assembly structure (stepasm.js) off the main thread: big files take seconds.
import { readStepAssembly } from './stepasm.js';

self.onmessage = (e) => {
  try {
    const result = readStepAssembly(e.data.text, (msg) => self.postMessage({ progress: msg }));
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: err.message || String(err) });
  }
};
