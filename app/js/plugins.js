// Plug-ins: tools of your own, developed apart from RazorCAD and kept on your own PC (private ones too). Each is a
// folder (desktop: Documents\RazorCAD\Plugins\<name>; the browser version keeps the ones installed into it) holding
// plugin.json and its JavaScript module, whose activate(api) adds commands. A plug-in's commands get a ribbon tab of
// their own (in parts, assemblies or drawings, as each command asks), a Tools menu entry and the command search.
// Commands run as macros do (the `rc` of macros.js: one undo step, rebuilt when they end), and can ask for values
// with a form of their own (api.form): a generator's sizes. Plug-ins can do anything RazorCAD can: they are only
// loaded once turned on in Tools ▸ Plug-ins (or made or installed there).
import * as M from './model.js';
import * as S from './sketchmodel.js';
import { platform } from './platform.js';
import { icon } from './icons.js';
import { evaluate } from './expr.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const el = (tag, attrs = {}, html = '') => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  e.innerHTML = html;
  return e;
};
export const KINDS = ['part', 'assembly', 'drawing'];
export const EVENTS = ['rebuilt', 'opened', 'saved'];
const ACTIVATE_MS = 15000;

// '0.21.4-beta' → [0, 21, 4]; true when version is at least min
export function versionAtLeast(version, min) {
  const k = (v) => String(v || '').split(/[^\d]+/).filter(Boolean).slice(0, 3).map(Number);
  const a = k(version), b = k(min);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}

