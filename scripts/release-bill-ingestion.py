#!/usr/bin/env python3
"""Merged backend-import operator for bounded FY26 bill tasks; never deploys services."""
import argparse
import copy
import json
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid

ACCOUNT = '967807252336'
REGION = 'us-east-1'
CLUSTER = 'capiro-dev'
HOST = 'capiro-newstack-preview-clone.cluster-csryw28ai752.us-east-1.rds.amazonaws.com'
ROOT = Path(__file__).resolve().parents[1]
SOURCE_REPOSITORY = 'https://github.com/neo-capiro/capiro-backend.git'
SOURCE_REF = 'refs/heads/backend-import'
REPOSITORY = 'capiro/preview-core'
IMAGE_PREFIX = f'{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/{REPOSITORY}@'
BASELINE = 'capiro-dev-api-sync-legiscan-bills-production-clone:3'
RULE = 'capiro-dev-sync-legiscan-bills'
TASK_ROLE = f'arn:aws:iam::{ACCOUNT}:role/Capiro-dev-Compute-ApiTaskRole12FAD4A7-szq3QeeZJSCQ'
EXEC_ROLE = f'arn:aws:iam::{ACCOUNT}:role/Capiro-dev-Compute-ApiMigrateTaskDefExecutionRoleEB-HuOMLdmYvwnx'
STATES = set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split())
JOBS = ('index', 'federal-passages', 'state-passages', 'federal-text', 'state-dataset', 'state-drain', 'state-archive', 'federal-archive', 'federal-inventory')
SCHEDULES = {'federal-passages': 'cron(10 * * * ? *)', 'state-passages': 'cron(20 * * * ? *)',
             'federal-text': 'cron(0 * * * ? *)'}
SCHEDULE_LIMITS = {'federal-text': 400, 'federal-passages': 1000, 'state-passages': 1000}

def require(condition, message):
    if not condition:
        raise ValueError(message)

def aws(service, operation, *args, payload=None):
    command = ['aws', service, operation, '--region', REGION, '--output', 'json', '--no-cli-pager', *args]
    # Payload contains only safe runtime configuration and secret references.
    # It is never printed; use a private temporary directory rather than shell interpolation.
    with tempfile.TemporaryDirectory(prefix='fy26-bill-') as directory:
        if payload is not None:
            file = Path(directory) / 'input.json'
            file.write_text(json.dumps(payload), encoding='utf-8')
            command += ['--cli-input-json', 'file://' + str(file)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    require(result.returncode == 0, f'AWS_{service}_{operation}_FAILED: ' + result.stderr[:500])
    return json.loads(result.stdout or '{}')

def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], text=True, timeout=60).strip()

def source_sha(sha):
    require(bool(re.fullmatch('[0-9a-f]{40}', sha)), 'INVALID_SOURCE_SHA')
    require(git('remote', 'get-url', 'origin') == SOURCE_REPOSITORY, 'REPOSITORY_MISMATCH')
    require(git('rev-parse', '--abbrev-ref', 'HEAD') in ('backend-import', 'HEAD'), 'BACKEND_IMPORT_CHECKOUT_REQUIRED')
    require(not git('status', '--porcelain', '--untracked-files=all'), 'CLEAN_SOURCE_REQUIRED')
    require(git('rev-parse', 'HEAD') == sha, 'CHECKOUT_SOURCE_MISMATCH')
    require(git('rev-parse', 'refs/remotes/origin/backend-import') == sha, 'INTEGRATION_SOURCE_MISMATCH')
    remote = git('ls-remote', '--exit-code', SOURCE_REPOSITORY, SOURCE_REF).split()
    require(remote == [sha, SOURCE_REF], 'REMOTE_INTEGRATION_SOURCE_MISMATCH')
    return sha

