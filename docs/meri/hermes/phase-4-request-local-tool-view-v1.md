# Phase 4 request-local tool view v1

Status: local, opt-in worker-overlay prototype; **schema narrowing is not active
in the default worker image or application path**. No deployment or live QA is
included.

`compileMeriHermesToolViewV1` builds an immutable per-run list from the
intersection of the versioned canonical catalog, deployment ceiling,
server-resolved authorization, and current availability. It includes every
eligible required dependency and eligible run-local clarification/recording
tool, then adds only eligible relevant tools. A required dependency missing
from any gate fails the run-local compilation; a catalog mismatch also fails.
Relevance never grants authorization. The existing broker rechecks execution
authorization and remains the source of permission decisions.

`MeriHermesRuntimeClient.createRunWithToolView` is disabled by default. With
`MERI_HERMES_TOOL_VIEW_V1_CLIENT_ENABLED=1`, it first checks the worker's
authenticated `/v1/capabilities` response for the explicit v1 feature and
then signs an input-bound, one-minute policy using the existing worker API
credential. It refuses an unextended worker. The legacy `createRun` path is
unchanged for routing-off parity. Neither path sends generic `tools` or
`enabled_toolsets` fields to the pinned worker.

## Worker overlay prototype

The pinned base image contains source at `/opt/hermes`, so a repo-owned image
layer can patch exact upstream files. Set build argument
`MERI_HERMES_TOOL_VIEW_V1_OVERLAY=1` to run the checksum-gated patch script;
its default is `0`. The patched worker accepts `meri_tool_view_v1` only with
`MERI_HERMES_TOOL_VIEW_V1_ENABLED=1` and a valid HMAC, expiry, and input hash.
It attaches the view to one `_RunLaunch` and one `AIAgent`, filters its loaded
native/plugin/memory/context schemas, reapplies the filter before each
provider request, checks the final provider tool payload immediately before
every custom/OpenAI transport call (including stream attempts and iteration
summaries), and blocks tool
invocations outside the view. Background review forks inherit the view.
Tool-search/delegation bridges are refused in v1 because they can dispatch
tools outside the top-level schema. Other providers/modes fail closed for a
narrowed run. The pinned `try_activate_fallback` path returns without changing
provider/model for narrowed runs; both streaming and non-streaming dispatch
also reject an out-of-band provider or mode change before transport. No shared
profile or registry is changed.

The source of truth is the archive fetched by `build-base.sh` from
`https://github.com/NousResearch/hermes-agent/archive/refs/tags/v2026.9.14.tar.gz`,
SHA-256 `47df72ebd3f9c96d806a94541163f7fe7d7ce5b84f85c1d3787e6dfeea1d7834`.
That archive contains `agent/turn_api_request.py` (SHA-256 `524b412e...`).
The local `.orchestration/hermes-gap-closure/pinned-upstream-source/src` mirror
contains only files chosen by an earlier selective extraction; its lack of
that file does not represent the Docker build context. The overlay test reads
each patched file directly from the exact archive and rejects hash/anchor
drift. `agent/chat_completion_helpers.py` owns the final transport calls;
`agent/turn_api_request.py` remains an early per-attempt filter only.

This prototype has a local pinned-image contract run, but is not wired into
Meri's application path and is not ready for deployed use. Local archive tests
execute the patched non-stream and
stream transport functions with a fake provider: a widened second attempt is
blocked before the fake SDK receives it. The same archive test executes the
patched fallback transition toward Anthropic and confirms it is refused before
state mutation, then checks that an out-of-band mode change is rejected by
both dispatch entries. They alone do not verify a running `AIAgent` or provider
request; the opt-in built-image harness below covers two overlapping synthetic
`/v1/runs`. MCP refresh and background-review behavior remain separate
unverified cases.
The application runtime adapter does not call `createRunWithToolView` yet;
Phase 3/4 routing must supply a current authorized/available catalog snapshot
and required dependencies. The current `createRun` remains the default.
An isolated follow-up source change adds a worker-owned catalog digest handshake.
On the opt-in worker, authenticated `/v1/capabilities` advertises a SHA-256 of
its raw, enabled API-server tool definitions (full schemas, sorted by name)
without listing tool names. The capability probe uses the same
`sorted(_get_platform_tools(_load_gateway_config(), "api_server"))` selection as
ordinary `/v1/runs` agent creation in the pinned source. The disabled overlay
advertises `supported:false` without loading gateway configuration or the raw
tool registry. The API signs that
digest alongside its own `catalog_version`, and the worker compares it with a
fresh agent-specific registry snapshot before exposing tools to a provider. It rechecks
before provider requests and tool calls. A changed MCP or registry schema,
different effective toolset, missing selected name, or changed selected
provider schema fails the narrowed run. The SHA-256 covers schema content;
it does not attest handler behavior or live connector availability. The
worker no longer accepts selected tools that exist only in run-local
memory/context additions outside its raw registered catalog; those tools need
their own versioned contract before they can be selected.

