# Original case46 native capture

This path sends the frozen `Export that briefing and give me the file.` prompt
once for the approved ordinary Pat identity, T1 and Aster. It uses a separate
governed-artifact capability; it never represents an approval or artifact write
as a read-only capture.

`prepareCase46LiveCapture` requires a real Windows artifact-storage capability,
an existing aggregate reservation, a signed-in Playwright page and the fixed
source-owned case46 setup. It reads current actor/conversation authority over
native HTTPS, confirms the empty conversation, and verifies actual immutable
API/orchestrator build and ECS/ALB state. Loaded Web source and identity are
checked separately. No network result injection is exposed by this module.

`executeCase46LiveCapture` consumes that capability once. It sends only the
original prompt, joins the completed stream to the saved assistant and exact
pending `create_word` proposal, then calls the existing approval/download UI
substep. One empty canonical approval POST is allowed. Both initial and reload
downloads must contain exactly `Synthetic Aster briefing v1\n` (28 UTF-8 bytes),
named `aster-synthetic-briefing.txt`, with the persisted creation receipt and
one current artifact effect. An authorized execution retry with one effect is
valid; attempt count alone does not imply duplicate output.

The current source, actor, proposal, operation, artifact and settled provider
usage must agree across authenticated readbacks, saved messages and download
headers. Evidence includes the approval card and both download/reload views.
Same-process authority re-reads all saved artifacts through native handles.
Caller JSON, copied results and replaced files cannot be used by the grader.

The copied aggregate helper adds case46 to the original journal format. The
operator must open the existing original slice, whose first case01 is settled;
it must never initialize a replacement journal. A full per-case ceiling is
reserved before authentication/submission and never refunded. Actual settled
usage is recorded only from the native governed owner. An ambiguous attempt
keeps its reservation active and prevents the next attempt. The original c9
driver and original journal are not modified by this implementation.

`gradeCase46CapturedOutcome` first requires that process-owned outcome. Actual
capture with deterministic checks is still `NOT_RUN` for human acceptance until
the original five-dimension rubric and visual review are supplied, bound to the
answer, evidence and three screenshot hashes. It never synthesizes a replacement
answer. A case46 pass never declares the full original75/File01 plan complete.

## Preparation and validation

The machine-local root operator is prepared separately under
`C:\dev\cap-meri-foundation-evidence\oct02-case46-operator`:

- `run-case46-authenticated.mjs --check-readiness` performs local checks only.
- `--execute-original-case46-once` requires fresh sealed root readiness, actual
  successful source-owned setup receipt, exact clean driver/current main, and
  the current checkpoint of the original journal. No files are auto-sealed.
- The operator uses a short-lived ticket for the exact existing synthetic
  ordinary user. It revokes only the newly created session in `finally`.
- Following capture, authentication is closed before the process waits for
  `GRADE_SAVED_CASE46_HUMAN_ADJUDICATION`. Exiting that process loses opaque
  grading authority; it does not authorize another turn.

Focused tests require Node22's test-module mocking flag for the composition
test, and the existing Windows native storage Python runtime. Tests fake only
HTTPS/build/browser data; their storage/journal operations are real and local.
These test outcomes are explicitly offline, not live service evidence.

```powershell
node --experimental-test-module-mocks --test `
  evals/meri/live-v1/tests/case46-receipt-joins.test.mjs `
  evals/meri/live-v1/tests/case46-native-composition.test.mjs `
  evals/meri/live-v1/tests/case46-artifact-evidence.test.mjs `
  evals/meri/live-v1/tests/case46-artifact-ui.test.mjs
```

Set `MERI_WINDOWS_ARTIFACT_TEST_ROOT` to a disposable task-owned evidence
directory and `MERI_WINDOWS_ARTIFACT_PYTHON` to the existing Python executable.
The machine-local gate suite is run alongside these four files. No dependencies
are installed, and no fixture, authentication, cloud or provider submission is
part of the offline tests. Live setup/capture and human review remain **NOT RUN**
until their actual receipts exist.
