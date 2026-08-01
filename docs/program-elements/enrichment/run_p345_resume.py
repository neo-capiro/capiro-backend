#!/usr/bin/env python3
"""Resume remaining Phase 3-5 commits after partial run."""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path

env = os.environ.copy()
SHA = "f8dba151c04f334fb81961baa8d67b261b5f6009"
ARN = "arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api-pe-enrichment:8"
RAW = "capiro-defense-budget-raw-dev-967807252336"
KMS = "arn:aws:kms:us-east-1:967807252336:key/29f4399d-4a5c-449e-b28d-29a7e71b8970"
OUT = Path("docs/program-elements/enrichment/batch-logs")
OUT.mkdir(parents=True, exist_ok=True)


def aws(args: list[str], raw: bool = False):
    r = subprocess.run(["aws"] + args, capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise SystemExit((r.stderr or r.stdout)[:3000])
    return r.stdout if raw else json.loads(r.stdout)


def wait_running_pe_tasks(timeout_s: int = 900) -> None:
    """Wait for any pe-enrichment family RUNNING tasks to stop."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        arns = aws(
            [
                "ecs",
                "list-tasks",
                "--cluster",
                "capiro-dev",
                "--desired-status",
                "RUNNING",
                "--family",
                "capiro-dev-api-pe-enrichment",
                "--query",
                "taskArns",
            ]
        )
        if not arns:
            print("no running pe-enrichment tasks")
            return
        print("waiting on", len(arns), "tasks", arns[0][-20:])
        time.sleep(15)
    raise SystemExit("timeout waiting for running pe-enrichment tasks")


net = aws(
    [
        "ecs",
        "describe-services",
        "--cluster",
        "capiro-dev",
        "--services",
        "capiro-dev-api",
        "--query",
        "services[0].networkConfiguration",
    ]
)
awsvpc = net["awsvpcConfiguration"]
nc = (
    "awsvpcConfiguration={subnets=["
    + ",".join(awsvpc["subnets"])
    + "],securityGroups=["
    + ",".join(awsvpc["securityGroups"])
    + "],assignPublicIp="
    + awsvpc.get("assignPublicIp", "DISABLED")
    + "}"
)


def fetch_log(task_arn: str, name: str) -> str:
    task_id = task_arn.split("/")[-1]
    time.sleep(5)
    streams = aws(
        [
            "logs",
            "describe-log-streams",
            "--log-group-name",
            "/capiro/dev/api",
            "--order-by",
            "LastEventTime",
            "--descending",
            "--max-items",
            "50",
        ]
    )
    text = ""
    for s in streams.get("logStreams", []):
        sn = s.get("logStreamName", "")
        if task_id not in sn:
            continue
        msgs: list[str] = []
        token = None
        for _ in range(100):
            args = [
                "logs",
                "get-log-events",
                "--log-group-name",
                "/capiro/dev/api",
                "--log-stream-name",
                sn,
                "--limit",
                "10000",
            ]
            if not msgs:
                args += ["--start-from-head"]
            if token:
                args += ["--next-token", token]
            ev = aws(args)
            batch = ev.get("events") or []
            if not batch and msgs:
                break
            msgs.extend(e.get("message", "") for e in batch)
            nt = ev.get("nextForwardToken")
            if nt == token:
                break
            token = nt
        text = "\n".join(msgs)
        (OUT / f"{name}.log").write_text(text, encoding="utf-8")
        break
    return text


def summarize(name: str, ex, text: str) -> dict:
    info = {"name": name, "exit": ex, "chars": len(text)}
    for key, pat in [
        ("mode", r'"mode"\s*:\s*"([^"]+)"'),
        ("status", r'"status"\s*:\s*"([^"]+)"'),
        ("upserted", r'"upserted"\s*:\s*(\d+)'),
        ("changed", r'"changed"\s*:\s*(\d+)'),
        ("rowCount", r'"rowCount"\s*:\s*(\d+)'),
        ("lines", r'"lines"\s*:\s*(\d+)'),
        ("values", r'"values"\s*:\s*(\d+)'),
        ("posture", r'"posture"\s*:\s*"([^"]+)"'),
        ("canonicalWrites", r'"canonicalWrites"\s*:\s*(true|false)'),
    ]:
        ms = re.findall(pat, text)
        if ms:
            info[key] = ms[-1]
    errs = re.findall(r"Error[^\n]{0,160}", text)
    if errs:
        info["errors"] = errs[-3:]
    print(json.dumps(info))
    print(" TAIL", text[-700:].replace("\n", " | ")[:700])
    return info


def run(name: str, command: list[str], polls: int = 400) -> dict:
    wait_running_pe_tasks()
    ov = {
        "containerOverrides": [
            {
                "name": "api",
                "command": command,
                "environment": [
                    {"name": "TMPDIR", "value": "/dev/shm"},
                    {"name": "GIT_SHA", "value": SHA},
                ],
            }
        ]
    }
    p = OUT / f"ov-{name}.json"
    p.write_text(json.dumps(ov), encoding="utf-8")
    rt = aws(
        [
            "ecs",
            "run-task",
            "--cluster",
            "capiro-dev",
            "--task-definition",
            ARN,
            "--launch-type",
            "FARGATE",
            "--network-configuration",
            nc,
            "--overrides",
            f"file://{p.resolve()}",
            "--count",
            "1",
            "--started-by",
            f"pe-{name}"[:36],
        ]
    )
    task = rt["tasks"][0]["taskArn"]
    print(f"\n=== {name} TASK {task}")
    print("CMD", " ".join(command))
    ex = None
    for i in range(polls):
        t = aws(
            [
                "ecs",
                "describe-tasks",
                "--cluster",
                "capiro-dev",
                "--tasks",
                task,
                "--query",
                "tasks[0]",
            ]
        )
        last = t.get("lastStatus")
        ex = (t.get("containers") or [{}])[0].get("exitCode")
        if i % 5 == 0 or last == "STOPPED":
            print(name, "poll", i, last, "exit", ex)
        if last == "STOPPED":
            break
        time.sleep(8)
    text = fetch_log(task, name)
    return summarize(name, ex, text)


def has_successful_commit(name: str) -> bool:
    log = OUT / f"{name}.log"
    if not log.exists() or log.stat().st_size < 200:
        return False
    t = log.read_text(encoding="utf-8", errors="replace")
    # success signals
    if re.search(r'"mode"\s*:\s*"COMMIT"', t) and re.search(r'"status"\s*:\s*"ok"', t):
        return True
    if re.search(r'"loadOutcome"\s*:\s*\{[^}]*"upserted"', t) and "Error" not in t[-500:]:
        # may still be ok
        if re.search(r'"canonicalWrites"\s*:\s*true', t):
            return True
    # if ended with process exit via nest and loadOutcome
    if '"loadOutcome"' in t and re.search(r'"upserted"\s*:\s*\d+', t):
        # check last 2k for fatal
        tail = t[-2000:]
        if "Usage:" in tail or "Expected exactly" in tail or "Quality audit failed" in tail:
            return False
        return True
    return False


def main() -> None:
    results: dict = {}

    # Collect in-flight sasc if any
    wait_running_pe_tasks()
    # Try to locate sasc log from latest stopped pe-sasc27-c
    # If incomplete, re-run.

    remaining = []
    plan = [
        (
            "hasc27-c",
            [
                "parse-hasc-report",
                "--artifact",
                "scripts/__data__/corrected_json/armed_services_hasc_fy2027_corrected.json",
                "--fy",
                "2027",
                "--commit",
                "--approved-sha256",
                "27bd590a7a1a7c0532a5f1cfeb2f8a3d894cff60e24cc0ae4e338fb4914ff096",
            ],
        ),
        (
            "sasc27-c",
            [
                "parse-sasc-report",
                "--artifact",
                "scripts/__data__/corrected_json/armed_services_sasc_fy2027_corrected.json",
                "--fy",
                "2027",
                "--commit",
                "--approved-sha256",
                "7b72c3ccd7b4fb4b8fd3990865eb514f629b685d3669459f2faf9ca47c891120",
            ],
        ),
        (
            "hacd27-c",
            [
                "parse-hac-d-report",
                "--artifact",
                "scripts/__data__/corrected_json/marks_hacd_fy2027_rdte.json",
                "--fy",
                "2027",
                "--commit",
                "--approved-sha256",
                "db40e84624847f2b605f8dfd815e159e3d83ce17827ade8d5de4c5abe605caf1",
            ],
        ),
        (
            "ndaa26-c",
            [
                "parse-ndaa-conference",
                "--artifact",
                "scripts/__data__/corrected_json/ndaa_conference_fy2026_corrected.json",
                "--fy",
                "2026",
                "--commit",
                "--approved-sha256",
                "766bf10f99f390b439138866c5017a555ec801351b293a5bb80538bb94efd3eb",
            ],
        ),
        (
            "om27-c",
            [
                "load-om",
                "--artifact",
                "scripts/__data__/corrected_json/om_fy2027.json",
                "--commit",
                "--approved-sha256",
                "2774f0f327572553bc206e181dd75fb945dfe24c07bac06a34af9d7fb4f09617",
            ],
        ),
        (
            "omop5-c",
            [
                "load-om-op5",
                "--artifact",
                "scripts/__data__/corrected_json/om_op5_fy2027.json",
                "--commit",
                "--approved-sha256",
                "bdae874b53bebaf4faa4bd8688c454b391a9a4189184dad467ff44dc215c09a1",
            ],
        ),
    ]

    for name, cmd in plan:
        if has_successful_commit(name):
            print("SKIP already ok", name)
            results[name] = {"skipped": True, "ok": True}
            continue
        results[name] = run(name, cmd)

    # missile pdoc
    miss = "e47707f50d29ebf796a3db57877d104001c5679ce783f308ed1cd47cca1107f4"
    subprocess.run(
        [
            "aws",
            "s3",
            "cp",
            f"s3://{RAW}/raw/public/dod-budget/fiscal_year=2027/source_authority=dod-comptroller/family=procurement/document_id=missile_procurement_army/sha256={miss}/original.pdf",
            f"s3://{RAW}/incoming/fy2027/Missile_Procurement_Army.pdf",
            "--sse",
            "aws:kms",
            "--sse-kms-key-id",
            KMS,
        ],
        check=False,
        env=env,
    )
    results["pdoc-miss-x"] = run(
        "pdoc-miss-x",
        [
            "ingest-defense-budget",
            "--path",
            f"s3://{RAW}/incoming/fy2027/Missile_Procurement_Army.pdf",
            "--fy",
            "2027",
            "--limit",
            "1",
            "--extract-only",
            "--allow-vendor-parse",
            "--mode",
            "pdf_premium",
        ],
    )
    lines = int(results["pdoc-miss-x"].get("lines") or 0)
    if results["pdoc-miss-x"].get("exit") == 0 and lines > 0:
        results["pdoc-miss-c"] = run(
            "pdoc-miss-c",
            [
                "ingest-defense-budget",
                "--path",
                f"s3://{RAW}/incoming/fy2027/Missile_Procurement_Army.pdf",
                "--fy",
                "2027",
                "--limit",
                "1",
                "--commit",
                "--approved-sha256",
                miss,
                "--allow-vendor-parse",
                "--mode",
                "pdf_premium",
            ],
        )
    else:
        results["pdoc-miss-c"] = {"skipped": True, "reason": "zero_lines_or_extract_fail", "lines": lines}

    results["derive"] = run("derive", ["run-pe-derive-chain"])
    results["diag-final"] = run("diag-final", ["diag-pe-trust"], polls=120)

    diag = {}
    log = OUT / "diag-final.log"
    if log.exists():
        text = log.read_text(encoding="utf-8", errors="replace")
        s, e = text.find("{"), text.rfind("}")
        if s >= 0 and e > s:
            try:
                j = json.loads(text[s : e + 1])
                pey = j.get("programElementYears", {})
                te = j.get("trustEvaluation", {})
                diag = {
                    "gitSha": j.get("gitSha"),
                    "trustOk": te.get("ok"),
                    "blockers": [(b.get("code"), b.get("count")) for b in te.get("blockers", [])],
                    "peyTotal": pey.get("total"),
                    "nonNull": pey.get("nonNullByField"),
                    "countByFY": pey.get("countByFiscalYear"),
                }
            except Exception as err:
                diag = {"parseError": str(err)}

    out = {"results": results, "diag": diag}
    (OUT / "results-final.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print("\nFINAL", json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
