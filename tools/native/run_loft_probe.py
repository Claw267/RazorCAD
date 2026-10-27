"""Check guided spline lofts through the real worker with staged kernel artifacts.
Usage: python tools/native/run_loft_probe.py BUILD_DIRECTORY [--multi] [--require-lifetime-hooks]
Requires Playwright (as does the repository test runner).
"""
import argparse
import functools
import http.server
import json
import sys
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('build_directory', type=Path)
parser.add_argument('--browser')
parser.add_argument('--multi',action='store_true')
parser.add_argument('--hard-cases',action='store_true')
parser.add_argument('--require-lifetime-hooks',action='store_true')
args = parser.parse_args()
build = args.build_directory.resolve()
here = Path(__file__).resolve().parent
app = here.parents[1] / 'app'

class Server(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/favicon.ico":
            self.send_response(204);self.end_headers();return
        if self.path.split('?')[0] == '/js/kernel.worker.js':
            source=(app/'js/kernel.worker.js').read_text(encoding='utf-8')
            source=source.replace('new URL(`../vendor/replicad/${KERNEL_BUILD}.wasm`, import.meta.url)', "new URL(`/native/${KERNEL_BUILD}.wasm`, import.meta.url)")
            source=source.replace('import(`../vendor/replicad/${KERNEL_BUILD}.js`)', "import(`/native/${KERNEL_BUILD}.js`)")
            payload=source.encode();self.send_response(200);self.send_header('Content-Type','application/javascript');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload);return
        super().do_GET()

    def translate_path(self, path):
        if path.split('?')[0] == '/tests/loft-g2-cases.js':
            return str(app.parent/'tests/loft-g2-cases.js')
        if path in ('/native/replicad_single.js','/native/replicad_single.wasm','/native/replicad_multi.js','/native/replicad_multi.wasm'):
            return str(build / path.rsplit('/', 1)[1])
        if path.split('?')[0] == '/loft-probe.mjs':
            return str(here / ('hard-loft-probe.mjs' if args.hard_cases else 'loft-probe.mjs'))
        return super().translate_path(path)

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy','same-origin')
        self.send_header('Cross-Origin-Embedder-Policy','require-corp')
        super().end_headers()

    def log_message(self, *_):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Server, directory=str(app)))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as p:
        options = {'executable_path': args.browser} if args.browser else {'channel': 'msedge'}
        browser = p.chromium.launch(**options)
        page = browser.new_page()
        page.on('console',lambda m: print(m.text,flush=True,file=sys.stderr) if m.type in ('error','warning') else None)
        page.goto(f'http://127.0.0.1:{server.server_port}/loft-probe.mjs')
        page.set_content('<script type="importmap">{"imports":{"three":"/vendor/three.module.js","three-mesh-bvh":"/vendor/three-mesh-bvh.module.js"}}</script>')
        result=page.evaluate("(options)=>import('/loft-probe.mjs').then(m=>m.run(options))", {"threads":2 if args.multi else 1,"requireLifetime":args.require_lifetime_hooks})
        print(json.dumps(result, indent=2))
        browser.close()
finally:
    server.shutdown()
raise SystemExit(0 if result.get('ok') else 1)
