#!/usr/bin/env python3
import os
import http.server
import socketserver

PORT = 8080
GOOGLE_API_KEY = os.environ.get('GOOGLE_MAPS_API_KEY', '')

class InjectingHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
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
