# Source-only author checks

```
node --test scripts/outreach-v3-qualification-plan.spec.mjs
node docs/cleanup-retirement-outreach-verification-integration-20261012/evidence/check-source-preservation.cjs
node docs/cleanup-retirement-outreach-verification-integration-20261012/evidence/capture-before-after-scopes.mjs
node --check scripts/outreach-v3-qualification-plan.mjs
node --check scripts/outreach-v3-qualification-plan.spec.mjs
node --check scripts/verify-outreach-v3-phase1-code.mjs
node --check scripts/verify-outreach-v3-phase3-code.mjs
node --check scripts/verify-outreach-v3-phase4-code.mjs
```

The Node test imports the pure helper only and evaluates actual wrappers through VM injected fake ports. Its actual child/file/provider/native work is refused/replaced, not performed. Frozen original source fixture modules are data only and must never be invoked. Node `--check` parses syntax without running modules.

Preserve 01-plan-and-wrapper-tests.log (21/21), 02-structural-source-preservation.log (24/24), 03-before-after-scopes.log (six paired inert scope traces), original source snapshots/raw hashes and before-after-scoped-traces.json. The separate trace-capture first pass incorrectly replaced the literal import.meta substitution target, causing a VM syntax error; original script plus both initial/diagnostic raw failure logs are retained. The correction protects that literal while replacing outer module URL expressions. No production source/test/expectation was modified to repair that evidence script.

No real wrapper run, package manager, generation/model/provider, Prisma client/native, application/DB/SQL, AWS, credential/permissions or frontend operation occurred. Fake-scope completion does not certify native/full gates or actual CI. Root owns independent review, scoped aliases/CI union and draft publication.
