import json, pathlib, re

repo=pathlib.Path('C:/dev/main/meri-closeout-c0-20261002')
docs=repo/'docs/meri/implementation'
evidence=repo/'docs/meri/releases/2026-10-02/fresh-live-benchmark'
summary=json.loads((evidence/'summary.json').read_text(encoding='utf-8'))
assert summary['casesCollected']==5 and summary['originalCaseAssertionFailures']==['02']
cost=summary['accountedCostMicros']/1e6
link='../releases/2026-10-02/fresh-live-benchmark/README.md'
status=f'''# Meri File01 current checkpoint — C0 and fresh live benchmark

**C0 baseline reconciliation is complete: current deployment, ordinary actor, canonical fixture, live capture, persisted answer and terminal spending readback are verified. File01 remains 01_BLOCKED.** Frozen semantic-clock injection remains an explicit fixture gap. The user subsequently requested a benchmark rerun and explicitly said “start your own,” authorizing the fresh independent run recorded below.

**Five live cases (01–05) collected.** All 15 capture checks passed: actor/client/current corpus, one saved prompt/answer, unchanged canonical corpus. All five server spending ledgers settled. This is live API/model evidence, not the 26-case offline suite. [Results and exact evidence]({link}).

**Findings:** case02 failed to report an unrestricted pending SMS proposal visible to the same ordinary actor. Case03 withheld unsupported outreach but appended an unrelated fiscal-year delta warning for the name Office Delta. Cases01/04 returned current monthly briefing guidance; citation hashes bind the current canonical v2 despite a copied V1 fixture title. Case05 cited only Aster and its current memory; no Bluehaven name or negative IDs appeared in the inspected response. Full source and human grading remain incomplete.

**Running versions:** source/main remains `723735ed1f5c562ab10e6077c67261285ea102fd`; API515 / `6be5a560…`, orchestrator105 / `7c04ca368…` (qualified coverage repair), WebVNext388 / `78ad5805…`. Actual model is `gpt-6-astra`; requested Standard and actual per-turn effort are recorded, including existing automatic Deep/high escalation. No additional AWS or Clerk credentials are needed; `capiro-dev` works.

**Fresh run accounting:** ${cost:.6f} under $30 aggregate / $15 per-case, concurrency1, no unknown new reservations. These are conservative provider-accounting values, not billing statements. All owned logins revoked; temporary operator tasks stopped and definition deregistered. Existing source corpus, approvals, historical fixture claims and old journal are unchanged. No production code, service deployment or model/provider setting changed.

**Original acceptance:** PASS0; case02 has a known failed assertion; cases01/03/04/05 are incomplete; cases06–75 NOT_RUN. Full frozen semantic-clock, effect, mode/JEV/variant/repeat and human-review gates remain. CD0/7 and CW0/8 accepted. Prior case01 failures and case17's partial UI slice remain historical evidence; no collector result is relabeled as a full pass.

**Next:** C1 should repair the proper-name delta classification and verify scoped task/footer/mail behavior. C2 should connect pending governance-state retrieval to the ordinary answer path and retain strict approval boundaries. Mail503 is still only an earlier observation; guard-rejected synthetic delegated mail reads do not reproduce provider failure. Preserve and regrade this run's saved outputs before paying for repeats.

The older evidence root and native aggregate remain unavailable here; their unknown billing is not cleared by this separately authorized run. Recover that journal before resuming the older run. See [current matrix](01-requirements.md), [handover](01-handover.md), [C0 source reconciliation](../releases/2026-10-02/closeout-c0/README.md), and [historical status](../releases/2026-10-02/closeout-c0/historical-STATUS.md).
'''
(docs/'STATUS.md').write_text(status,encoding='utf-8')
handover=f'''# File01 implementation handover — incomplete

C0 baseline reconciliation is complete, with frozen semantic-clock injection recorded as an unresolved fixture gap. The user then requested a rerun and explicitly authorized a fresh independent run. [Five live memory cases and evidence]({link}) now replace the earlier current-host authentication/capture blocker. **01_READY_FOR_02 is not established.**

Resume with [STATUS](STATUS.md) and the [current requirement matrix](01-requirements.md). API515, orchestrator105 and WebVNext388 are verified; the coverage candidate is already deployed. Ordinary synthetic Pat/Aster authentication, current canonical corpus, saved-message retrieval and terminal server-ledger readback work using the configured `capiro-dev` AWS profile. No credential handoff is needed.

Case02 has a confirmed pending-state omission; case03 has a separate proper-name delta coverage-footer defect. Requested Standard/effective Deep-high is explained by existing escalation. Citation content hashes correctly bind the canonical v2 record; the V1-looking title is inherited fixture text. Preserve precise distinctions between product behavior, synthetic tool restrictions and incomplete acceptance evidence.

Fresh run: cases01–05, ${cost:.6f} conservative provider accounting under $30/$15 ceilings, one active case, all settlements verified and sessions/operator tasks cleaned up. Exact IDs, operator scripts, current source proofs, responses, ledger and artifact hashes are archived in the report directory. Do not resubmit these conversations. The older native aggregate, uncertain billing, committed memory approval and fixture lineage remain untouched and must be recovered before any older-run resumption.

Next C1 work is the observed delta-classification repair and ordinary task/footer/mail verification. Next C2 work includes pending governance-state retrieval and remaining memory/approval/artifact/CD assertions. The full75, CD7, CW8, applicable M, mode/JEV variants/repeats, frozen semantic clock, effect readbacks and human review remain incomplete. No migration, new model, framework or infrastructure expansion was performed.

[Earlier C0 reconciliation](../releases/2026-10-02/closeout-c0/README.md) and [pre-C0 handover](../releases/2026-10-02/closeout-c0/historical-01-handover.md) remain historical receipts, not current deployment prohibitions or fresh release authorization.
'''
(docs/'01-handover.md').write_text(handover,encoding='utf-8')
p=docs/'01-requirements.md'; text=p.read_text(encoding='utf-8')
text=text.replace('Only C0 is requested.','C0 baseline reconciliation is complete, with the frozen semantic-clock fixture gap explicit; the user additionally authorized a fresh independent benchmark run.')
text=text.replace('This does not establish acceptance or effective per-turn model/tenant flags.',f'Fresh authenticated cases01–05 additionally record effective per-turn model/tenant evidence; full acceptance remains incomplete. See [fresh live run]({link}).')
start=text.index('Original 75: **'); end=text.index('\n\n| Case |',start)
text=text[:start]+f'Original75: **PASS0, known assertion FAIL1 (02), incomplete4 (01/03/04/05), NOT_RUN70**. Five original prompts have now run in the explicitly authorized fresh batch. Case03 additionally exposes a coverage relevance defect. Historical case01 failed attempts remain retained; none are erased or regraded by the fresh run. CD0/7 and CW0/8 accepted; applicable M, mode/JEV repeats, frozen semantic clock, full effect checks and human review remain incomplete. [Fresh collection, observations and settlements]({link}).'+text[end:]
details={
 '01':('INCOMPLETE','Fresh core facts, persisted answer and canonical citation-version hash verified; clock/effect/variant/human gates remain. Older failed attempts preserved.'),
 '02':('FAIL','Fresh answer omits pending SMS proposal despite authenticated same-actor visibility; does not assert SMS as approved. Known row assertion failure, human rubric not reviewed.'),
 '03':('INCOMPLETE; COVERAGE DEFECT','Fresh answer does not recommend revoked Office Delta memory; unrelated budget-delta footer reproduced. Full governance-state/effect/clock/human evidence incomplete.'),
 '04':('INCOMPLETE','Fresh answer correctly returns current monthly schedule; full clock/effect/variant/human gates remain.'),
 '05':('INCOMPLETE','Fresh client-scope response and exact citation evidence collected; full clock/effect/variant/human gates remain.')
}
for cid,(state,detail) in details.items():
    text,n=re.subn(r'^\| '+cid+r' \| Appendix F \|.*$',f'| {cid} | Appendix F | {state} | {detail} [Evidence]({link}) |',text,flags=re.M)
    assert n==1
