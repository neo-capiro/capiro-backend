#!/usr/bin/env python3
"""Source regression guard; not a YAML security parser or IAM enforcement proof.

Hermes drafted the contract/tests; integration tightens exact tags, required
files, actual denial, and fixed-path loading. Review new scripts/actions too.
"""
import re
import sys
import unittest
from pathlib import Path

SERVICES = ('api', 'api-strategy', 'engagement-api', 'intel-api', 'onboard-api',
            'workspace', 'web', 'meriv2-orchestrator')
WORKFLOWS = tuple(s + '-image.yml' for s in SERVICES) + ('web-vnext-deploy.yml',)
ROOT = Path(__file__).resolve().parent.parent
REQUIRED = tuple('.github/workflows/' + f for f in WORKFLOWS) + (
    '.github/workflows/deploy-all.yml', '.github/workflows/ci-pr.yml',
    'scripts/execute-meriv2-ecs-release.mjs', 'scripts/deploy-dev.sh', 'scripts/deploy-onboard.sh')
DENY = '''case "$SERVICE" in
            clio-sandbox|marketing) ;;
            *) echo "Use the reviewed digest release procedure for protected services." >&2; exit 1 ;;
          esac'''
ALLOWED_ACTIONS = ('actions/checkout@', 'pnpm/action-setup@', 'actions/setup-node@',
                   'aws-actions/configure-aws-credentials@', 'aws-actions/amazon-ecr-login@',
                   'docker/setup-buildx-action@', 'docker/setup-qemu-action@', 'docker/build-push-action@')
BUILD_DIGEST = '${{ steps.build.outputs.digest }}'
# api-image.yml also uploads the narrow source-to-digest receipt defined in
# docs/contracts/api-image-build-record.md.
# Evidence only: the exact producer command and artifact action are permitted for
# that one workflow; nothing else may add actions or helpers.
EVIDENCE_ACTIONS = {'api-image.yml': ('actions/upload-artifact@',)}
EVIDENCE_RUNS = {'api-image.yml': (
    'set -euo pipefail\nexport CHECKED_OUT_SHA="$(git rev-parse HEAD)"\npython scripts/api-image-build-record.py',)}


