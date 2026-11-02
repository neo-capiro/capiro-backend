# Audited HQ support sessions

The supported impersonation surface is a read-only client roster. Core derives its tenant from an exact saved `ImpersonationSession` owned by the current HQ administrator. The caller remains authenticated as that administrator in their home tenant; no target membership is created.

- `POST /capiro-admin/impersonate`: UUID request identity, target tenant and a 10–500 character reason. Repeating the same command returns its original session; replacement ends and audits earlier sessions. Lifetime is one hour.
- `GET /capiro-admin/impersonate`: recover the current server selection across tabs. Expired sessions receive one audited end; an inactive target is unavailable.
- `GET /capiro-admin/impersonate/:sessionId`: recover exact metadata, including ended and expired states.
- `GET /capiro-admin/impersonate/:sessionId/workspace`: read up to 50 current nonarchived clients, with an explicit next cursor. The query pins the stored tenant and applies client ethical walls to the real actor. Only client ID, name, status, website and update time are returned.
- `POST /capiro-admin/impersonate/end`: close only the named session. Repeated exits are harmless; an old tab cannot close a replacement.

The session owner verifies current native authentication and current HQ membership around its transaction. An actor lock serializes start, replacement, use and exit; workspace reads stabilize target availability. Start, end and each supported workspace read use the existing audit table, with the actual actor, target tenant and session. Read audits contain counts, not returned client content. All responses are noncacheable.

Ordinary application routes refuse both legacy tenant-impersonation headers and session-impersonation headers. The former automatic tenant override was removed. Personal settings, editing, approvals, Meri and other modules are outside the supported surface. Existing signed retained-authority records still receive their original current-state and expiry checks; no new impersonated retained authority is issued.

The frontend replaces the ordinary application with a persistent acting-as/expiry banner and roster, provides exact exit, and remounts query/request providers on scope changes. Cross-tab messages trigger a server read; five-second polling and focus rechecks cover missed messages. The local expiry clock hides data even while disconnected. Start recovery uses the shared encrypted command journal and original request UUID. Browser storage and messages convey intent only; each supported data request must pass the Core session owner.

Source checks do not qualify a deployed release. Connected-host acceptance remains separate.
