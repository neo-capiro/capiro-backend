from pathlib import Path
import json, subprocess, hashlib, os, tempfile, datetime

repository = Path('/dev/shm/capiro-runtime-candidate-20261014/repository')
source_ref = 'dd02f3ba0b4ab77e3725e83e4b9af27aecdc8eca'
old_main_ref = '4be13b0b1ed0f2f3fa014040eedbb2fc2c27dace'
old_main_frontier = '20281008040000_federal_evidence_passage_search'
successor_import_ref = 'c76f5fc0df6688743afeec274211afd2e67fe8f1'
owned = Path('/dev/shm/capiro-pinned-parser-install-20261014/retained-audit-fixtures')
owned.mkdir(parents=True, exist_ok=True)
metadata = [{"name":"20261007010000_newsletter_outreach_format","path":"apps/api/prisma/migrations/20261007010000_newsletter_outreach_format/migration.sql","backend_source_introduction":"a247f7a02a9b94d95e9ee5a516b396202aea994b|2026-10-12T20:01:19Z"},{"name":"20261007020000_newsletter_review_email_delivery","path":"apps/api/prisma/migrations/20261007020000_newsletter_review_email_delivery/migration.sql","backend_source_introduction":"a247f7a02a9b94d95e9ee5a516b396202aea994b|2026-10-12T20:01:19Z"},{"name":"20261007030000_newsletter_invitation_email_delivery","path":"apps/api/prisma/migrations/20261007030000_newsletter_invitation_email_delivery/migration.sql","backend_source_introduction":"a247f7a02a9b94d95e9ee5a516b396202aea994b|2026-10-12T20:01:19Z"},{"name":"20261007040000_newsletter_account_invitations","path":"apps/api/prisma/migrations/20261007040000_newsletter_account_invitations/migration.sql","backend_source_introduction":"a247f7a02a9b94d95e9ee5a516b396202aea994b|2026-10-12T20:01:19Z"},{"name":"20261014050000_user_portfolio_layout","path":"apps/api/prisma/migrations/20261014050000_user_portfolio_layout/migration.sql","backend_source_introduction":"47213eb8924016f444c73c53cfbee47c0349a282|2026-10-14T03:47:19Z"},{"name":"20281011010000_client_objectives","path":"apps/api/prisma/migrations/20281011010000_client_objectives/migration.sql","backend_source_introduction":"a9c6bdc35af70270d774ed9aeec542840f97af4c|2026-10-11T00:13:54Z"},{"name":"20281011020000_portfolio_prospect_stages","path":"apps/api/prisma/migrations/20281011020000_portfolio_prospect_stages/migration.sql","backend_source_introduction":"fd6ed6c017ae91ab774fd34f74475a746de13b68|2026-10-11T02:02:05Z"},{"name":"20281011030000_prospect_contacts","path":"apps/api/prisma/migrations/20281011030000_prospect_contacts/migration.sql","backend_source_introduction":"11903f32f6257a47e42f49c1abe92c0e0fb0e4fb|2026-10-12T10:05:07Z"},{"name":"20281012010000_client_activity_commands","path":"apps/api/prisma/migrations/20281012010000_client_activity_commands/migration.sql","backend_source_introduction":"027b5681349029086d4d9d836c5566130002b122|2026-10-12T03:05:58Z"},{"name":"20281012020000_client_ordered_owners","path":"apps/api/prisma/migrations/20281012020000_client_ordered_owners/migration.sql","backend_source_introduction":"f551c376d89c87afdfd2e40bfe41dac25248b4d5|2026-10-12T03:52:15Z"},{"name":"20281012030000_prospect_resource_origin","path":"apps/api/prisma/migrations/20281012030000_prospect_resource_origin/migration.sql","backend_source_introduction":"056bae1a00004f1ad7b0001ed89c48e704f84a7f|2026-10-12T04:48:25Z"},{"name":"20281012060000_federal_register_effective_evidence","path":"apps/api/prisma/migrations/20281012060000_federal_register_effective_evidence/migration.sql","backend_source_introduction":"e2f0fe48449aeb287c5343da0a3b65042e6f8ce6|2026-10-12T06:50:39Z"}]
source_paths = ['scripts/check-migration-timestamps.mjs', 'scripts/cleanup-gates/lib/cli.mjs', 'scripts/migration-timestamp-offsets.json']
inputs = {p: subprocess.check_output(['git', 'show', f'{source_ref}:{p}'], cwd=repository) for p in source_paths}
config = json.loads(inputs[source_paths[2]])
policy = config['apps/api/prisma/migrations']
assert policy == {'yearOffset': 2, 'toleranceDays': 7}
name_results = []
for item in metadata:
    introduced_sha, date = item['backend_source_introduction'].split('|')
    author_date = datetime.datetime.fromisoformat(date.replace('Z', '+00:00'))
    expected = author_date.replace(year=author_date.year + policy['yearOffset'])
    directory_date = datetime.datetime.strptime(item['name'][:14], '%Y%m%d%H%M%S').replace(tzinfo=datetime.timezone.utc)
    drift = (directory_date - expected).total_seconds() / 86400
    name_results.append({**item, 'introduction_commit': introduced_sha, 'introduction_author_date': date,
                         'offset_drift_days': drift, 'offset_valid': abs(drift) <= policy['toleranceDays'],
                         'after_old_main_frontier': item['name'] > old_main_frontier,
                         'ledger_application_state': 'UNKNOWN'})
