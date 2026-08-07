# Defense Budget Enactment Proof V1 Runbook

## Purpose

This runbook governs the only Phase 6 path that may support a line-level `enacted` assertion. A public-law label, conference amount, or explanatory-statement table by itself is insufficient.

## Proof contract

Every `DefenseBudgetEnactmentProofV1` contains:

- fiscal year;
- public-law number;
- enactment date;
- bill ID;
- division/title/section when applicable;
- exact public-law manifest key, SourceDocument ID, and SHA-256;
- exact line-detail manifest key, SourceDocument ID, and SHA-256;
- proof type;
- incorporation evidence when a companion document is used;
- source-profile hash;
- governed reviewer status;
- explicit-line-authority flag for continuing resolutions.

Supported proof types:

- `statutory_line_item`;
- `incorporated_explanatory_statement`;
- `incorporated_table`;
- `other_reviewed`.

## Direct statutory line item

A direct statutory proof is valid only when the public law itself is the exact line-detail source. The public-law and line-detail manifest keys, SourceDocument IDs, and SHAs must be identical.

The candidate artifact is built from those public-law bytes and may emit `enacted` only after exact native identity, FY, vehicle/profile, evidence, and reviewer checks pass.

## Incorporated explanatory statement or table

An incorporated proof requires two independently hashed sources:

1. the public law that creates the legal incorporation;
2. the exact line-detail companion that prints the line amount.

The proof must carry incorporation evidence bound to the public-law source ID/SHA. During trusted verification, the enacted candidate artifact is the line-detail artifact, while the exact public-law artifact must be supplied as a separate trusted reference with its own SourceDocument proof bundle.

Verification fails if:

- the public-law reference is missing;
- its SourceDocument ID/SHA differs;
- its artifact ID/content SHA differs from its proof bundle;
- its proof has a blocking finding;
- the line-detail artifact does not match the proof's line-detail key/ID/SHA;
- incorporation evidence is absent or bound to another source.

## Other reviewed proof

`other_reviewed` is never an automatic proof type. Reviewer status must be `reviewed` or `verified`, and statutory incorporation evidence remains required when the line-detail source is not the public law itself.

## Continuing resolutions

A continuing resolution is an interim package-period record by default. It cannot become a line-level `enacted` position unless the proof explicitly establishes line authority and the projection payload carries `explicitLineAuthority=true`.

Do not use an annualized CR amount as a substitute for full-year enacted funding.

## Rescissions, transfers, and other enacted actions

Rescissions/transfers/general provisions remain typed actions. They do not overwrite line totals unless the statute or incorporated table prints the revised total or a later governed policy explicitly permits an exact derivation.

A rescission retains negative direction; transfers retain source/destination pairing and are never silently netted.

## Inspection command

The historical public-law loader is intentionally contained as an inspect-only proof facade:

```bash
pnpm --filter @capiro/api parse:defense-approps-public-law -- \
  --proof <enactment-proof.json> \
  --candidates <line-candidates.json>
```

`--commit` is rejected. Canonical promotion is Phase 7 work.

## Verification behavior

The shared Phase 2 `enactment_proof` rule requires:

1. exactly one enactment-proof document fact;
2. governed proof status;
3. current source status and matching FY;
4. exact line-detail artifact key/ID/SHA;
5. every enacted assertion source-fact-bound to the proof fact and naming the same proof ID;
6. for direct statutory proof, public law equals line-detail source;
7. for incorporated proof, exact independent public-law reference + proof bundle + no blocking reference finding.

Any missing or ambiguous proof is blocking. Public-law label alone never passes.

## Coverage outcomes

The enacted coverage report distinguishes:

- direct statutory;
- incorporated statement/table;
- unresolved;
- not applicable;
- blocked.

A candidate native identity is blocked, not counted as enacted coverage.

## Source drift and supersession

If either public-law or line-detail bytes change:

- do not edit the old proof;
- register/resolve a new SourceDocument for the changed bytes;
- rebuild the proof with the new exact SHA;
- re-extract/reverify the affected line detail;
- supersede old audit projections rather than mutating proof fields;
- recertify the annual cycle.

If the public law is unchanged but the companion changed, reconfirm incorporation before accepting the new companion proof.

## Acceptance tests

The Phase 6 permanent suite covers:

- direct statutory line;
- valid incorporated explanatory statement;
- missing incorporation evidence;
- wrong companion SHA;
- conference-only amount;
- continuing resolution;
- omnibus division mismatch;
- public-law number mismatch;
- rescission action separation;
- candidate identity;
- stale/superseded source;
- direct and incorporated shared-verifier paths;
- independently trusted public-law reference requirement.

The closeout mutation controls additionally prove that public-law label-only enactment, missing incorporation proof, CR full-year enactment, and reversed rescission signs are detected and restored.
