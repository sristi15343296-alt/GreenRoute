#!/usr/bin/env python
"""Startup validation tests for Green Route backend.
These tests ensure that the application aborts early when configuration invariants are violated:
- Telemetry burst capacity must be >= telemetry.MAX_BATCH.
- Legacy unit token acceptance must be disabled in production.
"""
import os
import unittest

# Helper to import the Flask app after setting env vars.
def import_app():
    """Import the backend app module, ensuring a fresh import each call."""
    import importlib, sys
    if "app" in sys.modules:
        del sys.modules["app"]
    return importlib.import_module("app")

class StartupValidationTests(unittest.TestCase):
    def setUp(self):
        # Preserve original environment.
        self.orig_env = dict(os.environ)
        # Ensure defaults.
        os.environ.pop("GREENROUTE_ENV", None)
        os.environ.pop("GREENROUTE_TELEMETRY_BURST", None)
        os.environ.pop("GREENROUTE_ALLOW_LEGACY_UNIT_TOKENS", None)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.orig_env)

    def test_burst_less_than_max_batch_fails(self):
        # Set burst below telemetry.MAX_BATCH (which is 60 per code).
        os.environ["GREENROUTE_TELEMETRY_BURST"] = "30"
        with self.assertRaises(RuntimeError):
            import_app()

    def test_burst_equal_or_greater_passes(self):
        os.environ["GREENROUTE_TELEMETRY_BURST"] = "60"
        app = import_app()
        self.assertIsNotNone(app)

    def test_production_with_legacy_tokens_fails(self):
        os.environ["GREENROUTE_ENV"] = "production"
        os.environ["GREENROUTE_ALLOW_LEGACY_UNIT_TOKENS"] = "true"
        os.environ["GREENROUTE_TELEMETRY_BURST"] = "60"
        with self.assertRaises(RuntimeError):
            import_app()

    def test_production_without_legacy_tokens_passes(self):
        os.environ["GREENROUTE_ENV"] = "production"
        os.environ["GREENROUTE_ALLOW_LEGACY_UNIT_TOKENS"] = "false"
        os.environ["GREENROUTE_TELEMETRY_BURST"] = "60"
        app = import_app()
        self.assertIsNotNone(app)

if __name__ == "__main__":
    unittest.main()
