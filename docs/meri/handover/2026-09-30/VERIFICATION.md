# Publication verification

This verifies the **handover package**, not File01 acceptance or deployment. Policy: `neo-capiro/capiro-agent-ops@fe8adaa858ee2391b42697311ce91cf787e080b8`. Product code remains `c785e566321943470978d66325952ed916951346`; the publication commit adds only the handover and its canonical documentation pointer.

## Actual checks on 2026-09-30

- Package relative Markdown links resolved; JSON parsed; seven inert patches parsed with `git apply --numstat`, **exit 0**. No patch was applied to product source.
- The ten archived `.cjs.txt` sources matched their SHA-256/size manifest. The safe local `migration/verify-archive.cjs` parsed their syntax without importing/evaluating them and validated the aggregate result boundaries: **PASS, exit 0**. Independent integrity/negative checks also passed **7/7, exit 0**. No database, provider or AWS operation was invoked.
- Scoped `.gitattributes` rules preserve the exact bytes of migration reference text and archived patches on Windows and Linux. Their original CRLF/source whitespace and blank unified-diff context lines are literal archive data, so only those archival paths permit end-of-line whitespace; product source and ordinary documentation retain normal checks. A native independent reviewer found missing patch line-ending protection; it was corrected before publication and verified with `git check-attr`.
- Structured credential-pattern scanning and manual disclosure review found no real credential, customer/session payload or raw database snapshot in the package. One credential-shaped URL was explicitly reviewed as a synthetic pure-parser fixture in the pinned original test source; it uses a fake offline ARN and reserved example host. Its retained file SHA-256 is `1f8318fdd957e6977fbd9dba62318148100e58718966016af1ae9e52525b7a47`. Pattern scanning alone is not proof of exhaustive secret absence.
- The portable CI discovery helper was actually executed from this checkout on Node `v22.23.3`: **exit 0**, **1,762 suites**, shard counts **441/441/440/440**, **zero duplicates**, exact union. Normalized list SHA-256: `4d59db9c184d18a80e16d0cfb8761d86823faaf730557024ee6db185d89f8a17`. This discovery ran no tests and is not an API suite PASS.
- Independent Hermes review used Bedrock `moonshotai.kimi-k2.5` and returned **PASS for archive integrity/documentation quality**, process **exit 0**, completed `2026-09-30T00:19:43.5377851Z`. It checked policy precedence, remote usability, all ten source hashes, seven patch hashes, correct failed/NOT RUN distinctions and disclosure exclusions. It explicitly did not establish product acceptance or release readiness. No production model policy was changed.

The latest code's earlier targeted build/test results are recorded separately in [CI README](ci/README.md). They were not rerun merely to publish documentation. The GitHub pipeline on the published descendant must be assessed independently; this handover does not claim it is green.

## Verifying the received package

`PACKAGE-MANIFEST.json` lists repository-relative paths, Git blob IDs, SHA-256 and sizes for the staged Git bytes of this package plus the canonical `01-handover.md` pointer. It excludes itself to avoid a circular hash. Compare against the named commit's blobs (for example `git show <commit>:<path>`), or against an ordinary checkout respecting `.gitattributes`.

The smaller `migration/source-byte-manifest.json` and `preserved-work/manifest.json` preserve exact source/patch hashes and their original provenance. They do not certify archived drafts as safe to apply or private evidence as reproducible.

No shared database write, migration, deployment, main integration, production canary, authenticated production-browser test, worktree cleanup or unrelated-source change occurred in this publication task. The external effect is publication to the existing GitHub PR branch and its normal PR checks.
