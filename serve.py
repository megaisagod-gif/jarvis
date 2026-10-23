"""Run JARVIS locally on this computer:  python serve.py  ->  http://localhost:8765"""
import functools, http.server, os, threading, webbrowser

PORT = 8765
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.dirname(os.path.abspath(__file__)))
server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
print(f"J.A.R.V.I.S. online at http://localhost:{PORT}  (Ctrl+C to stop)")
if not os.environ.get("JARVIS_NO_BROWSER"):
    threading.Timer(0.8, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()
try:
    server.serve_forever()
except KeyboardInterrupt:
    print("\nGoodbye, sir.")
