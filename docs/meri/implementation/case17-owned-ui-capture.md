# Case 17: owned pending proposals and saved UI grading

This is a prepared case 17 path, not a live acceptance result. It makes no model
call or chat turn. Cases 14 and 12 are not completed by this path.

The existing approved synthetic Priya identity has the existing `user_admin`
membership in `meri-foundation-20260928-t1`. Setup and readback compare this role,
the Clerk identity, active membership, selected clients and ethical walls against
current database rows. They do not change a role or grant. Case 14 continues to
require the ordinary Pat `standard_user` identity.

## Setup and current authority

Use the existing fixed `meri-pending-memory-setup` entrypoint with `plan`, then
the reviewed `execute` input. The CLI accepts a recipe file or its exact fixed
input environment variable; see its `--input-env` parser. Never retry an
ambiguous execution. Its source owner creates the six frozen case 17 proposals
through the actual candidate service and stores the validated recipe locator in
the durable operation claim. A completed operation can be read after process
restart without accepting a submitted receipt as authority.

The CLI now binds the actual tenant context and memory-governance tenant context
after current actor and client checks. The shared case 01 factory's ordinary-user
conversation path is unchanged.

`GET /api/memory/proposals` retains its ordinary response. Only the approved
synthetic proposer with the completed case 17 locator receives the optional
`fixtureEvidence`. The service reconstructs the frozen manifest and reads the
actual current candidate owner before returning it. Missing, modified, revoked,
foreign or stale authority cannot be asserted through a request parameter.

The actual PostgreSQL regression exercises setup, a fresh service instance,
three API pages containing the exact six own proposals, the completed locator,
active-role/Clerk/wall checks, and ordinary or foreign callers. The pagination
check includes own personal proposals and excludes another actor's private rows.

## Single owned capture and offline grading

The operator imports `collectCase17LiveCapture` from
`evals/meri/live-v1/case17-live-capture.mjs`. Supply:

- `config`: schema version 1, case `17`, target `https://os.capiro.ai`, a new
  capture UUID, the exact setup recipe and approved Clerk organization ID.
- `config.limits`: concurrency 1, `maxSynthesisSubmissions: 0` and
  `maxApplicationWrites: 0`.
- `config.deployment`: current API and Web source SHAs and, for each service, the
  actual successful CodeBuild ID, exact buildspec SHA256 and ECR digest.
- `artifactStorage`: an actual capability returned by
  `createWindowsArtifactStorage` for a fresh task-owned local output directory.
- `createSignInTicket(clerkUserId)`: the existing private credential mechanism,
  returning only the ephemeral ticket without logging or saving it.
- `onSessionCreated(sessionId)`: register the new session for independent backend
  revocation on failure or process interruption. Do not save the session in public
  evidence or reuse a personal browser session.

The collector owns a fresh Playwright context. It verifies live API and Web
source/build/digest/health through native read-only AWS calls, verifies the
loaded Web release, authenticates the exact approved actor, and performs native
authenticated HTTPS reads only on `/api/me` and the own-proposals route.
Application writes and chat turns are blocked. Clerk operations are restricted
to the exact HTTPS frontend host; application main-frame navigation stays on
`os.capiro.ai`. No page, transport or owner callback can be supplied to this
authority factory.

Both the initial page and reloaded page must show all six proposals with their
correct scope, source, client labels and enabled Withdraw controls. The operator
does not click Withdraw. The collector follows bounded API/UI pagination,
binds each physical candidate to its frozen logical source, saves twelve card
screenshots, checks unchanged current owner evidence and unchanged deployment,
and revokes the new session before returning `CAPTURE_COMPLETE`.

Keep that returned opaque outcome in the same process. Pass it to
`gradeCase17CapturedOutcome`; copying JSON cannot mint capture authority. Grading
re-reads the native immutable evidence and screenshot bytes and never sends
another turn. Without a saved visual review it reports deterministic `PASS` and
overall `NOT_RUN`. A visual review binds the exact evidence hash, capture UUID,
twelve screenshot hashes, reviewer, reference, rationale and review time. Its
two explicit judgments cover correct visible cards/provenance and actions after
reload. A completed grade applies only to row 17, never the whole File 01 plan.

The module is prepared for an actual operator run. Local scope, integrity,
pagination, role, owner and grading tests do not claim authenticated browser
execution or production acceptance.
