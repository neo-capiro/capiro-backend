# Source mapping review — sanitized publication derivative

This is a sanitized derivative of the original independent source-only review (original SHA-256 `53c2504919ea0742ba6b83f584649393f5af4a98515c70cc21fd2db3c164c01a`). That review covered the original immutable inputs. The table below lists this publication derivative’s input hashes; independent publication review is pending. Original v2 SHA-256: `5a498e4cd2e06a118d54bae3e0caba44e9418c524b57f9d27481a51c37c2dad8`. See [SOURCE-REVIEW.md](SOURCE-REVIEW.md) for the complete original-to-sanitized manifest.

CLEAR for source mapping and handoff only. No unresolved coverage or unsafe authorization claim was found in the final four reports and successor index. This does not admit a new adapter/family, expand ALL3, or qualify a running endpoint.

## Exact inputs and coverage

Backend pin `b525032222515d636b0dae2d46e40c7c3d8b5528` resolves locally to tree `16723770a8e111fc66bcf70d36ff32ab71eb9928`; checkout state is not producer authority. Ledger pin is `fb708d231c7273f86b1462c72a72e70ccc36a3d6`, blob `1546e9566cb0719261ca660bd5402732f65146e7`.

| Reviewed file | Operations / families | SHA256 |
| --- | --- | --- |
| `MISSING-READS.json` | 63 / 33 | `8319101141697febe5ea115f6376c02260da8516c1e23db037832386c401fd8c` |
| `federal-producers.json` | 18 / 8 | `61e2dccc226548abe41ab6103c054fccb87f198386a601f19cbf1f1bc46b2ce5` |
| `market-producers.json` | 20 / 8 | `ddb07f7fb31968a654a836713eacf0e53a3b259b2a0fb4a495a02783c1c416fb` |
| `state-research-producers.json` | 11 / 8 | `f2e95feccffdf5d6107b3d9b372ce6e64eb93ff534bda4c1a416a4a8c2e024b6` |
| `scoped-producers.json` | 14 / 9 | `2b929c4b8ebe3c06e43b31c8e8a13b4896876dc70e32a2a13208fcad02653cc5` |
| `MAPPING-HANDOFF-v2.json` | 63 / 33 | `c6ebaf2987015db466e88b9d4c550ab77878582ab7142ab256d298ae16ed0def` |

I independently flattened all four operation inventories:63 unique operations,33 distinct families, no missing or duplicate operation. Families match the ledger. Every successor-index context-key array matches the ledger, and every JSON pointer resolves to its named operation. Structured context declarations in the market/state/scoped reports match; the federal report's prose owners cover its required defaultCongress, actorRole, evidenceAccuracyMode and hearing tenant/client-resolution contexts. Empty ledger context arrays are correctly not treated as absence of native server dependencies.

All four sanitized report hashes and byte lengths are rebound in the staged v2 derivative. The original index `128cc624...` captured scoped33ae9aad before its owner finalized61fc978b. Its custody issue is explicitly recorded and the original remains historical; adopt v2 only. No backend source or test evidence changed because of that report correction.

## Authorization and effect claims

The reports consistently distinguish the source-registered native `POST /api/clio/tools/:name` transport, native user/tenant/role and environment-dependent service-secret admission from retained authority. The closed retained operation set remains exactly Portfolio detail, Portfolio changes and Florida budget. No new key/origin/trust grant, worker credential, arbitrary tool-name dispatch, private subject mapping or ALL3 expansion is inferred. Source presence and inspected test source are not runtime proof.

Narrow source spot-checks support the material cautions:

- State designation misses can enter `meri-state-bill-live.ts:71-166`: quota reservation/upsert, provider calls and normalized bill persistence. Canonical stored-key hits differ. Neither path is silently labelled provider-free/effect-free.
- `query_global_data` uses the allowlisted analytics reader but `meri-tools.service.ts:4757-4784` still writes its best-effort query audit. Acquisition list/detail likewise audit and gate email/uploaded contact fields by exact current `ctx.role === 'capiro_admin'`, not model-supplied actorRole or generic role rank (`acquisition-personnel-read.service.ts:164-279`).
- Canonical client-wall access is exact tenant/client existence plus unwalled OR current exact-user grant, with no admin bypass; the helper itself does not establish current membership/archive status (`packages/shared/src/client-memory-wall.ts:9`). Reports correctly distinguish that from tenant/nonarchived visibility, market clientScope, representation/R5/manual tracked-bill paths and client registry/research-candidate gaps.
- Actor-owned outreach detail is not interchangeable with tenant campaign listing. Saved prospect/current legacy conversation scope is not interchangeable with a native Meri conversation UUID. The mapped BD evidence call suppresses scheduling; the neighboring UI dossier route is not promoted as an equivalent read.
- Public report catalogs are stored global sources, not proof of completeness/absence. Public-web and certification paths may perform provider/network work. Current source clocks, coverage, unknown/unavailable and partial-result behavior remain explicit rather than being converted into new business policy.

## Recommendation and remaining adoption limits

The successor recommendation is coherent: READS owns the next **bill-text2** source batch (`search_congress_bills`, `read_bill_text`); **public-reports3** and **acquisition-personnel2** remain parallel proposals. The generic native route must become finite fixed method/path/operation descriptors, with native bearer/service identity kept on CONTROL's existing native boundary and unavailable defaults retained.

Bill-text received literal frozen schema/normalizer comparison only. The direct implicit SEARCH query can still resolve using native currentCongress while the receiving normalizer uses trusted defaultCongress; exact bridge/alignment or fail-closed disagreement handling remains required. Flat native bodies, actual HTTP Date serialization, canonical READ IDs, source lineage/cursors/notes and independent byte/deadline bounds must be preserved. This mapping neither resolves that mismatch by inventing Congress policy nor claims executed conformance. The report explicitly limits its comparison because imported receiving helpers were not supplied.

Other families still need exact receiving-contract/context compatibility and separately allocated adapters/current-use authority. Only the supplied literal bill-text receiving contract was compared; other families and imported receiving helpers remain unverified. Current role/private client/folder/conversation mappings cannot be supplied by model selectors, generatedAt, a UUID-shaped ID or an empty context-key list. None of the cited tests was executed for this mapping, and native HTTP/DB/provider/session/source-completeness/integration qualification remains unrun.

Reviewer actions were limited to read-only JSON/source/Git inspection, coverage/pointer/hash comparison and this concise report. No suite, compiler, application/workload process, install, native/provider/network/DB call or frozen-file edit was performed. No further mapping correction is requested for the exact v2 inputs above; adoption limitations remain explicit work for the allocated owners.
