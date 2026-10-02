import datetime, hashlib, json, pathlib, re
import boto3
from botocore.config import Config

ROOT = pathlib.Path(r'C:\dev\cap-meri-foundation-evidence\oct02-reply-only')
BUILD = 'capiro-build-web-dev:98fcfd2b-fc5e-4ca0-962c-32b9af96933f'
SOURCE = 'bae902c734eea220b4c6299423119e7bdaac2f6b'
SPEC_HASH = 'dd3aaac45be1eada1a2451add262b6407313d699b390deb0c0707455c370af90'
REGION = 'us-east-1'
REPOSITORY = 'capiro/dev/meriv2-orchestrator'
PREFIX = '967807252336.dkr.ecr.us-east-1.amazonaws.com/' + REPOSITORY
session = boto3.Session(profile_name='default', region_name=REGION)
config = Config(connect_timeout=10, read_timeout=30, retries={'max_attempts': 2})
client = lambda name: session.client(name, config=config)
now = datetime.datetime.now(datetime.timezone.utc)
result = {'schema': 'meri-reply-only-independent-codebuild-v1', 'observedAt': now.isoformat(),
          'verdict': 'NOT_RUN', 'sourceSha': SOURCE, 'buildId': BUILD, 'externalWrites': 0,
          'scope': 'Read-only exact-source build, executed offline tests, packaged runtime and ECR qualification; deployment/live acceptance excluded.'}

def need(condition, code):
    if not condition:
        raise RuntimeError(code)