def image_digest(sha, qualified, write):
    repositories = aws('ecr', 'describe-repositories', '--repository-names', REPOSITORY)['repositories']
    require(len(repositories) == 1 and repositories[0]['repositoryName'] == REPOSITORY and
            repositories[0]['imageTagMutability'] == 'IMMUTABLE', 'IMMUTABLE_BACKEND_REPOSITORY_REQUIRED')
    images = aws('ecr', 'describe-images', '--repository-name', REPOSITORY, '--image-ids', 'imageTag=' + sha)['imageDetails']
    require(len(images) == 1 and sha in images[0].get('imageTags', []), 'CANDIDATE_SOURCE_TAG_MISMATCH')
    digest = images[0]['imageDigest']
    require(bool(re.fullmatch('sha256:[0-9a-f]{64}', digest)), 'INVALID_IMAGE_DIGEST')
    require(not write or qualified == digest, 'EXACT_IMAGE_QUALIFICATION_REQUIRED')
    return digest

def command_for(job, limit, commit, archive=None, publisher_only=False, phase='embed', passage_states=None, federal=None, alternate_only=False, all_formats=False):
    require(job in JOBS and type(limit) is int and 1 <= limit <= 1000, 'INVALID_JOB_OR_LIMIT')
    require(job != 'federal-text' or limit <= 400, 'FEDERAL_TEXT_CAP_EXCEEDED')
    require(not alternate_only or job == 'state-drain', 'ALTERNATE_ONLY_REQUIRES_STATE_DRAIN')
    require(not all_formats or job == 'state-drain', 'ALL_FORMATS_REQUIRES_STATE_DRAIN')
    require(not (alternate_only and all_formats), 'STATE_TEXT_FORMAT_OPTIONS_CONFLICT')
    publisher_only = publisher_only or alternate_only or all_formats
    require(not publisher_only or job == 'state-drain', 'PUBLISHER_ONLY_REQUIRES_STATE_DRAIN')
    require(phase in ('embed', 'extract') and (phase == 'embed' or job.endswith('-passages')), 'INVALID_EXTRACTION_PHASE')
    require(passage_states is None or (job == 'state-passages' and passage_states and len(set(passage_states)) == len(passage_states) and set(passage_states) <= STATES), 'PASSAGE_STATES_REQUIRE_STATE_JOB')
    if job in ('federal-archive', 'federal-inventory'):
        require(archive is None and isinstance(federal, dict), 'FEDERAL_SCOPE_REQUIRED')
        suffix = ['--commit', '--expected-host', HOST] if commit else []
        if job == 'federal-archive':
            require(set(federal) == {'type', 'hash', 'bills'} and federal['type'] in ('hr','s','hjres','sjres','hconres','sconres','hres','sres') and
                    isinstance(federal['hash'], str) and re.fullmatch('[0-9a-f]{64}', federal['hash']) and type(federal['bills']) is int and 1 <= federal['bills'] <= 50000, 'INVALID_FEDERAL_ARCHIVE_SCOPE')
            return ['import-federal-billstatus-cache', '--congress', '119', '--type', federal['type'], '--archive-hash', federal['hash'], '--expected-bills', str(federal['bills']), '--limit', str(limit)] + suffix
        if federal.get('stage') == 'refresh':
            require(set(federal) == {'stage', 'request_cap'} and type(federal['request_cap']) is int and
                    1 <= federal['request_cap'] <= 4800, 'INVALID_FEDERAL_REFRESH_SCOPE')
            return ['sync-federal-bill-inventory', '--congress', '119', '--stage', 'refresh',
                    '--limit', str(limit), '--request-cap', str(federal['request_cap'])] + suffix
        require(set(federal) == {'hashes', 'amendment_hash', 'amendments', 'stage', 'request_cap'} and isinstance(federal['hashes'], list) and len(federal['hashes']) == 8 and
                all(isinstance(h,str) and re.fullmatch('[0-9a-f]{64}', h) for h in federal['hashes']) and len(set(federal['hashes'])) == 8 and
                isinstance(federal['amendment_hash'],str) and re.fullmatch('[0-9a-f]{64}', federal['amendment_hash']) and
                type(federal['amendments']) is int and 1 <= federal['amendments'] <= 100000 and federal['stage'] in ('metadata','inventory','hydrate','finalize') and
                type(federal['request_cap']) is int and 1 <= federal['request_cap'] <= 4800, 'INVALID_FEDERAL_INVENTORY_SCOPE')
        return ['sync-federal-bill-inventory','--congress','119','--archive-hashes',','.join(federal['hashes']),'--amendment-list-hash',federal['amendment_hash'],
                '--expected-amendments',str(federal['amendments']),'--stage',federal['stage'],'--limit',str(limit),'--request-cap',str(federal['request_cap'])] + suffix
    require(federal is None, 'FEDERAL_SCOPE_WRONG_JOB')
    if job == 'state-archive':
        require(isinstance(archive, dict) and set(archive) == {'state', 'session', 'hash', 'bills'}, 'ARCHIVE_SCOPE_REQUIRED')
        require(archive['state'] in STATES and type(archive['session']) is int and archive['session'] > 0 and
                type(archive['bills']) is int and 1 <= archive['bills'] <= 50000 and
                isinstance(archive['hash'], str) and re.fullmatch('[0-9a-f]{64}', archive['hash']), 'INVALID_ARCHIVE_SCOPE')
        return ['import-state-dataset-cache', '--state', archive['state'], '--session', str(archive['session']),
                '--archive-hash', archive['hash'], '--expected-bills', str(archive['bills']), '--limit', str(limit)] + (
                ['--commit', '--expected-host', HOST] if commit else [])
    require(archive is None, 'ARCHIVE_SCOPE_WRONG_JOB')
    if job == 'index':
        return ['index-bill-passages'] + (['--commit', '--expected-host', HOST] if commit else [])
    if job.endswith('-passages'):
        return ['embed-bill-passages', '--source', job.split('-')[0], '--limit', str(limit)] + (['--states', ','.join(passage_states)] if passage_states else []) + (['--phase', 'extract'] if phase == 'extract' else []) + (['--commit', '--expected-host', HOST] if commit else [])
    if job == 'federal-text':
        return ['sync-federal-legislative-evidence', '--collection', 'BILLS', '--congress', '119', '--full', '--historical', '--cap', str(limit)] + (['--commit'] if commit else [])
    require(commit, 'STATE_WRITER_REQUIRES_COMMIT')
    return ['backfill-legiscan-datasets'] if job == 'state-dataset' else [
        'sync-state-text-drain', '--limit', str(min(limit, 100)), '--commit', '--expected-host', HOST] + (['--publisher-only'] if publisher_only else []) + (['--alternate-only'] if alternate_only else []) + (['--all-formats'] if all_formats else [])

