#!/usr/bin/env python3
"""Phase 3-5 enrichment batch: marks/OM inspect+commit, P-doc LP, derive, diag."""
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

jobs = [
    (
        "hasc27-i",
        [
            "parse-hasc-report",
            "--artifact",
            "scripts/__data__/corrected_json/armed_services_hasc_fy2027_corrected.json",
            "--fy",
            "2027",
        ],
    ),
    (
        "sasc27-i",
        [
            "parse-sasc-report",
            "--artifact",
            "scripts/__data__/corrected_json/armed_services_sasc_fy2027_corrected.json",
            "--fy",
            "2027",
        ],
    ),
    (
        "hacd27-i",
        [
            "parse-hac-d-report",
            "--artifact",
            "scripts/__data__/corrected_json/marks_hacd_fy2027_rdte.json",
            "--fy",
            "2027",
        ],
    ),
    (
        "ndaa26-i",
        [
            "parse-ndaa-conference",
            "--artifact",
            "scripts/__data__/corrected_json/ndaa_conference_fy2026_corrected.json",
            "--fy",
            "2026",
        ],
    ),
    ("om27-i", ["load-om", "--artifact", "scripts/__data__/corrected_json/om_fy2027.json"]),
    ("omop5-i", ["load-om-op5", "--artifact", "scripts/__data__/corrected_json/om_op5_fy2027.json"]),
]

shas = {
    "scripts/__data__/corrected_json/armed_services_hasc_fy2027_corrected.json": "27bd590a7a1a7c0532a5f1cfeb2f8a3d894cff60e24cc0ae4e338fb4914ff096",
    "scripts/__data__/corrected_json/armed_services_sasc_fy2027_corrected.json": "7b72c3ccd7b4fb4b8fd3990865eb514f629b685d3669459f2faf9ca47c891120",
    "scripts/__data__/corrected_json/marks_hacd_fy2027_rdte.json": "db40e84624847f2b605f8dfd815e159e3d83ce17827ade8d5de4c5abe605caf1",
    "scripts/__data__/corrected_json/ndaa_conference_fy2026_corrected.json": "766bf10f99f390b439138866c5017a555ec801351b293a5bb80538bb94efd3eb",
    "scripts/__data__/corrected_json/om_fy2027.json": "2774f0f327572553bc206e181dd75fb945dfe24c07bac06a34af9d7fb4f09617",
    "scripts/__data__/corrected_json/om_op5_fy2027.json": "bdae874b53bebaf4faa4bd8688c454b391a9a4189184dad467ff44dc215c09a1",
}


def aws(args: list[str], raw: bool = False):
    r = subprocess.run(["aws"] + args, capture_output=True, text=True, env=env)
    if r.returncode != 0:
        raise SystemExit((r.stderr or r.stdout)[:3000])
    return r.stdout if raw else json.loads(r.stdout)


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


def run(name: str, command: list[str], polls: int = 300):
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
    ov_path = OUT / f"ov-{name}.json"
    ov_path.write_text(json.dumps(ov), encoding="utf-8")
    # aws on Windows wants a path it can read; use absolute POSIX-ish path
    ov_arg = str(ov_path.resolve())
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
            f"file://{ov_arg}",
            "--count",
            "1",
            "--started-by",
            f"pe-{name}"[:36],
        ]
    )
    task = rt["tasks"][0]["taskArn"]
    print(f"\n=== {name}")
    print("TASK", task)
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
    task_id = task.split("/")[-1]
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
        for _ in range(80):
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
    print(name, "EXIT", ex, "chars", len(text))
    for pat in [
        r"INSPECT",
        r'"posture"\s*:\s*"[^"]+"',
        r'"canonicalWrites"\s*:\s*\w+',
        r'"lines"\s*:\s*\d+',
        r'"values"\s*:\s*\d+',
        r'"upserted"\s*:\s*\d+',
        r'"changed"\s*:\s*\d+',
        r"upserted[^\n]{0,50}",
        r"changed[^\n]{0,50}",
        r"Error[^\n]{0,160}",
        r"Usage:",
        r"ENOENT|no such file|Cannot find",
        r"Quality audit",
        r"Expected exactly",
    ]:
        ms = re.findall(pat, text, re.I)
        if ms:
            print(" ", pat, ms[:6])
    print(" TAIL", text[-1000:].replace("\n", " | ")[:1000])
    return ex, text


def main() -> None:
    results: dict = {}

    # Phase 3 marks + Phase 4 OM inspect
    for name, cmd in jobs:
        ex, _ = run(name, cmd)
        results[name] = ex

    commit_jobs = []
    for name, cmd in jobs:
        if results.get(name) != 0:
            continue
        art = None
        for i, a in enumerate(cmd):
            if a == "--artifact" and i + 1 < len(cmd):
                art = cmd[i + 1]
        if not art or art not in shas:
            continue
        cname = name.replace("-i", "-c")
        commit_jobs.append((cname, cmd + ["--commit", "--approved-sha256", shas[art]]))

    print("\nCOMMIT QUEUE", [n for n, _ in commit_jobs])
    for name, cmd in commit_jobs:
        ex, _ = run(name, cmd, polls=360)
        results[name] = ex

    # Phase 4 missile P-doc LlamaParse
    miss_sha = "e47707f50d29ebf796a3db57877d104001c5679ce783f308ed1cd47cca1107f4"
    subprocess.run(
        [
            "aws",
            "s3",
            "cp",
            f"s3://{RAW}/raw/public/dod-budget/fiscal_year=2027/source_authority=dod-comptroller/family=procurement/document_id=missile_procurement_army/sha256={miss_sha}/original.pdf",
            f"s3://{RAW}/incoming/fy2027/Missile_Procurement_Army.pdf",
            "--sse",
            "aws:kms",
            "--sse-kms-key-id",
            KMS,
        ],
        check=False,
        env=env,
    )
    ex, t = run(
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
        polls=420,
    )
    results["pdoc_miss_x"] = ex
    if ex == 0:
        m = re.search(r'"lines"\s*:\s*(\d+)', t)
        lines = int(m.group(1)) if m else 0
        print("pdoc lines", lines)
        if lines > 0:
            ex2, _ = run(
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
                    miss_sha,
                    "--allow-vendor-parse",
                    "--mode",
                    "pdf_premium",
                ],
                polls=420,
            )
            results["pdoc_miss_c"] = ex2
        else:
            results["pdoc_miss_c"] = "skip_zero_lines"

    # Phase 5 derive + diag
    ex, _ = run("derive", ["run-pe-derive-chain"])
    results["derive"] = ex
    ex, t = run("diag-final", ["diag-pe-trust"], polls=100)
    results["diag"] = ex

    diag_summary = {}
    log = OUT / "diag-final.log"
    if log.exists():
        text = log.read_text(encoding="utf-8", errors="replace")
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            try:
                j = json.loads(text[start : end + 1])
                pey = j.get("programElementYears", {})
                te = j.get("trustEvaluation", {})
                diag_summary = {
                    "gitSha": j.get("gitSha"),
                    "trustOk": te.get("ok"),
                    "blockers": [(b.get("code"), b.get("count")) for b in te.get("blockers", [])],
                    "peyTotal": pey.get("total"),
                    "nonNull": pey.get("nonNullByField"),
                    "countByFY": pey.get("countByFiscalYear"),
                }
            except Exception as e:
                diag_summary = {"parseError": str(e)}

    out = {"results": results, "diag": diag_summary}
    (OUT / "results.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print("\nALL RESULTS", json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