def git(root, *args, date='2026-10-14T00:00:00+00:00'):
    env = dict(os.environ)
    env.update(GIT_AUTHOR_NAME='Inert source policy fixture', GIT_AUTHOR_EMAIL='source-policy@example.invalid',
               GIT_COMMITTER_NAME='Inert source policy fixture', GIT_COMMITTER_EMAIL='source-policy@example.invalid',
               GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date)
    return subprocess.check_output(['git', *args], cwd=root, env=env, stderr=subprocess.PIPE, text=True).strip()
def fixture(label, grandfathered, added):
    root = Path(tempfile.mkdtemp(prefix=label+'-', dir=owned))
    git(root, 'init', '--quiet')
    for path, content in inputs.items():
        target = root/path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    for name in [old_main_frontier, *grandfathered]:
        path = root/'apps/api/prisma/migrations'/name/'migration.sql'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('-- Inert source-policy name marker; never executed.\n')
    git(root, 'add', '.')
    git(root, 'commit', '--quiet', '-m', 'Inert relative source frontier')
    base = git(root, 'rev-parse', 'HEAD')
    for item in added:
        path = root/item['path']
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('-- Inert source-policy addition name marker; never executed.\n')
        git(root, 'add', str(path.relative_to(root)))
        git(root, 'commit', '--quiet', '-m', 'Inert allocation '+item['name'],
            date=item['backend_source_introduction'].split('|')[1])
    command = ['node', 'scripts/check-migration-timestamps.mjs', '--base', base]
    result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=30)
    failures = [item['name'] for item in added if item['path'].rsplit('/migration.sql',1)[0] in result.stderr]
    return {'label': label, 'command': command, 'cwd': str(root), 'fixture_base': base,
            'source_baseline_description': 'Exact old-main maximum and relevant grandfathered names only; inert marker files, not actual SQL bodies or database state',
            'new_names': [item['name'] for item in added], 'grandfathered_names': grandfathered,
            'exit': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr,
            'failed_names': failures}
all_new = fixture('core12-vs-old-main', [], metadata)
layout = next(item for item in metadata if item['name'].endswith('_user_portfolio_layout'))
grandfathered = [item['name'] for item in metadata if item is not layout]
successor = fixture('core12-vs-successor-import', grandfathered, [layout])
expected = [item['name'] for item in name_results if not item['offset_valid']]
assert len(expected) == 5
assert all_new['exit'] == 1 and all_new['failed_names'] == expected
assert successor['exit'] == 1 and successor['failed_names'] == [layout['name']]
assert sum(item['after_old_main_frontier'] for item in name_results) == 7
receipt = {
    'qualification': 'Unchanged stock source timestamp CLI against two isolated Git metadata fixtures; no SQL, Prisma, database, app or provider execution',
    'source_ref': source_ref, 'old_main_ref': old_main_ref, 'successor_import_ref': successor_import_ref,
    'old_main_source_count': 458, 'old_main_frontier': old_main_frontier,
    'source_inputs': [{'path': p, 'bytes': len(b), 'git_blob': hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest(),
                      'sha256': hashlib.sha256(b).hexdigest()} for p,b in inputs.items()],
    'core_policy': policy, 'name_results': name_results, 'fixtures': [all_new, successor],
    'findings': [
        'All four 202610070[1-4]0000 newsletter names and the 20261014050000 layout name fail Core yearOffset=2/tolerance=7 when classified new against old-main source.',
        'The same five names also sort before the exact old-main maximum. Stock guard reports offset failures first and continues, so it does not additionally print ordering failures for those names.',
        'The seven 20281011/20281012 names satisfy both date offset and old-main ordering in this source metadata check.',
        'Against successor import c76, eleven paths are already present and grandfathered; only layout is added and fails. That narrower append-policy result is not old-main migration-plan acceptance.',
        'Application/ledger state is UNKNOWN for all twelve allocations, including the seven passing names. Source absence and source policy results do not determine pending/applied state.'
    ],
    'limitations': [
        'Exact published helper/config and successor first-add author dates were used; fixtures construct a relative source baseline and are not an actual cross-repository merge-base test.',
        'No migration name or SQL was changed in any product source/ref. Prior policy receipts and candidate heads remain preserved.',
        'No rename, history resolve, timestamp guard bypass, database or migration execution is authorized by this check.'
    ],
    'exit': 0,
}
output = owned/'core12-old-main-timestamp-policy.receipt.json'
output.write_text(json.dumps(receipt, indent=2)+'\n')
print(json.dumps(receipt,separators=(',',':')))
