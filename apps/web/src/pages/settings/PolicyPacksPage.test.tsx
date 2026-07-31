import { describe, expect, it } from 'vitest';
import {
  buildPolicyPackPayload,
  buildSimulationPayload,
  policyPackActionState,
  type PolicyPackFormValues,
  type PolicyPackRow,
} from './PolicyPacksPage.js';
import {
  POLICY_PACKS_TAB_KEY,
  isPolicyPacksLocation,
  visibleSettingsTabs,
} from './SettingsLayout.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const REVIEWER = '22222222-2222-4222-8222-222222222222';
const SECOND = '33333333-3333-4333-8333-333333333333';

function pack(overrides: Partial<PolicyPackRow> = {}): PolicyPackRow {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    packKey: 'firm-external-action-policy',
    version: '2026-08-01.v1',
    jurisdiction: 'federal',
    status: 'draft',
    legalReviewStatus: 'pending',
    authority: {
      type: 'approved_product_policy',
      title: 'Reviewed external-action product policy',
      sourceRef: 'approved-policy:external-actions',
      sourceVersion: 'v1',
    },
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    effectiveUntil: null,
    ownerUserId: OWNER,
    reviewedByUserId: null,
    reviewedAt: null,
    secondApprovedByUserId: null,
    secondApprovedAt: null,
    publishedByUserId: null,
    publishedAt: null,
    fourEyesRequired: true,
    rules: [
      {
        id: 'send.requires_approval',
        description: 'Outbound email requires approval.',
        outcome: 'WARN',
        code: 'external_send',
        tier: 'restricted',
        enabled: true,
        match: { tools: ['send_email'], channels: ['email'] },
        reason: 'The message leaves the firm.',
        authorityRef: 'approved-policy:external-actions',
        tests: ['policy.send.requires-approval'],
      },
    ],
    fallback: 'BLOCK',
    nonProduction: true,
    rulesHash: 'a'.repeat(64),
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function values(): PolicyPackFormValues {
  return {
    packKey: ' firm-external-action-policy ',
    version: ' 2026-08-01.v1 ',
    jurisdiction: 'federal',
    legalReviewStatus: 'pending',
    authorityType: 'approved_product_policy',
    authorityTitle: ' Reviewed external-action product policy ',
    authoritySourceRef: ' approved-policy:external-actions ',
    authoritySourceVersion: ' v1 ',
    effectiveFrom: '2026-08-01T00:00:00Z',
    fourEyesRequired: true,
    fallback: 'BLOCK',
    nonProduction: true,
    rules: [
      {
        id: ' send.requires_approval ',
        description: 'Outbound email requires approval.',
        outcome: 'WARN',
        code: ' external_send ',
        tier: 'restricted',
        enabled: true,
        tools: [' send_email ', ''],
        tests: [' policy.send.requires-approval '],
        authorityRef: ' approved-policy:external-actions ',
        reason: ' The message leaves the firm. ',
        additionalMatchJson: JSON.stringify({
          channels: ['email'],
          recipientTypes: ['government'],
        }),
      },
    ],
  };
}

describe('Policy Packs settings trust boundary', () => {
  it('shows the tab only to administrators and recognizes only the exact query-backed route', () => {
    expect(
      visibleSettingsTabs({ role: 'standard_user', billingAdmin: false }).some(
        (tab) => tab.key === POLICY_PACKS_TAB_KEY,
      ),
    ).toBe(false);
    expect(
      visibleSettingsTabs({ role: 'user_admin', billingAdmin: false }).some(
        (tab) => tab.key === POLICY_PACKS_TAB_KEY,
      ),
    ).toBe(true);
    expect(
      visibleSettingsTabs({ role: 'capiro_admin', billingAdmin: true }).some(
        (tab) => tab.key === POLICY_PACKS_TAB_KEY,
      ),
    ).toBe(true);

    expect(isPolicyPacksLocation('/settings/skills', '?view=policy-packs')).toBe(true);
    expect(isPolicyPacksLocation('/settings/skills', '?view=skills')).toBe(false);
    expect(isPolicyPacksLocation('/settings/personal', '?view=policy-packs')).toBe(false);
  });

  it('builds only the administrator-editable draft contract and never forwards authority claims', () => {
    const attackerSupplied = {
      ...values(),
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ownerUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      reviewedByUserId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      status: 'published',
      role: 'capiro_admin',
      rulesHash: '0'.repeat(64),
    } as PolicyPackFormValues & Record<string, unknown>;

    const payload = buildPolicyPackPayload(attackerSupplied);

    expect(payload).toMatchObject({
      packKey: 'firm-external-action-policy',
      version: '2026-08-01.v1',
      jurisdiction: 'federal',
      fallback: 'BLOCK',
      nonProduction: true,
      fourEyesRequired: true,
    });
    expect(payload).not.toHaveProperty('tenantId');
    expect(payload).not.toHaveProperty('ownerUserId');
    expect(payload).not.toHaveProperty('reviewedByUserId');
    expect(payload).not.toHaveProperty('status');
    expect(payload).not.toHaveProperty('role');
    expect(payload).not.toHaveProperty('rulesHash');
    expect(payload.rules).toEqual([
      expect.objectContaining({
        id: 'send.requires_approval',
        code: 'external_send',
        authorityRef: 'approved-policy:external-actions',
        tests: ['policy.send.requires-approval'],
        match: {
          tools: ['send_email'],
          channels: ['email'],
          recipientTypes: ['government'],
        },
      }),
    ]);
  });

  it('omits immutable identity fields from an in-place draft revision', () => {
    const payload = buildPolicyPackPayload(values(), true);
    expect(payload).not.toHaveProperty('packKey');
    expect(payload).not.toHaveProperty('version');
    expect(payload).toHaveProperty('rules');
    expect(payload).toHaveProperty('authority');
  });

  it('enforces four-eyes affordances without pretending the browser is the security boundary', () => {
    const awaitingFirstReview = pack({ status: 'pending_review' });
    expect(policyPackActionState(awaitingFirstReview, OWNER).canReview).toBe(false);
    expect(policyPackActionState(awaitingFirstReview, REVIEWER).canReview).toBe(true);

    const awaitingSecondReview = pack({
      status: 'pending_review',
      reviewedByUserId: REVIEWER,
      reviewedAt: '2026-08-02T00:00:00.000Z',
    });
    expect(policyPackActionState(awaitingSecondReview, OWNER).canSecondApprove).toBe(false);
    expect(policyPackActionState(awaitingSecondReview, REVIEWER).canSecondApprove).toBe(false);
    expect(policyPackActionState(awaitingSecondReview, SECOND).canSecondApprove).toBe(true);

    expect(
      policyPackActionState(pack({ status: 'reviewed', nonProduction: true }), SECOND).canPublish,
    ).toBe(false);
    expect(
      policyPackActionState(pack({ status: 'reviewed', nonProduction: false }), SECOND).canPublish,
    ).toBe(true);
  });

  it('offers rollback only from a live pack to a production retired version of the same key', () => {
    const live = pack({ status: 'published', nonProduction: false });
    const wrongKey = pack({
      id: '55555555-5555-4555-8555-555555555555',
      packKey: 'other-policy',
      status: 'retired',
      nonProduction: false,
    });
    const example = pack({
      id: '66666666-6666-4666-8666-666666666666',
      status: 'retired',
      nonProduction: true,
    });
    const valid = pack({
      id: '77777777-7777-4777-8777-777777777777',
      version: '2026-07-01.v1',
      status: 'retired',
      nonProduction: false,
    });

    expect(policyPackActionState(live, SECOND, [wrongKey, example]).canRollback).toBe(false);
    expect(policyPackActionState(live, SECOND, [wrongKey, example, valid]).canRollback).toBe(true);
  });

  it('keeps simulations bounded to canonical input and creates no policy binding claims', () => {
    const payload = buildSimulationPayload({
      tool: ' send_email ',
      inputJson: '{"to":"staff@mail.house.gov"}',
      jurisdiction: 'federal',
      clientId: '88888888-8888-4888-8888-888888888888',
    });
    expect(payload).toEqual({
      tool: 'send_email',
      input: { to: 'staff@mail.house.gov' },
      jurisdiction: 'federal',
      clientId: '88888888-8888-4888-8888-888888888888',
    });
    expect(payload).not.toHaveProperty('bindable');
    expect(payload).not.toHaveProperty('binding');
    expect(payload).not.toHaveProperty('decisionHash');
    expect(payload).not.toHaveProperty('tenantId');
    expect(() =>
      buildSimulationPayload({ tool: 'send_email', inputJson: '{not-json' }),
    ).toThrow('Simulation input must be valid JSON.');
  });
});
