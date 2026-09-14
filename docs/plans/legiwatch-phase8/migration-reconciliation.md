# Phase 8 migration and replacement accounting

The existing Rubin Turnbull staging inventory has 40 source alerts and 38 news definitions. No prior-phase alert promotion was recorded in the refreshed baseline. Earlier phases remain implemented with their own current-client configuration/acceptance gates; Phase 8 does not turn those gates into completed rollout claims.

The full 40-row ledger is `alert-replacement-ledger.json`. Alert 04–14 are the 11 action/amendment definitions; 15–22 the eight agendas; 23–28 the six statute definitions; 29–38 the ten bill-keyword definitions. Phase 8 adds separate configuration decisions for 01, 02, 03, 39 and 40. This totals 40, with no optional Analyst subscription invented.

News staging preserves all 38 source URL IDs and exact strings (21 quoted/17 unquoted), capture, original URL and source-relative path. Raw and interpreted queries are visible together. Stable account-qualified keys, immutable decisions and optimistic versions preserve local query edits, pauses, exclusions and removals on reimport. Quoted/unquoted synonyms and overlapping definitions remain separate source identities. Current folder/client binding is explicit; no historical editor proved which keywords each recipient should receive.

| Capture                  | Historical channel counts                       | Required current decision                                                                      |
| ------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| alert-01 Research Desk   | 10 email; eight categories                      | Map/exclude each source category with a reason, then select current scope/audience             |
| alert-02 Budget          | Nine email, three notification; five categories | Preserve notification separately; email is supported, in-app is unresolved for this new family |
| alert-03 Daily Briefing  | 12 email                                        | Source name absent; select cadence, cutoff and recipient list                                  |
| alert-39 Morning Edition | 10 email                                        | Separate subscription; source name/cadence absent                                              |
| alert-40 News Keyword    | Four email                                      | Explicit dictionary binding and audience; no inferred 38 subscriptions per person              |

All five captured editors lack cadence. Raw recipient controls remain historical evidence, not current permissions or consent. The three unnamed products use family labels. Source category mappings are explicit scope decisions, not a claim that Capiro reproduces an unavailable proprietary taxonomy. Notification-to-SMS substitution is unsupported.

API migration `20280914030000_legiwatch_news_fiscal` owns additive public evidence. Intel migration `20260914030000_legiwatch_news_editorial` owns private workflow state and the typed delivery extension. Workspace reuses existing source receipt/document tables. The upgrade rehearsal applies all owner migrations on two separate disposable databases and checks populated baseline preservation. Immutable public/private evidence is never rewritten or dropped for rollback.
