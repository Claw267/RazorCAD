// Crash reporting for the user interface and the geometry kernel. Errors are sent to the
// desktop shell, which writes a report folder (report.json + session.log + part.rcad)
// to %APPDATA%\RazorCAD\crashes. A trail of recent actions ("breadcrumbs") goes with it.
import { platform } from './platform.js';

Error.stackTraceLimit = 50;

const crumbs = [];
const seen = new Set();
let reports = 0;
let partTimer = null;

// Record an action in the session log (kept with any crash report).
export function breadcrumb(msg) {
  crumbs.push(`${new Date().toISOString().slice(11, 23)}  ${msg}`);
  if (crumbs.length > 150) crumbs.shift();
  platform.logEvent(msg).catch?.(() => {});
}

// Keep a recent copy of the open part with the session (at most every 30 s), so a report
// about a crash that killed the program can still include it.
export function rememberPart(app, now = false) {
  if (now) { clearTimeout(partTimer); partTimer = null; send(app); return; }
  if (partTimer) return;
  partTimer = setTimeout(() => { partTimer = null; send(app); }, 30000);
}
function send(app) {
  try { platform.rememberPart(JSON.stringify(app.doc)).catch?.(() => {}); } catch { /* ignore */ }
}

function appState(app) {
  if (!app) return null;
  try {
    return {
      mode: app.mode, pm: app.pm?.kind || null, feature: app.pm?.feature ? `${app.pm.feature.type} (${app.pm.feature.name})` : null,
      sketchTool: app.mode === 'sketch' ? app.sketcher?.tool : null, selection: app.selection?.kind || null,
      part: app.doc?.name, file: app.filePath || null, features: app.doc?.features?.length, bodies: app.result?.bodies?.length,
      featureErrors: app.result?.errors ? [...app.result.errors].slice(0, 20) : [], filters: app.filters ? [...app.filters] : [],
      viewport: app.viewport ? { width: app.viewport.width, height: app.viewport.height, style: app.viewport.displayStyle } : null,
    };
  } catch (e) {
    return { error: 'could not read the app state: ' + e.message };
  }
}

// Write a crash report. kind: ui-error | ui-unhandled-rejection | kernel-error | kernel-worker-crash ...
export async function reportError(kind, err, app, extra = {}) {
  const message = String(err?.message || err || 'Unknown error');
  const stack = [err?.stack, err?.workerStack ? 'Geometry kernel (worker):\n' + err.workerStack : null].filter(Boolean).join('\n\n');
  const key = `${kind}|${message}|${stack.slice(0, 300)}`;
  if (seen.has(key) || reports >= 20) return null; // no floods of identical reports
  seen.add(key);
  reports++;
  breadcrumb(`ERROR (${kind}): ${message}`);
  let part = null;
  try { part = app?.doc ? JSON.stringify(app.doc, null, 1) : null; } catch { /* ignore */ }
  try { const k = await app?.kernel?.stats?.(); if (k) extra = { ...extra, kernel: k }; } catch { /* ignore */ }
  try {
    const where = await platform.reportError({ kind, message, stack, breadcrumbs: crumbs.slice(-100), state: appState(app), extra, userAgent: navigator.userAgent, uiTime: new Date().toISOString(), part });
    app?.crashReported?.(where, kind, message);
    return where;
  } catch (e) {
    console.error('Could not write a crash report', e, err);
    return null;
  }
}

// Errors nobody caught: report them.
export function installCrashHandlers(app) {
  window.addEventListener('error', (e) => {
    const msg = String(e.message || '');
    if (/ResizeObserver loop/.test(msg)) return; // harmless browser notice
    reportError('ui-error', e.error || msg, app, { source: e.filename, line: e.lineno, column: e.colno });
  });
  window.addEventListener('unhandledrejection', (e) => reportError('ui-unhandled-rejection', e.reason, app));
}
