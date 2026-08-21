import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  OutreachV3ApproachApproval,
  OutreachV3DraftArtifact,
  OutreachV3GenerationPlan,
  OutreachV3SendIntentView,
} from './engagement-api.js';
import {
  approvalCount,
  deriveOutreachPhase1View,
  partitionDrafts,
  sendProgress,
} from './outreach-v3-phase1-model.js';

function draft(
  id: string,
  options: {
    approval?: string;
    audit?: string;
    severity?: string;
  } = {},
): OutreachV3DraftArtifact {
  return {
    id,
    outreachRecordId: 'record-1',
    generationKey: id,
    recipientKey: `${id}@example.com`,
    audienceKind: 'individual',
    currentVersion: 1,
    current: {
      id: `${id}-v1`,
      artifactId: id,
      outreachRecordId: 'record-1',
      version: 1,
      sourceVersionId: null,
      generationKey: id,
      recipientKey: `${id}@example.com`,
      audienceKind: 'individual',
      subject: `Subject ${id}`,
      body: `Body ${id}`,
      contentHash: `${id}-hash`,
      generationStatus: 'ready',
      auditStatus: options.audit ?? 'pass',
      approvalStatus: options.approval ?? 'unapproved',
      auditDecision: null,
      auditChecks: options.severity
        ? [{ check: 'grounding', severity: options.severity }]
        : [],
      reviewRequestId: null,
      provider: 'openai',
      model: 'test',
      promptSpecVersion: 'v1',
      sendable: false,
      createdAt: '2026-08-21T12:00:00.000Z',
      contextNote: 'Governed campaign context',
    },
    history: [],
  };
}

const plan: OutreachV3GenerationPlan = {
  planVersion: 'v1',
  sessionId: 'session-1',
  stateVersion: 4,
  specHash: 'spec',
  planHash: 'plan',
  deliveryPattern: 'personalized_separate',
  representativeSampleKeys: ['d1', 'd2'],
  eligible: true,
  blockers: [],
  slots: ['d1', 'd2', 'd3'].map((generationKey) => ({
    generationKey,
    audienceKind: 'individual' as const,
    recipients: [
      {
        targetKey: generationKey,
        label: generationKey,
        email: `${generationKey}@example.com`,
      },
    ],
  })),
};

const approach: OutreachV3ApproachApproval = {
  gateVersion: 'v1',
  sessionId: 'session-1',
  stateVersion: 4,
  specHash: 'spec',
  planHash: 'plan',
  sampleVersions: [],
  approvalHash: 'approval',
};

function intent(status: string): OutreachV3SendIntentView {
  return {
    id: 'intent-1',
    outreachRecordId: 'record-1',
    status,
    testMode: false,
    requestKey: 'send-1',
    totals: { total: 3, sent: status === 'sent' ? 3 : 1, failed: 0, unknown: 0, skipped: 0, held: 0 },
    error: null,
    startedAt: '2026-08-21T12:00:00.000Z',
    finishedAt: status === 'sent' ? '2026-08-21T12:01:00.000Z' : null,
    createdAt: '2026-08-21T12:00:00.000Z',
    deliveries: [],
  };
}

describe('Outreach V3 Phase 1 view model', () => {
  it('requires samples and approach approval before full generation', () => {
    expect(
      deriveOutreachPhase1View({
        step: 'drafts',
        plan,
        drafts: [],
        approach: null,
        job: null,
        intent: null,
      }),
    ).toBe('approach-start');

    expect(
      deriveOutreachPhase1View({
        step: 'drafts',
        plan,
        drafts: [draft('d1'), draft('d2')],
        approach: null,
        job: null,
        intent: null,
      }),
    ).toBe('approach-review');

    expect(
      deriveOutreachPhase1View({
        step: 'drafts',
        plan,
        drafts: [draft('d1'), draft('d2')],
        approach,
        job: null,
        intent: null,
      }),
    ).toBe('generating');
  });

  it('moves to exact-version review only after every planned slot exists', () => {
    expect(
      deriveOutreachPhase1View({
        step: 'drafts',
        plan,
        drafts: [draft('d1'), draft('d2'), draft('d3')],
        approach,
        job: null,
        intent: null,
      }),
    ).toBe('draft-review');
  });

  it('renders send progress and results from the same durable intent', () => {
    expect(
      deriveOutreachPhase1View({
        step: 'send',
        plan,
        drafts: [draft('d1')],
        approach,
        job: null,
        intent: intent('sending'),
      }),
    ).toBe('sending');

    expect(
      deriveOutreachPhase1View({
        step: 'send',
        plan,
        drafts: [draft('d1')],
        approach,
        job: null,
        intent: intent('sent'),
      }),
    ).toBe('results');
  });

  it('separates drafts needing judgment from clean matching versions', () => {
    const values = [
      draft('held', { audit: 'held' }),
      draft('finding', { severity: 'warning' }),
      draft('clean'),
      draft('approved', { approval: 'approved' }),
    ];
    const result = partitionDrafts(values);

    expect(result.judgment.map((value) => value.id)).toEqual(['held', 'finding']);
    expect(result.matching.map((value) => value.id)).toEqual(['clean', 'approved']);
    expect(approvalCount(values)).toBe(1);
  });

  it('does not call an unknown provider state complete by implication', () => {
    const value = intent('sending');
    value.totals = { total: 10, sent: 4, failed: 1, unknown: 2, skipped: 0, held: 1 };
    const progress = sendProgress(value);
    expect(progress).toEqual({ complete: 8, total: 10, percent: 80 });
  });
});

describe('Outreach V3 Phase 1 authority contract', () => {
  const moduleNames = [
    'VNextOutreachApproveSendWorkspace.tsx',
    'outreach-v3-phase1-approach.tsx',
    'outreach-v3-phase1-draft-card.tsx',
    'outreach-v3-phase1-draft-review.tsx',
    'outreach-v3-phase1-send-setup.tsx',
    'outreach-v3-phase1-results.tsx',
    'outreach-v3-phase1-meri.tsx',
  ];
  const mainSource = readFileSync(
    fileURLToPath(new URL('./VNextOutreachApproveSendWorkspace.tsx', import.meta.url)),
    'utf8',
  );
  const source = moduleNames
    .map((name) =>
      readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8'),
    )
    .join('\n');

  it('keeps the final confirmation as the only call site that fires the real-send mutation', () => {
    expect(mainSource.match(/realSendMutation\.mutate\(/g)).toHaveLength(1);
    expect(mainSource).toContain('SendConfirmDialog');
    expect(source).toContain('The confirmation dialog is the only real-send trigger.');
  });

  it('persists the idempotency key and never exposes real send authority to Meri', () => {
    expect(mainSource).toContain('phase1-send-request');
    expect(mainSource).toContain('requestKey: sendRequestKey');
    expect(source).toContain('Meri never approves, sends, or writes active memory on her own.');
    expect(source).not.toMatch(/controller\.sendTurn\([^)]*createOutreachV3SendIntent/);
  });

  it('contains every reviewed Phase 1 screen state from the approved prototype', () => {
    for (const copy of [
      'Read two before I write the other',
      'Writing the remaining',
      'need your judgment',
      'Before this goes out',
      'Final confirmation',
      'Sending now',
      'Governed learning',
    ]) {
      expect(source).toContain(copy);
    }
  });
});
