# Phase 7 source coverage

The receipts establish bounded source coverage, not legal-classification accuracy.

| Corpus | Verified scope | Remaining boundary |
|---|---|---|
| 2026 bill research | HB 1207 and SB 1156: all 11 provider-listed documents extracted; immutable revisions retained. | Not the entire 2026 session. Proposal, amendment, enactment and effective date remain distinct. |
| 2025 historical facts | Florida regular session 2135, dataset hash `2d5a454fd06a8bda71150f2e54e6dfeb`; 1,960 canonical bill imports. Original archive SHA-256 `82884bc1703d8e15afbd593ef3c8d8d8eef239d179d53317995509aedf1c42da`. | Archive contains 3,003 vote records and 219 people; current people directory was preserved. Full text requires selective hydration. No client assignments, calendar events or source transitions were created by the backfill. |
| Selected historical text | 2025 HB 823, Health Care: 1/1 provider-listed document extracted, exact revision retained. | Explicit cross-session research example; no companion relationship is inferred. |
| Captured statute targets | 155 publisher-verified identities; selected 2026 chapters loaded in two initial bounded batches and a targeted four-chapter retry (53/53 chapters ingested). 161/174 captured rows currently have qualifying retained edition evidence. | Ten proposed corrections, nine unresolved identities and current administrator application remain review items. Captured edition was unknown; 2026 is the explicit research selection. |
| Constitution | Article III and its 21 sections retained from the current publisher snapshot. | No invented annual constitution edition. |
| FAR | Three selected histories and one proposed-notice page. | Receipt is incomplete: history truncation, per-rule history cap and page cap. Correction/emergency and complete proceeding coverage are not claimed. |
| Adopted 1-1.008 | Exact publisher attachment and legacy Word bytes retained. | Extracted markup/embedded objects are partial; text is held for review. |
| Human accuracy | 60 citation/effect and 20 lifecycle/date review cases prepared with blank labels. | No precision, recall, abstention rate or client sign-off measured. Additional held-out negative/family coverage remains required. |

Existing bills and state-register schedules retain their prior cadence/quota controls and now use compatible Phase 7 source writers. The prior-session recommendation guard is deployed in Intel and the existing daily new-match worker. Database preservation hashes confirmed unchanged folders, assignments, staged configuration, mappings, hearing publications and source-action rows across the backfill. Direct original-publisher links and exact hashes are retained in the accompanying JSON evidence.
