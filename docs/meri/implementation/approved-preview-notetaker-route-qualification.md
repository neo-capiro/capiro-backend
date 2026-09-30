# Approved Engagement preview-route parity

The canonical Engagement route manifest included the existing client notetaker preference handlers, but the generated browser preview list omitted their common path. Regeneration adds only the anchored /api/engagement/clients/[^/]+/notetaker path, updates the manifest digest and changes the distinct path count from154 to155. The GET/POST/DELETE handlers already exist on GitHub main42942; no backend handler, authorization, role, ALB or model policy is changed.

Explicit v3 preview remains required and off by default. The browser adds its existing preview header for that exact path only while activated; extra/missing segments remain excluded. This affects the existing preference read/enable/disable calls under the established path-based preview mechanism.

Owner approval2026-09-29: "approved make sure everything goes inos.capiro.ai", responding to the exact proposal at C:/dev/cap-meri-foundation-evidence/preview-notetaker-routing-proposal.md. UI deployment is restricted to web-vnext at os.capiro.ai. No broader routing permission is inferred.

PASS:47 browser preview tests, including the new exact route activation/negative/deactivation test, exit0; canonical generator check and scoped test formatting exit0. Independent Hermes/Kimi exact static review returned SCOPED PASS, reviewer exit0. Evidence: preview-route-addition-final-tests.log and exit JSON; review-outreach-behavior-route-exact.jsonl and exit JSON. Full UI/release gates remain separate and mandatory.

Rollback uses the previous compatible web-vnext artifact/config through the approved workflow. Source rollback removes the added generated pattern; the manifest drift gate would correctly hold until its routing policy is reconciled. No deployment has occurred as part of this source qualification.