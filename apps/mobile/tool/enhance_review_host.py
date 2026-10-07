"""Host helper for integration_test/enhance_review_test.dart.

usage: python3 -I tool/enhance_review_host.py <books-dir> <out-dir> <prefix> [port]

Serves <books-dir>/<name>.epub (nobs, llm, ladr3e, sampler; private local
copies, never committed), saves screenshots as <out-dir>/<prefix>-<name>.png
and keeps carried highlight locators in <out-dir>/carry-<book>.json.

Screenshots come from the iOS simulator in SIM_UDID (default: booted), or
from adb when PLATFORM=android (the emulator reaches the host at 10.0.2.2).
"""
import http.server
import os
import subprocess
import sys
import urllib.parse

BOOKS, OUT, PREFIX = sys.argv[1], sys.argv[2], sys.argv[3]
PORT = int(sys.argv[4]) if len(sys.argv) > 4 else 8931
UDID = os.environ.get('SIM_UDID', 'booted')
ADB = os.path.expanduser('~/Library/Android/sdk/platform-tools/adb')
os.makedirs(OUT, exist_ok=True)


def safe(s):
    return ''.join(c for c in s if c.isalnum() or c in '-_')


class Handler(http.server.BaseHTTPRequestHandler):
    def reply(self, code, body=b'', ctype='text/plain'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        parts = url.path.strip('/').split('/')
        query = urllib.parse.parse_qs(url.query)
        if parts[0] == 'books' and len(parts) == 2:
            path = os.path.join(BOOKS, safe(parts[1].removesuffix('.epub')) + '.epub')
            if not os.path.exists(path):
                return self.reply(404, b'missing')
            with open(path, 'rb') as f:
                return self.reply(200, f.read(), 'application/epub+zip')
        if parts[0] == 'shot' and len(parts) == 2:
            dest = os.path.join(OUT, f'{PREFIX}-{safe(parts[1])}.png')
            if os.environ.get('PLATFORM') == 'android':
                with open(dest, 'wb') as out:
                    r = subprocess.run([ADB, 'exec-out', 'screencap', '-p'], stdout=out)
            else:
                r = subprocess.run(['xcrun', 'simctl', 'io', UDID, 'screenshot', dest], capture_output=True)
            print(f'SHOT {dest} rc={r.returncode}', flush=True)
            return self.reply(200 if r.returncode == 0 else 500, dest.encode())
        if parts[0] in ('put', 'get'):
            path = os.path.join(OUT, safe(query.get('k', [''])[0]) + '.json')
            if parts[0] == 'put':
                with open(path, 'w') as f:
                    f.write(query.get('v', [''])[0])
                return self.reply(200, b'ok')
            body = open(path, 'rb').read() if os.path.exists(path) else b''
            return self.reply(200, body)
        if parts[0] == 'log':
            print(f"LOG {query.get('m', [''])[0]}", flush=True)
            return self.reply(200, b'ok')
        return self.reply(404, b'?')

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
