#!/usr/bin/env python3
"""Source regression guard for the Meri/backend image-build boundary.

This guard is NOT a YAML security parser and NOT an IAM enforcement proof. It is
a fail-closed source contract over the *retained* build and release inputs.

WHY IT NO LONGER READS .github/workflows
----------------------------------------
The historical per-service GitHub workflows (api-image.yml, web-image.yml,
meriv2-orchestrator-image.yml, deploy-all.yml, ci-pr.yml, ...) were removed by
the inert backend repository import (c76f5fc0). They no longer exist at the
frozen source and this guard must not pretend they do. The same isolation
semantics are now carried by the actual retained operators:

  * scripts/meri-image-build.mjs   the only image-build path (CodeBuild project
                                   capiro-build-web-dev, buildspec override):
                                   exact-SHA source pin, exact-SHA tag, no
                                   mutable tag, no ECS/deploy side effect,
                                   offline image smoke, digest readback.
  * scripts/meri-release.mjs       the only promotion path; it must never build
                                   or push an image (build != promotion).
  * retired stubs                  deploy-dev.sh, deploy-onboard.sh and
                                   execute-meriv2-ecs-release.mjs stay retired.

Where a historical carrier is genuinely gone (the deploy-all.yml service-option
gate), the equivalent retained property is asserted instead: no retained input
can dispatch an ECS deployment of a protected service, because the build
operator has zero deployment commands and the retired deploy scripts abort.

Run:  python3 scripts/validate-meri-build-isolation.py
Test: python3 scripts/validate-meri-build-isolation.py --self-test
"""
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

BUILD_OPERATOR = 'scripts/meri-image-build.mjs'
RELEASE_OPERATOR = 'scripts/meri-release.mjs'
RETIRED_SCRIPTS = ('scripts/execute-meriv2-ecs-release.mjs',
                   'scripts/deploy-dev.sh', 'scripts/deploy-onboard.sh')
EVIDENCE_OPERATOR = 'scripts/api-image-build-record.py'
BUILDABLE_DOCKERFILES = ('apps/api/Dockerfile',
                         'apps/meriv2-orchestrator/Dockerfile',
                         'apps/web/Dockerfile')
REQUIRED = (BUILD_OPERATOR, RELEASE_OPERATOR, EVIDENCE_OPERATOR) + RETIRED_SCRIPTS + BUILDABLE_DOCKERFILES

ALLOWED_SERVICES = ('api', 'meriv2-orchestrator', 'web-vnext')
FORBIDDEN_BUILD_EFFECTS = ('aws ecs', 'update-service', 'register-task-definition',
                           'services-stable', 'run-task', 'aws ecs ')
EXACT_SHA_TAG = re.escape(r':\${EXPECTED_SHA}')
SOURCE_REPOSITORY = 'https://github.com/neo-capiro/capiro-backend.git'


def _code(text):
    return '\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('//'))