// A plug-in's modules as blob URLs, its own relative imports ('./lib.js', '../x.mjs') pointed at theirs: { url
// (the main module's), urls }. (Modules importing each other in a circle aren't supported.)
const IMPORT = /(\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?|\bexport\s*(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\2/g;
export function linkModules(files, main) {
  const urls = new Map(), busy = new Set();
  const resolve = (from, spec) => {
    const parts = from.split('/').slice(0, -1);
    for (const s of spec.split('/')) { if (s === '..') parts.pop(); else if (s && s !== '.') parts.push(s); }
    return parts.join('/');
  };
  const url = (path) => {
    if (urls.has(path)) return urls.get(path);
    if (!(path in files)) throw new Error(`The plug-in has no ${path}`);
    if (busy.has(path)) throw new Error(`${path} is imported in a circle (plug-ins' modules can't import each other in a circle)`);
    busy.add(path);
    const src = files[path].replace(IMPORT, (m, head, q, spec) => `${head}${q}${url(resolve(path, spec))}${q}`);
    busy.delete(path);
    const u = URL.createObjectURL(new Blob([`${src}\n//# sourceURL=plugin:///${path}`], { type: 'text/javascript' }));
    urls.set(path, u);
    return u;
  };
  return { url: url(main), urls: [...urls.values()] };
}

export class Plugins {
  constructor(app) {
    this.app = app;
    this.list = []; // { id, manifest, error, modified, on, state: 'off' | 'running' | 'failed', commands, handlers, … }
    this.folder = null;
    this.version = null;
    this.started = false;
  }
  prefs() { const p = (this.app.ui.prefs ||= {}); return p; }
  // which plug-ins are turned on: { id: true | false } (one found for the first time is off until turned on)
  switches() { return (this.prefs().plugins ||= {}); }
  data(id) { const d = (this.prefs().pluginData ||= {}); return (d[id] ||= {}); }
  save() { this.app.ui.savePrefs(); }
  label(p) { return String(p.manifest?.tab || p.manifest?.name || p.id); }
  // the kind of document in front: 'part' | 'assembly' | 'drawing'
  kind() { const a = this.app; return a.mode !== 'drawing' || !a.drawing ? 'part' : a.drawing.doc?.kind === 'assembly' ? 'assembly' : 'drawing'; }

  // ---- loading
  // the plug-ins found, the ones turned on started (once the preferences are read)
  async start() {
    this.started = true;
    this.version = await platform.appVersion().catch(() => null);
    await this.reload({ quiet: true });
  }
  async reload({ quiet = false } = {}) {
    for (const p of this.list) await this.stop(p);
    let found;
    try { found = await platform.listPlugins(); } catch (e) { found = { folder: null, plugins: [] }; if (!quiet) this.app.toast('Could not read the plug-ins: ' + (e?.message || e), true); }
    this.folder = found.folder;
    const sw = this.switches(), fresh = [];
    this.list = (found.plugins || []).map((x) => ({ id: x.id, manifest: x.manifest || {}, error: x.error || null, modified: x.modified, on: sw[x.id] === true, state: 'off', commands: [], handlers: [], cleanups: [], urls: [] }));
    for (const p of this.list) {
      if (!(p.id in sw)) fresh.push(p);
      if (p.on && !p.error) await this.run(p);
    }
    this.refreshUI();
    if (fresh.length && quiet) this.app.status(`${fresh.length === 1 ? `A new plug-in, ${this.label(fresh[0])}, was` : `${fresh.length} new plug-ins were`} found: Tools ▸ Plug-ins turns ${fresh.length === 1 ? 'it' : 'them'} on.`);
    return this.list;
  }
  // a plug-in loaded and its activate(api) run
  async run(p) {
    // (running already: stopped first, so its commands aren't added twice)
    await this.stop(p);
    p.state = 'off'; p.error = null;
    const need = p.manifest.razorcad;
    if (need && this.version && !versionAtLeast(this.version, need)) { p.state = 'failed'; p.error = `It needs RazorCAD ${need} or later`; return false; }
    try {
      const { files } = await platform.readPlugin(p.id);
      const main = String(p.manifest.main || 'main.js').replace(/^\.\//, '');
      const linked = linkModules(files || {}, main);
      p.urls = linked.urls;
      const mod = await import(linked.url);
      if (typeof mod.activate !== 'function') throw new Error(`${main} doesn't export an activate(api) function`);
      p.module = mod;
      p.state = 'running';
      let timer;
      await Promise.race([mod.activate(this.api(p)), new Promise((_, no) => { timer = setTimeout(() => no(new Error(`activate() took more than ${ACTIVATE_MS / 1000} s`)), ACTIVATE_MS); })]).finally(() => clearTimeout(timer));
      return true;
    } catch (e) {
      await this.stop(p);
      p.state = 'failed';
      p.error = e?.message || String(e);
      console.warn(`Plug-in ${p.id}:`, e);
      return false;
    }
  }
  // a plug-in's deactivate() run and all it added taken away
  async stop(p) {
    if (p.state === 'running') { try { await p.module?.deactivate?.(); } catch (e) { console.warn(`Plug-in ${p.id}: deactivate:`, e); } }
    for (const f of p.cleanups.splice(0)) { try { f(); } catch { /* gone already */ } }
    for (const u of p.urls.splice(0)) URL.revokeObjectURL(u);
    p.commands = []; p.handlers = []; p.module = null;
    if (p.state === 'running') p.state = 'off';
  }
  async setOn(p, on) {
    p.on = on;
    this.switches()[p.id] = on;
    this.save();
    // (turned on while running already: left running)
    if (on) { if (p.state !== 'running') await this.run(p); } else { await this.stop(p); p.state = 'off'; p.error = null; }
    this.refreshUI();
  }
  refreshUI() {
    const ui = this.app.ui;
    // (a plug-in tab in front that has gone: back to the first tab)
    const tabs = new Set(this.tabs(this.kind()).map((t) => t.id));
    const holder = this.app.mode === 'drawing' ? this.app.drawing : ui;
    if (holder && String(holder.cmTab || '').startsWith('plugin:') && !tabs.has(holder.cmTab)) holder.cmTab = null;
    ui.renderCommandManager?.();
  }

  // ---- what the rest of RazorCAD shows
  // the ribbon tabs of the plug-ins with commands for this kind of document: [{ id: 'plugin:<id>', label, plugin }]
  tabs(kind = this.kind()) {
    return this.list.filter((p) => p.state === 'running' && p.commands.some((c) => c !== 'sep' && c.in.includes(kind))).map((p) => ({ id: 'plugin:' + p.id, label: this.label(p), plugin: true, title: p.manifest.description || `${this.label(p)} (plug-in)` }));
  }
  // their buttons: { 'plugin:<id>': [items…] }, as the ribbons' commandDefs give theirs
  ribbonDefs(kind = this.kind()) {
    const out = {};
    for (const p of this.list) {
      if (p.state !== 'running') continue;
      const items = [];
      for (const c of p.commands) {
        if (c === 'sep') { if (items.length && items[items.length - 1] !== 'sep') items.push('sep'); continue; }
        if (c.in.includes(kind)) items.push(this.item(p, c));
      }
      while (items[items.length - 1] === 'sep') items.pop();
      if (items.length) out['plugin:' + p.id] = items;
    }
    return out;
  }
  item(p, c) { return { icon: c.icon, label: c.label, key: c.key || '', title: c.tooltip, action: () => this.exec(p, c) }; }
  // the Tools menu: Plug-ins… and each plug-in's commands for the document in front
  menuItems() {
    const kind = this.kind(), out = [{ label: 'Plug-ins…', icon: 'plugin', action: () => this.showDialog() }];
    for (const p of this.list) if (p.state === 'running') for (const c of p.commands) if (c !== 'sep' && c.in.includes(kind)) out.push({ label: `${this.label(p)} ▸ ${c.label}`, icon: c.icon, action: () => this.exec(p, c) });
    return out;
  }
  // a command run as a macro: one undo step, its errors shown
  async exec(p, c) {
    const a = this.app;
    const r = await a.macros.runFn((rc) => c.run(rc, p.apiObj), `${this.label(p)}: ${c.label}`);
    if (!r.ok) a.toast(`${this.label(p)} ▸ ${c.label}: ${r.error}`, true);
    return r;
  }
  // an event to the plug-ins listening (rebuilt, opened, saved); a listener's error doesn't stop the others
  emit(event, info) {
    for (const p of this.list) for (const h of p.handlers) if (h.event === event) {
      try { const r = h.fn(info); if (r?.catch) r.catch((e) => console.warn(`Plug-in ${p.id}: ${event}:`, e)); } catch (e) { console.warn(`Plug-in ${p.id}: ${event}:`, e); }
    }
  }

  // ---- what a plug-in is given: activate(api)
  api(p) {
    const self = this, a = this.app;
    const api = {
      id: p.id,
      manifest: JSON.parse(JSON.stringify(p.manifest)),
      razorcad: { version: this.version },
      app: a, M, S,
      // a command on the plug-in's tab: { id, label, icon (a RazorCAD icon's name, or SVG markup), tooltip, in:
      // ['part'] (and/or 'assembly', 'drawing'), run: async (rc, api) => … }
      command(def) {
        if (!def || typeof def.run !== 'function' || !String(def.label || '').trim()) throw new Error('A command needs a label and run(rc, api)');
        const kinds = (Array.isArray(def.in) ? def.in : [def.in || 'part']).filter((k) => KINDS.includes(k));
        if (!kinds.length) throw new Error(`A command's "in" is 'part', 'assembly' or 'drawing'`);
        const c = { id: String(def.id || def.label), label: String(def.label).trim(), icon: def.icon || 'plugin', tooltip: def.tooltip || def.label, in: kinds, run: def.run };
        if (p.commands.some((x) => x !== 'sep' && x.id === c.id)) throw new Error(`There is a command "${c.id}" already`);
        p.commands.push(c);
        if (self.started) self.refreshUI();
        return c.id;
      },
      separator() { p.commands.push('sep'); },
      // a command run as from its button
      run(id) { const c = p.commands.find((x) => x !== 'sep' && x.id === id); if (!c) throw new Error(`There is no command "${id}"`); return self.exec(p, c); },
      // events: 'rebuilt' (a part rebuilt: { doc, result }), 'opened' ({ path, kind }), 'saved' ({ path, kind }); off()
      on(event, fn) {
        if (!EVENTS.includes(event)) throw new Error(`There is no event "${event}" (${EVENTS.join(', ')})`);
        const h = { event, fn };
        p.handlers.push(h);
        return () => { p.handlers = p.handlers.filter((x) => x !== h); };
      },
      // something to undo when the plug-in stops (turned off, reloaded)
      onStop(fn) { p.cleanups.push(fn); },
      // values asked for: [{ key, label, type: 'number' | 'integer' | 'text' | 'select' | 'checkbox', value, unit,
      // min, max, options: [[value, label]…] | [values], hint }] → { key: value } or null; the values given last
      // offered again next time (remember: false not)
      form: (title, fields, opts = {}) => this.form(p, title, fields, opts),
      ask: (question, value = '') => a.macros.ask(question, value),
      choose: (title, html, choices) => a.ui.choose(title, 'plugin', html, choices),
      dialog: (title, body, buttons = [{ label: 'Close' }]) => a.ui.modal(title, 'plugin', typeof body === 'string' ? el('div', {}, body) : body, buttons),
      status: (msg) => a.status(String(msg)),
      toast: (msg, error = false) => a.toast(String(msg), error),
      // the plug-in's own settings, kept with RazorCAD's preferences
      settings: {
        get: (key, dflt = undefined) => { const d = self.data(p.id); return key in d ? JSON.parse(JSON.stringify(d[key])) : dflt; },
        set: (key, value) => { const d = self.data(p.id); if (value === undefined) delete d[key]; else d[key] = JSON.parse(JSON.stringify(value)); self.save(); },
        all: () => JSON.parse(JSON.stringify(self.data(p.id))),
      },
      // a file of the plug-in's own folder (text; base64 when binary, desktop only), e.g. a table of sizes
      readFile: (rel, binary = false) => platform.readPluginFile(p.id, rel, binary),
      async readJSON(rel) { return JSON.parse(await api.readFile(rel)); },
    };
    p.apiObj = api;
    return api;
  }

  // a form of values (api.form)
  form(p, title, fields, { icon: ic = 'plugin', ok = 'OK', hint = '', remember = true } = {}) {
    const a = this.app, mem = remember ? (this.data(p.id)['form:' + title] ||= {}) : {};
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const box = el('div', { class: 'dw-form plugin-form' });
      if (hint) box.appendChild(el('div', { class: 'pm-hint', style: 'margin-bottom:6px' }, esc(hint)));
      const inputs = {};
      for (const f of fields || []) {
        if (!f?.key) continue;
        const row = el('label', { class: 'pf-row' });
        const v0 = f.key in mem ? mem[f.key] : f.value;
        let inp;
        if (f.type === 'select') {
          inp = el('select');
          for (const o of f.options || []) { const [v, l] = Array.isArray(o) ? o : [o, o]; const opt = el('option', { value: String(v) }, esc(l)); if (String(v) === String(v0)) opt.selected = true; inp.appendChild(opt); }
        } else if (f.type === 'checkbox') { inp = el('input', { type: 'checkbox' }); inp.checked = !!v0; }
        else { inp = el('input', { type: 'text', spellcheck: 'false', class: f.type === 'text' ? 'pf-text' : 'pf-num' }); inp.value = v0 ?? ''; }
        inp.dataset.key = f.key;
        row.append(el('span', { class: 'pf-label' }, esc(f.label || f.key)), inp);
        if (f.unit) row.appendChild(el('span', { class: 'pf-unit' }, esc(f.unit)));
        box.appendChild(row);
        if (f.hint) box.appendChild(el('div', { class: 'pm-hint pf-hint' }, esc(f.hint)));
        inputs[f.key] = { f, inp };
      }
      const err = el('div', { class: 'pf-err' });
      box.appendChild(err);
      // the values typed, as numbers where asked (sums like 120/2 too); null, with the reason shown, if one is wrong
      const read = () => {
        const out = {};
        for (const { f, inp } of Object.values(inputs)) {
          inp.classList.remove('bad');
          if (f.type === 'checkbox') { out[f.key] = inp.checked; continue; }
          if (f.type === 'select') { const o = (f.options || []).map((x) => (Array.isArray(x) ? x[0] : x)).find((x) => String(x) === inp.value); out[f.key] = o ?? inp.value; continue; }
          if (f.type === 'text') { out[f.key] = inp.value; continue; }
          let n = NaN;
          try { n = inp.value.trim() === '' ? NaN : evaluate(inp.value, {}); } catch { n = NaN; }
          const bad = (why) => { inp.classList.add('bad'); err.textContent = `${f.label || f.key}: ${why}`; inp.focus(); return null; };
          if (!Number.isFinite(n)) return bad('type a number');
          if (f.type === 'integer' && !Number.isInteger(n)) return bad('type a whole number');
          if (f.min != null && n < f.min) return bad(`at least ${f.min}`);
          if (f.max != null && n > f.max) return bad(`at most ${f.max}`);
          out[f.key] = n;
        }
        err.textContent = '';
        return out;
      };
      const accept = () => {
        const v = read();
        if (!v) return false;
        if (remember) { Object.assign(mem, v); this.save(); }
        finish(v);
        return true;
      };
      const dlg = a.ui.modal(title, ic, box, [{ label: ok, primary: true, action: accept }, { label: 'Cancel', action: () => finish(null) }]);
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.preventDefault(); if (accept()) dlg.close(); } });
      const obs = new MutationObserver(() => { if (!document.contains(dlg.body)) { obs.disconnect(); finish(null); } });
      obs.observe(document.getElementById('modal-root'), { childList: true });
      setTimeout(() => { const first = box.querySelector('input,select'); first?.focus(); first?.select?.(); }, 0);
    });
  }

  // ---- Tools ▸ Plug-ins: the plug-ins found, turned on and off, reloaded, made and installed
  showDialog() {
    const a = this.app, ui = a.ui;
    const body = el('div', { class: 'plugins' });
    const list = el('div', { class: 'pl-list' });
    const where = platform.desktop
      ? `Plug-ins are folders in <a href="#" class="pl-folder">${esc(this.folder || 'Documents\\RazorCAD\\Plugins')}</a>: each holds a plugin.json and its JavaScript. They stay on this PC: your own plug-ins aren't shared with anyone.`
      : 'Plug-ins installed here are kept by this browser. Install… picks a plug-in\'s folder.';
    body.innerHTML = `<p class="pm-hint pl-where">${where}</p>`;
    body.appendChild(list);
    body.appendChild(el('p', { class: 'pm-hint' }, 'Plug-ins can do anything RazorCAD can (change and save files): turn on only plug-ins you trust. Help ▸ Manual ▸ Plug-ins tells how to write one.'));
    const render = () => {
      list.innerHTML = '';
      if (!this.list.length) list.appendChild(el('div', { class: 'pm-hint pl-empty' }, 'No plug-ins yet. New Plug-in… makes one to start from.'));
      for (const p of this.list) {
        const m = p.manifest || {};
        const row = el('div', { class: 'pl-row', 'data-plugin': p.id });
        const state = p.state === 'running' ? `<span class="pl-on">On: a ${esc(this.label(p))} tab${p.commands.filter((c) => c !== 'sep').length ? `, ${p.commands.filter((c) => c !== 'sep').length} command${p.commands.filter((c) => c !== 'sep').length === 1 ? '' : 's'}` : ''}</span>`
          : p.error ? `<span class="pl-err">${esc(p.error)}</span>` : '<span class="pl-off">Off</span>';
        row.innerHTML = `<label class="pl-switch" title="Turn the plug-in on or off"><input type="checkbox" ${p.on ? 'checked' : ''} ${p.error && !p.on && !p.manifest ? 'disabled' : ''}></label>
          <div class="pl-info"><div><b>${esc(m.name || p.id)}</b> <span class="pl-ver">${esc(m.version || '')}</span>${m.author ? ` <span class="pl-by">by ${esc(m.author)}</span>` : ''}</div>
          ${m.description ? `<div class="pl-desc">${esc(m.description)}</div>` : ''}<div class="pl-state">${state}</div></div>
          <div class="pl-acts">${platform.desktop ? '<button class="pm-btn pl-show" title="Its folder in Explorer">Folder</button>' : '<button class="pm-btn pl-rm">Remove</button>'}</div>`;
        const box = row.querySelector('input');
        box.onchange = async () => {
          if (box.checked) {
            const yes = await ui.choose('Turn On Plug-in', 'plugin', `<p>Turn on <b>${esc(m.name || p.id)}</b>${m.author ? ` by ${esc(m.author)}` : ''}?</p><p class="pm-hint">A plug-in can do anything RazorCAD can, including changing and saving files. Turn it on only if you trust where it came from.</p>`, [['on', 'Turn On', true], ['cancel', 'Cancel']]);
            if (yes !== 'on') { box.checked = false; return; }
          }
          box.disabled = true;
          await this.setOn(p, box.checked);
          render();
        };
        row.querySelector('.pl-show')?.addEventListener('click', () => platform.openPluginsFolder(p.id));
        row.querySelector('.pl-rm')?.addEventListener('click', async () => {
          if ((await ui.choose('Remove Plug-in', 'trash', `<p>Remove the plug-in <b>${esc(m.name || p.id)}</b> from this browser?</p>`, [['rm', 'Remove', true], ['cancel', 'Cancel']])) !== 'rm') return;
          await this.stop(p);
          await platform.removePlugin(p.id);
          delete this.switches()[p.id]; delete (this.prefs().pluginData || {})[p.id]; this.save();
          await this.reload();
          render();
        });
        list.appendChild(row);
      }
    };
    body.querySelector('.pl-folder')?.addEventListener('click', (e) => { e.preventDefault(); platform.openPluginsFolder(); });
    const added = async (id, what) => {
      if (!id) return;
      this.switches()[id] = true;
      this.save();
      await this.reload();
      render();
      const p = this.list.find((x) => x.id === id);
      a.status(p?.state === 'running' ? `${what} ${this.label(p)}: its tab is on the ribbon.` : `${what} ${id}${p?.error ? `, but it didn't start: ${p.error}` : ''}.`);
    };
    const dlg = ui.modal('Plug-ins', 'plugin', body, [
      { label: 'New Plug-in…', action: () => { this.newPlugin().then((id) => added(id, 'Made')).catch((e) => a.toast('Could not make the plug-in: ' + e.message, true)); return false; } },
      { label: 'Install…', action: () => { platform.installPlugin().then((id) => added(id, 'Installed')).catch((e) => a.toast('Could not install it: ' + e.message, true)); return false; } },
      { label: 'Reload', action: () => { this.reload().then(render); return false; } },
      { label: 'Close', primary: true },
    ]);
    render();
    return dlg;
  }

  // a new plug-in to start from: a generator of a plate with holes, on a tab of its own
  async newPlugin() {
    const name = await this.app.ui.promptText('New Plug-in', 'plugin', 'Its name (also its tab\'s):', 'My Tools');
    if (!name?.trim()) return null;
    const id = await platform.newPlugin(name.trim(), pluginTemplate(name.trim(), this.version));
    if (id && platform.desktop) platform.openPluginsFolder(id);
    return id;
  }
}

