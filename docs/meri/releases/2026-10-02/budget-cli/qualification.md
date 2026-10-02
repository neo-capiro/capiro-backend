# Budget installer tenant binding qualification

Code source `5aefd34e86c84293436b42b366d599e1867f4e94` fixes the operator CLI missing its explicit memory-governance tenant context. It uses the existing two-tenant cohort and canonical identity/namespace validation. No cohort, actor permission, provider, schema or model setting changes are included.

The actual CLI regression failed before repair and passed afterward against owned local PostgreSQL transactions. Independent Hermes/Bedrock Kimi source review exited 0/PASS. Root integration verification passed 13 Node assertions with no skips, including the actual CLI plan/install and setup/hydration boundaries; all 26 deterministic Promptfoo cases and the custom verifier passed. Exact commands, exits and log hashes are in the accompanying receipts. The preceding full qualification at `1d54ac1a95c7a2fb5184cee5af944891a0dba255` remains applicable to unchanged TypeScript and orchestrator source.

The API candidate built from `15ed650f3bc56b6906cb0dbf7cb30602843f4a7b` remains held and must not be promoted. Rebuild API from the merged repair source. The separately qualified orchestrator from that source has completed its image-only rollout to task definition91; its sanitized promotion receipt is included. Retirement/rollback compatibility remains unchanged: no database migration or ledger edits, and current API488 remains rollback baseline until the new image is qualified and promoted.

Original live acceptance remains NOT_RUN. Setup, provider-budget installation, authenticated capture and original case predicates must produce actual evidence before any case is reported passing. Health and offline qualification do not prove live acceptance.
