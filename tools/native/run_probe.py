"""Independently check a staged experimental kernel; production binaries stay untouched.
Usage: python tools/native/run_probe.py BUILD_DIRECTORY [--browser /path/to/chromium]
Requires Playwright (as does the repository test runner).
"""
import argparse
import functools
import http.server
import json
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('build_directory', type=Path)
parser.add_argument('--browser')
parser.add_argument('--resolution', type=int, choices=[16,32,64,128], default=16)
args = parser.parse_args()
build = args.build_directory.resolve()
here = Path(__file__).resolve().parent
app = here.parents[1] / 'app'

class Server(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        if path in ('/native/replicad_single.js', '/native/replicad_single.wasm'):
            return str(build / path.rsplit('/', 1)[1])
        if path.split('?')[0] == '/surface-probe.mjs':
            return str(here / 'surface-probe.mjs')
        return super().translate_path(path)

    def log_message(self, *_):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Server, directory=str(app)))
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with sync_playwright() as p:
        options = {'executable_path': args.browser} if args.browser else {'channel': 'msedge'}
        browser = p.chromium.launch(**options)
        page = browser.new_page()
        page.goto(f'http://127.0.0.1:{server.server_port}/surface-probe.mjs')
        result = page.evaluate('''(resolution) => new Promise((resolve) => {
          const worker = new Worker('/surface-probe.mjs?resolution=' + resolution, {type:'module'});
          const timer = setTimeout(() => {worker.terminate(); resolve({ok:false,error:'Native probe timed out'});},120000);
          worker.onmessage = ({data}) => {clearTimeout(timer);worker.terminate();resolve(data);};
          worker.onerror = (e) => {clearTimeout(timer);worker.terminate();resolve({ok:false,error:e.message});};
        })''', args.resolution)
        print(json.dumps(result, indent=2))
        browser.close()
finally:
    server.shutdown()
raise SystemExit(0 if result.get('ok') else 1)
