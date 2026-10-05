# LegiWatch QA fixes — October 4 report

## Implemented

- Explicit Florida “laid on table / companion passed / refer to SB or HB” evidence produces the terminal `superseded` status. Rule 7.18 print substitutions remain nonterminal. HB 1211's dossier uses this evidence immediately, with SB 474's outcome and chapter when retained. The derivation job updates stored status and its evidence date. Tracker lanes and change classification do not claim enactment of the replaced vehicle.
- OpenStates committee crosswalks retain sessionless legacy roster rows when an exact verified directory alias supplies the session. House publisher `CommitteeId` URLs can resolve committee identity. State rooms include current and historical referrals, bounded to the official session and chamber; historical matches use complete referral-list entries.
- Federal calendar/detail names resolve through official committee codes. The calendar filter uses the code rather than variant display names. Existing canonical alias handling remains the mechanism for merging retained duplicates without losing follows and links.
- The feed and its counts restrict alerts to the requesting tenant's nonarchived Portfolio clients, including when selecting a specific client or alert. Unknown/foreign selections fail closed. Historical uppercase UUIDs resolve to the same client name.
- Generic defense matching excludes legal/self-defense senses; explicit legal phrases still match when deliberately configured. Multiword issue areas remain phrases. Broad SQL keyword hits cannot independently override failed topic/issue matching.
- The stream groups matching bill observations across clients, preserving each underlying alert and triage control. Internal fit scores are removed from new alert copy and stripped from legacy card copy. Missing detailed traces are explicitly qualified, including critical cards; no trace is invented.
- State bill document views offer exact revision comparison and expose original bill/staff-analysis records. Incomplete extractions cannot be compared. Florida budget project rows show recent source amounts, and detailed amounts are visible outside selectors with readable labels.
- The existing notification drain reconciles hearing starts, durable schedule changes, finished transcripts, and high-priority client matches into the in-app inbox. It respects active membership and each follow's preferences/client selection, and claims durable event keys for retry deduplication. Settings link to per-hearing configuration. This change does not enable external email delivery.
- A prior failed governing rule no longer overrides a later canonical passage/enactment posture.

## Required live verification and data repair

A read-only ECS audit reached the serving database on October 5 using the application’s system RLS scope. It confirmed 15 active and 44 archived Portfolio clients in the reported tenant. The seven unexpected organizations are archived, not foreign-tenant clients. Of the audited alerts, 182 belong to archived clients, 24 to the active L3 Harris client, and one to a missing client. Uppercase UUIDs explain the historical L3 label. Six L3 legal-defense keyword matches are independently qualified false positives.

The apparent duplicate USPTO hearing is two distinct official events: a committee/day fallback attached event 338783 observations to event 338784 and overwrote its title/time. Thirteen misbound observations were found across eight event pairs. Exact numeric official IDs now prohibit that fallback; the dry-run/hash-bound repair script retains observations and before-images. Ukraine event 338796 is a true Joint/Senate alias and is qualified separately by its exact event identity and joint committee code.

Commerce’s February 10 meeting already retains 13 agenda items and 12 linked bills. Its first-party notice omitted CommitteeId; a unique exact directory name in the same official session/chamber now supplies the association, including notices previously attached to a Florida Channel archive record. Ambiguous or retired directory matches remain unresolved.

The first LegiScan hydration request was held by its existing quota guard. A subsequent bounded inventory attempt failed before document retrieval. Direct retrieval from the retained first-party Florida Legislature URLs completed all 13 versions: four HB 1211 PDFs, five SB 474 HTML versions and four SB 7002 HTML versions. Each is retained as complete-document extracted text with explicit first-party provenance.

Live repair has also linked 169 Florida notice observations to unique official 2026 committee directory identities; 40 ambiguous/unmatched observations remain unresolved instead of being guessed. Commerce is visibly populated with seven proceedings, 73 agenda items and seven documents. Six reviewed L3 legal-defense false positives were suppressed with before-images and correction evidence. Eleven misbound media candidates were restored to their exact official events; shared committee/day media URLs were retained where the source does not identify an exclusive event.

Release and final verification results are recorded separately when executed. The steps below remain the acceptance checklist.

1. Run `node scripts/legiwatch-qa-audit.cjs` from an environment with database connectivity and standard `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, and `PGDATABASE`. The script opens a read-only transaction, requires TLS verification, and reports attribution counts, the named clients, HB 1211/SB 474, Commerce joins, and the reported federal hearings. Keep its output private: it contains tenant/client identifiers.
2. Deploy the API, intel-api, web, and shared package changes together. No schema migration is introduced by this branch.
3. Run the existing `apps/api/scripts/derive-state-bill-status.ts` job and verify HB 1211 is `superseded` with March 9 evidence, no “Committee action” next step, and the companion's chapter shown. The House vehicle must not be labelled enacted.
4. Verify the reviewed official Florida committee inventory is installed using the existing read-only mode of `sync-florida-official-committees.ts`. If missing, use that script's documented reviewed apply workflow. Refresh OpenStates events with `OPENSTATES_EVENTS_STATES=FL`, `OPENSTATES_EVENTS_YEAR=2026`, and a window covering February 9–15. Verify Commerce events now resolve to the official/verified alias identity. Refresh first-party Florida calendar sources for original agendas and bill lists; absent publisher documents remain explicitly unavailable.
5. Use the audit's exact federal IDs to prepare reviewed pairs for `apps/api/scripts/reconcile-hearing-aliases.ts`. Run its dry-run and review the plan hash, then apply through its writer-pause workflow. Do not merge by title alone. Verify the September 28 week, committee filters, old hearing links, and Golden Dome (`sen-119-338758`). Repeated change-history observations also require inspection of their retained source/event identities.
6. Verify the default feed, client picker, and Portfolio agree, including counts and uppercase L3 Harris rows. Review old defense/AI false positives against retained matching evidence before suppressing them. Matching changes apply to subsequent detection; this branch does not silently rewrite stored alert history.
7. Verify the existing `notification-drain` schedule is active and healthy. Follow a hearing with a test account, exercise the four preferences, and check inbox delivery/retry behavior. Retained events predating the follow are excluded; starts have a 15-minute reconciliation window.
8. Check retained text availability and the research feature flag before claiming a comparison exists for every Florida bill. The comparison UI does not create missing extractions or generated legal analysis.

## Local verification

- API regression suites cover Florida substitution/status dates, OpenStates joins, room referrals, official committee names, notification job wiring, and existing alias behavior.
- Intel-api suites cover Portfolio scoping, client identifier casing, phrase matching, status/board behavior, and stale governing-rule posture.
- Web suites cover feed/triage/client attribution, settings, budget presentation, exact revision comparison, and grouping without losing alert identities.
- `pnpm --filter @capiro/api exec tsx test/legiwatch-lifecycle-postgres.ts` executes the actual notification SQL in temporary PostgreSQL tables, then rolls back. It verifies four categories, retry deduplication, tenant/user isolation, and disabled preferences.
- The existing full-schema feed PostgreSQL integration suite was skipped locally because no disposable full-schema `DATABASE_URL` was supplied. It remains covered by the repository's LegiWatch CI workflow.
