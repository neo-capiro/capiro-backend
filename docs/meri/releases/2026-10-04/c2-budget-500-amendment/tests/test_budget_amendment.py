"""Offline reducer tests; they never open or mutate the native Windows journal."""
import ctypes
import json
import pathlib
import runpy
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "evidence"
JOURNAL = EVIDENCE / "journal30.readonly.jsonl"


class _StubDll:
    def __getattr__(self, _name):
        def _unused(*_args):
            raise AssertionError("offline reducer test attempted native I/O")
        return _unused


# The helper imports the native module at load time. Stub only DLL discovery;
# reducer tests must never invoke a Windows API.
ctypes.WinDLL = lambda *_args, **_kwargs: _StubDll()
MODULE = runpy.run_path(str(EVIDENCE / "windows-capture-spend-bound.py"))
REDUCE = MODULE["reduce_fresh"]
# runpy returns a dictionary copy: bind the actual reducer function globals.
MODULE = REDUCE.__globals__
APPROVAL = "a" * 64
MODULE["BUDGET_AMENDMENT_AUTHORITY_SHA256"] = APPROVAL


def row_for(journal, **changes):
    return {
        "nativeCaptureVersion": 1,
        "sequence": 31,
        "atMs": 1791150000000,
        "event": "budget_amended",
        "oldMaxCostMicros": 30_000_000,
        "maxCostMicros": 500_000_000,
        "perCaseMaxCostMicros": 15_000_000,
        "concurrency": 1,
        "approvalSha256": APPROVAL,
        "journalBeforeSha256": MODULE["digest"](journal),
        "originalJournal30Sha256": MODULE["FRESH_JOURNAL30_SHA256"],
        "journalFileIdentity": MODULE["FRESH_JOURNAL30_IDENTITY"],
        **changes,
    }


def appended(wire, row):
    return wire + MODULE["data"](row) + b"\n"


class BudgetAmendmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.wire = JOURNAL.read_bytes()
        cls.before = REDUCE(cls.wire)

    def test_readonly_journal_snapshot_is_unchanged_without_amendment(self):
        self.assertEqual(self.before["eventCount"], 30)
        self.assertIsNone(self.before["activeRun"])
        self.assertEqual(self.before["knownSettledCostMicros"], 15_202_947)
        self.assertEqual(self.before["conservativeApprovalCostMicros"], 1_000_000)
        self.assertEqual(self.before["committedCostMicros"], 16_202_947)
        self.assertEqual(self.before["remainingReservationMicros"], 13_797_053)
        self.assertNotIn("maxCostMicros", self.before)
        self.assertNotIn("approvalSha256", self.before)

    def test_exact_row31_activates_only_aggregate_cap(self):
        row = row_for(self.wire)
        after = REDUCE(appended(self.wire, row))
        self.assertEqual(after["eventCount"], 31)
        self.assertEqual(after["maxCostMicros"], 500_000_000)
        self.assertEqual(after["approvalSha256"], APPROVAL)
        self.assertEqual(after["perCaseMaxCostMicros"], 15_000_000)
        self.assertEqual(after["committedCostMicros"], 16_202_947)
        self.assertEqual(after["remainingReservationMicros"], 483_797_053)
        self.assertEqual(after["knownSettledCostMicros"], self.before["knownSettledCostMicros"])
        self.assertEqual(after["conservativeApprovalCostMicros"], self.before["conservativeApprovalCostMicros"])
        self.assertIsNone(after["activeRun"])

    def test_unbound_authority_rejects_even_well_formed_caller_row(self):
        bound = MODULE["BUDGET_AMENDMENT_AUTHORITY_SHA256"]
        try:
            MODULE["BUDGET_AMENDMENT_AUTHORITY_SHA256"] = None
            with self.assertRaises(ValueError):
                REDUCE(appended(self.wire, row_for(self.wire)))
        finally:
            MODULE["BUDGET_AMENDMENT_AUTHORITY_SHA256"] = bound

    def test_rejects_altered_amount_authority_limits_and_checkpoint(self):
        base = row_for(self.wire)
        mutations = (
            {"oldMaxCostMicros": 29_000_000},
            {"oldMaxCostMicros": 30_000_000.0},
            {"concurrency": True},
            {"maxCostMicros": 500_000_001},
            {"perCaseMaxCostMicros": 15_000_001},
            {"concurrency": 2},
            {"approvalSha256": "b" * 64},
            {"journalBeforeSha256": "c" * 64},
            {"originalJournal30Sha256": "d" * 64},
            {"sequence": 32},
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                REDUCE(appended(self.wire, {**base, **mutation}))

    def test_rejects_changed_original_prefix(self):
        changed = bytearray(self.wire)
        changed[0] ^= 1
        with self.assertRaises(ValueError):
            REDUCE(bytes(changed))

    def test_rejects_replay_and_non31_amendment(self):
        first = row_for(self.wire)
        amended_wire = appended(self.wire, first)
        duplicate = {**first, "sequence": 32, "atMs": first["atMs"] + 1}
        with self.assertRaises(ValueError):
            REDUCE(appended(amended_wire, duplicate))
        misplaced = {**first, "sequence": 31}
        with self.assertRaises(ValueError):
            REDUCE(appended(self.wire, misplaced) + MODULE["data"]({"not": "a journal row"}) + b"\n")

    def test_later_ordinary_case_reservation_reads_amended_history(self):
        amendment = appended(self.wire, row_for(self.wire))
        subsequent = {
            "nativeCaptureVersion": 1, "sequence": 32, "atMs": 1791150000001,
            "event": "reserved", "caseId": "01",
            "captureRunId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "reservationId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "ceilingMicros": 15_000_000,
        }
        snapshot = REDUCE(appended(amendment, subsequent))
        self.assertEqual(snapshot["eventCount"], 32)
        self.assertEqual(snapshot["activeRun"], "01:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        self.assertEqual(snapshot["remainingReservationMicros"], 468_797_053)
        self.assertEqual(snapshot["maxCostMicros"], 500_000_000)


if __name__ == "__main__":
    unittest.main()