The upstream files this handshake depends on are pinned by SHA-256 at overlay
build time: `model_tools.py` (`c99620c8...e4b5`) and the custom chat transport
(`87f392e9...ec60d`). The pinned `model_tools.py` defines `None` as all
toolsets, which is why the capability probe must pass the API-server toolset
list explicitly. The pinned chat transport passes OpenAI-format tool schemas
through for the normal custom-provider path. The final payload check catches
later middleware/provider rewrites; any selected schema rewrite fails closed.

This follow-up is **source-only and unverified** under the current memory
constraint. Its edited tests, pinned-image build, concurrent contract harness,
MCP refresh and background-review checks have not run. The application runtime
adapter still does not call `createRunWithToolView`. The API's canonical
`catalog_version` still must come from the trusted capability registry in that
future adapter; the worker verifies only its own signed catalog digest, not
Meri permission or availability. Broker invocation authorization continues to
recheck permissions for Meri tools. A provider transport that rewrites a
selected schema will fail closed at the final payload check until an explicitly
versioned transform is added and tested.

The earlier built-image contract predates this digest field and cannot qualify
the new handshake: its image advertises no digest, so the new API client
deliberately rejects it. Rebuild from this exact source and rerun authenticated
capability discovery plus the concurrent signed-run contract before crediting
this revision. The worker overlay now recognizes an exact signed-body resend
before checking the resent token's expiry or current worker catalog. It first
verifies the HMAC, policy structure and input hash. Hermes' native authenticated
scope, idempotency key and whole-body fingerprint must match a durable run
record updated within its retention window. A different body or newly signed
expiry does not match and cannot replay. A missing key, expired token or stale
catalog still follows the normal new-run checks; the reservation race uses the
same durable replay guard. The worker store persists a fingerprint and run
status, not the request body. This change is source-only and has not passed a
pinned-image build or live acceptance run.

The API client currently signs a new `expires_at` on every
`createRunWithToolView` call, so its lost-response retry changes the body and
will receive an idempotency conflict. The API needs durable reuse of the exact
signed request body, or a separately reviewed semantic idempotency protocol,
before this path is activated. No cross-system canonical catalog equality or
dynamic connector availability is claimed here.

A separate source-only defensive client check now requires an explicit
idempotency key and a worker capability response advertising supported,
durable run idempotency with at least 86,400 seconds of retention before this
opt-in method signs a view. It refuses memory-fallback or short-retention
workers. This does **not** persist the exact outbound body, make retries safe,
prove retention in the running worker, or activate the method. The new
regressions and integrated typecheck are paused with the user's test hold.

The existing hosted-room `RoomExecutionPolicy` is a distinct authenticated
path and does not make general `/v1/runs` request filtering available.

Local contract tests cover independent snapshots, downward-only intersection,
required tool retention/failure, stale-catalog failure, no network call when
disabled, and unchanged legacy request serialization. Worker overlay tests
cover HMAC rejection, per-agent schema filtering, provider payload checks,
invocation rejection, and concurrent run isolation for the synthetic contract.
End-to-end catalog/version agreement and deployed runtime wiring remain Phase 4
acceptance blockers.

## Opt-in built-image contract harness

