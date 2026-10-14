# Finite successor startup source review

Exact PR16 `d15bba2cd75a8d36743e5d7a10eda346e4e48e2a`, tree `419e6d6dc9242bd85b578c267698918492f7365f`. Read-only: no source/ref edits, checks/startup, native/database/AWS/provider/HTTP/generation execution or credential-value lookup. Protected unpublished Engagement never read/hydrated. Root's evolving candidate and actual build/runtime results are not accepted by this note.

| Service | Published startup/mount | Existing runtime dependency |
| --- | --- | --- |
| Core | apps/api; build rootDir=src; serve dispatches node dist/main.js; /api:4000, /health carve-out; Docker22.23.3. | Config requires DATABASE_URL and existing Clerk secret/webhook bindings; Prisma init connects. Meri, WorkspaceAssistant and EngagementWorkers remain registered. |
| Workspace | /workspace-api:4200, /health carve-out; own generated client, auth/shared/meriv2-core artifacts. | Prisma init connects; required ORG_TENANT_RESOLVER precedes AuthModule, reusing ordinary membership/ACL. WEB_ORIGIN is existing cross-origin config; static defaults omit os.capiro.ai. |
| Strategy | /strategy-api:4400; /strategy-api/health; own generated client, auth/shared/strategy-verifier. | Prisma init connects. Watcher/outbox require STRATEGY_AGENTS_ENABLED and STRATEGY_WATCHER_SCHEDULER=true; reconciler additionally its own STRATEGY_RUN_RECONCILER flag. Default dark. |
| Intel | /intel-api:4300, /health carve-out, existing WS adapter; generated client/shared/meriv2-core. | Prisma init connects. HearingModule eagerly imports CaptureModule, which resolves Deepgram at Nest construction. MERIV2_ORCHESTRATOR_URL is request-time dependency. |

All four package/serve commands select node dist/main.js; migrate/seed are separate explicit branches. Docker recipes still run Prisma generation/downloads, unexecuted here. Preserve compiled support packages, package-local dependency links and matching generated-client/schema/native ABI. Local Node24 execution does not prove Docker/native acceptance.

## Concrete source gaps

Workspace pins20.16.0 while its direct frozen sanitize-html2.17.7 needs >=22.12 (Core already pins22.23.3 for that reason). Root's proposed Workspace alignment/pruned import probe addresses a real seam; image build remains unqualified. Strategy/Intel have no direct sanitize-html dependency; no blanket version change is inferred.

CaptureModule52–66 unconditionally awaits PublicCaptureCredentialsAdapter.resolve; adapter8 throws without DEEPGRAM_API_KEY. Unused capture therefore blocks unrelated Intel read startup. Existing PublicCaptureRuntimePort exposes only run(input); coordinator750 calls it after current demand/lease/fenced CAPTURING state. Minimum correction: keep the existing factory/token and return a run delegate that resolves the existing platform credential per run, checks existing billing/no-tenant invariant, constructs the existing runtime and forwards exact input. Check abort before/after await; propagate credential failure to existing fenced failure/bounded retry. No global key or rejected-promise cache; concurrent runs retain separate input/runtime/lease state. Direct CLI constructors/runtime class can stay unchanged. No new service/store/model/auth layer.

## Ownership and remaining qualification

Core preflight defaults: service=api, mode=active, backgroundOwner=api, externalActions=enabled, callbacks/Recall=true. Another Core with these defaults can arm existing Engagement loops. backgroundWorkersEnabled checks owner/service, not mode: shadow alone does not disable Core timers. Establish current owner and use existing ENGAGEMENT_BACKGROUND_OWNER/external-action/callback controls; preserve modules and ordinary user permissions. Meri lease sweeper is dark unless MERI_JOB_SWEEPER_ENABLED=true; OTLP export uses its existing endpoint opt-in. Inspected registered memory projection/notification services have no lifecycle timer. This finite review does not prove all transitive Core providers inert.

Native continuation needs admitted matching generated clients/schema/ordinary roles/engine and database, then serving image/origin and owned authenticated evidence. Cached Core schema missing UserPortfolioLayout is an artifact mismatch, not acceptance. No migration, mock success or new permission is inferred. Actual capture still requires admitted platform credentials/media/FFmpeg/Deepgram and current canonical demand/lease; deferred credential resolution grants no authority.

## Key Git metadata

- apps/api/src/engagement/runtime/engagement-runtime-policy.service.ts `c8ca62c522c1dd10e9c3876182c79421f4cf9ca4`
- apps/workspace/Dockerfile `095eda0b4c260c22a7aa6043817f1470fbfb4734`
- apps/intel-api/src/hearing/capture/capture.module.ts `431ff96511d732195ec8d42269504ccfa7177370`
- apps/intel-api/src/hearing/capture/public-capture-credentials.adapter.ts `39f614af9662e0fecc8caac39b1e00e13120b496`
- apps/intel-api/src/hearing/capture/public-capture.orchestrator.ts `e0dd174e2709b3399d483ed8aed767377a1f4f49`
- apps/intel-api/src/hearing/capture/ffmpeg-deepgram-capture.runtime.ts `7940a7b8b3fa6ce76c2a4db5d6d8a095a34fd766`

Discovery-only failures are retained in transcript: runtime.service path (actual runtime-policy.service), worker filename guess (actual public-capture.orchestrator), literal-brace package path, and initial review-note size assertion. Corrected finite reads/writing succeeded; none is a build/test/startup failure.
