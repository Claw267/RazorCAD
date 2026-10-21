"""RazorCAD regression tests: rebuilds the test parts with the real geometry kernel and runs a few UI
checks, in headless Microsoft Edge, then compares the results with tests/expected.json.

    python tests/run_tests.py                 run everything, compare, exit code 1 on any failure
    python tests/run_tests.py --update        run and store the results as the new expected ones
    python tests/run_tests.py --make-parts    rebuild tests/parts/*.rcad from tests/make_parts.js first
    python tests/run_tests.py --only NAME ... run just these parts / UI tests
    python tests/run_tests.py --perf          also list every test's time against its usual time
    python tests/run_tests.py --perf-strict   exit code 1 when something got slower too

Every run's times (part rebuilds, drawings, UI tests) are kept in tests/perf-history.json, per machine (the last
10 of each; not in git): a test markedly slower than its usual time (the median of those, 1.5x and 300 ms more)
is reported under Performance.

Needs Python's playwright package (pip install playwright); it uses the Edge already on the PC.
"""
import argparse
import functools
import http.server
import json
import math
import os
import platform
import statistics
import socketserver
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
APP = os.path.join(ROOT, 'app')
PARTS = os.path.join(HERE, 'parts')
EXPECTED = os.path.join(HERE, 'expected.json')
REL = 1e-6  # relative tolerance for volumes, areas and flat sizes
PERF = os.path.join(HERE, 'perf-history.json')
PERF_RUNS, PERF_MIN_RUNS = 10, 3   # times kept per test; runs needed before a time is judged
SLOW_RATIO, SLOW_MS = 1.5, 300     # slower than usual: this many times the median, and this much more


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.wasm': 'application/wasm'}

    def translate_path(self, path):
        p = path.split('?', 1)[0].split('#', 1)[0]
        if p.startswith('/tests/'):
            return os.path.join(HERE, *p[len('/tests/'):].split('/'))
        return super().translate_path(path)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        # (cross-origin isolation: the multi-threaded geometry kernel needs it for shared memory)
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def serve():
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.daemon_threads = True
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Handler, directory=APP))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def same_num(a, b):
    if a is None or b is None:
        return a is b
    return math.isclose(a, b, rel_tol=REL, abs_tol=1e-6)


def compare(name, got, want):
    """Differences between a part's results and the expected ones (list of strings)."""
    diffs = []
    if 'crash' in got:
        return [f'crashed: {got["crash"]}']
    for cfg, w in want.items():
        g = got.get(cfg)
        if g is None:
            diffs.append(f'{cfg}: not built')
            continue
        if g['errors'] != w['errors']:
            diffs.append(f'{cfg}: errors {g["errors"]} (expected {w["errors"]})')
        if len(g['bodies']) != len(w['bodies']):
            diffs.append(f'{cfg}: {len(g["bodies"])} bodies (expected {len(w["bodies"])})')
            continue
        for i, (gb, wb) in enumerate(zip(g['bodies'], w['bodies'])):
            for k in ('kind', 'faces', 'edges'):
                if gb.get(k) != wb.get(k):
                    diffs.append(f'{cfg} body {i + 1}: {k} {gb.get(k)} (expected {wb.get(k)})')
            for k in ('volume', 'area'):
                if not same_num(gb.get(k), wb.get(k)):
                    diffs.append(f'{cfg} body {i + 1}: {k} {gb.get(k)} (expected {wb.get(k)})')
            if 'flat' in wb or 'flat' in gb:
                gf, wf = gb.get('flat') or {}, wb.get('flat') or {}
                if gf.get('bends') != wf.get('bends') or not all(same_num(x, y) for x, y in zip(gf.get('size', []), wf.get('size', []))):
                    diffs.append(f'{cfg} body {i + 1}: flat pattern {gf} (expected {wf})')
    for cfg in got:
        if cfg not in want:
            diffs.append(f'{cfg}: new configuration (not in expected.json)')
    return diffs


def compare_drawing(got, want):
    """Differences between a part's drawing views and the expected ones (line counts exact, sizes to REL)."""
    if 'crash' in got:
        return [f'crashed: {got["crash"]}']
    diffs = []
    for vid, w in want.items():
        g = got.get(vid)
        if g is None:
            diffs.append(f'{vid}: no view')
        elif g.get('error') or w.get('error'):
            if g.get('error') != w.get('error'):
                diffs.append(f'{vid}: error {g.get("error")} (expected {w.get("error")})')
        else:
            if g['counts'] != w['counts']:
                diffs.append(f'{vid}: lines {g["counts"]} (expected {w["counts"]})')
            gs, ws = g.get('size') or [], w.get('size') or []
            if len(gs) != len(ws) or not all(same_num(x, y) for x, y in zip(gs, ws)):
                diffs.append(f'{vid}: size {gs} (expected {ws})')
    for vid in got:
        if vid not in want:
            diffs.append(f'{vid}: new view (not in expected.json)')
    return diffs