for rid,assessment,next_action in [
 ('01-B:','PARTIAL; case02 FAIL','C2: repair pending governance-state omission; retain approved-only fact boundary, older-memory/coverage/CD checks.'),
 ('01-D:','Observed coverage defect; broader gates NOT_RUN','C1: qualify proper-name delta classification repair, then remaining C3 JEV and trace assertions.'),
 ('ANNEX-6.1:','PARTIAL; current-memory observations only','C2: retain cases01–05 evidence and repair known gaps; older-than-500 recall and lifecycle variants remain.'),
 ('ANNEX-6.3–6.4:','PARTIAL; current memory version hashes verified','C2: extend exact current-owner source/permission/coverage and effect evidence; do not waive unresolved original gates.'),
 ('ANNEX-10.3:','PARTIAL; served identities verified','C1/C5: qualify the next delta-classification repair and retain compatible immutable release/schema/rollback evidence.'),
 ('ANNEX-12.8:','PARTIAL; five live cases collected, case02 FAIL','C2/C4: preserve fresh evidence, resolve semantic-clock/effect/human gaps and remaining families; recover old journal only before resuming that older run.'),
 ('ANNEX-13:','PARTIAL; served release inventory verified','C1/C5: maintain compatible schema and rollback evidence for the next authorized candidate; preserve old journal.')]:
    lines=text.splitlines()
    for i,line in enumerate(lines):
        if line.startswith('| '+rid):
            cols=line.split('|'); assert len(cols)==10
            cols[6]=' '+assessment+' '; cols[7]=cols[7].rstrip()+f'; [fresh live]({link}) '; cols[8]=' '+next_action+' '
            lines[i]='|'.join(cols)
    text='\n'.join(lines)+'\n'
p.write_text(text,encoding='utf-8')
p=docs/'01-source-acquisition.md'; text=p.read_text(encoding='utf-8'); marker='## Current consolidation checkpoint'
pos=text.index(marker); text=text[:pos]+f'Fresh runtime addendum: the user authorized an independent live rerun; cases01–05 are collected with exact corpus/citation/usage evidence, a case02 pending-state failure and a case03 coverage-footer defect. This changes observed runtime acceptance evidence only; donor provenance and conditional activation decisions are unchanged. [Run report]({link}).\n\n'+text[pos:]; p.write_text(text,encoding='utf-8')
p=docs/'01-source-inventory.json'; inventory=json.loads(p.read_text(encoding='utf-8')); old=list(inventory['integrationCheckpoints'])
inventory['integrationCheckpoints'].append({'date':summary['completedAt'],'kind':'fresh_authorized_live_memory_benchmark','sourceSha':'723735ed1f5c562ab10e6077c67261285ea102fd','evidence':'docs/meri/releases/2026-10-02/fresh-live-benchmark/README.md','casesCollected':['01','02','03','04','05'],'fullyAccepted':0,'knownCaseFailure':['02'],'coverageDefect':'Office Delta classified as budget_delta','accountedCostMicros':summary['accountedCostMicros'],'sourceProvenanceChanged':False,'historicalJournalChanged':False})
assert inventory['integrationCheckpoints'][:-1]==old
p.write_text(json.dumps(inventory,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
print('Updated current status, handover, matrix and runtime evidence references; original case IDs and old inventory objects preserved.')
