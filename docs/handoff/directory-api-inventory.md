# Directory vNext — API inventory (DIRECTORY-HANDOFF §3)

Every row resolved to a verified server controller, or a `GAPS.md` id. DTOs are
the server contract; the web's local type is noted only where it diverges.

Auth: all endpoints behind the shared Clerk-authenticated axios instance
(`useApi()`); `@CurrentTenant()` on the controller means tenant-scoped. None of
the list/detail reads below are public.

## Congressional Staff

| Screen · element | Method | Path | Params | Response type | Client file | Server controller | Query key | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Congressional list · rows | GET | `/api/directory/staffers` | `q, chamber, state[], issue[], page, pageSize` | `DirectoryStaffersResponse` | `DirectoryPage.tsx`, `useCongressionalStaffModel.ts` | `directory.controller.ts#staffers` (`@Get('staffers')`) | `['directory-staffers', q, chamber, state, issue, page]` | **No `role` or `committee` param** — those two designed pills are unfilterable server-side (honest-state note ships; Neo ruled to add them → gap DIR-8). |
| Congressional list · filter options | GET | `/api/directory/staffers` (derived) | — | facet lists derived client-side from a wide read | `DirectoryPage.tsx` `FILTERS` | same | — | No dedicated facet endpoint; options derived from returned rows. |
| Congressional profile · detail | GET | `/api/directory/staffers/:staffId` | path `staffId` | `StaffDetail` | `directory-api.ts#getStaffDetail`, `StaffProfileView.tsx` | `directory.controller.ts#staffDetail` | `['directory-staff', staffId]` | Preserves the full field set (identity/bio/roles/issues/emails/offices/positions/member+committee associations). §7.7 re-shells this, does not redesign. |
| Staff · trips | GET | `/api/directory/contacts/:contactId/trips` | path `contactId` | `DirectoryContactTripsPayload` | `directory-api.ts#getContactTrips`, `ContactTripsSection.tsx` | `directory.controller.ts#contactTrips` | `['directory-contact-trips', contactId]` | `role: approver|traveler`; `otherPartyName` always the counterparty. |

## Committee Staff (hierarchy + roster)

| Screen · element | Method | Path | Params | Response type | Client file | Server controller | Query key | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Committee list | GET | `/api/directory/committees` | `q, chamber, kind, page, pageSize` | `DirectoryCommitteesResponse` | `DirectoryPage.tsx` | `directory.controller.ts` (`@Get('committees')`) | `['directory-committees', q, chamber, page]` | `kind: committee|subcommittee`. |
| Committee detail (roster header) | GET | `/api/directory/committees/:committeeId` | path | `CommitteeDetail` | `directory-api.ts#getCommitteeDetail` | `directory.controller.ts#committeeDetail` | `['directory-committee', id]` | Has `subcommittees[]` (via `parentOfficeId`), `parentCommittee`, `staffCount`, `currentStaffCount`, `memberCount`. |
| Committee roster | GET | `/api/directory/committees/:committeeId/staff` | `q, page, pageSize` | `DirectoryCommitteeStaffResponse` | `DirectoryPage.tsx` | `directory.controller.ts#committeeStaff` | `['directory-committee-staff', id]` | Rows: `DirectoryCommitteeStaffer` (id, fullName, title, email, phone, officeLocation, isCurrent, committee{}). **One canonical staff id** — same identity as congressional staff. |
| Committee contacts (alt) | GET | `/api/directory/committees/:committeeId/contacts` | `personType, current, q, role, page, pageSize` | `CommitteeContactsResponse` | `directory-api.ts#getCommitteeContacts` | `directory.controller.ts` | — | Supports `role` filter the staffers list lacks. |
| People search (global) | GET | `/api/directory/people` | `q, committeeId, personType, current, page, pageSize` | `PeopleResponse` | `directory-api.ts#searchPeople` | `directory.controller.ts` | — | Backs global search across people. |

**Committee structure findings (gates Phase C — §14 Q1/Q2):**
- **Leadership context (Chair / Ranking Member / Vice Chair): SOURCE-BACKED.** Lives
  on member `committees[].position`, inverted into `officeId -> {chair, rankingMember,
  viceChairs[]}` in `directory.service.ts#buildCommitteeLeadershipMap`. Renderable today.
- **Subcommittee units: SOURCE-BACKED** via `parentOfficeId` (subcommittee → parent
  full committee). The two-tier committee→subcommittee tree is renderable.
- **Unit → staff placement: NOT MODELED (gap DIR-1).** Staff are attached to a
  committee office, not to a specific subcommittee/unit within it. Roster renders;
  the per-unit staff grouping on the hierarchy canvas has no source edge.
- **Edges (structure vs working_relationship): NOT MODELED (gap DIR-2).** No edge
  table. The dashed bipartisan edge ships disabled, not faked.
- **Vacancies: NOT MODELED (gap DIR-3).** No unfilled-seat record exists. Muted
  vacancy nodes cannot render — logged, not invented.

