"""RazorCAD regression tests: rebuilds the test parts with the real geometry kernel and runs a few UI
checks, in headless Microsoft Edge, then compares the results with tests/expected.json.

    python tests/run_tests.py                 run everything, compare, exit code 1 on any failure
    python tests/run_tests.py --update        run and store the results as the new expected ones
    python tests/run_tests.py --make-parts    rebuild tests/parts/*.rcad from tests/make_parts.js first
    python tests/run_tests.py --only NAME ... run just these parts / UI tests

Needs Python's playwright package (pip install playwright); it uses the Edge already on the PC.
"""
import argparse
import functools
import http.server
import json
import math
import os
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


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.wasm': 'application/wasm'}

    def translate_path(self, path):
        p = path.split('?', 1)[0].split('#', 1)[0]
        if p.startswith('/tests/'):
            return os.path.join(HERE, *p[len('/tests/'):].split('/'))
        return super().translate_path(path)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--update', action='store_true')
    ap.add_argument('--make-parts', action='store_true')
    ap.add_argument('--only', nargs='*')
    ap.add_argument('--headed', action='store_true', help='show the browser window')
    args = ap.parse_args()
    try: sys.stdout.reconfigure(encoding='utf-8')
    except Exception: pass

    from playwright.sync_api import sync_playwright
    httpd = serve()
    url = f'http://127.0.0.1:{httpd.server_address[1]}/index.html'
    console_errors = []
    t0 = time.time()
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=not args.headed)
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
        for v in merged['parts'].values():
            for c in v.values():
                if isinstance(c, dict):
                    c.pop('ms', None)
        with open(EXPECTED, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(merged, f, indent=1)
            f.write('\n')
        print(f'\nexpected.json updated ({len(results["parts"])} parts).')
    print(f'\n{"ALL PASSED" if not failures else f"{failures} FAILED"}  ({time.time() - t0:.0f} s)')
    sys.exit(1 if failures and not args.update else 0)


if __name__ == '__main__':
    main()
