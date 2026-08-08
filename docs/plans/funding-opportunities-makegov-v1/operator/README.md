# Operator tooling — P17 Tango capability probe

Two files, one job: let a human answer "is this account entitled to a Tango
dataset?" without the API key ever reaching a terminal, a transcript, or a
saved report.

| File | What it is |
|---|---|
| `run-p17-probe.ps1` | The probe runner. All logic and all guards live here. |
| `p17.cmd` | Thin double-clickable wrapper. Resolves the `.ps1` next to itself. |

```
docs/plans/funding-opportunities-makegov-v1/operator/p17.cmd
```

Run it with no arguments and it probes the checkout it lives in. Pass a repo
root as the first argument to probe a different one.

---

## Who may run this

**An operator, at a keyboard.** Plan §4.6 forbids a Tango key passing through
an agent session, and the standing `capiro-dev` AWS approval does **not**
override that. An agent may edit these files; it may not run them.

## What it does and does not touch

Read-only. Every call is a GET or the smallest possible LIST — no
create/update/delete is ever issued. The key is fetched from Secrets Manager
(`tango`, plain string, `us-east-1`, profile `capiro-dev`) into a variable,
exported for the child process only, and cleared in a `finally` that runs on
failure too. Only its character count is ever printed.

## Three rules that are load-bearing

**`--request-ceiling` is 25, never 30.** The account is capped at 25 requests
per ~31s (D-65). A ceiling of 30 sits *above* the provider's own limit, so the
self-imposed cap can never bind — that is the defect D-65 fixed in the probe's
default, and an explicit `30` from a launcher reinstates it. A full pass needs
~17 calls and fits on a fresh window; the 2026-08-08 run started at
`remaining: 12` and died on its last probes.

**A report is a record, not a scratch file.** `OutFile` is timestamped per run
and the script refuses to overwrite an existing one. This was a fixed filename
until 2026-08-08, which meant the next run silently destroyed the previous — and
the 2026-08-08 run is the only live-provider evidence this program has. Same
reasoning as leaving `p17-tango-capability-report.json` (2026-08-07) unmodified
despite two superseded rows: editing or clobbering a captured artifact is how
records stop being evidence. Reports default outside the repo so one is never
committed by accident.

**A pre-P40 checkout produces a non-answer that reads like an answer.** Without
`apps/api/src/external/tango/tango-dibbs.client.ts` the probe still runs and
reports `dibbs: not_attempted / no_rest_client_wired`. That is a fact about
Capiro's code, not about the provider's entitlement — the D-64 confusion, one
layer out. The script hard-fails instead. Point it at a checkout containing
merge commit `094daf1d` (PR #857) or later.

## Choosing a checkout

Do **not** point this at a working checkout sitting on a feature branch: a dirty
tree makes the run unreproducible, and a branch off an older base may predate
P40. A detached worktree at a known commit is the reliable shape.

```bash
git -C <repo> worktree add --detach C:\dev\capiro-p17-wt origin/main
```

Then `pnpm install --frozen-lockfile` inside it. Note that `git worktree add`
cannot check out a branch another worktree already holds, which is why
`--detach` at a commit is the form used here.

## Reading the result

The `dibbs` row is the point. `supported` answers P40's entitlement question,
and because the probe calls through `TangoDibbsClient` — which throws when a 200
carries no `results` array — a successful run also confirms the pagination
envelope against a live response.

Scope that precisely: the probe captures **no response bodies**, so it confirms
the *envelope* only. Mapper field types, null semantics, and date formats remain
readings of published names until full contract validation records actual record
contents. That validation is still the real gate.

An envelope mismatch is a contract finding: update `dibbs-sbir-rest-contract.md`
and capture a fixture. Never widen the client to accept both shapes.

## ASCII only

PowerShell 5.1 reads a BOM-less UTF-8 file as Windows-1252, so an em-dash
becomes three bytes whose embedded quote breaks parsing several lines later —
reported against the wrong line. Keep `.ps1` and `.cmd` here ASCII, plain
hyphens only. (This `README.md` is not executed and may use whatever it likes.)