def candidate_task(baseline, digest, sha, job, limit, states, commit, govinfo_arn=None, archive=None, publisher_only=False, phase='embed', passage_states=None, federal=None, congress_arn=None, alternate_only=False, all_formats=False):
    command = command_for(job, limit, commit, archive, publisher_only, phase, passage_states, federal, alternate_only, all_formats)
    require(bool(re.fullmatch('sha256:[0-9a-f]{64}', digest)), 'INVALID_IMAGE_DIGEST')
    require(bool(re.fullmatch('[0-9a-f]{40}', sha)), 'INVALID_SOURCE_SHA')
    require(states and len(set(states)) == len(states) and set(states) <= STATES, 'INVALID_STATES')
    # A dataset is the provider's atomic export. Keep each invocation to one state.
    require(job != 'state-dataset' or len(states) == 1, 'DATASET_REQUIRES_ONE_STATE')
    require(job != 'state-archive' or states == [archive['state']], 'ARCHIVE_STATE_MISMATCH')
    require(baseline['family'] == BASELINE.split(':')[0] and baseline['revision'] == 3, 'BASELINE_MISMATCH')
    require(baseline['taskRoleArn'] == TASK_ROLE and baseline['executionRoleArn'] == EXEC_ROLE, 'ROLE_MISMATCH')
    require(baseline['networkMode'] == 'awsvpc' and 'FARGATE' in baseline['requiresCompatibilities'], 'NETWORK_MODE_MISMATCH')
    require(baseline['runtimePlatform'] == {'cpuArchitecture': 'ARM64', 'operatingSystemFamily': 'LINUX'}, 'PLATFORM_MISMATCH')
    require(len(baseline['containerDefinitions']) == 1, 'BASELINE_CONTAINER_COUNT')
    old = baseline['containerDefinitions'][0]
    require(old['name'] == 'api-sync-legiscan-bills' and not old.get('environmentFiles'), 'BASELINE_CONTAINER_MISMATCH')
    env = {x['name']: x['value'] for x in old.get('environment', [])}
    require(env.get('DB_HOST') == HOST and env.get('DB_NAME') == 'capiro' and env.get('DB_PORT') == '5432', 'DATABASE_TARGET_MISMATCH')
    secret_map = {x['name']: x for x in old['secrets']}
    require({'DB_USER', 'DB_PASSWORD', 'LEGISCAN_API_KEY'} <= secret_map.keys(), 'MISSING_SECRET_REFERENCE')
    require(not ({'DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME'} & secret_map.keys()), 'AMBIGUOUS_DATABASE_TARGET')
    secret_names = ['DB_USER', 'DB_PASSWORD'] + (['LEGISCAN_API_KEY'] if job == 'state-dataset' or (job == 'state-drain' and not (publisher_only or alternate_only or all_formats)) else [])
    secrets = [copy.deepcopy(secret_map[name]) for name in secret_names]
    if job == 'federal-text' and commit:
        require(govinfo_arn and re.fullmatch(f'arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:capiro/dev/govinfo_api_key-[A-Za-z0-9]+', govinfo_arn), 'GOVINFO_REFERENCE_REQUIRED')
        secrets.append({'name': 'GOVINFO_API_KEY', 'valueFrom': govinfo_arn})
    if job == 'federal-inventory' and commit and federal['stage'] in ('metadata','inventory','refresh'):
        require(congress_arn and re.fullmatch(f'arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:capiro/dev/congress_gov_api_key-[A-Za-z0-9]+', congress_arn), 'CONGRESS_REFERENCE_REQUIRED')
        secrets.append({'name': 'CONGRESS_API_KEY', 'valueFrom': congress_arn})
    safe = {key: env[key] for key in ('DB_HOST', 'DB_PORT', 'DB_NAME')}
    safe.update(NODE_ENV='production', AWS_REGION_DEFAULT=REGION, BILL_FISCAL_YEAR='2026', GIT_SHA=sha, RELEASE_SHA=sha,
                LEGISCAN_STATES=','.join(states), LEGISCAN_SESSIONS='all', LEGISCAN_DRAIN_CAP=str(limit),
                LEGISCAN_DOCUMENT_REFRESH_CAP=str(min(limit, 100)), LEGISCAN_VOTE_REFRESH_CAP='25',
                LEGISCAN_MONTHLY_BUDGET='9000', LEGISCAN_HARD_CAP='10000', LEGISCAN_DOCUMENT_EVIDENCE_ENABLED='true',
                LEGIWATCH_PUBLISHED_RECORD_REFRESH_ENABLED='true', FEDERAL_LEGISLATIVE_EVIDENCE_ENABLED='true')
    container = {'name': 'fy26-bills', 'image': IMAGE_PREFIX + digest, 'essential': True,
                 'command': command, 'environment': [{'name': k, 'value': v} for k, v in sorted(safe.items())],
                 'secrets': secrets, 'logConfiguration': copy.deepcopy(old['logConfiguration']),
                 'readonlyRootFilesystem': old.get('readonlyRootFilesystem', False)}
    result = {key: copy.deepcopy(baseline[key]) for key in ('taskRoleArn', 'executionRoleArn', 'networkMode', 'requiresCompatibilities', 'cpu', 'memory', 'runtimePlatform')}
    result.update(family='capiro-dev-api-fy26-bills-' + job, containerDefinitions=[container])
    return result

