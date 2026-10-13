"""Receiving-branch source CI only; no native, full-retirement or deployed proof.

The workflow uses JSON (valid YAML) so this gate needs only Python's standard
library. These jobs exercise the existing owners and explicit synthetic fixtures.
They do not restore the donor carrier's absent full preservation check identity.
"""
from copy import deepcopy
import fnmatch
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PATH = ".github/workflows/backend-cleanup-preservation.yml"
BASE = "523ef9167f05a33efdbdfbbfc08d5fc2e2679012"
PATTERNS = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "apps/**",
            "packages/**", "scripts/**", "infra/**", "tests/**", "docs/**",
            ".github/workflows/**"]
COMMANDS = [
    ("Check the receiving source job and unchanged deployment defaults",
     "python3 scripts/ci/backend-retirement-source-jobs.contract.spec.py"),
    ("Exercise standalone assembly and Docker consumer refusals",
     "node --test scripts/ci/frontend-artifact-docker.contract.spec.mjs scripts/ci/frontend-standalone-artifact.contract.spec.mjs scripts/ci/newsletter-artifact-packaging-plan.spec.mjs"),
    ("Preserve static artifact owner contracts",
     "node --test scripts/ci/onboard-spa-artifact.contract.spec.mjs scripts/ci/newsletter-static-release.contract.spec.mjs"),
    ("Preserve reviewed backend retirement and command scopes",
     "node --test scripts/ci/florida-owned-portrait-release.spec.mjs scripts/ci/defense-backend-workspace.contract.spec.mjs scripts/ci/engagement-resilience-recovery.contract.spec.mjs scripts/ci/context-plane-scope.contract.spec.mjs scripts/ci/context-plane-validation-scope.spec.mjs scripts/ci/rebuild-verification-scopes.spec.mjs"),
    ("Preserve current-source edge declarations and header refusal",
     "node --test scripts/ci/newsletter-declared-edge.contract.spec.mjs"),
    ("Exercise isolated loopback fixtures with synthetic asset identities",
     "node --test scripts/ci/newsletter-loopback-serving.spec.mjs"),
]
DEFAULTS = ["apps/web/Dockerfile", "apps/onboard-api/Dockerfile", "package.json", "apps/api/package.json",
            "pnpm-workspace.yaml", "pnpm-lock.yaml", ".github/workflows/web-image.yml",
            ".github/workflows/cleanup1-gate.yml", ".github/workflows/ci-pr.yml"]


def unique_pairs(pairs):
    value = {}
    for key, child in pairs:
        if key in value:
            raise ValueError("duplicate workflow key: " + key)
        value[key] = child
    return value


def load(source):
    return json.loads(source, object_pairs_hook=unique_pairs)


def validate(document):
    assert set(document) == {"name", "on", "permissions", "jobs"}
    assert document["name"] == "Backend artifact source contracts"
    assert document["on"] == {"pull_request": {"paths": PATTERNS}}
    assert document["permissions"] == {"contents": "read"}
    assert set(document["jobs"]) == {"artifact-source-contracts"}
    job = document["jobs"]["artifact-source-contracts"]
    assert set(job) == {"runs-on", "timeout-minutes", "steps"}
    assert job["runs-on"] == "ubuntu-22.04" and job["timeout-minutes"] == 10
    assert job["steps"] == [
        {"uses": "actions/checkout@v4", "with": {"fetch-depth": 0,
                                               "persist-credentials": False}},
        {"uses": "actions/setup-node@v7", "with": {"node-version": "24"}},
        *[{"name": name, "run": command} for name, command in COMMANDS],
    ]
    return job


class SourceJobsContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = load((ROOT / PATH).read_text())

    def test_current_receiving_job_and_dependency_closure(self):
        job = validate(self.document)
        files = [word for step in job["steps"] for word in step.get("run", "").split()
                 if word.startswith("scripts/")]
        self.assertEqual(len(files), len(set(files)))
        for file in files:
            with self.subTest(file=file):
                self.assertTrue((ROOT / file).is_file(), "missing source owner")
        for file in ["scripts/build-newsletter-release.sh",
                     "scripts/lib/newsletter-artifact-packaging-plan.mjs",
                     "apps/web/Dockerfile.frontend-artifact"]:
            self.assertTrue((ROOT / file).is_file(), file)

    def test_all_source_categories_trigger_without_draft_native_work(self):
        validate(self.document)
        for file in ["pnpm-lock.yaml", "apps/new-package/package.json",
                     "packages/new-owner/src/index.ts", "scripts/new-spec.mjs",
                     "infra/cdk/new-stack.ts", "tests/new-test.ts",
                     "docs/contracts/new-contract.md", ".github/workflows/new.yml"]:
            self.assertTrue(any(fnmatch.fnmatchcase(file, pattern) for pattern in PATTERNS))
        self.assertNotIn("source-identities", self.document["jobs"])
        self.assertNotIn("frontend-parity", self.document["jobs"])

    def test_security_bypasses_and_unavailable_carrier_dependency_refuse(self):
        mutations = []
        for field, value in [("if", "false"), ("continue-on-error", True),
                             ("services", {"postgres": {"image": "postgres"}}),
                             ("permissions", {"id-token": "write"}),
                             ("needs", "unavailable-full-retirement")]:
            changed = deepcopy(self.document)
            changed["jobs"]["artifact-source-contracts"][field] = value
            mutations.append(changed)
        for field, value in [("permissions", {"contents": "write"}),
                             ("on", {"pull_request_target": {}})]:
            changed = deepcopy(self.document)
            changed[field] = value
            mutations.append(changed)
        for mutation in ["drop", "duplicate", "bypass", "install", "native", "upload", "source-pin"]:
            changed = deepcopy(self.document)
            steps = changed["jobs"]["artifact-source-contracts"]["steps"]
            if mutation == "drop": steps.pop()
            elif mutation == "duplicate": steps.append(deepcopy(steps[-1]))
            elif mutation == "source-pin": steps[0]["with"]["ref"] = "main"
            else:
                steps[3]["run"] += {"bypass": " || true", "install": "\nnpm install",
                                     "native": "\npnpm gate:cleanup1", "upload": "\naws s3 cp file s3://bucket"}[mutation]
            mutations.append(changed)
        for changed in mutations:
            with self.subTest(change=changed), self.assertRaises(AssertionError):
                validate(changed)
        with self.assertRaises(ValueError): load('{"jobs":{},"jobs":{}}')

    def test_failures_propagate_before_any_later_job_command(self):
        # Execute the actual selected command sequence against local inert tools.
        # A failing command must not reach any subsequent scope or success marker.
        job = validate(self.document)
        commands = [step["run"] for step in job["steps"] if "run" in step]
        with tempfile.TemporaryDirectory(prefix="capiro-source-job-") as temp:
            directory = Path(temp)
            tool = "#!/usr/bin/env python3\nimport os, pathlib, sys\np=pathlib.Path(os.environ['CALL_LOG'])\na=p.read_text().splitlines() if p.exists() else []\np.write_text('\\n'.join(a+[repr(sys.argv[1:])])+'\\n')\nsys.exit(17 if len(a)==int(os.environ['FAIL_AT']) else 0)\n"
            # /usr/bin/python3 is an explicit interpreter; the fake python3 below
            # therefore cannot recursively invoke itself through env/PATH.
            tool = tool.replace("#!/usr/bin/env python3", "#!/usr/bin/python3")
            for name in ["node", "python3"]:
                (directory / name).write_text(tool)
                (directory / name).chmod(0o700)
            script = "\n".join(commands + ["echo CAPIRO_ARTIFACT_SOURCE_FIXTURES_COMPLETE"])
            for fail_at in range(-1, len(commands)):
                log = directory / "calls.log"
                log.unlink(missing_ok=True)
                result = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script],
                                        env={"PATH": str(directory) + ":/usr/bin:/bin",
                                             "CALL_LOG": str(log), "FAIL_AT": str(fail_at)},
                                        capture_output=True, text=True)
                with self.subTest(fail_at=fail_at):
                    self.assertEqual(result.returncode, 0 if fail_at == -1 else 17)
                    self.assertEqual(len(log.read_text().splitlines()),
                                     len(commands) if fail_at == -1 else fail_at + 1)
                    self.assertEqual("CAPIRO_ARTIFACT_SOURCE_FIXTURES_COMPLETE" in result.stdout,
                                     fail_at == -1)

    def test_existing_defaults_and_full_acceptance_gates_stay_byte_exact(self):
        for file in DEFAULTS:
            before = subprocess.run(["git", "show", f"{BASE}:{file}"], cwd=ROOT,
                                    check=True, capture_output=True).stdout
            current = (ROOT / file).read_bytes()
            if file in ["package.json", "apps/api/package.json"]:
                kind = "root" if file == "package.json" else "api"
                source = "import {restoreReviewedPeManifest} from './scripts/lib/reviewed-pe-manifest-contract.mjs'; import {readFileSync} from 'node:fs'; process.stdout.write(restoreReviewedPeManifest(readFileSync(0), process.argv[1]));"
                current = subprocess.run(["node", "--no-addons", "--input-type=module", "-e", source, kind],
                                         cwd=ROOT, input=current, check=True, capture_output=True,
                                         env={"PATH": os.environ["PATH"]}).stdout
            with self.subTest(file=file): self.assertEqual(current, before)


if __name__ == "__main__":
    unittest.main()
