"""Development server for RazorCAD's UI (no caching, so code edits show up on reload).

The finished application is RazorCAD.exe (see build.bat); this is only for working on the code.
"""
import http.server
import socketserver
import sys
import os

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'app'))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.wasm': 'application/wasm'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        # (cross-origin isolation: the multi-threaded geometry kernel needs it for shared memory)
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


# threaded: a browser keeps idle connections open, which would block a single-threaded server
socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer.daemon_threads = True
with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), Handler) as httpd:
    print(f'RazorCAD dev server at http://localhost:{PORT}/  (Ctrl+C to stop)')
    httpd.serve_forever()
