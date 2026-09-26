"""Exercise the exact patched pinned Hermes hook dispatcher in a built image.

Run this read-only against the opt-in overlay image; no provider or broker runs.
"""
from __future__ import annotations

import os
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from hermes_cli.plugins_dispatch import PluginDispatchMixin, _HOOK_SKIPPED


class Probe(PluginDispatchMixin):
    def __init__(self) -> None:
        self._hook_timeout_lock = threading.Lock()
        self._hook_running_callbacks = {}
        self._hook_timeout_suppressed_until = {}
        self._hook_timeout_suppression_seconds = 60.0

    @staticmethod
    def _invoke_hook_callback(callback, payload):
        return callback(**payload)


class HookSerializationTest(unittest.TestCase):
    def test_two_fast_concurrent_policy_calls_each_evaluated_once_without_overlap(self):
        probe = Probe()
        started = threading.Event()
        release = threading.Event()
        state_lock = threading.Lock()
        calls = 0
        running = 0
        maximum = 0

        def callback():
            nonlocal calls, running, maximum
            with state_lock:
                calls += 1
                running += 1
                maximum = max(maximum, running)
                if calls == 1:
                    started.set()
            if not release.wait(3):
                raise AssertionError("test callback release timed out")
            with state_lock:
                running -= 1
            return "allowed"

        with patch.dict(os.environ, {"MERI_HERMES_TOOL_VIEW_V1_ENABLED": "1"}):
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(probe._run_hook_callback_bounded, "pre_tool_call", callback, {}, 5.0)
                self.assertTrue(started.wait(2))
                second = pool.submit(probe._run_hook_callback_bounded, "pre_tool_call", callback, {}, 5.0)
                time.sleep(0.03)
                self.assertFalse(second.done())
                release.set()
                self.assertEqual(first.result(timeout=3), "allowed")
                self.assertEqual(second.result(timeout=3), "allowed")
        self.assertEqual(calls, 2)
        self.assertEqual(maximum, 1)

    def test_waiter_exhausts_its_own_deadline_and_fails_closed(self):
        probe = Probe()
        started = threading.Event()
        release = threading.Event()
        calls = 0

        def callback():
            nonlocal calls
            calls += 1
            started.set()
            release.wait(3)
            return "allowed"

        with patch.dict(os.environ, {"MERI_HERMES_TOOL_VIEW_V1_ENABLED": "1"}):
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(probe._run_hook_callback_bounded, "pre_tool_call", callback, {}, 5.0)
                self.assertTrue(started.wait(2))
                second = pool.submit(probe._run_hook_callback_bounded, "pre_tool_call", callback, {}, 0.05)
                self.assertIs(second.result(timeout=2), _HOOK_SKIPPED)
                self.assertEqual(calls, 1)
                release.set()
                self.assertEqual(first.result(timeout=3), "allowed")

    def test_timed_out_callback_suppresses_waiters_even_after_worker_finishes(self):
        probe = Probe()
        started = threading.Event()
        release = threading.Event()
        finished = threading.Event()
        calls = 0

        def callback():
            nonlocal calls
            calls += 1
            started.set()
            release.wait(3)
            finished.set()
            return "too late"

        with patch.dict(os.environ, {"MERI_HERMES_TOOL_VIEW_V1_ENABLED": "1"}):
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(probe._run_hook_callback_bounded, "pre_tool_call", callback, {}, 0.05)
                self.assertTrue(started.wait(2))
                self.assertIs(first.result(timeout=2), _HOOK_SKIPPED)
                second = pool.submit(probe._run_hook_callback_bounded, "pre_tool_call", callback, {}, 0.2)
                self.assertIs(second.result(timeout=2), _HOOK_SKIPPED)
                release.set()
                self.assertTrue(finished.wait(2))
                self.assertIs(probe._run_hook_callback_bounded("pre_tool_call", callback, {}, 0.2), _HOOK_SKIPPED)
        self.assertEqual(calls, 1)

    def test_late_completion_is_rejected_even_if_done_wait_reports_true(self):
        """Simulate a delayed waiter reacquiring after callback completion."""
        probe = Probe()
        real_event = threading.Event
        created = 0

        class LateDoneEvent(real_event):
            def __init__(self):
                nonlocal created
                super().__init__()
                created += 1
                self.ordinal = created

            def wait(self, timeout=None):
                if self.ordinal == 2 and timeout is not None:
                    super().wait(timeout + 0.1)
                    return self.is_set()
                return super().wait(timeout)

        def callback():
            time.sleep(0.04)
            return "late allow must not be accepted"

        with patch.dict(os.environ, {"MERI_HERMES_TOOL_VIEW_V1_ENABLED": "1"}):
            with patch.object(threading, "Event", LateDoneEvent):
                result = probe._run_hook_callback_bounded("pre_tool_call", callback, {}, 0.01)
        self.assertIs(result, _HOOK_SKIPPED)
        self.assertTrue(probe._hook_timeout_suppressed_until)

    def test_feature_disabled_preserves_immediate_second_call_skip(self):
        probe = Probe()
        started = threading.Event()
        release = threading.Event()

        def callback():
            started.set()
            release.wait(3)
            return "allowed"

        with patch.dict(os.environ, {"MERI_HERMES_TOOL_VIEW_V1_ENABLED": "0"}):
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(probe._run_hook_callback_bounded, "pre_tool_call", callback, {}, 5.0)
                self.assertTrue(started.wait(2))
                second = pool.submit(probe._run_hook_callback_bounded, "pre_tool_call", callback, {}, 5.0)
                self.assertIs(second.result(timeout=2), _HOOK_SKIPPED)
                release.set()
                self.assertEqual(first.result(timeout=3), "allowed")


if __name__ == "__main__":
    unittest.main()
