import { describe, expect, it } from 'vitest';
import {
  acceptContextCommand,
  addTargetCommand,
  deliveryCommands,
  excludeContextCommand,
  goalCommands,
  rejectTargetRecommendationCommand,
  sponsorCommand,
  strategyCommands,
} from './commands.js';

describe('Outreach V3 command builders', () => {
  it('creates one deterministic goal batch without UI-only state', () => {
    expect(
      goalCommands({
        goal: 'Protect funding',
        objective: 'Educate staff',
        topic: 'FY27 Ground Robotics',
        desiredOutcome: 'Request a meeting',
        askMode: 'explicit',
        askText: 'Request a 30-minute briefing',
        whyNow: 'The mark is below the request',
      }),
    ).toEqual([
      { type: 'SET_GOAL', schemaVersion: 1, payload: { value: 'Protect funding' } },
      { type: 'SET_OBJECTIVE', schemaVersion: 1, payload: { value: 'Educate staff' } },
      { type: 'SET_TOPIC', schemaVersion: 1, payload: { value: 'FY27 Ground Robotics' } },
      {
        type: 'SET_DESIRED_OUTCOME',
        schemaVersion: 1,
        payload: { value: 'Request a meeting' },
      },
      {
        type: 'SET_ASK',
        schemaVersion: 1,
        payload: { mode: 'explicit', text: 'Request a 30-minute briefing' },
      },
      {
        type: 'SET_WHY_NOW',
        schemaVersion: 1,
        payload: { value: 'The mark is below the request' },
      },
    ]);
  });

  it('refuses an incomplete goal before it reaches the command engine', () => {
    expect(() =>
      goalCommands({
        goal: 'Protect funding',
        objective: ' ',
        topic: 'FY27 Ground Robotics',
        desiredOutcome: 'Request a meeting',
        askMode: 'explicit',
        askText: 'Request a briefing',
        whyNow: '',
      }),
    ).toThrow('Objective is required.');
  });

  it('preserves every supported client-optional sponsor scope', () => {
    expect(sponsorCommand({ kind: 'none' })).toEqual({
      type: 'SET_SPONSOR_SCOPE',
      schemaVersion: 1,
      payload: { kind: 'none', label: null, clientRefs: [] },
    });
    expect(
      sponsorCommand({
        kind: 'multi_client',
        clientIds: [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
        ],
      }),
    ).toEqual({
      type: 'SET_SPONSOR_SCOPE',
      schemaVersion: 1,
      payload: {
        kind: 'multi_client',
        label: null,
        clientRefs: [
          { clientId: '11111111-1111-4111-8111-111111111111' },
          { clientId: '22222222-2222-4222-8222-222222222222' },
        ],
      },
    });
    expect(() =>
      sponsorCommand({
        kind: 'multi_client',
        clientIds: [
          '11111111-1111-4111-8111-111111111111',
          '11111111-1111-4111-8111-111111111111',
        ],
      }),
    ).toThrow('Several-clients sponsor scope requires at least two clients.');
  });

  it('selects and rejects targets with server-resolvable contracts', () => {
    expect(addTargetCommand({ source: 'directory_staff', id: 'staff-9' })).toEqual({
      type: 'ADD_TARGET_REFS',
      schemaVersion: 1,
      payload: { refs: [{ source: 'directory_staff', id: 'staff-9' }] },
    });
    expect(
      rejectTargetRecommendationCommand({
        recommendationRef: `orec_${'a'.repeat(64)}`,
        targetKey: 'directory_staff:staff-9',
      }),
    ).toEqual({
      type: 'REJECT_TARGET_RECOMMENDATION',
      schemaVersion: 1,
      payload: {
        recommendationRef: `orec_${'a'.repeat(64)}`,
        targetKey: 'directory_staff:staff-9',
        reason: 'not_relevant',
      },
    });
  });

  it('keeps context selection and exclusion source-bound', () => {
    const selection = {
      locator: { source: 'government_record', category: 'hearing', id: 'h-7' },
      contextClass: 'campaign_fact' as const,
      scope: { kind: 'campaign' as const },
    };
    expect(acceptContextCommand([selection])).toEqual({
      type: 'ACCEPT_CONTEXT_REFS',
      schemaVersion: 1,
      payload: { selections: [selection] },
    });
    expect(excludeContextCommand([{ contextKey: 'campaign_fact:campaign:hearing:h-7' }])).toEqual({
      type: 'EXCLUDE_CONTEXT_REFS',
      schemaVersion: 1,
      payload: {
        refs: [
          {
            contextKey: 'campaign_fact:campaign:hearing:h-7',
            reason: 'user_excluded',
          },
        ],
      },
    });
    expect(() => acceptContextCommand([])).toThrow('Choose at least one context source.');
  });

  it('separates delivery and strategy from generation or send authority', () => {
    expect(deliveryCommands('personalized_separate', 'light')).toEqual([
      {
        type: 'SET_DELIVERY_PATTERN',
        schemaVersion: 1,
        payload: { value: 'personalized_separate' },
      },
      { type: 'SET_PERSONALIZATION', schemaVersion: 1, payload: { value: 'light' } },
    ]);
    expect(() => deliveryCommands('shared_thread', 'high')).toThrow(
      'High per-recipient personalization is incompatible with a shared thread.',
    );
    const commands = strategyCommands({
      campaignAngle: 'Protect funding through staff education',
      tone: 'Direct and professional',
      length: 'short',
    });
    expect(commands.map((entry) => entry.type)).toEqual([
      'SET_CAMPAIGN_ANGLE',
      'SET_TONE',
      'SET_LENGTH',
    ]);
    expect(JSON.stringify(commands)).not.toMatch(/REQUEST_(SAMPLE|FULL)_GENERATION|SEND/i);
  });
});