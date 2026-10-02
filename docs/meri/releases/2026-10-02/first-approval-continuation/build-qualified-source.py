"""Fixed API/orchestrator build only, after exact-source Actions startup failure."""
import datetime, hashlib, json, pathlib, re, subprocess, sys, time
import boto3
from botocore.config import Config

base = pathlib.Path(__file__).parent
repo = pathlib.Path(r'C:\dev\cap-meri-outcomes-validation')
mode, service = sys.argv[1:]
assert mode in ('start', 'observe') and service in ('api', 'meriv2-orchestrator', 'web-vnext')
request = json.loads((base / 'reviewed-build-input.json').read_text())
source = request['sourceSha']
assert re.fullmatch('[0-9a-f]{40}', source)
selected = request['services'][service]
recipe = (base / (service + '.buildspec.yml')).read_bytes()
recipe_hash = hashlib.sha256(recipe).hexdigest()
assert recipe_hash == selected['buildspecSha256']
session = boto3.Session(profile_name='default', region_name='us-east-1')
config = Config(retries={'total_max_attempts': 1}, connect_timeout=10, read_timeout=30)
client = lambda name: session.client(name, config=config)
who = client('sts').get_caller_identity()
assert who['Account'] == '967807252336' and who['Arn'] == 'arn:aws:iam::967807252336:user/hermes-cli'
cb = client('codebuild')
start_file = base / (service + '-build-start.json')
def git(*args):
    return subprocess.check_output(['git', *args], cwd=repo, text=True).strip()
def need(condition, code):
    if not condition:
        raise RuntimeError(code)

if mode == 'start':
    assert git('branch', '--show-current') == 'main'
    assert git('rev-parse', 'HEAD') == source and not git('status', '--porcelain')
    assert git('ls-remote', 'origin', 'refs/heads/main').split()[0] == source
    run = json.loads(subprocess.check_output(['gh', 'run', 'view', str(selected['actionRunId']), '--repo', 'neo-capiro/capirov2', '--json', 'headSha,conclusion,jobs,url,workflowName'], cwd=repo, text=True))
    assert run['headSha'] == source and run['conclusion'] == 'startup_failure' and not run['jobs']
    assert run['workflowName'] == {'api':'api-image','meriv2-orchestrator':'meriv2-orchestrator-image','web-vnext':'web-vnext-image'}[service]
    projects = cb.batch_get_projects(names=['capiro-build-web-dev'])['projects']
    assert len(projects) == 1
    project = projects[0]
    assert project['source']['type'] == 'GITHUB' and project['source']['location'] in ('https://github.com/neo-capiro/capirov2', 'https://github.com/neo-capiro/capirov2.git')
    assert project['environment']['type'] == 'ARM_CONTAINER' and project['environment']['privilegedMode'] is True
    args = {'projectName': 'capiro-build-web-dev', 'sourceVersion': source, 'buildspecOverride': recipe.decode(), 'environmentVariablesOverride': [{'name': 'EXPECTED_SHA', 'value': source, 'type': 'PLAINTEXT'}], 'idempotencyToken': 'case01-' + service + '-' + source[:20]}
    with (base / (service + '-build-request.json')).open('x', encoding='utf8') as file:
        json.dump(args, file, indent=2)
    with (base / (service + '-build-start.lock')).open('x') as file:
        json.dump({'sourceSha': source, 'service': service, 'startedAtEpoch': time.time()}, file)
    build = cb.start_build(**args)['build']
    receipt = {'service': service, 'buildId': build['id'], 'sourceSha': source, 'buildspecSha256': recipe_hash, 'actionRun': run, 'callerArn': who['Arn'], 'status': build['buildStatus'], 'startedAtEpoch': time.time(), 'scope': 'Immutable candidate image publication only; no ECS service, database, migration or provider configuration mutation'}
    with start_file.open('x', encoding='utf8') as file:
        json.dump(receipt, file, indent=2)
    print(json.dumps(receipt))
