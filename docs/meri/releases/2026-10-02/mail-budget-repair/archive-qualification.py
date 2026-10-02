"""Fresh 991b mail-budget evidence only; --check is read-only, --write explicit."""
import argparse, hashlib, json, pathlib, re, subprocess
ROOT=pathlib.Path(__file__).resolve().parent
REPO=pathlib.Path('C:/dev/cap-meri-fixture-hardening')
SOURCE='991b5b15fa134d64579c96853dc92e9a00fa8520'
PRIOR='6e829e479b0f1311f6d7e624fbc917ce136d9bb3'
RELATIVE=pathlib.Path('docs/meri/releases/2026-10-02/mail-budget-repair')
HASHES={
  "browser-api501-observation.json": "0982c5187cd0e1d774a9bd133d6688d9609545cb35441073075d2700edc7a880",
  "independent-kimi-exit.json": "8e91283d15204387973e9f4b7fcd34b4011b7702186227dff048b827992873bc",
  "independent-kimi-review.md": "01535094633cee13bc95dac8ba96a37be618636a575b4e68f291b40e97213df6",
  "independent-kimi-source-hashes.json": "cb04985d7d9719cc9f745be5b1a23997843c0a13da948c631440a880cb61a4b7",
  "independent-kimi-usage.json": "d4bad0c21e096ac43b2422360f57f13ea281c41bdfd2dc54d01363ebfb7cedbd",
  "independent-source-review.json": "a4ae70f42221d50e75b3392ee19c773b71d6b5b01885fec1837e17e317b83591",
  "integrated-bill-postgres.exit.json": "da7ee0aad2b64e768daebb25fbf86438297ec4736fc3229cfbb9efae79b85ea4",
  "integrated-bill-postgres.log": "b85d7c6ddf6c4be076e7d02a83408859009399c67d6722202653484983dea138",
  "integrated-offline26-verifier.exit.json": "7d9da698ee4459a8ff8ae540cdaff76393a00f2932cc8b10dab3091b8d7eb09f",
  "integrated-offline26-verifier.log": "8a6d5048912b38340ce08bb033e31a84974e49c4520475b3c649cb3a4f1808c1",
  "integrated-offline26.exit.json": "47e1963230719c04ac78e7ad7b4045ca16a2eae1d02a7f34e4a6c2fc9ff391f5",
  "integrated-offline26.json": "5cc6705ead5d15008d2cc35798f7035b63cc306997eba7ac97b0c2a1294e8d73",
  "integrated-offline26.log": "20bf400544128f459f5d99e912644d5887b844b98e3e781430b82295ddf2497d",
  "integrated-offline26.summary.json": "4ccaa3ef75adf511f31768d0b2a2cb5b156eb4740215a5c690615bd51850661a",
  "integrated-qualification.json": "3e64e398823120342cc18d4013b93fac98b5f38e6c774be07268078b46391d98",
  "integrated-tests.exit.json": "6394213ae3fcec4ca5e4ec654152ba111751d60e06030edfba3f906d1e2cb1fb",
  "integrated-tests.log": "62d3218f6389cc966ce18a29451889b958daac71c8b534c8461c634da5664ce8",
  "integrated-types.exit.json": "dd67f4364f9d54c3518139282bf9b611f38699f8f83bff9bfc5d134fd0936d60",
  "integrated-types.log": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
def need(ok,code):
    if not ok: raise RuntimeError(code)
def sha(data): return hashlib.sha256(data).hexdigest()
def git(*args): return subprocess.check_output(['git',*args],cwd=REPO)
def encode(value): return (json.dumps(value,indent=2)+'\n').encode('utf8')
def collect(read=None):
    read=read or (lambda name:(ROOT/name).read_bytes())
    files={name:read(name) for name in HASHES}
    for name,data in files.items():
        need(sha(data)==HASHES[name],'EVIDENCE_CHANGED:'+name)
        need(not re.search(r'(?:sk_live_|sk_test_|sk-proj-|sk-or-v1-|AKIA)[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.',data.decode('utf-8-sig')),'SENSITIVE:'+name)
    parse=lambda name:json.loads(files[name])
    q=parse('integrated-qualification.json')
    need(q['status']=='PASS' and q['sourceSha']==SOURCE and q['schemaChange'] is False and q['liveAcceptance']=='NOT_RUN','QUALIFICATION')
    names={'integrated-tests','integrated-bill-postgres','integrated-types','integrated-offline26','integrated-offline26-verifier'}
    need(len(q['results'])==5 and {r['name'] for r in q['results']}==names,'RESULT_SET')
    for r in q['results']:
        need(r['sourceSha']==SOURCE and r['exitCode']==0 and parse(r['name']+'.exit.json')==r and sha(files[r['name']+'.log'])==r['logSha256'],'RESULT:'+r['name'])
    need(re.search(rb'Test Suites:\s+8 passed, 8 total',files['integrated-tests.log']) is not None,'SUITES')
    need(re.search(rb'Tests:\s+66 passed, 66 total',files['integrated-tests.log']) is not None,'TESTS')
    pg=parse('integrated-bill-postgres.log');need(pg['status']=='PASS' and pg['passed']==5 and pg['skipped']==0 and pg['sharedDatabaseAccess'] is False,'BILL_PG')
    summary=parse('integrated-offline26.summary.json')
    for k,v in [('success',True),('exit_code',0),('found_count',26),('evaluated_rows',26),('pass_count',26),('fail_count',0),('error_count',0)]:need(summary[k]==v,'OFFLINE:'+k)
    need(summary['provenance']['sourceGitSha']==SOURCE and summary['report_sha256']==sha(files['integrated-offline26.json']) and all(v is True for v in summary['checks'].values()),'OFFLINE_BINDING')
    review=parse('independent-source-review.json');usage=parse('independent-kimi-usage.json');exit_receipt=parse('independent-kimi-exit.json');review_hashes=parse('independent-kimi-source-hashes.json')
    need(review['verdict']=='PASS' and review['sourceSha']==SOURCE and review['sourceUnchangedSinceModelReview'] is True,'REVIEW')
    need(exit_receipt['exitCode']==0 and usage['reportedResultExit']==0 and usage['toolCalls']==0 and usage['provider']=='bedrock' and usage['initializedModel']=='moonshotai.kimi-k2.5' and usage['sessionId']=='20261002_135450_694b53','REVIEW_ACTUAL')
    need(review_hashes['sourceSha']==SOURCE and review_hashes['files']==review['reviewedFiles'],'REVIEW_SOURCE')
    for path,value in {**q['sourceGitBlobSha256'],**review_hashes['files']}.items():need(sha(git('show',SOURCE+':'+path))==value,'SOURCE:'+path)
    delta=git('diff','--name-only',PRIOR,SOURCE).decode().splitlines()
    expected=['apps/api/src/engagement/mail-query-deadline.postgres.spec.ts','apps/api/src/engagement/mail-query-deadline.spec.ts','apps/api/src/engagement/mail-query-deadline.ts']
    need(sorted(delta)==expected,'THREE_FILE_INCREMENT')
    for name,entry in review['artifacts'].items():need(sha(files[name])==entry['sha256'],'REVIEW_ARTIFACT:'+name)
    observation=parse('browser-api501-observation.json');need(observation['checks'][0]['result']=='FAIL' and observation['apiTaskDefinition']=='capiro-dev-api:501','PRESERVE_LIVE_FAILURE')
    q.update(schemaVersion=1,jestPassed=66,jestSkipped=0,actualBillPostgresChecks=5,actualMailPostgresTests=3,offlineCases=26,customVerifierExit=0,incrementalBaseSha=PRIOR,incrementalSourceFiles=expected,fullFile01Acceptance=False)
    files['qualification.json']=encode(q)
    files['source-git-blob-hashes.json']=encode({'testedCodeSha':SOURCE,'files':q['sourceGitBlobSha256']})
    files['qualification.md']=TEXT.encode('utf8')
    files['.gitattributes']=b'# Preserve actual evidence bytes and hashes.\n* -text\n'
    files['artifact-hashes.json']=encode({'sourceSha':SOURCE,'files':{name:sha(data) for name,data in sorted(files.items())}})
    return files
TEXT='''# Mail deadline availability repair qualification

API501/source d77 deployed successfully, but the actual owner mailbox probe still
failed with a 503 at 13:49 UTC. Service health did not establish live recovery.
The browser failure receipt is preserved. The prior 3.5-second shared SQL budget
was too short for that observed operation; the exact SQLSTATE was not exposed.

Source 991b5b15fa134d64579c96853dc92e9a00fa8520 changes only the mail deadline
helper and its two tests. One monotonic ten-second budget remains shared across
count/page/coverage SQL, with a twelve-second Prisma transaction timeout.
The actual healthy four-second PostgreSQL query now succeeds; actual ten-second
server cancellation and pool/timeout cleanup are verified. The five-second
legislative bill budget, query SQL, tenant/owner filters and provider configuration
are unchanged. This is a bounded availability tradeoff, not proof every mailbox
query will complete. No database schema or migration changes are included.

Actual integrated qualification: 66 Jest tests across eight suites (including
three real mail PostgreSQL tests), five additional real bill PostgreSQL checks,
API typecheck and 26 deterministic offline cases with custom verifier; all exit0.
New independent Hermes/Bedrock Kimi review session 20261002_135450_694b53 passed
with actual exit0 and zero tool calls. Five reviewed source/dependency hashes are
bound to this candidate. Its prose calls legislative bill cancellation 'billing';
that terminology is imprecise and does not describe a billing-system change.

Earlier source/baseline compatibility evidence remains in ../live-db-recovery/.
This fresh qualification does not reuse its old mail review as current review.
The new image and post-deployment mailbox acceptance remain NOT_RUN here.
Original File01 live evaluation and human acceptance remain incomplete.
'''
def main():
    p=argparse.ArgumentParser();m=p.add_mutually_exclusive_group(required=True);m.add_argument('--check',action='store_true');m.add_argument('--write',action='store_true');args=p.parse_args()
    files=collect()
    if args.write:
        need(git('rev-parse','HEAD').decode().strip()==SOURCE,'EXACT_CHECKOUT_REQUIRED')
        need(git('branch','--show-current').decode().strip() not in ('','main'),'ISOLATED_BRANCH_REQUIRED')
        need(not git('status','--porcelain').strip(),'CLEAN_CHECKOUT_REQUIRED')
        target=REPO/RELATIVE;need(not target.exists(),'ARCHIVE_EXISTS');target.mkdir(parents=True,exist_ok=False)
        for name,data in files.items():
            with (target/name).open('xb') as f:f.write(data)
    print(json.dumps({'status':'ARCHIVED' if args.write else 'CHECK_PASS','sourceSha':SOURCE,'files':len(files),'jest':66,'mailPg':3,'billPg':5,'offline':26,'target':str(REPO/RELATIVE),'cloudWrites':0,'liveAcceptance':'NOT_RUN'}))
if __name__=='__main__':main()
