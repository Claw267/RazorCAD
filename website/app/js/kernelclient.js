// More geometry kernels at once, for work that doesn't touch the part being edited: an assembly's parts (built
// side by side), drawing views, picks and cut lists. Each is a worker of its own, started when first needed, up to
// `size` (set from what the PC has: machine.js; until that is known, a quarter of its threads, at most 4). A job
// with an affinity (a model) goes to the worker that had it before, so that worker's cached build of it is used
// again. Workers idle for IDLE_MS are stopped (their memory given back), one kept.
const IDLE_MS = 180000;
export class KernelPool {
  constructor(main, size = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 4)))) {
    this.main = main;
    this.size = size;
    this.workers = []; // { client, jobs, used }
    this.affinity = new Map(); // affinity key → worker
    this._reap = setInterval(() => this.reap(), 30000);
  }
  // (workers idle a while stopped, the most recently used one kept)
  reap(now = performance.now()) {
    const idle = this.workers.filter((w) => !w.jobs && now - (w.used || 0) > IDLE_MS).sort((a, b) => (a.used || 0) - (b.used || 0));
    if (idle.length === this.workers.length) idle.pop();
    for (const w of idle) {
      this.workers.splice(this.workers.indexOf(w), 1);
      for (const [k, x] of this.affinity) if (x === w) this.affinity.delete(k);
      w.client.dispose();
    }
    return idle.length;
  }
  pick(aff) {
    const w = aff && this.affinity.get(aff);
    if (w && this.workers.includes(w)) return w;
    let best = this.workers.find((x) => !x.jobs);
    if (!best && this.workers.length < this.size) {
      best = { client: new KernelClient({ fonts: this.main.fonts }), jobs: 0 };
      best.client.ready.then(() => { for (const [k, d] of this.main.fonts) best.client.sendFont(k, d); }).catch(() => {});
      this.workers.push(best);
    }
    best ||= this.workers.reduce((a, b) => (b.jobs < a.jobs ? b : a));
    if (aff) { this.affinity.set(aff, best); if (this.affinity.size > 200) this.affinity.delete(this.affinity.keys().next().value); }
    return best;
  }
  async request(type, data = {}, aff = null) {
    const w = this.pick(aff);
    w.jobs++;
    try {
      await w.client.ready;
      for (const [k, d] of this.main.fonts) await w.client.sendFont(k, d);
      return await w.client.request(type, data);
    } finally { w.jobs--; w.used = performance.now(); }
  }
  // as many jobs at once as there are workers (fn(item) runs each); resolves when all are done
  async each(items, fn) {
    let i = 0;
    const lane = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
    await Promise.all(Array.from({ length: Math.min(this.size, items.length) }, lane));
  }
  stats() { return { size: this.size, started: this.workers.length, busy: this.workers.filter((w) => w.jobs).length }; }
}

// Main-thread client for the geometry worker. Rebuild requests are coalesced:
// while one rebuild runs, only the most recent document is queued.
// If the kernel breaks (it aborted, or its worker died), the worker is replaced by a fresh one
// and the request is repeated once, so one kernel failure doesn't take the whole model down.
const RECYCLE_MB = 3600; // the kernel can address 4 GB

export class KernelClient {
  // threads: how many threads the kernel may use (more than 1: the multi-threaded kernel, where the page allows it)
  constructor({ fonts = null, threads = 1 } = {}) {
    this.threads = threads;
    this.seq = 0;
    this.calls = new Map();
    this.busy = false;
    this.nextDoc = null;
    this.waiters = [];
    this.lastDoc = null;     // last document rebuilt, to restore a replaced worker's state
    this.fonts = fonts || new Map();  // font key -> bytes, sent again to a replaced worker (a pool's workers share the main one's)
    this.restarts = 0;
    this.spawn();
  }

