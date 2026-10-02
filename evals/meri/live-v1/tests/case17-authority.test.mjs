import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import {
  inspectCase17Scope,
  collectCase17LiveCapture,
  currentCase17CaptureAuthority,
} from '../case17-live-capture.mjs';
import { inspectCase17Build } from '../case17-build-authority.mjs';
import { gradeCase17CapturedOutcome, inspectCase17VisualReview } from '../grade-case17-capture.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
function config() {
  const userId = randomUUID();
  return {
    schemaVersion: 1,
    caseId: '17',
    target: 'https://os.capiro.ai',
    captureRunId: randomUUID(),
    clerkOrganizationId: 'org_owned',
    limits: { concurrency: 1, maxSynthesisSubmissions: 0, maxApplicationWrites: 0 },
    deployment: { apiSha: 'a'.repeat(40), webSha: 'b'.repeat(40) },
    recipe: {
      schemaVersion: 1,
      target: 'capiro-dev',
      fixtureNamespace: 'meri-foundation-20260928',
      caseId: '17',
      fixtureInstanceId: randomUUID(),
      ctx: {
        tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
        tenantSlug: 'meri-foundation-20260928-t1',
        role: 'user_admin',
        userId,
      },
      clerkUserId: 'user_Priya',
      actors: { PRIYA: { physicalId: userId, tenantId: 'T1' } },
    },
  };
}
it('only approved existing-role proposer and no-turn read scope is accepted as data', () => {
  const c = config();
  assert.deepEqual(inspectCase17Scope(c), c);
  for (const change of [
    (c) => {
      c.caseId = '14';
    },
    (c) => {
      c.target = 'https://app.capiro.ai';
    },
    (c) => {
      c.recipe.ctx.role = 'standard_user';
    },
    (c) => {
      c.recipe.ctx.tenantId = randomUUID();
    },
    (c) => {
      c.recipe.ctx.userId = randomUUID();
    },
    (c) => {
      c.limits.maxSynthesisSubmissions = 1;
    },
    (c) => {
      c.limits.maxApplicationWrites = 1;
    },
    (c) => {
      c.deployment.webSha = 'unqualified';
    },
  ]) {
    const c = config();
    change(c);
    assert.throws(() => inspectCase17Scope(c));
  }
});
it('fake storage, copied receipt, page and claimed readiness cannot mint live capture authority', async () => {
  const outcome = {
    caseId: '17',
    status: 'CAPTURE_COMPLETE',
    fixtureReady: true,
    evidence: { sha256: 'a'.repeat(64) },
  };
  assert.throws(() => currentCase17CaptureAuthority(outcome), /UNTRUSTED_CAPTURE/);
  assert.throws(() => gradeCase17CapturedOutcome(outcome), /UNTRUSTED_CAPTURE/);
  await assert.rejects(
    collectCase17LiveCapture({
      config: config(),
      artifactStorage: { root: 'C:/forged', writeBytes: () => {} },
      createSignInTicket: () => {
        throw Error('must not call auth');
      },
      onSessionCreated: () => {},
      page: {},
      readCurrentOwner: () => ({ ready: true }),
    }),
    /unverified native artifact storage/,
  );
});
function buildFixture(service) {
  const sourceSha = 'a'.repeat(40),
    imageDigest = 'sha256:' + 'b'.repeat(64);
  return {
    expected: {
      service,
      sourceSha,
      imageDigest,
      buildId: 'unit-build',
      buildspecSha256: hash('fixed recipe'),
    },
    build: {
      id: 'unit-build',
      buildStatus: 'SUCCEEDED',
      buildComplete: true,
      resolvedSourceVersion: sourceSha,
      source: {
        type: 'GITHUB',
        location: 'https://github.com/neo-capiro/capirov2',
        buildspec: 'fixed recipe',
      },
      phases: ['PRE_BUILD', 'BUILD', 'POST_BUILD'].map((phaseType) => ({
        phaseType,
        phaseStatus: 'SUCCEEDED',
      })),
    },
    snapshot: {
      task: {
        containerDefinitions: [
          {
            name: service,
            image: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/${service}@${imageDigest}`,
            environment: [
              { name: 'GIT_SHA', value: sourceSha },
              { name: 'RELEASE_SHA', value: sourceSha },
            ],
          },
        ],
      },
      baseline: { imageDigest, taskDefinitionArn: 'unit-definition' },
      service: {
        deployments: [{ id: 'unit-deployment', status: 'PRIMARY', rolloutState: 'COMPLETED' }],
      },
    },
    image: { imageDetails: [{ imageDigest }] },
  };
}
it('both API and Web require exact current successful build/source/recipe/digest binding', () => {
  for (const service of ['api', 'web-vnext']) {
    assert.equal(inspectCase17Build(buildFixture(service)).service, service);
    for (const alter of [
      (f) => {
        f.build.buildStatus = 'FAILED';
      },
      (f) => {
        f.build.source.buildspec = 'other';
      },
      (f) => {
        f.build.source.location = 'https://github.com/other/repo';
      },
      (f) => {
        f.snapshot.task.containerDefinitions[0].name = 'sidecar';
      },
      (f) => {
        f.snapshot.baseline.imageDigest = 'sha256:' + '0'.repeat(64);
      },
      (f) => {
        f.snapshot.service.deployments[0].rolloutState = 'IN_PROGRESS';
      },
      (f) => {
        f.snapshot.task.containerDefinitions[0].environment[0].value = '0'.repeat(40);
      },
    ]) {
      const f = buildFixture(service);
      alter(f);
      assert.throws(() => inspectCase17Build(f));
    }
  }
  assert.throws(() => inspectCase17Build(buildFixture('meriv2-orchestrator')));
});
it('saved visual review binds exact twelve saved screenshots, run, bytes and capture time', () => {
  const evidence = {
    captureRunId: randomUUID(),
    completedAt: Date.now() - 1000,
    rounds: [
      {
        cards: Array.from({ length: 6 }, (_, i) => ({
          screenshot: { sha256: hash('before' + i) },
        })),
      },
      {
        cards: Array.from({ length: 6 }, (_, i) => ({ screenshot: { sha256: hash('after' + i) } })),
      },
    ],
  };
  const review = {
    schemaVersion: 1,
    kind: 'meri-case17-visual-review',
    caseId: '17',
    captureRunId: evidence.captureRunId,
    evidenceSha256: 'a'.repeat(64),
    reviewer: 'Synthetic QA reviewer',
    reference: 'Established Meri Memory cards',
    rationale: 'Each source/scope/action visible before and after reload',
    reviewedAt: new Date().toISOString(),
    screenshotSha256s: evidence.rounds.flatMap((r) => r.cards.map((c) => c.screenshot.sha256)),
    allSixCardsVisibleWithCorrectScopeAndProvenance: true,
    allSixActionsVisibleAfterReload: true,
  };
  assert.equal(inspectCase17VisualReview(review, evidence, 'a'.repeat(64)).passed, true);
  for (const alter of [
    (r) => {
      r.captureRunId = randomUUID();
    },
    (r) => {
      r.evidenceSha256 = 'b'.repeat(64);
    },
    (r) => {
      r.screenshotSha256s.pop();
    },
    (r) => {
      r.reviewedAt = new Date(evidence.completedAt - 1).toISOString();
    },
    (r) => {
      r.reviewer = '';
    },
    (r) => {
      delete r.allSixActionsVisibleAfterReload;
    },
  ]) {
    const r = structuredClone(review);
    alter(r);
    assert.throws(() => inspectCase17VisualReview(r, evidence, 'a'.repeat(64)));
  }
  assert.equal(
    inspectCase17VisualReview(
      { ...review, allSixActionsVisibleAfterReload: false },
      evidence,
      'a'.repeat(64),
    ).passed,
    false,
  );
});
