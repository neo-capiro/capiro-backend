# Band A — P51 (GA / closeout), independent §6.2 review

**Verdict: `P51_GA_CLOSEOUT_REJECTED`**

**Reviewed:** 2026-08-13, by an independent reviewer who did not write, review, or
deploy any phase of this program. Read-only: nothing in this review ran a command
against `capiro-dev`, edited a document, or touched a working tree other than to
write this file.

**Pinned to:** `d800dcfde51f6cf21a4b54b511006b9001fd6d2b` (`main`, 2026-08-13 16:40
-0400, "feat(x-feed): configurable X Intelligence dashboard feed (#948)"). Every
document quotation below is `git show d800dcfde5:<path>`, not a working-tree read.

**Scope:** P51's own GA/closeout criteria, reviewed for **internal consistency** —
does this program's own documentation agree with itself about what GA requires and
what state the program is in. This review makes no claim about whether any *code* is
correct; that is a different band. Nothing here required a MakeGov key, a console, or
a live read.

**Verdict vocabulary** (following `docs/runbooks/phase-2-independent-live-validation.md`
§8, the program's established two-string convention):

```
P51_GA_CLOSEOUT_INDEPENDENTLY_APPROVED
or
P51_GA_CLOSEOUT_REJECTED  (list every failing check)
```

Approval would require P51's stated GA criteria to be internally consistent with
P49's and P50's own rows, with the closeout section's own tables, and with the
decision log — and for each named GA criterion to be operationalized well enough
that a reader could tell whether it had been met. Five of the checks below fail.
Rejection here is a finding **about the documentation**, not an assertion that any
shipped code is defective.

---

## Summary of checks

| # | Check | Result |
|---|---|---|
| 1 | P51's GA criteria agree with P49/P50's rows | **PASS** — see §1.0 |
| 2 | P51's own row is internally consistent with the rest of the document | **FAIL** — F-01 |
| 3 | No other instances of the P41/P42/P43 staleness pattern | **FAIL** — F-02 … F-07 |
| 4 | Zero genuine §6.2 verdicts, with an exact baseline count | **PASS (count established)** — §2 |
| 5 | "Design-partner acceptance" is operationalized | **FAIL** — F-08 |
| 6 | A HANDOFF exists for D-79 / PR #943 | **FAIL** — F-09 |
| 7 | The matrix reflects the current GA ingestion bar | **FAIL** — F-10 |
| 8 | The original plan doc's "Definition of program completion" is readable | **FAIL (confirmed absent)** — F-11 |

---

## §1 — Do P51's GA criteria match what P49 and P50 say they require?

### 1.0 The direct question: PASS

P51's row (`completion-matrix.md:86`, Deploy column) states GA is:

> **blocked** — GA needs P49's canary and P50's enablement to have actually run,
> plus design-partner acceptance

P49's row (`:84`, Deploy) states:

> **blocked** — the canary itself needs a live MakeGov key, flag enablement, and
> Neo performing every mutating step

P50's row (`:85`, Deploy) states:

> **blocked** — live rule enablement is out-of-band and Neo's, and the tracked
> Compute stack is drifted

**These three agree.** P51 claims readiness for nothing that P49 or P50 say is
blocked; it correctly names both as prerequisites and adds a third. The
"Closeout status" section's opening line — *"The program is NOT complete, and this
section exists so that cannot be read any other way"* (`:215`) — is honest and is
the document at its best. On the narrow question asked, P51 does not overclaim.

**The failures are elsewhere**: P51's row contradicts a correction recorded five
days earlier in the same document (F-01), and the closeout section P51 owns carries
six further stale claims (F-02 … F-07).

### 1.1 P51's GA criteria are stated three times, and the three do not agree

| Location | Stated GA gate |
|---|---|
| `:86` (P51 row, Deploy) | P49 canary + P50 enablement + **design-partner acceptance** |
| `:240` ("What is blocked, and on whom") | "P49 and P50 actually running" — design-partner acceptance **absent** |
| `:320` ("What is still genuinely outstanding") | "P49 + P50 having run"; note reads "acceptance is a judgement, not a test" — design-partner acceptance **absent as a gate** |

A reader consulting either summary table, rather than the phase row, would conclude
GA has two gates. A reader consulting the row would conclude three. This is the
single criterion nobody has operationalized (F-08) and it is also the one that
disappears from both summaries. Recorded as **F-12** (low), because it compounds
F-08 rather than standing alone.

---

## §2 — Independent-review baseline: the exact count

Requested as a real baseline number for what the Tier 2 effort is changing. Counted
mechanically from the Review column of all 52 phase rows (`completion-matrix.md:35`
through `:86`), not by reading prose about the count.

| Review-column value | Count | Phases |
|---|---|---|
| `*pending*` | **26** | P00 – P25 |
| `*self-verified only — no independent reviewer*` | **17** | P26 – P39 (14), P44, P45, P46 |
| `*self-verified only*` (bare, no qualifier) | **5** | P47, P48, P49, P50, P51 |
| `*self-verified only; §6.2's independent tester has still never run*` | **2** | P42, P43 |
| `*self-verified only.* Neo read #867/#870 as owner reviews; §6.2's tester never run | **1** | P41 |
| `**read by Neo 2026-08-08**` … §6.2's tester still has not run | **1** | P40 |
| **Total** | **52** | P00 – P51 |

### The headline numbers

- **Genuine §6.2 verdicts (`PASS` / `PASS WITH NON-BLOCKING NOTES` / `FAIL`) recorded
  as of `d800dcfde5`: ZERO. 0 of 52.** Not one row in the Review column carries any
  of the three strings the matrix's own legend (`:12`) defines as the only valid
  values.
- **Rows recording self-verification in some form: 26 of 52** (17 + 5 + 2 + 1 + 1).
- **Rows recording no review of any kind, not even self-verification: 26 of 52**
  (all of P00–P25, the entire first half of the program).
- **Rows with any human read at all: 2 of 52** (P40, P41) — both by Neo, the
  program's owner, and both explicitly disclaimed in the cell itself as not the
  §6.2 gate. The matrix's own instruction (`:272`) is *"Do not upgrade 'Neo reviewed
  it' into 'the gate ran'."*

### F-13 (low): the closeout text misstates its own baseline

Two places assert every row is `*self-verified only*`:

- `:260-261` — *"Every phase in this program is marked *self-verified only*."*
- `:315` — *"every row above is *self-verified only*"*

**Both are false for exactly half the program.** P00–P25 are marked `*pending*`,
which the Deviations table (`:202`) defines as a distinct and weaker state: those 26
phases were built as sequential commits on one branch, the per-phase gate *"cannot
run between phases,"* and *"the `Review` column stays empty for P00–P10 until that
happens — it is not satisfied by this branch's CI being green."* `*pending*` means
"no review, deferred"; `*self-verified only*` means "the executor tested its own
work." Collapsing them overstates the coverage of the weaker half by one full
category.

This matters for the Tier 2 baseline specifically: the number to beat is not "52
self-verified" but **"26 self-verified, 26 with nothing recorded, 0 independently
reviewed."**

---

## §3 — Findings, severity-ranked

### F-01 · HIGH · P51's own row repeats a claim the same document formally retracted five days earlier

`completion-matrix.md:86`, P51's **Live acceptance** column, states:

> Every deferred capability is named and flag-off, never implied complete:
> **P40-P43 blocked on the provider**, webhook write tier unresolved, P39 MCP
> merged without a live handshake

`completion-matrix.md:221`, 135 lines later in the same file, states:

> **P40–P43** | **NOT blocked — this row previously said otherwise and was wrong
> (D-62).**

`decision-log.md:1907` (D-62, 2026-08-08) is titled *"CORRECTION: P40–P43 were never
blocked on the provider"* and opens:

> **This entry corrects a claim this program recorded in at least five places and
> repeated for a day.** The completion matrix, this log, P17's capability report,
> the P46–P51 handoff, **and the project closeout** all stated that DIBBS and
> SBIR/STTR have no API surface…

**D-62 names "the project closeout" as one of the five places to correct. P51's row
IS the project closeout, and it was not corrected.** Beyond being stale, it is now
also contradicted by outcomes: P40 is merged with its entitlement answered
(`dibbs: supported`), P41–P43 are code-complete, D-71 contract-validated both rails
against a real capture on 2026-08-09, and the ingestion handoff records ~14,769 real
DIBBS rows in `capiro-dev` as of 2026-08-12.

This is the highest-severity finding because it sits **inside the GA phase's own
acceptance evidence**. P51's Live-acceptance cell is the artifact that is supposed to
guarantee no deferred capability is misrepresented at closeout, and it is the cell
misrepresenting one.

**Doc-text update required** — `completion-matrix.md:86`, Live acceptance column,
replace:

> `P40-P43 blocked on the provider`

with:

> `P40–P43 are code-complete and merged, and were never blocked on the provider (D-62); both rails' contracts are validated against a real capture (D-71). What remains open is ingestion completeness (D-75–D-78) and schedule enablement, not buildability`

---

### F-02 · HIGH · P41's Live acceptance asserts "no live DIBBS response has ever been observed" — contradicted by P40's row four lines above, by D-71, and by 14,769 rows in the database

`completion-matrix.md:76`, P41 **Live acceptance**:

> **Still no live DIBBS response has ever been observed** — every field mapping
> inherits P40's open contract gate

Contradicted by three independent records, all at the same SHA:

1. `completion-matrix.md:75`, P40's own Live acceptance: *"contents
   **CONTRACT-VALIDATED** (D-71) … pulled 5 real records each from
   `rfqs`/`rfps`/`awards` and ran them through the actual mappers."*
2. `decision-log.md:2318` (D-71, 2026-08-09) — the capture itself, now pinned as
   fixtures in `tango-dibbs.mapper.spec.ts`.
3. `HANDOFF-2026-08-11-dibbs-sbir-ingestion-resume.md:14-16` — 13,625 rfq rows
   (~18% of target) and 1,144 rfp rows (**~100%, `complete: true`**) present in
   `capiro-dev`, verified by direct DB query on 2026-08-12.

P41's row also still says *"parts 1–2 merged; part 3 in PR #873"* and *"Deployment of
these commits to `capiro-dev` was **not verified in the part-3 session**"* — and,
critically, **carries no D-79 note at all**, even though D-79 shipped
`generate-dibbs-opportunity-candidates.ts` explicitly "for P41."

**The asymmetry is the tell.** The D-79 commit (`aebec3b32`, 2026-08-13 10:04) changed
**exactly one line** of `completion-matrix.md` — P43's row. P41's row, describing the
other half of the same change, was left untouched. Verified:
`git show --stat aebec3b32 -- docs/` → `completion-matrix.md | 2 +-`.

**Doc-text updates required** — `completion-matrix.md:76` (P41):
- Status column: replace `parts 1–2 merged; part 3 in PR #873 (status as written — flip this row when #873 merges)` with the merged state, matching what P43's row now records.
- Live acceptance: replace `Still no live DIBBS response has ever been observed — every field mapping inherits P40's open contract gate` with `Contract validated against a real 15-record capture 2026-08-09 (D-71) and ~14,769 real rows ingested as of 2026-08-12 (D-75–D-78); the 5-record-per-endpoint sample is not exhaustive and no detail endpoint was called`.
- Deploy column: add the D-79 note that P43's row already carries — *"UPDATED 2026-08-13 (D-79): the scorer is now WIRED via `generate-dibbs-opportunity-candidates.ts`; schedule ships `enabled: false`."*

---

### F-03 · HIGH · The closeout section's phase-range table says P41 and P42 are "unbuilt"

`completion-matrix.md:221`, the P51-owned **Closeout status** table:

> **P41 is unblocked but unbuilt; P42 is buildable but unbuilt, its entitlement
> `not_attempted` rather than refused; P43 depends on P42.**

Contradicted by the phase rows in the same file:

- `:76` P41 — *"parts 1–2 merged; part 3 in PR #873"* — built.
- `:77` P42 — *"parts 1–3 built — the phase is code-complete. Parts 1–2 MERGED."*
- `:78` P43 — *"parts 1–3 built — the phase, and with it **every phase that is CODE, is complete**."*

P42's entitlement is also no longer `not_attempted`: D-71 records a live capture
against `/api/sbir/topics/` and `/api/sbir/solicitations/`.

This is the same staleness pattern as the known P41/P42/P43 "part 3 open" instance,
but one layer out and materially worse: **the closeout summary is what a reader
consults to answer "is the program done," and it is five days behind the rows it
summarizes.** It is also the second consecutive time this exact table has been wrong
about P40–P43 — it previously said "blocked," was corrected by D-62 on 2026-08-08,
and its replacement text was stale within 24 hours.

**Doc-text update required** — `completion-matrix.md:221`, replace the trailing
sentence with: *"**Updated 2026-08-13: P40–P43 are all code-complete and merged.**
P41 parts 1–3 and P43 parts 1–3 are merged; P42 parts 1–3 are merged; both rails'
contracts are validated (D-71) and the matching producers are wired (D-79). What
remains is ingestion completeness (D-75–D-78) and schedule enablement, both operator
steps."*

---

### F-04 · MEDIUM · Two closeout tables say a migration remains unapplied; D-70 proved none does

`completion-matrix.md:222`:

> The P46 and P48 migrations are **applied to `capiro-dev`**; P47 has none. **One
> later migration remains unapplied — see below.**

`completion-matrix.md:235`:

> Applying `20260907010000_tango_event_outbox_per_event` to `capiro-dev` | … **this
> is now an actionable apply step** rather than a dependency.

`decision-log.md:2248` (D-70, 2026-08-09) — a clean `capiro-dev-api-migrate:55` run:

> ```
> 256 migrations found in prisma/migrations
> No pending migrations to apply.
> ```
> **The completion matrix was wrong.** Its Deploy cells said "NOT applied to
> `capiro-dev`" for P36, P40 and P42 … Both were reading the same stale document.

D-70's corrections were applied to the **phase rows** for P36, P40 and P42 — all
three now read *"APPLIED — verified 2026-08-09."* They were **not** applied to the
closeout tables at `:222` and `:235`. If 0 migrations are pending against 256 found,
`20260907010000_tango_event_outbox_per_event` is among the applied ones by
construction.

**Doc-text updates required** — `:222` strike *"One later migration remains
unapplied — see below"* and replace with *"All migrations in this program are applied
as of 2026-08-09 (D-70): 256 found, 0 pending."* Delete or strike the `:235` row of
the blocked table.

---

### F-05 · MEDIUM · "Two things a reader should not have to rediscover" carries a hazard D-70 proved has inverted — and D-70's own lesson is about exactly this

`completion-matrix.md:245-247`, item 1 of the section explicitly designed to prevent
rediscovery:

> **23 of the 27 EventBridge rules targeting `capiro-dev-api-migrate` are
> revision-unpinned, and 16 are enabled.** Registering a migrate revision is
> therefore a de facto deploy of 16 scheduled jobs.

`decision-log.md:2248` (D-70):

> This program has carried a documented hazard since P40 … True when written. **It
> was inverted in practice.** … Those jobs were not "about to be deployed by a new
> revision" — they were **already dead**, and had been failing every time they
> fired. Registering rev 55 **RESTORED** them.
>
> Generalisable, and the reason this is written down rather than just fixed: **a
> documented hazard describes the system on the day it was written.** This one had
> quietly become its own opposite, and every session since had been carefully
> steering around a danger that had already turned into an outage.

The hazard is still stated in its pre-D-70 form in three further places: P40's Deploy
cell (`:75`, which explicitly cross-references this stale section), P42's Deploy cell
(`:77`, marked as superseded text), and `:235`. D-70 also records that rev 55 has
already been registered and pinned, so the "registering a revision" framing describes
an action already taken.

**This is the most operationally consequential staleness instance**, because the
section's stated purpose is to stop the next reader rediscovering things, and a reader
who trusts it will steer around a hazard that D-70 showed had become an outage in the
opposite direction. It is also the clearest case of the document failing to apply its
own decision log's generalizable lesson to itself.

**Doc-text update required** — `completion-matrix.md:245-247`, replace item 1 with:
*"**23 of the 27 EventBridge rules targeting `capiro-dev-api-migrate` are
revision-unpinned, and 16 are enabled — but read D-70 before acting on that.** As of
2026-08-09 the family's pinned image had been pruned from ECR and those 16 rules were
already failing every fire (`CannotPullContainerError`); registering rev 55 against a
valid image RESTORED them rather than deploying them. Re-verify the live rule state
before treating this as a hazard or as a safety."*

---

### F-06 · MEDIUM · The forward-looking brief for the D-79 work still says "nothing calls it"

`HANDOFF-2026-08-11-dibbs-sbir-matching-producer.md:1-20`:

> # DIBBS/SBIR matching — wire the producer that's shipped dark
> ## STATUS — the scoring logic is built and tested; **nothing calls it**
> … **Confirmed by grep, not assumed:** nothing outside those two files' own spec
> files imports either scorer.

D-79 (2026-08-13) made this false — both scorers now have producers. The file was
last touched by `ff01edb95` (2026-08-11) and was **not** updated by the D-79 commit.

The program has an established convention for exactly this: `HANDOFF-P40-part3.md`
was written as a forward-looking brief and then **updated in place** once the work
landed — *"## STATUS — part 3 is BUILT (2026-08-08) … Read that section as the
specification it was, not as outstanding work."* The matching-producer brief did not
get the same treatment. This is the F-09 gap seen from the other side: not only is
there no completion record, the specification it was built from still reads as
outstanding work.

**Doc-text update required** — prepend a status block to
`HANDOFF-2026-08-11-dibbs-sbir-matching-producer.md` mirroring `HANDOFF-P40-part3.md`'s
form: *"**DONE 2026-08-13 (D-79, PR #943).** Both producers are built and merged; read
the sections below as the specification they were, not as outstanding work. What
remains outstanding is ingestion completeness and schedule enablement, not this."*

---

### F-07 · LOW · Test-evidence cells for P26–P32 do not carry the counts the matrix's own rule requires

The matrix's legend (`:11`) requires the Tests column to hold *"Suite/test counts
after the phase."* Actual contents:

| Row | Tests cell |
|---|---|
| P26 (`:61`) | `api 61/1889 (see P27+ for the running floor)` — equals P33's figure, and jumps from P25's `49/1463` for a web-only phase; this is a retrospective backfill, not a per-phase count |
| P27 (`:62`) | `api 53→ suites, +tests` — **an unfilled placeholder** |
| P28–P32 (`:63-67`) | `api/web floors moved, see PR bodies` — a pointer, not a count |

P27's cell in particular is a template fragment that was never completed. Given
GitHub Actions has been `startup_failure` repo-wide since 2026-07-31 (`:252-255`) and
*"Every phase's evidence in this matrix is a local run,"* the recorded counts are the
only test evidence that exists for these phases.

**Doc-text update required** — either backfill the seven cells from the named PR
bodies, or replace each with an explicit `not recorded per-phase; see PR #<n>` so the
gap is legible rather than looking like satisfied evidence.

---

### F-08 · HIGH · "Design-partner acceptance" is a phrase with no definition anywhere in the program

**The string "design partner" / "design-partner" appears in this program's entire
document corpus exactly once** — `completion-matrix.md:86`, P51's Deploy cell.
Verified by `git grep -i "design.partner" d800dcfde5` scoped to
`docs/plans/funding-opportunities-makegov-v1/`, `docs/product/funding-opportunities.md`,
`docs/runbooks/funding-opportunities-rollout.md`, and
`docs/runbooks/funding-opportunities-makegov-canary.md`: **1 hit, that line.**

There is no definition of:

- **Which client.** No design partner is named. (Other Capiro programs do name
  theirs — `docs/plans/2026-07-09-state-legislation-platform-plan.md:626` resolves
  its D4 as *"Ballard Partners"* with an explicit demo gate. This program has no
  equivalent, resolved or open.)
- **What artifact constitutes acceptance.** No sign-off document, no checklist, no
  recorded conversation. The one acceptance checklist that exists
  (`funding-opportunities-makegov-canary.md:176-185`) is P49's *internal-tenant
  canary* checklist, performed by Neo on `capiro-internal` — a different thing from
  an external design partner accepting the product, and P51 lists P49 as a separate
  prerequisite alongside it.
- **Whose authority grants it.** Every other blocker in the closeout tables names an
  owner ("Neo", "MakeGov console", "a reviewer"). The `:240` and `:320` rows for GA
  name only "P49 + P50 having run" — **design-partner acceptance has no owner
  because it is not in either table** (F-12).
- **What "accepted" means.** `docs/product/funding-opportunities.md` — P51's own
  named deliverable — contains **zero** occurrences of "GA", "general availability",
  "acceptance", or "criteri*". The product doc defines no GA bar at all.

The nearest thing to a definition is `:320`'s parenthetical: *"acceptance is a
judgement, not a test."* That is an accurate statement about the *kind* of thing
acceptance is, and it is not a definition of who exercises the judgement or against
what.

**GA cannot be "blocked on" a criterion nobody has operationalized.** As written, the
criterion is unfalsifiable in both directions: no evidence could establish it was met,
and no evidence could establish it was not. Either it is a real gate and needs a named
partner, a named artifact, and a named authority, or it is aspirational language and
should not appear in a Deploy cell alongside two blockers that do have owners.

**Doc-text update required** — `completion-matrix.md:86`, Deploy column. Either:

- (a) operationalize it: *"plus design-partner acceptance: **[named client tenant]**
  signs off on **[named artifact — e.g. a completed copy of the canary runbook's
  Acceptance checklist run against their own tenant]**, granted by **[named person]**,
  recorded as a committed handoff in this directory"*; or
- (b) if no design partner is engaged, replace with: *"plus design-partner acceptance
  — **UNDEFINED as of 2026-08-13. No design partner is named anywhere in this program,
  no acceptance artifact is specified, and no authority to grant it is identified.
  This is not a gate that can currently be passed or failed; P51's closeout must
  either define it or drop it.**"*

Whichever is chosen, the same text must be reflected at `:240` and `:320` so all three
statements of the GA gate agree (F-12).

---

### F-09 · HIGH · No HANDOFF document exists for D-79 / PR #943, breaking this program's own established convention

**Confirmed by direct inspection of the commit.** `git show --stat aebec3b32 -- docs/`
returns exactly two modified files:

```
M	docs/plans/funding-opportunities-makegov-v1/completion-matrix.md   (2 +-, i.e. one line)
M	docs/plans/funding-opportunities-makegov-v1/decision-log.md        (100 ++)
```

No handoff was added. No handoff was updated. The change itself is substantial —
22 files, +2,680/−4,826, two new producer scripts, 27 lines of new CDK schedule
declarations, and the deletion of a 9-file web directory.

**Every other merged phase in this program has one.** Seven handoffs are committed in
this directory (P40-part3, P46-P51, 2026-08-08-session, 2026-08-08-p41, and the three
2026-08-11 notes). The convention is stated explicitly and defended twice:

- `HANDOFF-P46-P51.md:8-14` — *"**This handoff is COMMITTED, unlike its
  predecessors.** … A program whose institutional memory lives on one laptop has no
  institutional memory, so this one is in the repo."*
- `HANDOFF-P40-part3.md:3-6` — *"Committed to the repo deliberately: four earlier
  handoffs in this program exist only on one machine's local disk, and this program's
  own history is unrecoverable if that machine is lost."*

The canary runbook's own Acceptance checklist reinforces it as an acceptance artifact:
*"Canary evidence attached to the P49 handoff"*
(`funding-opportunities-makegov-canary.md:184`).

The gap is compounded by F-06: not only is there no completion handoff, the brief the
work was built from still reads as outstanding. A reader arriving at this directory
today would conclude the producers do not exist.

**P51's closeout should require this before the DIBBS/SBIR producer work is declared
done.** Concretely, the closeout criterion to add — new bullet under
`completion-matrix.md:257` ("Not done, and deliberately so"), or better, a new row in
the `:313` outstanding table:

> `| Handoff for D-79 / PR #943 (DIBBS/SBIR matching producers, V2 gate retirement) | the implementer | Every other merged phase in this program has a committed handoff; this change has only a decision-log entry and a one-line matrix edit. Closeout must not declare the producer work "done" without one. |`

---

### F-10 · HIGH · The matrix records no GA ingestion bar at all, and every surrounding document frames the goal as full-catalog completeness

**The bar Neo set today** — *prove correctness on real data, not full-catalog
completeness*: ≥1 dataset per rail at ~100%, the zero-rows bug fixed, and real
candidates verified end-to-end for ≥1 client — **appears nowhere at `d800dcfde5`.**
Verified by `git grep -i "full.catalog\|catalog completeness\|zero.rows"` over the
program directory, the product doc, and both runbooks: the only hits are the
*title* of the ingestion handoff and two incidental phrases.

The matrix is not merely silent — the silence reads as the stricter bar, because
every artifact around it does:

| Where | What it implies the bar is |
|---|---|
| `HANDOFF-2026-08-11-dibbs-sbir-ingestion-resume.md:1` | Titled **"DIBBS/SBIR full-catalog ingestion — resume"** |
| same, `:14-19` | Tracks each sub-dataset as `Rows / Target / %` against full catalog targets — 75,339 rfqs, 185,518 awards, 22,480 topics. Two rails sit at 0% under this framing |
| `HANDOFF-2026-08-11-dibbs-sbir-matching-producer.md:23` | *"even once ingestion … is **100% complete**, zero DIBBS/SBIR rows will appear in any client's inbox"* — makes 100% the reference point |
| `decision-log.md:2794` (D-79) | *"while DIBBS/SBIR **ingestion is itself still incomplete** (D-75 through D-78)"* — incompleteness as the reason to defer |
| `decision-log.md` (D-79, closing) | *"nothing here is expected to produce visible rows on capiro-dev until it is enabled **and ingestion has real data behind it**"* |

Under Neo's actual bar, the state of the world is materially better than the docs
read: `tango_dibbs_solicitation` (rfp) is at **~100%, `complete: true`**, and
`tango_sbir_solicitation` at ~72% is likewise **`complete: true`** — one confirmed
complete dataset per rail, which is the whole of the new ingestion criterion. Under
the full-catalog framing the same facts read as "18% / 0% / 0% / 72%" and look like
a program nowhere near GA. **Same data, opposite conclusion, entirely because of
which bar the document states.**

Two further consequences worth recording:

- The **zero-rows condition is not tracked anywhere as a GA criterion.** D-79
  identified it (*"`client_funding_opportunity` held zero rows for either source, for
  every tenant"*) and shipped the producers that address it, but no document lists
  "non-zero candidate rows for DIBBS and SBIR" as something GA checks. It is a
  finding in a decision log, not a criterion in the matrix.
- The **"real candidates verified end-to-end for ≥1 client" condition has no home
  either.** The nearest existing artifact is the canary runbook's §15 Browser
  acceptance and its Acceptance checklist — which is, notably, already
  correctness-shaped rather than completeness-shaped (*"Every visible claim traces to
  a source"*, *"Two manual passes are quiet on unchanged data"*, *"No cross-client
  leakage observed"*). **The canary runbook is already closer to Neo's bar than the
  completion matrix is.** The matrix should be brought to it, not the reverse.

**Doc-text update required** — add a new subsection to the Closeout status block,
immediately after `completion-matrix.md:223`:

> ### The GA ingestion bar (set 2026-08-13)
>
> **GA's ingestion criterion is correctness on real data, not full-catalog
> completeness.** Full-catalog ingestion (D-75–D-78) remains a goal and is tracked in
> `HANDOFF-2026-08-11-dibbs-sbir-ingestion-resume.md`; it is **not** a GA gate. GA
> requires all three of:
>
> 1. **≥1 dataset per rail ingested to ~100% with `complete: true`.** Met as of
>    2026-08-12: `tango_dibbs_solicitation` (rfp) ~100%, `tango_sbir_solicitation`
>    ~72% and `complete: true`. Verify by direct DB query, not from this document.
> 2. **The zero-rows defect closed** — `client_funding_opportunity` holds non-zero
>    rows for both `dibbs` and `sbir_sttr`. Producers exist as of D-79; **this is
>    not yet demonstrated**, because the schedules ship `enabled: false` and no
>    manual `--commit` run is recorded.
> 3. **Real candidates verified end-to-end for ≥1 client** — a real client's inbox
>    renders real DIBBS and SBIR rows traceable to a source, per the canary
>    runbook's §15 and Acceptance checklist.
>
> Where any earlier text in this file or in a handoff implies full-catalog
> completeness is required for GA, this section supersedes it.

Then correct the two summary tables so the strict reading is not reintroduced:
`:241` (*"only the entitlement probe and live sync need a key"* — the entitlement
probe is closed) and `:321` (*"DIBBS / SBIR (P40–P43) | nobody — buildable now"* —
they are built, merged, and validated).

---

### F-11 · MEDIUM · The original plan document is confirmed absent from the repository, in this commit and in all history

The prior investigation's finding **stands, and is stronger than "not found at this
SHA."**

`README.md:6` names the plan: `funding-opportunities-makegov-shippable-microphase-plan.md`
v1.0 (P00–P51). Searches performed:

- `git ls-tree -r --name-only d800dcfde5 | grep -i shippable-microphase` → **no match**
- `git log --all --diff-filter=A --name-only -- "*shippable-microphase*"` → **no match**
- `git log --all --pretty=format: --name-only | sort -u | grep -i microphase` → **no match**

**The file has never existed in this repository, on any branch, in any commit.** The
single reference to it in the entire tree is the README line naming it.

The consequence for this review is direct and specific: **§6.2, §6.3, §6.1 and §4.6 —
including whatever the plan says about a "Definition of program completion" — are
readable only through quotation.** The matrix's Review-column legend (`:12`) quotes
§6.2's three verdict strings; D-55 (`decision-log.md:1718`) paraphrases §6.3's merge
gate; D-62 quotes §4.6's key-handling prohibition. Every one of those is a
second-hand transcription with no primary source in the repo, and no way to check a
transcription against the original.

For P51 specifically, this means **there is no checked-in authority against which
"the program is complete" can be evaluated.** P51's closeout criteria are
self-declared. That is not a defect in P51's authorship — the closeout section is
notably honest — but it means this review can verify only internal consistency, which
is exactly what was scoped, and can verify nothing against the plan's own definition.

**Doc-text update required** — `README.md:6`, annotate the Plan row:

> `| Plan | `funding-opportunities-makegov-shippable-microphase-plan.md` v1.0 (P00–P51) — **NOT CHECKED INTO THIS REPOSITORY, in this commit or any commit on any branch (verified 2026-08-13). Every reference to §4.6 / §6.1 / §6.2 / §6.3 in this program's documents is a quotation from a document no reader here can open. Committing it, or recording where it lives, is a closeout item.** |`

and add the corresponding row to the `:313` outstanding table.

---

### F-12 · LOW · The GA gate is stated three times with two different contents

Detailed in §1.1. `:86` names three conditions; `:240` and `:320` name two, dropping
design-partner acceptance. Fix alongside F-08 so all three read identically.

---

### F-13 · LOW · The closeout text misstates the program's own review baseline

Detailed in §2. `:260-261` and `:315` both assert every row is `*self-verified only*`;
26 of 52 are `*pending*`, a distinct and weaker state per the Deviations table's own
definition at `:202`.

**Doc-text update required** — `:260-261`, replace *"Every phase in this program is
marked *self-verified only*"* with: *"**26 of 52 phases are marked *self-verified
only*; the other 26 (P00–P25) are marked *pending* — no review of any kind, per the
Deviations entry of 2026-08-06. Zero phases carry a §6.2 verdict.**"* Apply the same
correction at `:315`.

---

### F-14 · LOW · P49, P50 and P51 are the only rows that violate the matrix's own "Code = a SHA" rule

The legend (`:10`) states: *"**Code** | Merge SHA of the phase branch. Not 'done' — a
SHA."* All 49 other rows comply. The three closeout rows do not — their Code cells
hold deliverable descriptions and the merge SHA has migrated into the Status cell:

| Row | Code (SHA) column actually contains | Tests column actually contains |
|---|---|---|
| P49 (`:84`) | `canary runbook + read-only diag-funding-opportunities-makegov built and tested (17 tests)` | `included in the api scope above` |
| P50 (`:85`) | `enablement runbook (rollout §30–34) built; ProcessTangoEvents schedule declared enabled: false` | `n/a — documentation and a disabled declaration` |
| P51 (`:86`) | `product doc docs/product/funding-opportunities.md written; matrix rows P46-P51 filled` | `n/a — documentation` |

The rows are structurally intact (12 pipe-delimited fields each, same as every other
row — verified mechanically), so this is content drift, not a broken table. Effect:
**P51 records no test evidence at all**, and the three phases most in need of a
precise pointer at closeout are the three whose Code column has none.

**Doc-text update required** — move the merge SHAs already present in each Status
cell (`a87de936`, `22a0f393`, `9b23dc89`) into the Code column, and shift each row's
existing Code/Tests text one column right.

---

## §4 — One structural observation, offered as context rather than as a finding

D-79 added `GenerateDibbsOpportunityCandidates` / `GenerateSbirOpportunityCandidates`
to `infra/cdk/lib/ingestion-schedule.ts`, `enabled: false`. That file is imported by
`infra/cdk/lib/compute-stack.ts:21` (`import { INGESTION_JOBS } from
'./ingestion-schedule'`) — the `Capiro-dev-Compute` stack that this matrix's own
standing rule forbids deploying:

> `:27` — *"Do not deploy `Capiro-dev-Compute`. It is drifted. This applies during
> rollback too."*
>
> `:85` (P50, Deploy) — *"**blocked** — live rule enablement is out-of-band and
> Neo's, and **the tracked Compute stack is drifted**."*

So the two new schedule declarations cannot reach live EventBridge through the
tracked CDK path. The alternative path exists and is documented —
`infra/cdk/scripts/gen-ingestion-schedules.ts` generates hand-runnable
`aws events` commands from the same `INGESTION_JOBS` source of truth — so this is not
a blocker, and P50's own "out-of-band" framing already anticipates it.

**I am not raising it as a finding** because no document at this SHA states it
incorrectly. I record it because P51's closeout is where the question "how do these
two new declarations actually become live rules" gets answered, and the answer is
currently implicit in a CDK import graph rather than written down anywhere a closeout
reader would look.

---

## §5 — What would move this to `P51_GA_CLOSEOUT_INDEPENDENTLY_APPROVED`

1. **F-01, F-02, F-03** corrected — no phase row or closeout table asserting a state
   the same document formally retracted. These three are the same defect class the
   program already caught once (P41/P42/P43 "part 3 open") and are the reason for the
   verdict.
2. **F-08** resolved — design-partner acceptance either operationalized (named client,
   named artifact, named authority) or explicitly marked undefined, and stated
   identically in all three places (F-12).
3. **F-10** resolved — the current GA ingestion bar written into the matrix, with the
   full-catalog framing explicitly demoted to a goal.
4. **F-09** resolved — a committed handoff for D-79 / PR #943, and F-06's brief
   updated in place.
5. **F-04, F-05** corrected — the closeout tables and the "should not have to
   rediscover" list brought forward to D-70.
6. **F-11, F-13, F-14** at minimum annotated, so the gaps are legible rather than
   invisible.

None of these require a MakeGov key, a console, a deploy, or a human judgement. All
eleven documentation findings are correctable by editing files in this directory.

**A note on what this verdict does and does not say.** The recurring pattern across
F-01 through F-06 is not carelessness — it is that this program corrects itself in
*decision-log entries* and *phase rows*, and the *summary sections* lag. Every single
contradiction found here was already correctly recorded somewhere else in the same
corpus; not one is a fact nobody knew. D-70 named the mechanism exactly — *"a claim
about the live system was carried forward from a document instead of being checked
against the system"* — and then that same lesson was not applied to the document
stating the hazard D-70 had just inverted. The documentation is unusually honest and
unusually self-correcting; what it lacks is a step that re-reads the summaries after
each correction. **P51's closeout is that step, and it has not run since 2026-08-08.**
Its own section header still says so: `## Closeout status (P51, 2026-08-08)`.
