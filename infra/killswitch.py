"""Unlinks the project from its billing account as soon as its budget reports any cost.

Cloud Billing publishes the budget's state to Pub/Sub several times a day; a push
subscription posts each message here. Standard library only: this runs as
`python3 -c <this file>` in the stock Python image (killswitch.nix).
"""

import base64
import json
import os
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

PROJECT = os.environ["PROJECT_ID"]
# Unlink once the month's cost, after the free tier, exceeds this. 0: any charge at all.
MAX_COST = float(os.environ.get("MAX_COST", "0"))
BILLING_INFO = f"https://cloudbilling.googleapis.com/v1/projects/{PROJECT}/billingInfo"
TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"


def log(severity, message, **fields):
    print(json.dumps({"severity": severity, "message": message, **fields}), flush=True)


def call(url, method="GET", body=None, token=None):
    headers = {"Metadata-Flavor": "Google"} if token is None else {"Authorization": f"Bearer {token}"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    with urllib.request.urlopen(urllib.request.Request(url, data, headers, method=method), timeout=30) as res:
        return json.load(res)


def should_unlink(notification):
    """The budget notification's cost, and whether it is over the limit."""
    cost = float(notification["costAmount"])
    return cost, cost > MAX_COST


def handle(envelope):
    notification = json.loads(base64.b64decode(envelope["message"]["data"]))
    cost, over = should_unlink(notification)
    if not over:
        log("INFO", "within budget", cost=cost, currency=notification.get("currencyCode"))
        return
    token = call(TOKEN_URL)["access_token"]
    if not call(BILLING_INFO, token=token).get("billingEnabled"):
        log("INFO", "billing already unlinked", cost=cost)
        return
    log("ALERT", "cost over the limit: unlinking billing", cost=cost, limit=MAX_COST)
    call(BILLING_INFO, method="PUT", body={"billingAccountName": ""}, token=token)
    log("ALERT", "billing unlinked", project=PROJECT)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            handle(json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))))
            self.send_response(204)
        except Exception as err:  # noqa: BLE001 -- anything: answer 500 so Pub/Sub retries
            log("ERROR", "failed", error=repr(err))
            self.send_response(500)
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    HTTPServer(("", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
