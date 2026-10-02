# Synthetic UI attempt v2

Status: NOT RUN pending root's fresh readiness. Policy HEAD and origin/main freshly confirmed at `39590a3bfc57ce03b0411ff7912a7c8d99deb70c`.

The first actual Hermes attempt ended with Node exit 1 during authentication, zero conversation-creation requests, zero conversations, and zero turns. Its immutable result SHA256 is `40a3b0be56d4b6e473cbfd119269886d98ea7f1e52f44b10343044412873c87f`; its files and lock remain unchanged. The v2 driver refuses unless that exact result still shows all zero counts.

The diagnosed mismatch is concrete: a bounded unauthenticated GET of deployed `https://os.capiro.ai/runtime-config.js` returned HTTP 200 and the expected Web release `940fe9354f95630c6acb0f20f75ced26ea9e75f4`. Its public Clerk publishable key decodes to frontend hostname `clerk.app.capiro.ai`. The original guard allowed `clerk.capiro.ai` and a development wildcard. V2 permits only the exact HTTPS origin `https://clerk.app.capiro.ai` for Clerk authentication mutations and verifies that the loaded public configuration decodes to that same host. No raw key or runtime configuration was printed or saved. Evidence: `deployed-clerk-binding-v2.json` and `synthetic-ui-auth-public-domain-diagnosis.json`.

No authentication fallback was added. Ticket strategy, exact synthetic ordinary-member identities, expected Web source/surface, fresh ephemeral browser, one new unscoped conversation plus one exact no-tools turn per tenant, strict application mutation guard, bounded browser duration, and revocation of each known newly created Clerk session remain unchanged. Clerk attempt diagnostics retain only bounded status, session-present boolean, and whitelisted missing-field names. Blocked request diagnostics retain method, allowlisted hostname or generic unapproved-host plus hash, and pathname segments from a fixed vocabulary. Query strings, opaque IDs, tokens, raw errors and responses are omitted. No auth/session state is persisted.

Root must write `synthetic-meri-ui-v2-ready.json` with the existing `meri.synthetic-ui-readiness.v1` schema, `attemptId: "v2-auth-domain-binding"`, `ready: true`, an expiry at most 15 minutes ahead, actual merged source, actual served image digests, and the verified canary plan/apply receipt paths. The earlier readiness file cannot authorize v2.

After root's explicit release, run the prepared actual Hermes launcher exactly once:

```powershell
python C:\dev\cap-meri-foundation-evidence\oct02-release-path\launch-synthetic-ui-v2-hermes.py
```

Hermes may execute only `run-synthetic-ui-v2-smoke.py`, which records the actual exit of `node synthetic-meri-ui-v2-smoke.cjs --readiness synthetic-meri-ui-v2-ready.json --execute-two-synthetic-turns` using absolute paths. New logs, receipts, and exclusive lock use the v2 prefix. No automatic retries, lock removal, policy weakening, user substitution, passwords, or extra application turns. On any failure, stop and report actual partial counts for root reconciliation.

Root independently reviewed the v2 source and syntax check. This is an operational two-turn smoke, not the original 75-case File01 acceptance; retrieval, citation quality, and starter behavior remain outside this check.