def machine():
    """This PC (times are only compared with its own)."""
    return f'{platform.node()}|{platform.processor() or platform.machine()}|{os.cpu_count()}'


def timings(results):
    """Every timed test: {key: ms} (parts per configuration, drawings, UI tests)."""
    out = {}
    for name, got in results.get('parts', {}).items():
        for cfg, v in got.items():
            if isinstance(v, dict) and isinstance(v.get('ms'), (int, float)):
                out[f'part:{name}/{cfg}'] = v['ms']
    for name, got in results.get('drawings', {}).items():
        if isinstance(got, dict) and isinstance(got.get('ms'), (int, float)):
            out[f'drawing:{name}'] = got['ms']
    for name, r in results.get('ui', {}).items():
        if isinstance(r.get('ms'), (int, float)):
            out[f'ui:{name}'] = r['ms']
    return out


def perf_report(times, total_s, show_all=False, whole=True):
    """This run's times against the usual ones (printed), and stored. Returns the number markedly slower."""
    hist = {}
    if os.path.exists(PERF):
        try:
            with open(PERF, encoding='utf-8') as f:
                hist = json.load(f)
        except (OSError, ValueError):
            hist = {}
    mine = hist.setdefault(machine(), {})
    rows, slower = [], []
    for key, ms in sorted(times.items()):
        past = mine.get(key, [])
        usual = statistics.median(past) if len(past) >= PERF_MIN_RUNS else None
        rows.append((key, ms, usual))
        if usual is not None and ms > usual * SLOW_RATIO and ms - usual > SLOW_MS:
            slower.append((key, ms, usual))
        mine[key] = (past + [round(ms)])[-PERF_RUNS:]
    # (the whole run's time: only from full runs)
    tot = mine.get('_total_s', [])
    usual_total = statistics.median(tot) if len(tot) >= PERF_MIN_RUNS and whole else None
    if whole:
        mine['_total_s'] = (tot + [round(total_s, 1)])[-PERF_RUNS:]
    try:
        with open(PERF, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(hist, f, indent=1)
            f.write('\n')
    except OSError:
        pass
    judged = sum(1 for _, _, u in rows if u is not None)
    print(f'\nPerformance ({len(rows)} timed; {judged} against their usual times):')
    if show_all:
        for key, ms, usual in rows:
            print(f'  {key:44} {ms:8.0f} ms' + (f'   usual {usual:.0f} ms ({ms / usual:.2f}x)' if usual else '   (no history yet)'))
    for key, ms, usual in slower:
        print(f'  SLOWER  {key:40} {ms:.0f} ms, usually {usual:.0f} ms ({ms / usual:.1f}x)')
    if not slower:
        print('  no slowdowns' if judged else f'  (no history yet: times are compared after {PERF_MIN_RUNS} runs)')
    slowest = sorted(rows, key=lambda r: -r[1])[:3]
    print('  slowest: ' + ', '.join(f'{k} {ms / 1000:.1f} s' for k, ms, _ in slowest))
    if usual_total:
        print(f'  whole run {total_s:.0f} s (usually {usual_total:.0f} s)')
    return len(slower)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--update', action='store_true')
    ap.add_argument('--make-parts', action='store_true')
    ap.add_argument('--only', nargs='*')
    ap.add_argument('--headed', action='store_true', help='show the browser window')
    ap.add_argument('--perf', action='store_true', help='list every test time against its usual time')
    ap.add_argument('--perf-strict', action='store_true', help='fail when something got markedly slower')
    args = ap.parse_args()
    try: sys.stdout.reconfigure(encoding='utf-8')
    except Exception: pass

    from playwright.sync_api import sync_playwright
    httpd = serve()
    url = f'http://127.0.0.1:{httpd.server_address[1]}/index.html'
    console_errors = []
    t0 = time.time()
    with sync_playwright() as p:
        # (on a CI machine with no graphics card, WebGL needs the software renderer allowed)
        ci_args = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] if os.environ.get('CI') else []
        browser = p.chromium.launch(channel='msedge', headless=not args.headed, args=ci_args)
        page = browser.new_page(viewport={'width': 1400, 'height': 900})
        page.on('console', lambda m: console_errors.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: console_errors.append(str(e)))
        # (a fresh browser is a first run: no Getting Started Tour over the tests)
        page.add_init_script("try { const p = JSON.parse(localStorage.getItem('razorcad.prefs') || '{}'); p.tourDone = true; localStorage.setItem('razorcad.prefs', JSON.stringify(p)); } catch (e) {}")
        page.goto(url)
        page.wait_for_function("window.app && window.app.doc && !window.app.kernel.pending && document.querySelector('#status-msg')?.textContent === 'Ready'", timeout=180000)

        if args.make_parts:
            os.makedirs(PARTS, exist_ok=True)
            made = page.evaluate("async () => (await import('/tests/make_parts.js')).makeParts().map((x) => ({ name: x.name, json: JSON.stringify(x.doc, null, 1) }))")
            for m in made:
                with open(os.path.join(PARTS, m['name'] + '.rcad'), 'w', encoding='utf-8', newline='\n') as f:
                    f.write(m['json'] + '\n')
            print(f'made {len(made)} test parts')

        parts = []
        for n in sorted(os.listdir(PARTS)):
            if n.endswith('.rcad'):
                with open(os.path.join(PARTS, n), encoding='utf-8') as f:
                    parts.append({'name': n[:-5], 'json': f.read()})
        page.set_default_timeout(0)
        results = page.evaluate("async ([parts, only]) => (await import('/tests/suite.js')).run(parts, only)", [parts, args.only])
        browser.close()
    httpd.shutdown()

    perf_times = timings(results)
    expected = {}
    if os.path.exists(EXPECTED):
        with open(EXPECTED, encoding='utf-8') as f:
            expected = json.load(f)
    failures = 0
    print(f'\nParts ({len(results["parts"])}):')
    for name, got in results['parts'].items():
        times = ', '.join(f'{v.get("ms", "?")} ms' for v in got.values() if isinstance(v, dict))
        if args.update:
            print(f'  {name:24} recorded ({times})')
            continue
        want = expected.get('parts', {}).get(name)
        diffs = ['not in expected.json (run with --update)'] if want is None else compare(name, got, want)
        print(f'  {"PASS" if not diffs else "FAIL"}  {name:24} {times}')
        for d in diffs:
            print(f'        {d}')
        failures += bool(diffs)
    drawings = results.get('drawings', {})
    if drawings:
        print(f'\nDrawings ({len(drawings)}):')
    for name, got in drawings.items():
        ms = got.pop('ms', '?') if isinstance(got, dict) else '?'
        if args.update:
            print(f'  {name:24} recorded ({ms} ms)')
            continue
        want = expected.get('drawings', {}).get(name)
        diffs = ['not in expected.json (run with --update)'] if want is None else compare_drawing(got, want)
        print(f'  {"PASS" if not diffs else "FAIL"}  {name:24} {ms} ms')
        for d in diffs:
            print(f'        {d}')
        failures += bool(diffs)
    print(f'\nUI ({len(results["ui"])}):')
    for name, r in results['ui'].items():
        print(f'  {"PASS" if r.get("ok") else "FAIL"}  {name:24} {r.get("ms", "?")} ms  {r.get("detail", "")}')
        failures += not r.get('ok')
    if console_errors:
        print(f'\nBrowser console errors ({len(console_errors)}):')
        for e in console_errors[:20]:
            print('  ' + e[:300])
    if args.update:
        merged = dict(expected)
        merged.setdefault('parts', {})
        merged['parts'].update(results['parts'])
        merged.setdefault('drawings', {})
        merged['drawings'].update(drawings)
        for v in merged['parts'].values():
            for c in v.values():
                if isinstance(c, dict):
                    c.pop('ms', None)
        with open(EXPECTED, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(merged, f, indent=1)
            f.write('\n')
        print(f'\nexpected.json updated ({len(results["parts"])} parts, {len(drawings)} drawings).')
    slower = perf_report(perf_times, time.time() - t0, args.perf, whole=not args.only)
    if args.perf_strict and slower:
        failures += slower
    print(f'\n{"ALL PASSED" if not failures else f"{failures} FAILED"}  ({time.time() - t0:.0f} s)')
    sys.exit(1 if failures and not args.update else 0)


if __name__ == '__main__':
    main()
