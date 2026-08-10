# Applying capiro-dev migrations — the exact commands

**Always via `capiro-dev-api-migrate`. Never `capiro-dev-api-admin-migrate`** — that
second family's rev 9 runs `prisma migrate resolve --rolled-back <name> || true`
before every deploy, silently auto-resolving the ledger. `capiro-dev-api-migrate`
routes through the entrypoint's `migrate` verb, which never auto-resolves a
failed migration (see `docs/plans/funding-opportunities-makegov-v1/decision-log.md`
D-70, and the entrypoint's own Phase A hardening in `apps/api/scripts/entrypoint.sh`).

## 1. Build and push the image migrations will run from

```bash
export AWS_PROFILE=capiro-dev
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 967807252336.dkr.ecr.us-east-1.amazonaws.com

REPO=/path/to/a/clean/detached/checkout/of/capirov2  # NOT one on a feature branch
SHA=$(git -C "$REPO" rev-parse HEAD)
ECR=967807252336.dkr.ecr.us-east-1.amazonaws.com

docker buildx build --platform linux/arm64 -f "$REPO/apps/api/Dockerfile" \
  -t "$ECR/capiro/dev/api:latest" -t "$ECR/capiro/dev/api:$SHA" \
  --push "$REPO"
```

Cross-building arm64 on an x86 box runs under emulation — expect ~2 minutes.

**Use a clean checkout of a real, pushed commit — never a local commit that has
not been pushed to `origin`.** A build tagged with a SHA that exists only
locally is indistinguishable, later, from a legitimate build — the tag looks
exactly like every other commit-SHA tag until someone tries to `git show` it
and finds nothing. This actually happened: see decision-log D-73, where a
`capiro/dev/api:latest` repush left the tag pointing at a build matching no
commit anywhere in the repository (720 branches checked), which then made an
unrelated task family fail two build/verb hypotheses down before the real
cause surfaced. Confirm `git merge-base --is-ancestor <sha> origin/main` (or
equivalent) BEFORE trusting a tag's SHA to mean what it looks like it means.

## 2. Point `capiro-dev-api-migrate` at that image

There is no `--container-image` flag on `register-task-definition`; the family's
current definition has to be fetched, edited, and re-registered.

```bash
aws ecs describe-task-definition --region us-east-1 \
  --task-definition capiro-dev-api-migrate \
  --query 'taskDefinition' --output json > /tmp/migrate-td.json

node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync("/tmp/migrate-td.json","utf8"));
d.containerDefinitions[0].image = `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api:${process.argv[1]}`;
for (const f of ["taskDefinitionArn","revision","status","requiresAttributes",
                  "compatibilities","registeredAt","registeredBy","deregisteredAt"]) delete d[f];
fs.writeFileSync("/tmp/migrate-td-new.json", JSON.stringify(d));
' "$SHA"

aws ecs register-task-definition --region us-east-1 \
  --cli-input-json file:///tmp/migrate-td-new.json \
  --query "taskDefinition.{family:family,rev:revision,image:containerDefinitions[0].image}"
```

**Prefer pinning by digest over `:<sha>` tag when the task definition will be
reused across multiple runs** (anything other than "use it once, right now").
A tag — including a commit-SHA-shaped one — can be repushed and silently point
somewhere else later; a digest (`...api@sha256:...`, read back from the
`register-task-definition`/`describe-images` response after the push above)
cannot. For a one-shot migrate run immediately after building, the SHA tag is
fine because nothing has had a chance to repush it yet.

**Watch the file encoding if editing on Windows.** `Out-File -Encoding utf8` in
PowerShell 5.1 writes a BOM, which `--cli-input-json file://` rejects as invalid
JSON. Use UTF-8-no-BOM (`[System.Text.UTF8Encoding]::new($false)`), the Edit
tool, or Node/Python as above — never a PowerShell text cmdlet for this file.

## 3. Run it

```bash
NETCFG='awsvpcConfiguration={subnets=[subnet-0e38bd390f8961fef,subnet-0920665f91c905f01,subnet-06db79cd21239de19],securityGroups=[sg-01def4e5c0fe44d4a],assignPublicIp=DISABLED}'

TASK_ARN=$(aws ecs run-task --region us-east-1 --cluster capiro-dev \
  --task-definition capiro-dev-api-migrate \
  --launch-type FARGATE --network-configuration "$NETCFG" \
  --query 'tasks[0].taskArn' --output text)
TID="${TASK_ARN##*/}"

# Poll rather than `aws ecs wait tasks-stopped` — its ~600s budget can expire
# on a slow image pull and abort a migration that is actually fine.
while :; do
  ST=$(aws ecs describe-tasks --region us-east-1 --cluster capiro-dev \
        --tasks "$TID" --query 'tasks[0].lastStatus' --output text)
  [ "$ST" = STOPPED ] && break
  sleep 10
done

aws ecs describe-tasks --region us-east-1 --cluster capiro-dev --tasks "$TID" \
  --query 'tasks[0].{exit:containers[0].exitCode,reason:stoppedReason}'
```

Exit code `0` with `"reason": "Essential container in task exited"` is success.
**This is the wrapper script's own exit code check, applied to the JSON field
above — not the shell command's own `$?`.** A polling loop like the one above
always exits 0 itself if it reaches its `echo` cleanly; the field to check is
`containers[0].exitCode` inside the printed JSON, every time, even when the
surrounding script "succeeded."

## 4. Confirm what actually happened — read the log, don't trust the exit code alone

```bash
aws logs get-log-events --region us-east-1 --log-group-name /capiro/dev/api \
  --log-stream-name "api/api/$TID" --start-from-head \
  --query "events[].message" --output text
```

Look for one of:

- `No pending migrations to apply.` — nothing was pending. This is what a clean
  system reports; it is NOT evidence anything is broken.
- `The following migration(s) have been applied: <name>` — lists every migration
  that ran, by name. `prisma migrate deploy` always names what it applies, so
  an empty list plus exit 0 means genuinely nothing was pending, never a silent
  skip.

**Do not infer migration state from `completion-matrix.md` or any other doc.**
D-70 recorded three matrix cells that said "not applied" while the database had
already applied everything — the doc was stale and nobody had re-checked it
against the system. The check above costs one task run; trust it over any prose
claim, including this file's own, if the two ever disagree.

## Known-clear as of 2026-08-09

Confirmed by the method above, not asserted: `capiro-dev-api-migrate` revision
55 (image `90f01afaa440aad1e3b7f15a2b4c077a225849c2`) reported
`256 migrations found / No pending migrations to apply`. Diffed
`apps/api/prisma/migrations/` between that commit and current `main`
(`130e93a9`) and found zero new migration directories — so as of this writing,
re-running the migrate task is expected to be a no-op. It is still run as part
of every deploy, because "expected to be a no-op" and "confirmed a no-op" are
different claims, and the second one is free to check.