try:
    identity = client('sts').get_caller_identity()
    need(identity['Account'] == '967807252336' and identity['Arn'] == 'arn:aws:iam::967807252336:user/hermes-cli', 'CALLER_MISMATCH')
    response = client('codebuild').batch_get_builds(ids=[BUILD])
    need(not response.get('buildsNotFound') and len(response.get('builds', [])) == 1, 'BUILD_ID_MISMATCH')
    build = response['builds'][0]
    need(build['id'] == BUILD and build['projectName'] == 'capiro-build-web-dev', 'PROJECT_MISMATCH')
    need(build['sourceVersion'] == SOURCE, 'REQUESTED_SOURCE_MISMATCH')
    need(build['source']['type'] == 'GITHUB' and build['source']['location'] in ['https://github.com/neo-capiro/capirov2', 'https://github.com/neo-capiro/capirov2.git'], 'CANONICAL_SOURCE_MISMATCH')
    actual_hash = hashlib.sha256(build['source']['buildspec'].encode('utf-8')).hexdigest()
    need(actual_hash == SPEC_HASH, 'ACTUAL_BUILDSPEC_MISMATCH')
    need(hashlib.sha256((ROOT/'meriv2-orchestrator.buildspec.yml').read_bytes()).hexdigest() == SPEC_HASH, 'LOCAL_REVIEWED_BUILDSPEC_MISMATCH')
    need(build['environment']['type'] == 'ARM_CONTAINER' and build['environment']['privilegedMode'] is True, 'BUILD_ENVIRONMENT_MISMATCH')
    pinned = [x for x in build['environment'].get('environmentVariables', []) if x['name'] == 'EXPECTED_SHA']
    need(len(pinned) == 1 and pinned[0]['value'] == SOURCE and pinned[0]['type'] == 'PLAINTEXT', 'SOURCE_OVERRIDE_MISMATCH')
    if build.get('resolvedSourceVersion'):
        need(build['resolvedSourceVersion'] == SOURCE, 'RESOLVED_SOURCE_MISMATCH')
    result.update(buildStatus=build['buildStatus'], currentPhase=build.get('currentPhase'),
                  actualBuildspecSha256=actual_hash, resolvedSourceSha=build.get('resolvedSourceVersion'),
                  environmentType=build['environment']['type'], environmentImage=build['environment']['image'],
                  phases=[{'phase': p['phaseType'], 'status': p.get('phaseStatus')} for p in build.get('phases', [])])
    if build['buildStatus'] == 'IN_PROGRESS':
        result['verdict'] = 'IN_PROGRESS'
    else:
        need(build['buildStatus'] == 'SUCCEEDED', 'BUILD_DID_NOT_SUCCEED')
        need(build.get('resolvedSourceVersion') == SOURCE, 'RESOLVED_SOURCE_UNAVAILABLE')
        for phase in ['DOWNLOAD_SOURCE', 'PRE_BUILD', 'BUILD', 'POST_BUILD']:
            found = [p for p in build.get('phases', []) if p['phaseType'] == phase]
            need(len(found) == 1 and found[0].get('phaseStatus') == 'SUCCEEDED', 'EXECUTED_PHASE_NOT_SUCCEEDED')
        logs = build['logs']
        need(logs['groupName'] == '/aws/codebuild/capiro-build-web-dev' and logs['streamName'] == BUILD.split(':')[1], 'LOG_IDENTITY_MISMATCH')
        log_client = client('logs')
        token = None
        markers = []
        count_payloads = []
        ansi = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')
        for page in range(100):
            args = dict(logGroupName=logs['groupName'], logStreamName=logs['streamName'], startFromHead=True, limit=10000)
            if token:
                args['nextToken'] = token
            response = log_client.get_log_events(**args)
            for event in response['events']:
                for raw in event['message'].splitlines():
                    line = ansi.sub('', raw).strip()
                    if line.startswith('ORCHESTRATOR_SOURCE_TEST_COUNTS='):
                        count_payloads.append(json.loads(line.split('=', 1)[1]))
                    elif re.fullmatch(r'(OFFLINE_PACKAGED_ENTRYPOINT_HEALTH_AUTH_PASS|LOCAL_REPODIGEST_ECR_MATCH_PASS|CANDIDATE_ORCHESTRATOR_SOURCE_SHA=[a-f0-9]{40}|CANDIDATE_ORCHESTRATOR_IMAGE=967807252336\.dkr\.ecr\.us-east-1\.amazonaws\.com/capiro/dev/meriv2-orchestrator@sha256:[a-f0-9]{64})', line):
                        markers.append({'timestamp': event['timestamp'], 'line': line})
            next_token = response.get('nextForwardToken')
            if next_token == token:
                break
            token = next_token
        else:
            raise RuntimeError('LOG_PAGINATION_LIMIT')
        need(len(count_payloads) == 1, 'EXECUTED_TEST_COUNTS_MISSING_OR_DUPLICATE')
        counts = count_payloads[0]
        keys = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites']
        need(set(counts) == set(keys) and all(isinstance(counts[k], int) for k in keys), 'TEST_COUNT_SHAPE_MISMATCH')
        need(counts['numFailedTests'] == counts['numFailedTestSuites'] == 0 and counts['numPassedTests'] > 0, 'TESTS_NOT_PASSED')
        need(counts['numTotalTests'] == counts['numPassedTests'] + counts['numPendingTests'], 'TEST_COUNT_ARITHMETIC')
        need(counts['numTotalTestSuites'] == counts['numPassedTestSuites'] + counts['numPendingTestSuites'], 'SUITE_COUNT_ARITHMETIC')
        details = client('ecr').describe_images(repositoryName=REPOSITORY, imageIds=[{'imageTag': SOURCE}])['imageDetails']
        need(len(details) == 1 and SOURCE in details[0].get('imageTags', []), 'ECR_SOURCE_TAG_MISMATCH')
        digest = details[0]['imageDigest']
        need(re.fullmatch(r'sha256:[a-f0-9]{64}', digest) is not None, 'ECR_DIGEST_INVALID')
        expected_markers = ['OFFLINE_PACKAGED_ENTRYPOINT_HEALTH_AUTH_PASS', 'LOCAL_REPODIGEST_ECR_MATCH_PASS', 'CANDIDATE_ORCHESTRATOR_SOURCE_SHA='+SOURCE, 'CANDIDATE_ORCHESTRATOR_IMAGE='+PREFIX+'@'+digest]
        for marker in expected_markers:
            need(sum(m['line'] == marker for m in markers) == 1, 'EXECUTED_MARKER_MISSING_OR_DUPLICATE')
        result.update(verdict='PASS', actualTestCounts=counts, executedMarkers=markers, image=PREFIX+'@'+digest,
                      imageDigest=digest, ociRevisionSourceSha=SOURCE,
                      labelProof='SUCCEEDED exact reviewed buildspec asserts built OCI revision label equals exact source, ARM64 architecture and packaged Node v20.16.0 before publish.',
                      liveAcceptance='NOT_RUN; skipped live tests remain skipped',
                      expectedCountComparison={'expectedPassed': 1405, 'expectedPending': 2, 'expectedSuites': 125,
                                               'matchesExpected': counts['numPassedTests'] == 1405 and counts['numPendingTests'] == 2 and counts['numTotalTestSuites'] == 125})
except Exception as error:
    result.update(verdict='BLOCKED', failureCode=str(error) if isinstance(error, RuntimeError) else type(error).__name__)

path = ROOT/('orchestrator-repair-independent-'+now.strftime('%Y%m%dT%H%M%SZ')+'.json')
path.write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
print(json.dumps({'receipt': str(path), 'verdict': result['verdict'], 'buildStatus': result.get('buildStatus'),
                  'phase': result.get('currentPhase'), 'actualTestCounts': result.get('actualTestCounts'),
                  'imageDigest': result.get('imageDigest'), 'failureCode': result.get('failureCode')}))
raise SystemExit(1 if result['verdict'] == 'BLOCKED' else 0)
