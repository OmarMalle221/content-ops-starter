"""Webhook sink for the CI check of the alert notifications (tests only, never deployed).

Accepts Alertmanager's webhook JSON on POST /<receiver> and prints one JSON line per request on
stdout: {"path": "/team", "status": "firing", "alerts": ["DfnNotificationTest"]}. The CI job reads
these lines with `docker logs`. SANDBOX: the alerts describe fictitious funds.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

MAX_BODY = 1 << 20


class Sink(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 (http.server naming)
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            self.send_response(413)
            self.end_headers()
            return
        try:
            body = json.loads(self.rfile.read(length))
            line = {
                "path": self.path,
                "status": body.get("status"),
                "receiver": body.get("receiver"),
                "alerts": sorted({a["labels"].get("alertname", "") for a in body.get("alerts", [])}),
            }
        except (ValueError, KeyError, TypeError, AttributeError):
            self.send_response(400)
            self.end_headers()
            return
        print(json.dumps(line), flush=True)
        self.send_response(200)
        self.end_headers()

    def do_GET(self):  # noqa: N802 — readiness probe
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):  # requests are reported as JSON lines only
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    HTTPServer(("0.0.0.0", port), Sink).serve_forever()