def evaluate(files):
    errors = []
    for name in REQUIRED:
        if name not in files:
            errors.append('Missing required file: ' + name)
    build = files.get(BUILD_OPERATOR, '')
    release = files.get(RELEASE_OPERATOR, '')

    # ---- the only image-build path ----------------------------------------
    if not build:
        errors.append(BUILD_OPERATOR + ': missing build operator')
    else:
        code = _code(build)
        services = re.search(r'if \(!\[([^\]]+)\]\.includes\(SERVICE\)\)', code)
        parsed = tuple(re.findall(r"'([^']+)'", services[1])) if services else ()
        if parsed != ALLOWED_SERVICES:
            errors.append('build operator: buildable service allowlist changed')
        if re.search(r':latest\b', code):
            errors.append('build operator: mutable latest tag')
        # Exactly one immutable image reference, bound to the pinned SHA.
        refs = re.findall(r'dkr\.ecr\.\$\{REGION\}\.amazonaws\.com/\$\{REPOSITORY\}' + EXACT_SHA_TAG, code)
        if len(refs) != 1:
            errors.append('build operator: require exactly one exact-SHA image reference')
        # Exactly one push, of that reference, in the post-build phase only.
        if code.count('docker push') != 1 or 'docker push "$image"' not in code:
            errors.append('build operator: require exactly one bound docker push')
        if not re.search(r'const image = `[^`]*' + EXACT_SHA_TAG + r'`', code):
            errors.append('build operator: pushed image is not bound to the exact SHA')
        for effect in FORBIDDEN_BUILD_EFFECTS:
            if effect in code:
                errors.append('build operator: deployment side effect ' + effect.strip())
        # Source identity, platform, account and tag-absence are asserted before
        # any build command runs.
        for fragment, label in (
                ('CODEBUILD_RESOLVED_SOURCE_VERSION', 'resolved source version'),
                ('git rev-parse HEAD', 'checked-out sha'),
                ('git status --porcelain --untracked-files=no', 'clean tree'),
                ('$(uname -m)" = aarch64', 'native arm64 host'),
                ('aws sts get-caller-identity --query Account --output text)" = ${ACCOUNT}',
                 'account identity'),
                ("imageIds[?imageTag=='", 'unused exact tag')):
            if fragment not in code:
                errors.append('build operator: missing ' + label)
        # Exact split-repository source pin for this build; the project itself is
        # still configured for the legacy repository, so the pin is mandatory.
        if "const SOURCE_REPOSITORY = '" + SOURCE_REPOSITORY + "'" not in code:
            errors.append('build operator: exact source repository pin changed')
        if 'sourceTypeOverride: ' not in code or 'sourceLocationOverride: SOURCE_REPOSITORY' not in code:
            errors.append('build operator: start-build does not pin sourceLocationOverride')
        if 'sourceVersion: SOURCE_SHA' not in code:
            errors.append('build operator: start-build does not pin sourceVersion')
        # Offline qualification and its required markers.
        runs = re.findall(r'docker run[^\n]*', code)
        if not runs or any('--network none' not in run for run in runs):
            errors.append('build operator: an image smoke is not offline')
        markers = re.search(r'const REQUIRED = \[([^\]]*)\]', code)
        parsed_markers = re.findall(r"'([^']+)'", markers[1]) if markers else []
        if parsed_markers != ['IMAGE_SMOKE_PASS', 'LOCAL_REPODIGEST_ECR_MATCH_PASS', 'PROMOTION_POLICY_TEST_PASS']:
            errors.append('build operator: required markers changed')
        # The promotion/release policy tests are a required gate on the retained
        # build path (the historical ci-pr.yml wiring was removed).
        if ('node --test scripts/lib/meri-release-policy.test.mjs scripts/meri-release.test.mjs'
                not in code or 'echo PROMOTION_POLICY_TEST_PASS' not in code):
            errors.append('build operator: promotion-policy test gate not wired')
        # Attribution must name the repository the source is actually pinned to.
        if 'org.opencontainers.image.source=https://github.com/neo-capiro/capiro-backend' not in code:
            errors.append('build operator: OCI source attribution is not the pinned backend repository')
        # Exactly one StartBuild; recovery must be read-only.
        if code.count("'start-build'") != 1:
            errors.append('build operator: require exactly one start-build call')
        for fragment in ('list-builds-for-project', 'batch-get-builds', 'selectReconcileMatch'):
            if fragment not in code:
                errors.append('build operator: missing read-only reconcile binding ' + fragment)
        # Build + smoke are never reported as a qualification on their own.
        if 'BUILD_AND_IMAGE_SMOKE_PASS_NOT_QUALIFIED' not in code or 'qualified: false' not in code:
            errors.append('build operator: build/smoke claims qualification without the digest scan')
        if "'scan'" not in code or 'scan-readback.json' not in code:
            errors.append('build operator: digest scan stage missing')
        if 'echo IMAGE_SMOKE_PASS' not in code and "console.log('IMAGE_SMOKE_PASS')" not in code:
            errors.append('build operator: smoke does not emit IMAGE_SMOKE_PASS')
        # This guard and the orchestrator guard must keep being invoked by the
        # actual build path: that is the retained CI wiring.
        for guard in ('python3 scripts/validate-meri-build-isolation.py',
                      'python3 scripts/validate-meri-orchestrator-build-only.py'):
            if guard not in code:
                errors.append('build operator: guard not wired ' + guard)
        if 'meri-release.mjs' in code:
            errors.append('build operator: build must not invoke promotion')

    # ---- promotion never builds or publishes ------------------------------
    if release:
        if re.search(r'start-build|start_build|startBuild', release):
            errors.append('release operator: promotion must not start a build')
        if re.search(r'docker\s+build|docker\s+push', release):
            errors.append('release operator: promotion must not build or push images')

    # ---- retired deployment bypasses stay retired -------------------------
    execute = files.get('scripts/execute-meriv2-ecs-release.mjs', '')
    if execute and ("throw new Error('Retired:" not in execute
                    or re.search(r'\bimport\b|\brequire\(|execFile|spawn\(|update-service|run-task|aws ecs', execute)):
        errors.append('legacy Meri executor not retired')
    for name in ('scripts/deploy-dev.sh', 'scripts/deploy-onboard.sh'):
        body = files.get(name, '')
        if body and ('\nexit 1\n' not in body or re.search(r'\baws\b|docker|eval|source', body)):
            errors.append(name + ': mutable deployment bypass')

    # ---- buildable recipes still exist ------------------------------------
    for name in BUILDABLE_DOCKERFILES:
        body = files.get(name, '')
        if body and not re.search(r'(?m)^FROM\s+\S+', body):
            errors.append(name + ': no build stage')
    return errors