def evaluate(files):
    errors = []
    for name in REQUIRED:
        if name not in files:
            errors.append('Missing required file: ' + name)
    for name in WORKFLOWS:
        content = files.get('.github/workflows/' + name, '')
        code = '\n'.join(line for line in content.splitlines() if not line.lstrip().startswith('#'))
        if re.search(r':latest\b|workflow_run\s*:|aws\s+ecs\b|update-service|register-task-definition|services-stable|docker\s+push', code):
            errors.append(name + ': forbidden mutable/deploy path')
        actions = re.findall(r'\buses:\s*(\S+)', code)
        allowed_actions = ALLOWED_ACTIONS + EVIDENCE_ACTIONS.get(name, ())
        if any(not a.startswith(allowed_actions) for a in actions):
            errors.append(name + ': unreviewed action/reusable workflow')
        tag_blocks = re.findall(r'(?m)^          tags: \|\n((?:            [^\n]+\n)+)', content + '\n')
        service = name.removesuffix('-image.yml')
        repo = ('${{ env.EXPECTED_ECR_REPOSITORY }}' if name == 'web-vnext-deploy.yml'
                else 'capiro/${{ env.TARGET_ENV }}/' + service)
        expected = '            ${{ steps.ecr.outputs.registry }}/' + repo + ':${{ github.sha }}'
        if len(tag_blocks) != 1 or tag_blocks[0].splitlines() != [expected]:
            errors.append(name + ': require exclusive exact SHA tag')
        if '        id: build\n        uses: docker/build-push-action@' not in content or 'push: true' not in content:
            errors.append(name + ': missing bound build action')
        # Every IMAGE_DIGEST binding must be the bound build step's digest, never a tag or SHA.
        digests = re.findall(r'(?m)^\s+IMAGE_DIGEST:\s*(.*?)\s*$', code)
        if not digests or any(d != BUILD_DIGEST for d in digests) or '$GITHUB_STEP_SUMMARY' not in content:
            errors.append(name + ': missing candidate digest evidence')
        # Only known build/test commands are expected. Adding an indirect shell,
        # Python/Node release helper is a reviewable contract change, not an escape.
        for block in re.split(r'(?m)^      - ', content)[1:]:
            run = re.search(r'(?m)^        run:\s*([^\n]*)([\s\S]*)', block)
            if not run:
                continue
            body = (run[1] + run[2]).strip().lstrip('|>-').strip()
            if '\n'.join(line.strip() for line in body.splitlines()) in EVIDENCE_RUNS.get(name, ()):
                continue
            if (re.search(r'\b(?:bash|sh|curl|wget|aws|node|pwsh|powershell|source)\b|\$\(|`|&&|;', body)
                    or not re.match(r'(?:python3 scripts/validate-meri-(?:build-isolation|orchestrator-build-only)\.py\s*$|pnpm (?:install --frozen-lockfile|--filter @capiro/(?:shared|strategy-verifier|web) (?:build|typecheck|exec vitest run))|test -n "\$IMAGE_DIGEST")', body)):
                # Summary prose contains a semicolon; it is quoted, not executable.
                summary = body.startswith('test -n "$IMAGE_DIGEST"') and all(
                    re.match(r'\s*(?:test -n "\$IMAGE_DIGEST"|echo "[^"`]*" >> "\$GITHUB_STEP_SUMMARY")\s*$', line)
                    and '$(' not in line for line in body.splitlines())
                if not summary:
                    errors.append(name + ': unreviewed run command')
    deploy = files.get('.github/workflows/deploy-all.yml', '')
    options = re.search(r'      service:[\s\S]*?        options:\n((?:          - [^\n]+\n)+)', deploy)
    if not options or options[1].splitlines() != ['          - clio-sandbox', '          - marketing']:
        errors.append('deploy-all: protected service choice')
    aws_pos = deploy.find('uses: aws-actions/configure-aws-credentials@')
    if DENY not in deploy or aws_pos < 0 or deploy.index(DENY) >= aws_pos:
        errors.append('deploy-all: deny direct dispatch before credentials')
    execute = files.get('scripts/execute-meriv2-ecs-release.mjs', '')
    if not execute.startswith("#!/usr/bin/env node\nthrow new Error('Retired:") or re.search(r'\bimport\b|execFile|update-service|run-task', execute):
        errors.append('legacy Meri executor not retired')
    for name in ('scripts/deploy-dev.sh', 'scripts/deploy-onboard.sh'):
        body = files.get(name, '')
        if '\nexit 1\n' not in body or re.search(r'\baws\b|docker|eval|source', body):
            errors.append(name + ': mutable deployment bypass')
    ci = files.get('.github/workflows/ci-pr.yml', '')
    for command in ('python3 scripts/validate-meri-build-isolation.py',
                    'node --test scripts/lib/meri-release-policy.test.mjs scripts/meri-release.test.mjs'):
        if command not in ci:
            errors.append('ci-pr: missing ' + command)
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
        del self.files['.github/workflows/api-image.yml']
        self.assertTrue(evaluate(self.files))

    def test_latest(self):
        self.mutate('.github/workflows/api-image.yml', ':${{ github.sha }}', ':latest')

    def test_extra_mutable_tag(self):
        self.mutate('.github/workflows/api-image.yml', '          tags: |', '          tags: |\n            registry/other:mutable')

    def test_ecs(self):
        self.mutate('.github/workflows/api-image.yml', 'run: python3', 'run: aws ecs update-service\n          python3')

    def test_indirect_helper(self):
        self.mutate('.github/workflows/api-image.yml', 'run: python3 scripts/validate-meri-build-isolation.py', 'run: node scripts/meri-release.mjs promote')

    def test_deploy_action(self):
        self.mutate('.github/workflows/api-image.yml', 'uses: actions/checkout@v4', 'uses: aws-actions/amazon-ecs-deploy-task-definition@v2')

    def test_missing_digest(self):
        self.mutate('.github/workflows/api-image.yml', '${{ steps.build.outputs.digest }}', '${{ github.sha }}')

    def test_record_helper_exact(self):
        self.mutate('.github/workflows/api-image.yml', 'python scripts/api-image-build-record.py',
                    'python scripts/api-image-build-record.py --promote')

    def test_evidence_action_scoped(self):
        self.mutate('.github/workflows/web-image.yml', 'uses: actions/checkout@v4', 'uses: actions/upload-artifact@v4')

    def test_missing_deny(self):
        self.mutate('.github/workflows/deploy-all.yml', DENY, 'echo allowed')

    def test_noop_deny(self):
        self.mutate('.github/workflows/deploy-all.yml', '>&2; exit 1 ;;', '>&2; true ;;')

    def test_late_deny(self):
        name = '.github/workflows/deploy-all.yml'
        self.files[name] = self.files[name].replace(DENY, '') + '\n' + DENY
        self.assertTrue(evaluate(self.files))

    def test_legacy_reactivated(self):
        self.mutate('scripts/execute-meriv2-ecs-release.mjs', 'throw new Error', 'console.log')

    def test_ci_missing(self):
        self.mutate('.github/workflows/ci-pr.yml', 'node --test scripts/lib/meri-release-policy.test.mjs scripts/meri-release.test.mjs', 'echo skip')


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        unittest.main(argv=[sys.argv[0]])
    else:
        failures = evaluate(load())
        print('\n'.join(failures) if failures else 'PASS: 9 SHA-only build workflows, protected bypasses retired, CI qualification wired')
        sys.exit(bool(failures))