## Department of War (acquisition personnel)

| Screen · element | Method | Path | Params | Response type | Client file | Server controller | Query key | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DoW list · rows | GET | `/api/acquisition-personnel` | `service, organization, role, pe_code, pe_aligned(aligned\|unaligned), sort(pe_first\|confidence), q, page, limit` | `AcquisitionPersonnelListResponse` (`data: ProgramTeamPerson[]`) | `program-element/api.ts#getAcquisitionPersonnel`, `DirectoryPage.tsx` | `acquisition-personnel.controller.ts#list` (`ListPersonnelDto`) | `['dow-directory', q, page, service, role, pe_aligned]` | **PE-first sort is server-supported** (`sort:'pe_first'`). Provenance on each row: `confidence, firstSeenAt, lastSeenAt, sourceCount`. |
| DoW profile · detail | GET | `/api/acquisition-personnel/:id` | path | `AcquisitionPersonnelDetail` | `program-element/api.ts#getAcquisitionPersonnelDetail` | `acquisition-personnel.controller.ts#detail` | `['dow-person', id]` | Adds `sources[]` (source, sourceUrl, snippet, observedAt, confidence), `pePrimary, peSecondary[], programOfRecord`. |
| PE → personnel | GET | `/api/program-elements/:peCode/personnel` | path | personnel list | `program-element/api.ts` | `acquisition-personnel.controller.ts#listForProgramElement` | — | PE → person resolution (consumer §8.6). |

**Provenance (§14 Q5):** `firstSeenAt`, `lastSeenAt`, `confidence` are all persisted
and present on both list rows and detail. `sourceRevision` is not a named field but
`sources[].observedAt` + `sources[].source` carry per-mention provenance. `roleCode`
(PEO|DPEO|PM|KO|TD|DIRECTOR) is **not a normalized enum** — `role` is a free-text
string; the Role filter passes it through to the server (`role` param) rather than
deriving a family client-side. Org-chart reference (DIR-6) is not persisted.

## State Legislators

| Screen · element | Method | Path | Params | Response type | Client file | Server controller | Query key | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| State legislator list | GET | `/api/explorer/state-legislators` | paging + `state, chamber, party` (via `CommonPagingDto & Record<string,unknown>`) | `{ rows: StateLegislatorRow[]; total }` | `DirectoryPage.tsx` | `explorer.controller.ts#stateLegislators` | `['state-legislators', …]` | Row counts: `committeeCount: number`, `billCount: number\|null`, `enactedCount: number\|null`. |
| State legislator facets | GET | `/api/explorer/state-legislator-facets` | — | `StateLegislatorFacets` (`states, chambers, parties`) | `DirectoryPage.tsx` | `explorer.controller.ts#stateLegislatorFacets` | `['state-legislator-facets']` | Dedicated facet endpoint (unlike congressional). |
| State legislator profile | GET | `/api/explorer/state-legislators/:id` | path `id` = `ocd-person/<uuid>` (encoded) | `StateLegislatorDetail` | `directory-api.ts#getStateLegislatorDetail`, `StateLegislatorProfileView.tsx` | `explorer.controller.ts#stateLegislatorDetail` | `['state-legislator', id]` | `sponsoredBills: [] \| null` — **null = never crosswalked** (unknown), `[]` = linked but sponsors nothing (a real empty). `sponsoredBillsTotal`, `syncedAt`, `legiscanPeopleId`. |

**Unknown-vs-zero (§14 Q3 / DIR-7 — highest-value gap): RESOLVED server-side.**
The API distinguishes `null` (never crosswalked to LegiScan) from `0`/number from
absent. `billCount`/`enactedCount` are `null` when `legiscanPeopleId` is null;
`sponsoredBills` is `null` (not `[]`) for the same case. The "not available" vs `0`
vs number tri-state survives the API boundary. No client-side `?? 0` — a test must
fail on it.

## Program Element service (DoW alignment target — read-only)

| Screen · element | Method | Path | Params | Response type | Client file | Server controller | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PE identity (DoW aligns to) | GET | `/api/program-elements/:peCode` | path | `ProgramElementDetail` | `program-element/api.ts` | program-elements controller | Directory reads PE identity; does not own it. |

## Gaps logged (see `GAPS.md`)

- **DIR-1** unit→staff placement not modeled — hierarchy groups by committee, not subcommittee-unit.
- **DIR-2** no edge table — dashed `working_relationship` edge ships disabled.
- **DIR-3** no vacancy records — muted nodes cannot render.
- **DIR-4** `roleFamily` not a field on congressional staff — Role filter would need server param (free-text `title` exists; do not derive client-side).
- **DIR-6** org-chart reference (directory section/page) not persisted for acquisition personnel.
- **DIR-8** congressional staffers endpoint lacks `role` and `committee` params (Neo ruled to add server-side); committee contacts endpoint has `role` but staffers list does not.
