"""Emit the 7 put-rule + 7 put-targets JSON files. Local only. Does not call AWS."""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ACCOUNT = "967807252336"
REGION = "us-east-1"
CLUSTER_ARN = f"arn:aws:ecs:{REGION}:{ACCOUNT}:cluster/capiro-dev"
INVOKER = f"arn:aws:iam::{ACCOUNT}:role/capiro-dev-eventbridge-sync-invoker"
TD = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/capiro-dev-api-sync-jobs:12"
SUBNETS = [
    "subnet-0e38bd390f8961fef",
    "subnet-0920665f91c905f01",
    "subnet-06db79cd21239de19",
]
SG = "sg-01def4e5c0fe44d4a"
CONTAINER = "api-sync-jobs"

JOBS = [
    {
        "id": "SyncTangoDibbs",
        "name": "fo-dev-sync-tango-dibbs",
        "schedule": "cron(10 13 * * ? *)",
        "command": ["sync-tango-dibbs", "--commit"],
        "description": (
            "[daily] Funding Opportunities: DIBBS bid-board incremental sync "
            "(daily 13:10 UTC, issue-date window + 7d overlap). "
            "Created DISABLED 2026-08-14. Out-of-band; not a CDK resource."
        ),
    },
    {
        "id": "ReconcileTangoDibbsFull",
        "name": "fo-dev-reconcile-tango-dibbs-full",
        "schedule": "cron(10 13 ? * SUN *)",
        "command": ["sync-tango-dibbs", "--commit", "--full"],
        "description": (
            "[weekly] Funding Opportunities: DIBBS full reconciliation "
            "(Sun 13:10 UTC) — catches amendments the issue-date window cannot. "
            "Created DISABLED 2026-08-14. Out-of-band; not a CDK resource."
        ),
    },
    {
        "id": "SyncTangoSbir",
        "name": "fo-dev-sync-tango-sbir",
        "schedule": "cron(30 13 * * ? *)",
        "command": ["sync-tango-sbir", "--commit"],
        "description": (
            "[daily] Funding Opportunities: SBIR/STTR incremental sync "
            "(daily 13:30 UTC, publication-date window + 7d overlap). "
            "Created DISABLED 2026-08-14. Out-of-band; not a CDK resource."
        ),
    },
    {
        "id": "ReconcileTangoSbirFull",
        "name": "fo-dev-reconcile-tango-sbir-full",
        "schedule": "cron(30 13 ? * SUN *)",
        "command": ["sync-tango-sbir", "--commit", "--full"],
        "description": (
            "[weekly] Funding Opportunities: SBIR/STTR full reconciliation "
            "(Sun 13:30 UTC) — catches topic amendments the publication-date window cannot. "
            "Created DISABLED 2026-08-14. Out-of-band; not a CDK resource."
        ),
    },
    {
        "id": "ProcessTangoEvents",
        "name": "fo-dev-process-tango-events",
        "schedule": "cron(20 13 * * ? *)",
        "command": ["process-tango-events", "--commit"],
        "description": (
            "[daily] Funding Opportunities: drain verified Tango webhook deliveries "
            "into deduped client alerts (daily 13:20 UTC). "
            "Created DISABLED 2026-08-14. Out-of-band; not a CDK resource. "
            "Upstream notice sync has no live rule as of draft date."
        ),
    },
    {
        "id": "GenerateDibbsOpportunityCandidates",
        "name": "fo-dev-generate-dibbs-opportunity-candidates",
        "schedule": "cron(15 13 * * ? *)",
        "command": ["generate-dibbs-opportunity-candidates", "--commit"],
        "description": (
            "[daily] Funding Opportunities: persist DIBBS client suggestions "
            "after the DIBBS bid-board sync (daily 13:15 UTC). "
            "Created DISABLED 2026-08-14. Out-of-band; not a CDK resource."
        ),
    },
    {
        "id": "GenerateSbirOpportunityCandidates",
        "name": "fo-dev-generate-sbir-opportunity-candidates",
        "schedule": "cron(35 13 * * ? *)",
        "command": ["generate-sbir-opportunity-candidates", "--commit"],
        "description": (
            "[daily] Funding Opportunities: persist SBIR/STTR client suggestions "
            "after the SBIR/STTR sync (daily 13:35 UTC). "
            "Created DISABLED 2026-08-14. Out-of-band; not a CDK resource."
        ),
    },
]


def rule_body(job: dict) -> dict:
    return {
        "Name": job["name"],
        "ScheduleExpression": job["schedule"],
        "State": "DISABLED",
        "Description": job["description"],
        "EventBusName": "default",
    }


def targets_body(job: dict) -> dict:
    return {
        "Rule": job["name"],
        "EventBusName": "default",
        "Targets": [
            {
                "Id": f"{job['name']}-fargate",
                "Arn": CLUSTER_ARN,
                "RoleArn": INVOKER,
                "Input": json.dumps(
                    {
                        "containerOverrides": [
                            {"name": CONTAINER, "command": job["command"]}
                        ]
                    },
                    separators=(",", ":"),
                ),
                "EcsParameters": {
                    "TaskDefinitionArn": TD,
                    "TaskCount": 1,
                    "LaunchType": "FARGATE",
                    "PlatformVersion": "LATEST",
                    "NetworkConfiguration": {
                        "awsvpcConfiguration": {
                            "Subnets": SUBNETS,
                            "SecurityGroups": [SG],
                            "AssignPublicIp": "DISABLED",
                        }
                    },
                    "EnableECSManagedTags": False,
                    "EnableExecuteCommand": False,
                },
            }
        ],
    }


def main() -> None:
    index = []
    for job in JOBS:
        rule_path = HERE / f"{job['name']}.put-rule.json"
        tgt_path = HERE / f"{job['name']}.put-targets.json"
        rule_path.write_text(json.dumps(rule_body(job), indent=2) + "\n", encoding="utf-8")
        tgt_path.write_text(json.dumps(targets_body(job), indent=2) + "\n", encoding="utf-8")
        index.append(
            {
                "cdkId": job["id"],
                "ruleName": job["name"],
                "schedule": job["schedule"],
                "command": job["command"],
                "putRule": rule_path.name,
                "putTargets": tgt_path.name,
            }
        )
    (HERE / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(JOBS)} rule + {len(JOBS)} target files + index.json")


if __name__ == "__main__":
    main()