`apps/api/scripts/meri-hermes-phase4-image-contract.ts` is the local-only
built-image acceptance harness. It is inert by default. To execute it, both
`--run` and `MERI_HERMES_PHASE4_RUN=1` are required, and
`MERI_HERMES_PHASE4_IMAGE` must name an image already built locally. The
harness never builds or pulls an image. It checks the image's pinned upstream
commit and `ai.capiro.meri.tool_view_v1_overlay=1` label before creating any
resource.

Build a uniquely tagged image with the overlay enabled (the regular
`build-base.sh` worker-layer step defaults the overlay off):

```powershell
docker build -f docker/hermes-worker/Dockerfile `
  --build-arg HERMES_BASE_IMAGE=meri-hermes-worker:v2026.9.14 `
  --build-arg MERI_HERMES_TOOL_VIEW_V1_OVERLAY=1 `
  -t meri-hermes-worker:phase4-contract-local docker/hermes-worker
$env:MERI_HERMES_PHASE4_IMAGE = 'meri-hermes-worker:phase4-contract-local'
$env:MERI_HERMES_PHASE4_RUN = '1'
pnpm --filter @capiro/api exec tsx scripts/meri-hermes-phase4-image-contract.ts --run
```

The image must already be present; use the exact pinned base built from the
SHA-256-verified v2026.9.14 archive. The test creates only uniquely labeled
containers, a labeled named volume, and a Docker `--internal` network. A fake
provider and broker run in a second container using the same already-built
image; the worker has no real provider key, AWS credentials, external provider
URL, browser, or production endpoint. Docker does not publish ports from an
internal network, so the harness sends its synthetic HTTP probes through a
bounded one-shot `docker exec` bridge mounted read-only in each container.
Neither container has host-published ingress or network egress. Both fake
endpoints record only synthetic case markers, schema names, and broker
method/path counts. The fake provider
holds the first requests until both distinct runs arrive, then calls each run's
allowed tool and deliberately attempts the other run's tool. Acceptance
requires exactly disjoint schemas on every provider attempt, successful
completion of both runs, one fake-broker request per allowed tool, and zero
broker effects for the cross-view calls. Runs have a 60-second terminal
deadline; failed runs are stopped by exact run ID. Teardown verifies the
unique ownership label before removing only these containers, network, and
volume; it never prunes images or shared Docker resources.

The first built-image run exposed a difference between `/v1/toolsets` and
`AIAgent`'s model-visible `agent.tools`: the endpoint advertised Meri's broker
plugins, but a signed required Meri tool failed closed before provider dispatch
with `required_tool_unavailable_in_worker`. A temporary experiment adding
`meri` to the shared API-server platform toolsets did not resolve it and was
removed; it is not part of this package. The pinned worker's
progressive `tool_search` can defer plugin schemas from `agent.tools` even when
they are registered. The overlay now reads the same run's raw enabled/disabled
registry snapshot with `skip_tool_search_assembly`, intersects it with the
signed request-local view, and rejects conflicting or missing required schemas.
This never widens past the signed view or changes the shared registry; broker
authorization remains a separate ceiling. Before the hook repair, four fresh
concurrent fake-provider/broker runs passed twice and failed twice because
Hermes' shared `pre_tool_call` callback was still running and blocked an
otherwise allowed tool. Both failures were fail-closed. The opt-in overlay now
serializes callbacks by identity at the shared dispatcher while the runtime
feature flag is on, for signed and unsigned runs alike. Each waiter consumes
the same monotonic deadline as its callback; timeout or late completion still
fails closed and suppresses reuse. With the flag off, Hermes' original
immediate-skip behavior is retained. The patch never retries a tool handler or
broker write. Five built-image adversarial dispatcher tests pass, including a
late policy result that must not be accepted; three concurrent synthetic runs
passed after the initial repair and the exact final image passed twice after
the late-result fix. Independent read-only review found no remaining race in
that path. This is local contract evidence only, not production acceptance.

This is still a local contract test, not production evidence or authorization
to deploy. Run the static guardrail test with
`node --test apps/api/scripts/meri-hermes-phase4-image-contract.guardrails.test.mjs`;
that test does not invoke Docker. The dispatcher regression suite
`docker/hermes-worker/overlay/test_hook_dispatch_serialization.py` runs inside
the overlay-enabled image with `--network none` and no credentials.