def network_for(targets):
    require(len(targets) == 1, 'EXPECTED_ONE_BILL_TARGET')
    target = targets[0]
    require(target['Arn'] == f'arn:aws:ecs:{REGION}:{ACCOUNT}:cluster/{CLUSTER}', 'CLUSTER_MISMATCH')
    require(target['RoleArn'] == f'arn:aws:iam::{ACCOUNT}:role/capiro-dev-eventbridge-sync-invoker', 'INVOKER_MISMATCH')
    ecs = target['EcsParameters']
    require(ecs['LaunchType'] == 'FARGATE' and ecs['TaskCount'] == 1, 'TARGET_MODE_MISMATCH')
    net = ecs['NetworkConfiguration']['awsvpcConfiguration']
    require(set(net['Subnets']) == {'subnet-0e38bd390f8961fef', 'subnet-0920665f91c905f01', 'subnet-06db79cd21239de19'} and
            net['SecurityGroups'] == ['sg-01def4e5c0fe44d4a'] and net['AssignPublicIp'] == 'DISABLED', 'BILL_NETWORK_MISMATCH')
    return {'awsvpcConfiguration': {'subnets': net['Subnets'], 'securityGroups': net['SecurityGroups'], 'assignPublicIp': 'DISABLED'}}

def ingestion_metric(events):
    metrics = []
    for event in events:
        line = event.get('message', '')
        if line.startswith('INGESTION_METRIC '):
            line = line[len('INGESTION_METRIC '):]
        try:
            row = json.loads(line)
            if isinstance(row, dict) and 'source' in row and 'error_count' in row:
                metrics.append(row)
        except (ValueError, TypeError):
            pass
    require(len(metrics) == 1 and metrics[0]['error_count'] == 0, 'SUCCESSFUL_DB_RUN_RECEIPT_REQUIRED')
    return metrics[0]