  spawn() {
    const url = new URL('./kernel.worker.js', import.meta.url);
    if (this.threads > 1) url.searchParams.set('threads', String(this.threads));
    const worker = new Worker(url, { type: 'module' });
    this.worker = worker;
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') { this.onProgress?.(e.data.value, e.data.label, e.data.feature); return; }
      const { id, ok, result, error, stack, fatal } = e.data;
      const c = this.calls.get(id);
      if (!c) return;
      this.calls.delete(id);
      if (ok) c.resolve(result);
      else { const err = new Error(error); err.workerStack = stack; err.fatal = !!fatal; c.reject(err); }
    };
    worker.onerror = (e) => {
      if (worker !== this.worker) return;
      e.preventDefault?.(); // reported below as a kernel crash, not again as a page error
      console.error('Kernel worker error', e);
      const err = new Error(`${e.message || 'The geometry kernel stopped'}${e.filename ? ` (${e.filename}:${e.lineno})` : ''}`);
      // a worker that never started (missing files) is not restarted, or it would loop
      err.fatal = started;
      this.onCrash?.(err);
      this.failAll(worker, err);
      if (started) this.restart(worker); // later requests go to a fresh worker, not one that may be dead
    };
    let started = false;
    this.ready = this.call('ping').then(async (r) => {
      for (const [key, data] of this.fonts) await this.call('loadFont', { key, data: data.slice(0) });
      return r;
    });
    this.ready.then(() => { started = true; }, () => {});
    return this.ready;
  }

  // reject every request sent to `worker` (it is dead)
  failAll(worker, err) {
    for (const [id, c] of this.calls) {
      if (c.worker !== worker) continue;
      this.calls.delete(id);
      const e = new Error(err.message); e.workerStack = err.workerStack; e.fatal = err.fatal !== false; e.followOn = !!err.followOn; e.cancelled = !!err.cancelled;
      c.reject(e);
    }
  }

  // Stop what the kernel is doing (e.g. a cut that would take minutes): the worker is replaced by a fresh one
  // and the requests it had fail as cancelled (not as a crash).
  async cancel() {
    const w = this.worker;
    if (this._restarting) return this._restarting;
    this._restarting = (async () => {
      const stopped = Object.assign(new Error('Stopped'), { fatal: false, cancelled: true });
      // (a queued rebuild may still hold the slow feature: the caller rebuilds once it has dealt with it)
      const queued = this.waiters;
      this.nextDoc = null;
      this.waiters = [];
      queued.forEach((q) => q.reject(stopped));
      try { w.terminate(); } catch { /* already gone */ }
      this.failAll(w, stopped);
      try { await this.spawn(); } finally { this._restarting = null; }
    })();
    return this._restarting;
  }

  // Replace a broken worker (once per broken worker, however many requests noticed it).
  restart(broken) {
    if (this.worker === broken && !this._restarting) {
      this._restarting = (async () => {
        this.restarts++;
        try { broken.terminate(); } catch { /* already gone */ }
        // (requests that were waiting on the broken worker: not failures of their own)
        this.failAll(broken, Object.assign(new Error('The geometry kernel was restarted'), { followOn: true }));
        try { await this.spawn(); } finally { this._restarting = null; }
      })();
    }
    return this._restarting || this.ready;
  }

  call(type, data = {}) {
    const id = ++this.seq;
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject, worker });
      worker.postMessage({ id, type, data });
    });
  }

  // A request that survives a kernel failure: on a fatal error the worker is replaced, its
  // state rebuilt from the last document if needed, and the request sent again once.
  async request(type, data = {}) {
    await this._restarting;
    // (other requests act on the model as built: they wait for a rebuild being made or queued — the
    // worker would otherwise run them in its pauses, on a half-built model)
    if (type !== 'rebuild' && type !== 'stats' && type !== 'cancel') while (this.pending || this.expecting) await new Promise((r) => setTimeout(r, 25));
    const worker = this.worker;
    try {
      return await this.call(type, data);
    } catch (err) {
      if (!err.fatal) throw err;
      if (!err.followOn) this.onRestart?.(err); // one report per crash, not one per waiting request
      await this.restart(worker);
      if (type !== 'rebuild' && this.lastDoc) await this.call('rebuild', { doc: this.lastDoc, previewId: null });
      try {
        return await this.call(type, data);
      } catch (err2) {
        err2.firstError = err;
        throw err2;
      }
    }
  }

  // previewId: feature shown as a preview (model rolled back to just before it)
  // haveMesh: key of the mesh the view shows (the kernel then doesn't resend an unchanged mesh)
  rebuild(doc, previewId = null, haveMesh = null) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.nextDoc = JSON.stringify(doc);
      this.nextPreview = previewId;
      this.nextHave = haveMesh;
      this.pump();
    });
  }

  pump() {
    if (this.busy || this.nextDoc === null) return;
    const doc = this.nextDoc;
    const previewId = this.nextPreview;
    const haveMesh = this.nextHave;
    const waiters = this.waiters;
    this.nextDoc = null;
    this.waiters = [];
    this.busy = true;
    this.runningDoc = doc; // (what is being built, so the app can tell when it has gone stale)
    this.runningSince = performance.now();
    // clear `busy` (and start any queued rebuild) before waiters resume, so they can
    // tell whether their result is already superseded
    this.request('rebuild', { doc, previewId, haveMesh }).then(
      (r) => {
        this.lastDoc = doc; this.busy = false; this.pump(); waiters.forEach((w) => w.resolve(r));
        if (r?.kernelMemoryMB > RECYCLE_MB) this.recycle();
      },
      (err) => { this.busy = false; this.pump(); waiters.forEach((w) => w.reject(err)); },
    );
  }

  // The kernel's memory only grows (up to 4 GB, where it would fail). Past RECYCLE_MB the worker is
  // replaced by a fresh one once it's idle, and the last model rebuilt in it.
  async recycle() {
    if (this._recycling) return;
    this._recycling = true;
    try {
      while (this.busy || this.calls.size) await new Promise((r) => setTimeout(r, 250));
      const doc = this.lastDoc;
      await this.restart(this.worker);
      if (doc && !this.busy) await this.call('rebuild', { doc, previewId: null }).catch(() => {});
    } finally {
      this._recycling = false;
    }
  }

  get pending() { return this.busy || this.nextDoc !== null; }
  // (a rebuild about to be asked for: the app marks it while it gets ready, so requests wait for it too)
  expect(on) { this.expecting = Math.max(0, (this.expecting || 0) + (on ? 1 : -1)); }

  // bodyId: export only that body; info: { [bodyId]: { name, color } }
  exportBody(format, bodyId = null, info = {}) {
    return this.request('export', { format, bodyId, info });
  }

  featureFaces(id) {
    return this.request('featureFaces', { id });
  }

  async loadFont(key, data) {
    this.fonts.set(key, data);
    await this.ready;
    return this.call('loadFont', { key, data: data.slice(0) });
  }

  textOutlines(texts) {
    return this.request('textOutlines', { texts });
  }

  measure(refs) {
    return this.request('measure', { refs });
  }

  // curves where a sketch's plane cuts the bodies (before that sketch), in sketch coordinates
  sectionCurves(sketchId) {
    return this.request('sectionCurves', { sketchId });
  }

  exportFaceDXF(ref) {
    return this.request('exportFaceDXF', { ref });
  }

  // The worker stopped for good (its memory given back); requests still waiting fail.
  dispose() {
    this.disposed = true;
    const err = new Error('The geometry kernel was stopped'); err.fatal = false; err.cancelled = true;
    try { this.failAll(this.worker, err); } catch { /* nothing waiting */ }
    this.worker.terminate();
  }

  // (a font sent to this worker only if it doesn't have it yet: pool workers share the font list)
  async sendFont(key, data) {
    this._sent ||= new Set();
    if (this._sent.has(key)) return;
    this._sent.add(key);
    await this.ready;
    return this.call('loadFont', { key, data: data.slice(0) });
  }

  // kernel memory / stack state for crash reports (never restarts anything)
  stats() {
    return Promise.race([this.call('stats'), new Promise((r) => setTimeout(() => r(null), 1000))]).catch(() => null);
  }
}
