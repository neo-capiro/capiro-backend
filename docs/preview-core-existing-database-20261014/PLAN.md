# Existing-database Core preview source proposal

Base: backend PR22 `2875afa0cf65053b5faa2b29e742c81cba446931`. The user permits ordinary preview writes to the existing database, including account metadata. Preserve the existing Clerk/tenant/client controls. No new isolated database is a prerequisite.

Keep the existing three-service isolated proposal available as historical optional source, correcting its Core platform, health, signing-reference and runtime controls. Add an opt-in Core-only composition that imports existing cluster/VPC/subnets/security group/execution role/task role and secret references. It creates only a new held task definition/service/target group/host rule; no database, credentials, IAM grants, networking, production-service update or migration is synthesized. Exact source/image and metadata bindings are supplied explicitly and validated before constructing a CDK App.

Reuse canonical environment switches, not a new application/auth/worker owner. The new service is ARM64, serves ordinary Core, uses `/health`, and starts with zero tasks. Background timers/email delivery/provider actions remain disabled. Ordinary authenticated account/data writes remain allowed by the current handlers.

Verification: closed metadata refusal, synthetic template resource boundary, held count/platform/health/secrets, canonical worker-control provenance, unchanged auth/migrations/lock, current source custody. Runtime/schema/image/Clerk/DNS/TLS acceptance remains shipping work. Independent review of the exact returned commit is required before promotion.