def verify_registered_task(expected, registered):
    for key, value in expected.items():
        if key != 'containerDefinitions':
            require(registered.get(key) == value, 'REGISTERED_TASK_MISMATCH')
            continue
        actual = registered.get(key, [])
        require(len(actual) == len(value) == 1, 'REGISTERED_CONTAINER_MISMATCH')
        for field, submitted in value[0].items():
            returned = actual[0].get(field)
            # ECS returns these name/value sets in arbitrary order. Keep exact
            # membership and values, and never normalize command argument order.
            if field in ('environment', 'secrets'):
                require(isinstance(returned, list) and
                        all(isinstance(item, dict) and isinstance(item.get('name'), str) for item in returned),
                        'REGISTERED_CONTAINER_MISMATCH')
                require(len({item['name'] for item in returned}) == len(returned), 'REGISTERED_CONTAINER_MISMATCH')
                returned = sorted(returned, key=lambda item: item['name'])
                submitted = sorted(submitted, key=lambda item: item['name'])
            require(returned == submitted, 'REGISTERED_CONTAINER_MISMATCH')

def schedule_snapshot(job):
    require(job in SCHEDULES, 'JOB_NOT_SCHEDULEABLE')
    rule = 'capiro-dev-fy26-bills-' + job
    state = aws('events', 'describe-rule', '--name', rule)
    require(state['Name'] == rule and state['State'] == 'ENABLED' and
            state['ScheduleExpression'] == SCHEDULES[job], 'EXISTING_SCHEDULE_MISMATCH')
    targets = aws('events', 'list-targets-by-rule', '--rule', rule)['Targets']
    network_for(targets)
    target = targets[0]
    expected_arn = f'arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/capiro-dev-api-fy26-bills-{job}:'
    require(target['Id'] == 'fy26-bill-task' and
            re.fullmatch(re.escape(expected_arn) + '[1-9][0-9]*', target['EcsParameters']['TaskDefinitionArn']), 'EXISTING_TARGET_MISMATCH')
    require(not target.get('InputPath') and not target.get('InputTransformer') and
            json.loads(target.get('Input', '{}')) == {'containerOverrides': [{'name': 'fy26-bills',
                'command': command_for(job, SCHEDULE_LIMITS[job], True)}]}, 'EXISTING_COMMAND_MISMATCH')
    return {'rule': state, 'target': target}

