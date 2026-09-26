# Meri orchestrator compliance audit wiring cleanup

At source HEAD `0e95feb74`, `ApiComplianceAuditRepo` was registered in the Meri
module and injected into `ChatAssistantService`, but no runtime path called its
`record()` method. The repo and its unused dependency wiring were removed.
The repo-only impersonation passthrough spec was removed with that class;
tool-executor and action-proposal passthrough coverage remains.

The API `/api/clio/compliance-checks` contract and storage remain unchanged.
The orchestrator's separate `auditChatReply` / `persistChatAudit` path also
remains unchanged. Held write proposals continue to be recorded by the API's
durable proposal transaction.

This source-only cleanup was reviewed with reference searches and
`git diff --check`; Jest, Node, typecheck, build, database, Docker, browser,
provider, and live QA checks were deferred under the active hold.
