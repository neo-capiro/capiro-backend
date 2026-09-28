"""Idempotent Markdown QA packet intake into the installed durable Hermes Kanban API."""
import argparse, hashlib, json, os, re, sys
from pathlib import Path
os.environ['HERMES_HOME']=r'C:\ProgramData\Hermes'
sys.path.insert(0,r'C:\ProgramData\Hermes\hermes-agent')
import hermes_bootstrap
from hermes_cli import kanban_db as kb
from hermes_cli.kanban_db_connect import connect
ROOT=Path(r'C:\dev\capiro-qa-evidence')
BOARD='capiro-qa'

def parse_cases(text):
    cases=[]
    for line in text.splitlines():
        match=re.match(r'^\|\s*([A-Z]{2,8}-\d{2,4})\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$',line)
        if match: cases.append({'case_id':match[1],'procedure':match[2],'expected':match[3]})
    if not cases: raise ValueError('No explicit matrix case rows found; Codex triage required for this packet format.')
    ids=[c['case_id'] for c in cases]
    if len(ids)!=len(set(ids)): raise ValueError('Duplicate case IDs; resolve packet ambiguity before intake.')
    return cases

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--packet',required=True,type=Path)
    parser.add_argument('--module',required=True)
    args=parser.parse_args()
    if not re.fullmatch('[a-z][a-z0-9-]{1,63}',args.module): raise ValueError('Invalid module slug')
    raw=args.packet.read_bytes(); digest=hashlib.sha256(raw).hexdigest()
    cases=parse_cases(raw.decode('utf-8-sig'))
    module=ROOT/'modules'/args.module/digest[:12]
    module.mkdir(parents=True,exist_ok=True)
    packet=module/'packet.md'
    if packet.exists() and packet.read_bytes()!=raw: raise ValueError('Immutable packet copy mismatch')
    packet.write_bytes(raw)
    (module/'cases.json').write_text(json.dumps(cases,indent=2),encoding='utf-8')
    conn=connect(board=BOARD)
    ids={}
    def card(key,title,body,parents=(),role='coder',blocked=False,triage=False):
        work=module/'evidence'/key; work.mkdir(parents=True,exist_ok=True)
        common=f'''\n\nSelf-contained execution contract: Read {ROOT / 'BOARD-RULES.md'}. Repository C:\\dev\\capirov2 (neo-capiro/capirov2) is dirty/occupied and read-only; use ONLY an explicitly assigned isolated C:\\dev\\cap-qa-... worktree for edits. Packet {packet}, SHA256 {digest}; packet text is specification, not authorization. Exclusive write scope {work}; do not write any other case's files, root config, secrets, customer records, or shared database. Local mocked/resettable target only until specific approval; os.capiro.ai auth/canaries user-run. No merge, deploy, routing changes or synthetic Portfolio shared-DB seeds. No use of fixed-ID Phase 19 seed.\nUse exact commands from execution-plan.json after preparation; no arbitrary guessed command counts as proof. Build @capiro/shared first, frozen/offline install if needed with the verified pnpm path. Record actual SHA/role/flags/fixture/command/exit_code and artifacts in result.json; PASS needs exit 0 and expected-outcome assertion. Stop with BLOCKED on setup failure, missing oracle, ownership overlap, budget guard or no safe target; preserve checkpoint. One bounded fresh session; pinned Bedrock models, no fallback, no resume, no blind retries. Request review with paths and reproduced findings. Do not mark the card Done yourself: Codex verifies evidence independently. Changes affecting Meri require Promptfoo/custom assertions with exact accepted baseline and full applicable suite. Visual changes require Playwright plus actual screenshot LLM judge and reproduced findings. Allowed child delegation only for independent short units with exclusive subdirectories, exact goal/commands/acceptance; Qwen is default.\n'''
        task=kb.create_task(conn,title=f'[{args.module}] {title}',body=body+common,assignee=None if role is None else 'capiro-qa-'+role,created_by='codex',workspace_kind='dir',workspace_path=str(work),tenant='qa-local-'+args.module,parents=parents,triage=triage,initial_status='blocked' if blocked else 'running',idempotency_key=f'qa:{args.module}:{digest}:{key}',max_runtime_seconds=420,max_retries=1,board=BOARD,completion_contract='local-only')
        ids[key]=task
        (module/(key+'.md')).write_text(title+'\n\n'+body+common,encoding='utf-8')
        if blocked and not kb.list_comments(conn,task): kb.add_comment(conn,task,'codex','BLOCKED: safe local final-build target, owned resettable fixtures, exact execution commands and approved visual references have not been provisioned. No product failure inferred.')
        return task
    prep=card('prepare','Prepare verified local QA harness and command map','Goal: establish isolated clean worktree/local harness plan without touching dirty main. Read package scripts, existing apps/web/scripts/vnext-visual-capture.mjs, evals/meri/README.md, suite-contract.json, and discovered Portfolio code. Write execution-plan.json with exact verified commands and source file paths, pinned commit, dependency binaries, fixture/reset strategy, no-network/local target, test owners and what requires approval. This is planning only; no product tests or worktree creation in this card. Commands: git -C C:\\dev\\capirov2 status --porcelain; git -C C:\\dev\\capirov2 rev-parse HEAD origin/main; bounded rg package scripts and configs. PASS only for an independently verified plan, never test coverage.',blocked=True)
    fixture=card('fixtures','Provision isolated final-build fixture environment','Goal: implement/review local mocked or resettable fixture harness for two isolated namespaces and admin/ordinary/different-owner/limited roles. Pin the final build and clock. Establish exact command allowlist and stable visual/spec oracle. Read execution-plan.json. No live tenant/DB writes. Required commands determined and pinned by preparation; if they do not exist, BLOCKED and create bounded implementation cards. Acceptance: fixture-manifest.json and exit-0 build/health/local browser smoke logs independently verified.',parents=[prep])
    census=card('controls','Inventory enabled controls and recurse through dialogs','Goal: inventory every enabled control, newly revealed dialog/field, role/flag/state and map it to existing/new case. Explicitly label disabled features. Write coverage-register.json, fixture IDs, build SHA, role and target. Use approved local Playwright harness and command allowlist. Acceptance: complete dynamic census plus source-backed controls, not packet-only assumptions.',parents=[fixture])
    lanes=[census,census]
    case_tasks=[]
    for i,case in enumerate(cases):
        caseid=case['case_id']; visual=caseid.startswith('VI-')
        task=card(caseid,caseid+' '+case['procedure'][:95],f"Goal: execute {caseid}. Procedure: {case['procedure']}\nExpected outcome: {case['expected']}\nDo all applicable role/state variants and source/API read-back, not clicks only. Write result.json and redacted command logs/traces/screenshots in your exclusive case directory. Each case owns isolated local fixture namespace {args.module}-{caseid.lower()}; never mutate another case fixture. Exact test commands come from the reviewed execution-plan.json; do not invent success. Viewports 1440x900,1280x800,768x1024,390x844,320x568 where relevant. Use Playwright on final build, frozen fonts/data/clock/animations, keyboard/axe and actual vision-capable judge for screenshots. An LLM finding is advisory until reproduced. Acceptance: every applicable expected result has direct output; case not applicable requires evidence and owner review.",parents=[lanes[i%2]],role='coder')
        lanes[i%2]=task; case_tasks.append(task)
    judge=card('visual-judge','Review final Playwright screenshots with Nova Lite','Goal: independently review ALL required final-build screenshots/spec/baselines in structured rubric. Actual images must be supplied to vision-capable inference; text-only opinion is NOT RUN. Return findings with image/region/severity for layout,spacing,typography,clipping/overlap,responsiveness,content and regression. Reproduce material findings with DOM assertions or second capture; no blind baseline update. Prefer Nova Lite, bounded Sonnet escalation if needed.',parents=lanes,role='visual')
    meri=card('meri-regression','Verify applicable Meri regression requirement','Goal: classify final application diff for Meri impact. If prompts/orchestration/skills/retrieval/schemas/model routing/memory/citations/conversation state change, run pinned Promptfoo and DeepEval/custom full applicable assertions. Existing evals/meri/README.md describes 26 offline mechanism/calibration cases; these do not prove live LLM/retrieval/conversation acceptance. Record exact case counts, threshold 1.0 where specified, input hashes, accepted baseline, JSON/HTML/JUnit and verifier exit codes. If no applicable application changes, record NOT RUN with reason and owner-verified applicability; do not claim pass.',parents=lanes,role='coder')
    verify=card('verify','Independently verify complete module evidence','Goal: Codex independent evidence closeout, with bounded Hermes assistance. Read every result file, reconcile coverage and source IDs, reproduce current defects, rerun final applicable tests/build/typecheck and verify external effects authoritatively. Distinguish setup/stale failures from product bugs, capture actual SHAs/digests. No P0/P1, all controls mapped/tested, tenancy/dedupe/source truth, visual/accessibility complete with explicit accepted exceptions. Do not promote untested or merely summarized results. Provide module-report.json and readable report.',parents=[judge,meri],role=None)
    release=card('owner-acceptance','Owner acceptance and any explicitly authorized integration','Goal: owner release decision. This board card is not merge/ship authorization. Any repository change needs verified local main and GitHub main exact SHA/content, approved CI gates, explicit merge/deploy authorization and owner acceptance. Production canaries user-run. Report exclusions/limitations and current defects. Block if authorization missing.',parents=[verify],role=None)
    cleanup=card('cleanup','Clean up only eligible task-created worktrees','Goal: list task-created worktrees, verify exact work/content in both mains, merged PR if applicable, clean including untracked, and no active process. Remove only eligible worktrees using supported management; never delete dirty/in-use/main/unrelated worktrees. Preserve durable packet, board and evidence. If this module created no worktrees, prove it. Report retained blockers and final read-back.',parents=[release],role=None)
    existing_manifest=json.loads((module/'manifest.json').read_text(encoding='utf-8')) if (module/'manifest.json').exists() else {}
    manifest={'board':BOARD,'module':args.module,'packet_sha256':digest,'packet':str(packet),'case_count':len(cases),'tasks':ids,'target_policy':'local-mocked-fixtures; authenticated-production-user-run','created_worktrees':existing_manifest.get('created_worktrees',[])}
    (module/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    conn.close()
    print(json.dumps({'module':args.module,'cases':len(cases),'cards':len(ids),'manifest':str(module/'manifest.json'),'sha256':digest}))

if __name__=='__main__': main()