def activate_schedule(job, td, arn, before, metric):
    require(job in SCHEDULES, 'JOB_NOT_SCHEDULEABLE')
    source = metric.get('source', '')
    require(metric.get('error_count') == 0 and
            (source == 'sync-federal-legislative-evidence' if job == 'federal-text' else
             source.startswith('bill-text:fy26:' + job.split('-')[0] + ':')), 'CANARY_SOURCE_MISMATCH')
    command = td['containerDefinitions'][0]['command']
    require(command == command_for(job, SCHEDULE_LIMITS[job], True), 'SCHEDULE_COMMAND_MISMATCH')
    require(schedule_snapshot(job) == before, 'BILL_TARGET_CHANGED_DURING_CANARY')
    rule = before['rule']['Name']
    desired = copy.deepcopy(before['target'])
    desired['EcsParameters']['TaskDefinitionArn'] = arn
    # Keep the enabled rule, target ID, command, roles and network unchanged.
    # EventBridge has no compare-and-swap API: the root release lock plus this
    # immediate recheck prevents competing releases; PutTargets replaces one ID.
    result = aws('events', 'put-targets', payload={'Rule': rule, 'Targets': [desired]})
    require(result.get('FailedEntryCount') == 0, 'SCHEDULE_TARGET_FAILED')
    after = schedule_snapshot(job)
    require(after == {'rule': before['rule'], 'target': desired}, 'SCHEDULE_READBACK_MISMATCH')
    return {'rule': rule, 'expression': SCHEDULES[job], 'taskDefinition': arn,
            'previousTaskDefinition': before['target']['EcsParameters']['TaskDefinitionArn']}

