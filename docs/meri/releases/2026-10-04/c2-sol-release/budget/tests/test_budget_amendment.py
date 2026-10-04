"""Offline tests for the native Sol qualification allocation reducer."""
import ctypes
import json
import pathlib
import runpy
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "evidence"
JOURNAL30 = EVIDENCE / "journal30.readonly.jsonl"
ACK = ROOT / "native-ack.json"


class _StubDll:
    def __getattr__(self, _name):
        def _unused(*_args):
            raise AssertionError("offline reducer test attempted native I/O")
        return _unused


ctypes.WinDLL = lambda *_args, **_kwargs: _StubDll()
REDUCE = runpy.run_path(str(EVIDENCE / "windows-capture-spend-bound.py"))["reduce_fresh"]
# runpy returns a dictionary copy; policy binds must target the function's real globals.
MODULE = REDUCE.__globals__
ACK_DATA = json.loads(ACK.read_text(encoding="utf-8"))
ROW31 = ACK_DATA["event"]
WIRE30 = JOURNAL30.read_bytes()
WIRE31 = WIRE30 + MODULE["data"](ROW31) + b"\n"
PLAN_SHA = "f" * 64
MODULE["SOL_PROBE_PLAN_SHA256"] = PLAN_SHA
MODULE["SOL_PROBE_ID"] = "7c4f12b8-18be-4d30-92d4-e796206ba413"


def allocation_row(**changes):
    return {
        "nativeCaptureVersion": 1, "sequence": 32, "atMs": 1791150000000,
        "event": "sol_model_qualification_allocated", "probeId": MODULE["SOL_PROBE_ID"],
        "probePlanSha256": PLAN_SHA, "tenantId": MODULE["SOL_PROBE_TENANT_ID"],
        "provider": "openai", "model": "gpt-6.1-sol", "maxGenerationRequests": 3,
        "maxOutputTokensPerRequest": 1024, "maxRequestBytes": 32768,
        "serviceTier": "default", "retries": 0, "hostedTools": False,
        "localFunctionCallRoundtripOnly": True, "acceptanceAuthority": False,
        "captureAuthority": False, "conservativeModelQualificationCostMicros": 1_000_000,
        **changes,
    }


def appended(wire, row):
    return wire + MODULE["data"](row) + b"\n"


class SolProbeBudgetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.before = REDUCE(WIRE31)
        cls.allocated_wire = appended(WIRE31, allocation_row())

    def test_exact_row31_ack_replay_and_original_authorities_unchanged(self):
        self.assertEqual(ROW31["sequence"], 31)
        self.assertEqual(MODULE["digest"](WIRE31), MODULE["FRESH_JOURNAL31_SHA256"])
        self.assertEqual(len(WIRE31), MODULE["FRESH_JOURNAL31_BYTES"])
        self.assertEqual(self.before["eventCount"], 31)
        self.assertEqual(self.before["committedCostMicros"], 16_202_947)
        self.assertEqual(self.before["remainingReservationMicros"], 483_797_053)
        auth = ACK_DATA["state"]["files"]["run-authorization.json"]
        journal = ACK_DATA["state"]["files"]["fresh-spend.jsonl"]
        self.assertEqual(auth["sha256"], MODULE["FRESH_AUTHORIZATION"])
        self.assertEqual(auth["identity"], MODULE["FRESH_AUTHORIZATION_IDENTITY"])
        self.assertEqual(journal["identity"], MODULE["FRESH_JOURNAL30_IDENTITY"])
        self.assertEqual(WIRE31[:len(WIRE30)], WIRE30)
        self.assertEqual(self.before["committedCostMicros"], REDUCE(WIRE30)["committedCostMicros"])
        altered_row31 = {**ROW31, "maxCostMicros": ROW31["maxCostMicros"] + 1}
        with self.assertRaises(ValueError):
            REDUCE(appended(WIRE30, altered_row31))
        with self.assertRaises(ValueError):
            REDUCE(appended(WIRE31, ROW31))
        with self.assertRaises(ValueError):
            REDUCE(appended(WIRE31, {**ROW31, "sequence": 32}))
        MODULE['require_sol_probe_checkpoint'](ACK_DATA['state'], WIRE31, self.before)
        stale = json.loads(json.dumps(ACK_DATA['state']))
        stale['files']['fresh-spend.jsonl']['sha256'] = MODULE['FRESH_JOURNAL30_SHA256']
        with self.assertRaises(ValueError):
            MODULE['require_sol_probe_checkpoint'](stale, WIRE31, self.before)

    def test_unbound_plan_disables_funding(self):
        bound = MODULE["SOL_PROBE_PLAN_SHA256"]
        try:
            MODULE["SOL_PROBE_PLAN_SHA256"] = None
            with self.assertRaises(ValueError):
                REDUCE(appended(WIRE31, allocation_row()))
        finally:
            MODULE["SOL_PROBE_PLAN_SHA256"] = bound

    def test_exact_fixed_one_dollar_allocation_is_committed_not_known_usage(self):
        after = REDUCE(self.allocated_wire)
        self.assertEqual(after["eventCount"], 32)
        self.assertEqual(after["knownSettledCostMicros"], self.before["knownSettledCostMicros"])
        self.assertEqual(after["conservativeApprovalCostMicros"], 1_000_000)
        self.assertEqual(after["conservativeModelQualificationCostMicros"], 1_000_000)
        self.assertEqual(after["committedCostMicros"], 17_202_947)
        self.assertEqual(after["remainingReservationMicros"], 482_797_053)
        self.assertIsNone(after["activeRun"])
        self.assertIs(after["solModelQualificationProbe"]["captureAuthority"], False)
        self.assertIs(after["solModelQualificationProbe"]["acceptanceAuthority"], False)

    def test_small_later_settlement_does_not_refund_qualification_allocation(self):
        reserve = {
            "nativeCaptureVersion": 1, "sequence": 33, "atMs": 1791150000001,
            "event": "reserved", "caseId": "01",
            "captureRunId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "reservationId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "ceilingMicros": 15_000_000,
        }
        settle = {
            "nativeCaptureVersion": 1, "sequence": 34, "atMs": 1791150000002,
            "event": "settled", "caseId": "01", "captureRunId": reserve["captureRunId"],
            "reservationId": reserve["reservationId"],
            "usage": {"chargedCostMicros": 0, "ledgerSha256": "a" * 64,
                "envelopeSha256": "b" * 64, "captureAuthority": True},
        }
        after = REDUCE(appended(appended(self.allocated_wire, reserve), settle))
        self.assertEqual(after["knownSettledCostMicros"], self.before["knownSettledCostMicros"])
        self.assertEqual(after["conservativeModelQualificationCostMicros"], 1_000_000)
        self.assertEqual(after["committedCostMicros"], 17_202_947)
        self.assertEqual(after["remainingReservationMicros"], 482_797_053)

    def test_allocation_rejects_mutation_replay_and_malformed_numbers(self):
        base = allocation_row()
        mutations = (
            {"probeId": "00000000-0000-4000-8000-000000000001"},
            {"probePlanSha256": "a" * 64},
            {"tenantId": "00000000-0000-4000-8000-000000000001"},
            {"provider": "other"}, {"model": "other"},
            {"maxGenerationRequests": 4}, {"maxGenerationRequests": True},
            {"maxOutputTokensPerRequest": 1024.0}, {"maxRequestBytes": 32769},
            {"retries": False}, {"conservativeModelQualificationCostMicros": 1_000_001},
            {"captureAuthority": True}, {"acceptanceAuthority": True},
            {"hostedTools": True}, {"serviceTier": "flex"}, {"unexpected": "caller"},
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                REDUCE(appended(WIRE31, {**base, **mutation}))
        with self.assertRaises(ValueError):
            REDUCE(appended(self.allocated_wire, {**base, "sequence": 33, "atMs": base["atMs"] + 1}))

    def test_future_capacity_counts_permanent_allocation(self):
        wire = self.allocated_wire
        sequence = 33
        for index in range(32):
            run_id = f"{index + 1:08x}-aaaa-4aaa-8aaa-{index + 1:012x}"
            reservation_id = f"{index + 100:08x}-bbbb-4bbb-8bbb-{index + 100:012x}"
            reserve = {
                "nativeCaptureVersion": 1, "sequence": sequence, "atMs": 1791150000000 + sequence,
                "event": "reserved", "caseId": "01", "captureRunId": run_id,
                "reservationId": reservation_id, "ceilingMicros": 15_000_000,
            }
            wire = appended(wire, reserve)
            sequence += 1
            settle = {
                "nativeCaptureVersion": 1, "sequence": sequence, "atMs": 1791150000000 + sequence,
                "event": "settled", "caseId": "01", "captureRunId": run_id,
                "reservationId": reservation_id,
                "usage": {"chargedCostMicros": 15_000_000, "ledgerSha256": "a" * 64,
                    "envelopeSha256": "b" * 64, "captureAuthority": True},
            }
            wire = appended(wire, settle)
            sequence += 1
        near_limit = REDUCE(wire)
        self.assertEqual(near_limit["committedCostMicros"], 497_202_947)
        self.assertEqual(near_limit["remainingReservationMicros"], 2_797_053)
        self.assertEqual(near_limit["conservativeModelQualificationCostMicros"], 1_000_000)
        last = {
            "nativeCaptureVersion": 1, "sequence": sequence, "atMs": 1791150000000 + sequence,
            "event": "reserved", "caseId": "01",
            "captureRunId": "eeeeeeee-aaaa-4aaa-8aaa-eeeeeeeeeeee",
            "reservationId": "ffffffff-bbbb-4bbb-8bbb-ffffffffffff", "ceilingMicros": 3_000_000,
        }
        with self.assertRaises(ValueError):
            REDUCE(appended(wire, last))
        self.assertEqual(REDUCE(self.allocated_wire)["remainingReservationMicros"], 482_797_053)

    def test_original_bytes_and_case_authority_cannot_be_rewritten_by_caller(self):
        self.assertEqual(WIRE31[:len(WIRE30)], WIRE30)
        for mutation in ({"caseId": "01"}, {"ceilingMicros": 500_000_000},
                         {"maxCostMicros": 900_000_000}, {"concurrency": 99}):
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                REDUCE(appended(WIRE31, allocation_row(**mutation)))
        with self.assertRaises(ValueError):
            MODULE["execute_fresh"]({"op": "fresh_allocate_sol_probe", "root": MODULE["FRESH_ROOT"],
                "state": {}, "event": allocation_row()})
        with self.assertRaises(ValueError):
            MODULE["execute_fresh"]({"op": "fresh_allocate_sol_probe", "root": MODULE["FRESH_ROOT"],
                "state": {"freshVersion": 1, "root": MODULE["FRESH_ROOT"], "directories": {}, "files": {}}})


if __name__ == "__main__":
    unittest.main()