else:
    start = json.loads(start_file.read_text())
    need(start['sourceSha'] == source and start['buildspecSha256'] == recipe_hash and start['service'] == service, 'START_BINDING_MISMATCH')
    build_id = start['buildId']
    now = datetime.datetime.now(datetime.timezone.utc)
    out = {'service': service, 'sourceSha': source, 'buildId': build_id, 'observedAt': now.isoformat(), 'verdict': 'NOT_RUN', 'externalWrites': 0, 'liveAcceptance': 'NOT_RUN'}
    try:
        result = cb.batch_get_builds(ids=[build_id])
        need(not result.get('buildsNotFound') and len(result['builds']) == 1, 'BUILD_ID_MISMATCH')
        build = result['builds'][0]
        need(build['id'] == build_id and build['projectName'] == 'capiro-build-web-dev' and build['sourceVersion'] == source, 'SOURCE_PROJECT_MISMATCH')
        need(build['source']['type'] == 'GITHUB' and build['source']['location'] in ('https://github.com/neo-capiro/capirov2', 'https://github.com/neo-capiro/capirov2.git'), 'BUILD_ORIGIN_MISMATCH')
        need(hashlib.sha256(build['source']['buildspec'].encode()).hexdigest() == recipe_hash, 'EXECUTED_RECIPE_MISMATCH')
        need(build['environment']['type'] == 'ARM_CONTAINER' and build['environment']['privilegedMode'] is True, 'BUILD_ENVIRONMENT_MISMATCH')
        variables = [item for item in build['environment'].get('environmentVariables', []) if item['name'] == 'EXPECTED_SHA']
        need(variables == [{'name': 'EXPECTED_SHA', 'value': source, 'type': 'PLAINTEXT'}], 'SOURCE_OVERRIDE_MISMATCH')
        if build.get('resolvedSourceVersion'):
            need(build['resolvedSourceVersion'] == source, 'RESOLVED_SOURCE_MISMATCH')
        out.update(buildStatus=build['buildStatus'], phase=build.get('currentPhase'), actualBuildspecSha256=recipe_hash, resolvedSourceSha=build.get('resolvedSourceVersion'), phases=[{'phase': phase['phaseType'], 'status': phase.get('phaseStatus')} for phase in build.get('phases', [])])
        if build['buildStatus'] == 'IN_PROGRESS':
            out['verdict'] = 'IN_PROGRESS'
        else:
            need(build['buildStatus'] == 'SUCCEEDED' and build.get('resolvedSourceVersion') == source, 'BUILD_NOT_SUCCEEDED')
            for phase in ('DOWNLOAD_SOURCE', 'PRE_BUILD', 'BUILD', 'POST_BUILD'):
                observed = [item for item in build['phases'] if item['phaseType'] == phase]
                need(len(observed) == 1 and observed[0].get('phaseStatus') == 'SUCCEEDED', 'PHASE_NOT_SUCCEEDED')
            details = client('ecr').describe_images(repositoryName='capiro/dev/' + service, imageIds=[{'imageTag': source}])['imageDetails']
            need(len(details) == 1 and source in details[0]['imageTags'], 'ECR_SOURCE_TAG_MISMATCH')
            digest = details[0]['imageDigest']
            need(re.fullmatch(r'sha256:[a-f0-9]{64}', digest), 'ECR_DIGEST_INVALID')
            image = '967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/' + service + '@' + digest
            label = {'api':'API','meriv2-orchestrator':'ORCHESTRATOR','web-vnext':'WEB'}[service]
            expected = list(selected['executedMarkers']) + ['LOCAL_REPODIGEST_ECR_MATCH_PASS', 'CANDIDATE_' + label + '_SOURCE_SHA=' + source, 'CANDIDATE_' + label + '_IMAGE=' + image]
            logs = build['logs']
            need(logs['groupName'] == '/aws/codebuild/capiro-build-web-dev' and logs['streamName'] == build_id.split(':')[1], 'LOG_IDENTITY_MISMATCH')
            token, markers = None, []
            log_client = client('logs')
            for _ in range(100):
                args = {'logGroupName': logs['groupName'], 'logStreamName': logs['streamName'], 'startFromHead': True, 'limit': 10000}
                if token:
                    args['nextToken'] = token
                page = log_client.get_log_events(**args)
                for event in page['events']:
                    for raw in event['message'].splitlines():
                        line = re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', raw).strip()
                        if line in expected:
                            markers.append({'timestamp': event['timestamp'], 'line': line})
                following = page.get('nextForwardToken')
                if following == token:
                    break
                token = following
            else:
                raise RuntimeError('LOG_PAGINATION_LIMIT')
            for marker in expected:
                need(sum(item['line'] == marker for item in markers) == 1, 'EXECUTED_MARKER_MISSING_OR_DUPLICATE')
            out.update(verdict='PASS', image=image, imageDigest=digest, executedMarkers=markers)
    except Exception as error:
        out.update(verdict='BLOCKED', failureCode=str(error) if isinstance(error, RuntimeError) else type(error).__name__)
    output = base / (service + '-independent-' + now.strftime('%Y%m%dT%H%M%S%fZ') + '.json')
    with output.open('x', encoding='utf8') as file:
        json.dump(out, file, indent=2)
    print(json.dumps({'receipt': str(output), 'verdict': out['verdict'], 'status': out.get('buildStatus'), 'phase': out.get('phase'), 'imageDigest': out.get('imageDigest'), 'failureCode': out.get('failureCode')}))
    sys.exit(1 if out['verdict'] == 'BLOCKED' else 0)
