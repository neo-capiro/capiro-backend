# Authenticated website workflow configuration

Core owns tenant-scoped configuration. Current active Capiro administrators use
`GET/POST /clio/site-workflows`; every save (including disable) adds an immutable
revision using an expected base version. The revision is also the exact request
receipt, so retry/readback cannot manufacture a second change or overwrite a
concurrent edit. No separate mutable approval or current-version ledger exists.
`POST /clio/site-workflows/requests/read` accepts a requestId and returns its original
receipt only to the currently authorized administrator who saved it.

Trusted runtime callers use `POST /clio/site-workflows/runtime/list` with
`{conversationId}`, or `runtime/read` with `{conversationId,selection}`. Both require
ordinary Core user authentication and the verified existing service identity.
Current conversation ownership, active tenant/membership and client/wall access
reuse the canonical conversation-management authorization. A selection contains
siteId, workflowId, version and the RFC8785 manifest SHA256. Disabled or revised
selections are refused. Runtime must re-read at each tool boundary.

The browser-safe shared contract admits HTTPS DNS origins, explicit tools,
mandatory per-interaction approval, bounded downloads and 1-minute to 8-hour idle
session retention. Closed objects carry no credential/session-storage fields.
Enabling requires terms-review and qualification evidence references. These are
configuration records, not evidence that an editor/browser host is operational.
Runtime retains the platform-origin ceiling, credential confidentiality, approved
takeover host, per-call approval and session destruction enforcement. Admin
configuration cannot widen those controls. No credentials are collected here.

The SQL forward migration gives capiro_app SELECT/INSERT only and forces tenant
RLS. Ordinary-role PostgreSQL tests cover CAS, exact replay/readback, role and
membership withdrawal, client walls, conversation ownership, disabling and RLS.
Tests use only the explicitly named local disposable database. No deployment,
live website interaction or host qualification is asserted by these tests.
