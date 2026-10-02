# Mail deadline availability repair qualification

API501/source d77 deployed successfully, but the actual owner mailbox probe still
failed with a 503 at 13:49 UTC. Service health did not establish live recovery.
The browser failure receipt is preserved. The prior 3.5-second shared SQL budget
was too short for that observed operation; the exact SQLSTATE was not exposed.

Source 991b5b15fa134d64579c96853dc92e9a00fa8520 changes only the mail deadline
helper and its two tests. One monotonic ten-second budget remains shared across
count/page/coverage SQL, with a twelve-second Prisma transaction timeout.
The actual healthy four-second PostgreSQL query now succeeds; actual ten-second
server cancellation and pool/timeout cleanup are verified. The five-second
legislative bill budget, query SQL, tenant/owner filters and provider configuration
are unchanged. This is a bounded availability tradeoff, not proof every mailbox
query will complete. No database schema or migration changes are included.

Actual integrated qualification: 66 Jest tests across eight suites (including
three real mail PostgreSQL tests), five additional real bill PostgreSQL checks,
API typecheck and 26 deterministic offline cases with custom verifier; all exit0.
New independent Hermes/Bedrock Kimi review session 20261002_135450_694b53 passed
with actual exit0 and zero tool calls. Five reviewed source/dependency hashes are
bound to this candidate. Its prose calls legislative bill cancellation 'billing';
that terminology is imprecise and does not describe a billing-system change.

Earlier source/baseline compatibility evidence remains in ../live-db-recovery/.
This fresh qualification does not reuse its old mail review as current review.
The new image and post-deployment mailbox acceptance remain NOT_RUN here.
Original File01 live evaluation and human acceptance remain incomplete.