def load():
    return {name: (ROOT / name).read_text(encoding='utf-8') for name in REQUIRED if (ROOT / name).is_file()}


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.files = load()
        self.assertEqual(evaluate(self.files), [])

    def mutate(self, name, before, after):
        self.assertIn(before, self.files[name])
        self.files[name] = self.files[name].replace(before, after, 1)
        self.assertTrue(evaluate(self.files))

    def test_missing_file(self):
        del self.files[BUILD_OPERATOR]
        self.assertTrue(evaluate(self.files))

    def test_latest_tag(self):
        self.mutate(BUILD_OPERATOR, r':\${EXPECTED_SHA}', ':latest')

    def test_second_image_reference(self):
        self.mutate(BUILD_OPERATOR, 'docker push "$image"',
                    'docker push registry/other:${EXPECTED_SHA}\ndocker push "$image"')

    def test_ecs_side_effect(self):
        self.mutate(BUILD_OPERATOR, 'docker push "$image"', 'aws ecs update-service --force\ndocker push "$image"')

    def test_source_pin_removed(self):
        self.mutate(BUILD_OPERATOR, 'sourceLocationOverride: SOURCE_REPOSITORY,', '')

    def test_source_repository_changed(self):
        self.mutate(BUILD_OPERATOR, SOURCE_REPOSITORY, 'https://github.com/neo-capiro/capirov2.git')

    def test_guard_unwired(self):
        self.mutate(BUILD_OPERATOR, 'python3 scripts/validate-meri-build-isolation.py', 'true')

    def test_offline_smoke_removed(self):
        self.mutate(BUILD_OPERATOR, '--network none', '--network host')

    def test_architecture_check_removed(self):
        self.mutate(BUILD_OPERATOR, '$(uname -m)" = aarch64', '$(uname -m)" = x86_64')

    def test_account_check_removed(self):
        self.mutate(BUILD_OPERATOR, 'aws sts get-caller-identity --query Account --output text)" = ${ACCOUNT}', 'true')

    def test_marker_removed(self):
        self.mutate(BUILD_OPERATOR, "'IMAGE_SMOKE_PASS'", "'SMOKE_PASS'")

    def test_promotion_gate_removed(self):
        self.mutate(BUILD_OPERATOR, 'node --test scripts/lib/meri-release-policy.test.mjs scripts/meri-release.test.mjs', 'echo skip')

    def test_promotion_marker_removed(self):
        self.mutate(BUILD_OPERATOR, 'echo PROMOTION_POLICY_TEST_PASS', 'echo done')

    def test_source_attribution_reverted(self):
        self.mutate(BUILD_OPERATOR,
                    'org.opencontainers.image.source=https://github.com/neo-capiro/capiro-backend',
                    'org.opencontainers.image.source=https://github.com/neo-capiro/capirov2')

    def test_second_start_build(self):
        self.mutate(BUILD_OPERATOR, "aws(['codebuild', 'start-build',",
                    "aws(['codebuild', 'start-build', '--dry-run']);\n  aws(['codebuild', 'start-build',")

    def test_qualification_claimed_without_scan(self):
        self.mutate(BUILD_OPERATOR, "'BUILD_AND_IMAGE_SMOKE_PASS_NOT_QUALIFIED'", "'IMMUTABLE_BUILD_AND_IMAGE_SMOKE_PASS'")
        self.assertTrue(evaluate(self.files))

    def test_service_allowlist_widened(self):
        self.mutate(BUILD_OPERATOR, "'web-vnext']", "'web-vnext', 'marketing']")

    def test_promotion_starts_a_build(self):
        self.mutate(RELEASE_OPERATOR, 'const fail = (message) => {',
                    "const startBuild = () => 1;\nconst fail = (message) => {")

    def test_legacy_reactivated(self):
        self.mutate('scripts/execute-meriv2-ecs-release.mjs', 'throw new Error', 'console.log')

    def test_deploy_bypass_reactivated(self):
        self.mutate('scripts/deploy-dev.sh', 'exit 1', 'exit 1\naws ecs update-service')


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        unittest.main(argv=[sys.argv[0]])
    else:
        failures = evaluate(load())
        print('\n'.join(failures) if failures
              else 'PASS: exact-SHA source-pinned build operator, promotion separation, '
                   'retired bypasses and wired guards')
        sys.exit(bool(failures))
