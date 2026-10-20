"""Local-only reference preview; no application integrations or dependencies."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--host', default='0.0.0.0')
p.add_argument('--port', type=int, default=4173)
p.add_argument('--strictPort', action='store_true')
a=p.parse_args()
ThreadingHTTPServer((a.host,a.port),partial(SimpleHTTPRequestHandler,directory=str(Path(__file__).resolve().parent))).serve_forever()