def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog='Exit 0: completed; 1: guard/run failure; 2: invalid arguments. Root qualifies the exact image before writes.')
    parser.add_argument('--operation', choices=['inspect', 'run', 'schedule'], default='inspect')
    parser.add_argument('--job', choices=JOBS, required=True)
    parser.add_argument('--limit', type=int, default=3)
    parser.add_argument('--states', help='State jobs default FL; explicit passage states use an isolated one-shot checkpoint')
    parser.add_argument('--archive-hash', help='Exact previously staged ZIP SHA256; state-archive only')
    parser.add_argument('--archive-session', type=int)
    parser.add_argument('--archive-bills', type=int, help='Exact full provider parent count in the frozen ZIP')
    parser.add_argument('--federal-type', choices=['hr','s','hjres','sjres','hconres','sconres','hres','sres'])
    parser.add_argument('--archive-hashes')
    parser.add_argument('--amendment-list-hash')
    parser.add_argument('--expected-amendments', type=int, help='Pinned stages default 7119; refresh discovers a complete current count')
    parser.add_argument('--federal-stage', choices=['metadata','inventory','hydrate','finalize','refresh'])
    parser.add_argument('--request-cap', type=int, default=100)
    parser.add_argument('--commit', action='store_true')
    parser.add_argument('--publisher-only', action='store_true', help='State drain without LegiScan API credentials or fallback')
    parser.add_argument('--alternate-only', action='store_true', help='One-shot state alternate PDF drain; forces publisher-only and omits LegiScan credentials')
    parser.add_argument('--all-formats', action='store_true', help='One bounded state drain of primary and alternate formats; forces publisher-only and omits LegiScan credentials')
    parser.add_argument('--phase', choices=['extract', 'embed'], default='embed', help='One-shot passage extraction or embedding')
    parser.add_argument('--source-sha', required=True, help='Exact reviewed, merged backend-import tip')
    parser.add_argument('--qualified-digest', help='Exact ARM64 digest already probed and scanned by root')
    parser.add_argument('--receipt', type=Path, help='Absolute receipt path outside the checkout; required for run/schedule')
    args = parser.parse_args()
    states = (args.states or 'FL').split(',')
    passage_states = states if args.states is not None and args.job == 'state-passages' else None
    federal = None
    if args.job == 'federal-archive':
        require(args.archive_session is None and args.archive_hashes is None and args.amendment_list_hash is None and args.federal_stage is None, 'FEDERAL_ARCHIVE_ARGUMENT_MISMATCH')
        federal = {'type':args.federal_type,'hash':args.archive_hash,'bills':args.archive_bills}
    elif args.job == 'federal-inventory':
        require(args.federal_type is None and args.archive_hash is None and args.archive_session is None and args.archive_bills is None, 'FEDERAL_INVENTORY_ARGUMENT_MISMATCH')
        if args.federal_stage == 'refresh':
            require(args.archive_hashes is None and args.amendment_list_hash is None and args.expected_amendments is None, 'FEDERAL_REFRESH_REJECTS_FROZEN_PINS')
            federal = {'stage':'refresh','request_cap':args.request_cap}
        else:
            federal = {'hashes':(args.archive_hashes or '').split(','),'amendment_hash':args.amendment_list_hash,'amendments':7119 if args.expected_amendments is None else args.expected_amendments,'stage':args.federal_stage,'request_cap':args.request_cap}
    else:
        require(not any(v is not None for v in (args.federal_type,args.archive_hashes,args.amendment_list_hash,args.federal_stage)) and args.expected_amendments in (None,7119) and args.request_cap == 100, 'FEDERAL_SCOPE_WRONG_JOB')
    archive = None
    if args.job == 'state-archive' or (args.job != 'federal-archive' and any(value is not None for value in (args.archive_hash, args.archive_session, args.archive_bills))):
        require(len(states) == 1, 'ARCHIVE_REQUIRES_ONE_STATE')
        archive = {'state': states[0], 'session': args.archive_session, 'hash': args.archive_hash, 'bills': args.archive_bills}
    command_for(args.job, args.limit, args.commit, archive, args.publisher_only, args.phase, passage_states, federal, args.alternate_only, args.all_formats)
    require(states and len(set(states)) == len(states) and set(states) <= STATES, 'INVALID_STATES')
    require(args.job != 'state-dataset' or len(states) == 1, 'DATASET_REQUIRES_ONE_STATE')
    if args.operation == 'schedule':
        require(not args.alternate_only, 'ALTERNATE_FORMATS_ARE_ONE_SHOT_ONLY')
        require(not args.all_formats, 'ALL_FORMATS_ARE_ONE_SHOT_ONLY')
        require(passage_states is None, 'STATE_SCOPED_PASSAGES_ARE_ONE_SHOT_ONLY')
        require(args.phase == 'embed', 'EXTRACTION_IS_ONE_SHOT_ONLY')
        require(args.commit and args.job in SCHEDULES, 'SCHEDULE_REQUIRES_SUPPORTED_COMMIT_JOB')
        require(args.limit == SCHEDULE_LIMITS[args.job], 'SCHEDULE_LIMIT_MISMATCH')
    if args.operation != 'inspect':
        require(bool(re.fullmatch('sha256:[0-9a-f]{64}', args.qualified_digest or '')), 'EXACT_IMAGE_QUALIFICATION_REQUIRED')
        require(args.receipt is not None and args.receipt.is_absolute() and
                not args.receipt.resolve().is_relative_to(ROOT) and args.receipt.parent.is_dir(), 'EXTERNAL_RECEIPT_PATH_REQUIRED')
    sha = source_sha(args.source_sha)
    require(aws('sts', 'get-caller-identity')['Account'] == ACCOUNT, 'AWS_ACCOUNT_MISMATCH')
    digest = image_digest(sha, args.qualified_digest, args.operation != 'inspect')
    baseline = aws('ecs', 'describe-task-definition', '--task-definition', BASELINE)['taskDefinition']
    target = aws('events', 'list-targets-by-rule', '--rule', RULE)['Targets']
    network = network_for(target)
    govinfo = aws('secretsmanager', 'describe-secret', '--secret-id', 'capiro/dev/govinfo_api_key')['ARN'] if args.job == 'federal-text' and args.commit else None
    congress = aws('secretsmanager', 'describe-secret', '--secret-id', 'capiro/dev/congress_gov_api_key')['ARN'] if args.job == 'federal-inventory' and args.commit and federal['stage'] in ('metadata','inventory','refresh') else None
    td = candidate_task(baseline, digest, sha, args.job, args.limit, states, args.commit, govinfo, archive, args.publisher_only, args.phase, passage_states, federal, congress, args.alternate_only, args.all_formats)
    schedule = schedule_snapshot(args.job) if args.operation == 'schedule' else None
    receipt = {'operation': args.operation, 'job': args.job, 'source': sha, 'digest': digest, 'databaseHost': HOST,
               'command': td['containerDefinitions'][0]['command'], 'states': ','.join(states), 'limit': args.limit, 'commit': args.commit}
    if schedule is not None:
        receipt['scheduleBefore'] = schedule
    print(json.dumps(receipt), flush=True)
    if args.operation == 'inspect':
        return
    registered = aws('ecs', 'register-task-definition', payload=td)['taskDefinition']
    arn = registered['taskDefinitionArn']
    verify_registered_task(td, registered)
    started = aws('ecs', 'run-task', payload={'cluster': CLUSTER, 'taskDefinition': arn, 'count': 1,
        'launchType': 'FARGATE', 'networkConfiguration': network, 'startedBy': 'fy26-bill-backend',
        'clientToken': 'fy26-' + str(uuid.uuid4())})
    require(not started.get('failures') and len(started.get('tasks', [])) == 1, 'BILL_TASK_NOT_STARTED')
    task_arn = started['tasks'][0]['taskArn']
    receipt.update(taskDefinition=arn, taskArn=task_arn)
    args.receipt.write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(json.dumps({'taskArn': task_arn, 'status': 'started'}), flush=True)
    for _ in range(90):
        time.sleep(30)
        tasks = aws('ecs', 'describe-tasks', '--cluster', CLUSTER, '--tasks', task_arn)
        if tasks.get('failures') or not tasks.get('tasks'):
            continue  # ECS read-after-start can be eventually consistent.
        task = tasks['tasks'][0]
        require(task['taskDefinitionArn'] == arn and task['taskArn'] == task_arn, 'RUNNING_TASK_MISMATCH')
        if task['lastStatus'] != 'STOPPED':
            continue
        containers = task.get('containers', [])
        passed = len(containers) == 1 and containers[0].get('exitCode') == 0 and containers[0].get('imageDigest') == digest
        receipt.update(status='success' if passed else 'failed', stopCode=task.get('stopCode'), stoppedReason=task.get('stoppedReason'),
                       containers=[{k: c.get(k) for k in ('name', 'exitCode', 'imageDigest', 'reason')} for c in containers])
        args.receipt.write_text(json.dumps(receipt, indent=2), encoding='utf-8')
        print(json.dumps(receipt), flush=True)
        require(passed, 'BILL_TASK_FAILED')
        if args.operation == 'schedule':
            logs = td['containerDefinitions'][0]['logConfiguration']['options']
            stream = logs['awslogs-stream-prefix'] + '/fy26-bills/' + task_arn.rsplit('/', 1)[1]
            events = aws('logs', 'get-log-events', '--log-group-name', logs['awslogs-group'], '--log-stream-name', stream, '--start-from-head')['events']
            metric = ingestion_metric(events)
            source_sha(sha)
            receipt['schedule'] = activate_schedule(args.job, td, arn, schedule, metric)
            receipt['runMetric'] = metric
            args.receipt.write_text(json.dumps(receipt, indent=2), encoding='utf-8')
            print(json.dumps({'schedule': receipt['schedule']}), flush=True)
        return
    raise TimeoutError('BILL_TASK_WAIT_EXPIRED: inspect recorded task ARN; do not blindly retry')

if __name__ == '__main__':
    main()