// The files of a new plug-in
export function pluginTemplate(name, version = null) {
  const manifest = { name, version: '1.0.0', description: 'My own RazorCAD tools.', author: '', main: 'main.js', tab: name };
  if (version) manifest.razorcad = String(version).replace(/-.*$/, '');
  return {
    'plugin.json': JSON.stringify(manifest, null, 2) + '\n',
    'main.js': `// ${name}: a RazorCAD plug-in. RazorCAD loads this module and calls activate(api) when the plug-in is turned on;
// its commands go on the "${name}" tab. Change it, save, then Tools ▸ Plug-ins ▸ Reload. Help ▸ Manual ▸ Plug-ins
// lists what api and rc offer.

export function activate(api) {
  api.command({
    id: 'plate',
    label: 'Plate with Holes',
    icon: 'extrude',
    tooltip: 'A new part: a plate with a hole in each corner',
    async run(rc) {
      // the sizes asked for (the ones typed last are offered again)
      const v = await api.form('Plate with Holes', [
        { key: 'width', label: 'Width', type: 'number', unit: 'mm', value: 120, min: 1 },
        { key: 'depth', label: 'Depth', type: 'number', unit: 'mm', value: 80, min: 1 },
        { key: 'thick', label: 'Thickness', type: 'number', unit: 'mm', value: 10, min: 0.1 },
        { key: 'hole', label: 'Hole diameter', type: 'number', unit: 'mm', value: 9, min: 0.1 },
        { key: 'inset', label: 'Hole inset', type: 'number', unit: 'mm', value: 10, min: 0 },
      ]);
      if (!v) return;
      await rc.newPart(\`Plate \${v.width} x \${v.depth} x \${v.thick}\`);
      const plate = await rc.sketch('top', (s) => s.centerRect(0, 0, v.width, v.depth));
      await rc.extrude(plate, v.thick);
      const holes = await rc.sketch('top', (s) => {
        for (const x of [-1, 1]) for (const y of [-1, 1]) s.circle(x * (v.width / 2 - v.inset), y * (v.depth / 2 - v.inset), v.hole / 2);
      });
      await rc.cut(holes, v.thick);
      const r = await rc.rebuild();
      api.status(r.errors.length ? \`The plate has \${r.errors.length} error(s)\` : 'Plate made.');
    },
  });
}

// (optional) when the plug-in is turned off or reloaded
export function deactivate() {}
`,
  };
}
