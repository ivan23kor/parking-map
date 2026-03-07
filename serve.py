#!/usr/bin/env python3
import os
import http.server
import socketserver

PORT = 8080
GOOGLE_API_KEY = os.environ.get('GOOGLE_MAPS_API_KEY', '')
LEGACY_UI_PATHS = ('/ui-map', '/ui-panorama', '/ui-upload', '/dist')

class InjectingHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        if self.path == '/' or self.path.endswith('.html') or self.path == '/env.js':
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        super().end_headers()

    def do_GET(self):
        if any(self.path == path or self.path.startswith(f'{path}/') for path in LEGACY_UI_PATHS):
            self.send_response(404)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Clear-Site-Data', '"cache"')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            self.end_headers()
            self.wfile.write(b'Not found')
            return

        if self.path == '/env.js':
            # Serve the env vars as JavaScript
            self.send_response(200)
            self.send_header('Content-Type', 'application/javascript')
            self.end_headers()
            self.wfile.write(f'window.env = {{GOOGLE_MAPS_API_KEY: "{GOOGLE_API_KEY}"}};'.encode('utf-8'))
            return
        super().do_GET()

if __name__ == '__main__':
    with socketserver.TCPServer(('', PORT), InjectingHTTPRequestHandler) as httpd:
        print(f'Serving at http://localhost:{PORT}')
        httpd.serve_forever()
