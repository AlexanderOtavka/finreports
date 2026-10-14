"""The kill switch's decisions, without Google: `call` is replaced. Run by `nix flake check`
(the killswitch check) as `python3 -m unittest killswitch_test`, in this directory."""

import base64
import json
import os
import unittest
from unittest import mock

os.environ.setdefault("PROJECT_ID", "finreports-test")
import killswitch  # noqa: E402 -- reads PROJECT_ID on import


def envelope(**notification):
    return {"message": {"data": base64.b64encode(json.dumps(notification).encode()).decode()}}


class KillSwitch(unittest.TestCase):
    def setUp(self):
        self.calls = []

        def call(url, method="GET", body=None, token=None):
            self.calls.append((method, url, body, token))
            return {"access_token": "token"}

        patcher = mock.patch.object(killswitch, "call", call)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_nothing_at_zero(self):
        killswitch.handle(envelope(costAmount=0, budgetAmount=1, currencyCode="USD"))
        self.assertEqual(self.calls, [])

    def test_unlinks_at_any_cost(self):
        killswitch.handle(envelope(costAmount=0.01, budgetAmount=1, currencyCode="USD"))
        self.assertEqual(
            self.calls,
            [
                ("GET", killswitch.TOKEN_URL, None, None),
                (
                    "PUT",
                    "https://cloudbilling.googleapis.com/v1/projects/finreports-test/billingInfo",
                    {"billingAccountName": ""},
                    "token",
                ),
            ],
        )

    def test_bad_message_raises(self):
        # The handler answers 500 for this, so that Pub/Sub retries.
        with self.assertRaises(Exception):
            killswitch.handle({"message": {"data": "not base64 json"}})


if __name__ == "__main__":
    unittest.main()
