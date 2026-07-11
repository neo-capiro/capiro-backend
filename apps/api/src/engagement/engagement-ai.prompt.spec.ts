// Outreach prompt assembly (W0.3 group salutation, W0.5 tone line) and the
// adaptive USD formatter (W0.6). buildOutreachPrompt is pure over its `input`
// (reads no instance state), so a bare prototype is enough to exercise it.

import { describe, expect, test } from '@jest/globals';
import {
  EngagementAiService,
  formatUsdCompact,
  type CampaignEmailInput,
  type OutreachDraftInput,
} from './engagement-ai.service.js';

function buildPrompt(input: OutreachDraftInput): string {
  const svc = Object.create(EngagementAiService.prototype) as EngagementAiService;
  return (
    svc as unknown as { buildOutreachPrompt(i: OutreachDraftInput): string }
  ).buildOutreachPrompt(input);
}

function buildCampaignPrompt(input: CampaignEmailInput): string {
  const svc = Object.create(EngagementAiService.prototype) as EngagementAiService;
  return (
    svc as unknown as { buildCampaignPrompt(i: CampaignEmailInput): string }
  ).buildCampaignPrompt(input);
}

const base: OutreachDraftInput = {
  workflow: 'campaign',
  client: { name: 'Aperture Defense Systems' },
  recipients: [{ name: 'Dana Reed', email: 'dana@mail.house.gov' }],
  context: {
    tone: 'professional',
    recipientProfile: 'Rep. Dana Reed (D, CA-12). Committees: Armed Services.',
  },
  promptTemplate: 'custom',
  objective: 'Request a 15-minute meeting',
};

describe('buildOutreachPrompt — audience salutation (W0.3)', () => {
  test('individual campaign keeps the first-name greeting rule', () => {
    const prompt = buildPrompt(base);
    expect(prompt).toContain('addresses the recipient by their real first name');
    expect(prompt).not.toContain('COLLECTIVE');
  });

  test('group campaign switches to a collective salutation and drops per-member tailoring', () => {
    const prompt = buildPrompt({ ...base, audienceKind: 'group' });
    expect(prompt).toContain('COLLECTIVE greeting');
    expect(prompt).toContain('never single out one member');
    expect(prompt).not.toContain('addresses the recipient by their real first name');
  });

  test('audienceKind "individual" is byte-identical to the default (no regression)', () => {
    expect(buildPrompt({ ...base, audienceKind: 'individual' })).toBe(buildPrompt(base));
  });
});

describe('buildOutreachPrompt — tone directive (W0.5)', () => {
  test('renders an explicit tone instruction from context.tone', () => {
    expect(buildPrompt(base)).toContain('Write in a professional register.');
  });

  test('omits the tone line when no tone is supplied', () => {
    const { tone: _tone, ...contextWithoutTone } = base.context as Record<string, unknown>;
    const prompt = buildPrompt({ ...base, context: contextWithoutTone });
    expect(prompt).not.toContain('register.');
  });
});

describe('formatUsdCompact — adaptive money format (W0.6)', () => {
  test('sub-billion amounts render in millions, never "$0B"', () => {
    expect(formatUsdCompact(450_000_000)).toBe('$450M');
    expect(formatUsdCompact(248_000_000)).toBe('$248M');
    expect(formatUsdCompact(450_000_000)).not.toContain('B');
  });

  test('billions and trillions keep one decimal', () => {
    expect(formatUsdCompact(10_600_000_000)).toBe('$10.6B');
    expect(formatUsdCompact(2_400_000_000_000)).toBe('$2.4T');
  });

  test('thousands and zero degrade cleanly', () => {
    expect(formatUsdCompact(12_000)).toBe('$12K');
    expect(formatUsdCompact(0)).toBe('$0');
    expect(formatUsdCompact(Number.NaN)).toBe('$0');
  });
});

describe('buildCampaignPrompt — token forbidding (W0.7, legacy EngagementCampaign path)', () => {
  const input: CampaignEmailInput = {
    campaign: { objective: 'FY27 briefing' },
    client: { name: 'Aperture Defense Systems' },
    meeting: null,
    debrief: null,
    prep: null,
    recipients: [{ name: 'Dana Reed', email: 'dana@mail.house.gov', title: 'LD' }],
    campaignType: 'custom',
  };

  test('no longer instructs the model to EMIT template variables', () => {
    expect(buildCampaignPrompt(input)).not.toContain('Use template variables');
  });

  test('forbids template variables and bracket placeholders', () => {
    expect(buildCampaignPrompt(input)).toContain(
      'Do not use template variables or bracket placeholders',
    );
  });
});
