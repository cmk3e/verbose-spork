"""Zero-dependency web dashboard: live countdowns, tote movement, tickets."""

import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

log = logging.getLogger("tote_handicapper")
DASHBOARD = Path(__file__).with_name("dashboard.html")


def make_handler(scheduler):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in ("/", "/index.html"):
                self._send(200, DASHBOARD.read_bytes(), "text/html; charset=utf-8")
            elif path == "/api/state":
                body = json.dumps(scheduler.snapshot(), default=str).encode()
                self._send(200, body, "application/json")
            elif path.startswith("/api/tickets/") and path.endswith(".txt"):
                race_id = path[len("/api/tickets/"):-4]
                state = scheduler.races.get(race_id)
                if state and state.ticket_text:
                    self._send(200, state.ticket_text.encode(), "text/plain; charset=utf-8")
                else:
                    self._send(404, b"no tickets yet", "text/plain")
            else:
                self._send(404, b"not found", "text/plain")

        def log_message(self, fmt, *args):
            log.debug("web: " + fmt, *args)

    return Handler


def serve(scheduler, host: str = "127.0.0.1", port: int = 8000) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), make_handler(scheduler))
    log.info("dashboard on http://%s:%d", host, port)
    return server
