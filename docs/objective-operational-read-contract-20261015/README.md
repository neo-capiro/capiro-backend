# Review pickup

Read `PROPOSAL.md`, `SOURCE-MAP.json`, `CONTRACT.schema.json` and `WIRE-EXAMPLES.json`.
`SOURCE-PINS.json` records the exact inspected dependencies and its frontend Git-verification
limitation. The accepted composite schema is referenced from the adjacent checked-in
`objective-workload-authority-20261015` directory without changing it.

This is a docs-only proposal, not a public export or working endpoint. Source mapping and
offline fixtures do not qualify permission enforcement, persistence, pagination, current
counts, meeting selection, inherited receipt witnesses or runtime behavior.

Run the bounded offline checks with an existing Ajv6 installation, without installing
dependencies or executing application services. From this backend checkout, for example:

```powershell
node --max-old-space-size=768 docs/objective-operational-read-contract-20261015/validate-proposal.cjs ../backend/node_modules/.pnpm/ajv@6.15.0/node_modules/ajv
```

The explicit path above is the neighboring task-local dependency checkout. Another existing
Ajv6 directory can be supplied as the argument. The script emits a JSON report to stdout;
its success covers only the listed proposal conformance fixtures. No provider, DB, browser,
network, model, migration or Docker action is performed.

Implementation allocation is still needed for the Core membership ledger/receipt lookup,
resource-owner readers, independent permissions reconciliation, composite reader and
frontend receiving. Question identity/resolution and feasibility/window labels have no
proven owner in this source mapping and stay explicit full-page gaps.
