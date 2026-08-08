import {
  canonicalizeCampaignSpecV1,
  createBlankCampaignSpecV1,
  hashCampaignSpecV1,
  parseCampaignSpecV1,
} from './outreach-campaign-spec.v1.js';
import { parseOutreachCommandEnvelope } from './outreach-command.contract.js';
import { reduceOutreachCommand } from './outreach-command-reducer.js';
import { OutreachCommandError } from './outreach-command-errors.js';
import {
  deriveOutreachReadiness,
  PHASE2_OUTREACH_FEATURE_AVAILABILITY,
} from './outreach-readiness.contract.js';
import {
  assertOutreachCommandRegistry,
  OUTREACH_COMMAND_REGISTRY,
} from '../commands/outreach-command-registry.js';

const command = (type: string, payload: unknown) =>
  parseOutreachCommandEnvelope({ type, schemaVersion: 1, payload });

describe('Outreach V3 Phase 2 campaign state', () => {
  it('creates the exact deterministic no-client blank state', () => {
    const first = createBlankCampaignSpecV1();
    const second = createBlankCampaignSpecV1();
    expect(first.sponsor).toEqual({ kind: 'undecided', label: null, clientRefs: [] });
    expect(first.targeting.selectedTargetRefs).toEqual([]);
    expect(first.context.campaignFactRefs).toEqual([]);
    expect(canonicalizeCampaignSpecV1(first)).toBe(canonicalizeCampaignSpecV1(second));
    expect(hashCampaignSpecV1(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashCampaignSpecV1(first)).toBe(hashCampaignSpecV1(second));
  });

  it('canonicalizes key order, line endings and set-like arrays', () => {
    const base = createBlankCampaignSpecV1();
    const input = {
      ...base,
      goal: { ...base.goal, goal: '  Goal\r\nLine  ', objective: 'Objective' },
      targeting: {
        ...base.targeting,
        criteria: {
          notes: null,
          governmentLevels: ['state', 'federal', 'state'],
          chambers: ['senate', 'house', 'senate'],
          committees: ['  Armed Services ', 'Appropriations', 'Armed Services'],
          agencies: ['DoD', 'DoD'],
          states: ['VA', 'CA', 'VA'],
          relationshipPreference: 'any',
          includeStaff: true,
          includePrincipals: true,
        },
      },
    };
    const normalized = parseCampaignSpecV1(input);
    expect(normalized.goal.goal).toBe('Goal\nLine');
    expect(normalized.targeting.criteria?.governmentLevels).toEqual(['federal', 'state']);
    expect(normalized.targeting.criteria?.committees).toEqual([
      'Appropriations',
      'Armed Services',
    ]);
  });

  it('rejects unknown spec keys and non-empty future-owned reference arrays', () => {
    const blank = createBlankCampaignSpecV1();
    expect(() => parseCampaignSpecV1({ ...blank, wizardStep: 3 })).toThrow();
    expect(() =>
      parseCampaignSpecV1({
        ...blank,
        targeting: { ...blank.targeting, selectedTargetRefs: [{ targetId: 'future' }] },
      }),
    ).toThrow();
  });

  it('enforces sponsor invariants', () => {
    const blank = createBlankCampaignSpecV1();
    expect(() =>
      parseCampaignSpecV1({
        ...blank,
        sponsor: { kind: 'client', label: null, clientRefs: [] },
      }),
    ).toThrow();
    expect(() =>
      parseCampaignSpecV1({
        ...blank,
        sponsor: { kind: 'coalition', label: null, clientRefs: [] },
      }),
    ).toThrow();
  });

  it('keeps the command registry exact and external-action free', () => {
    expect(() => assertOutreachCommandRegistry()).not.toThrow();
    expect(new Set(OUTREACH_COMMAND_REGISTRY.map((entry) => entry.type)).size).toBe(
      OUTREACH_COMMAND_REGISTRY.length,
    );
    expect(OUTREACH_COMMAND_REGISTRY.some((entry) => entry.type.includes('SEND_EMAIL_NOW'))).toBe(
      false,
    );
  });

  it('applies core commands without mutating unrelated state', () => {
    const blank = createBlankCampaignSpecV1();
    const goal = reduceOutreachCommand(blank, command('SET_GOAL', { value: 'Win support' }));
    expect(goal.changed).toBe(true);
    expect(goal.nextSpec.goal.goal).toBe('Win support');
    expect(goal.nextSpec.sponsor).toEqual(blank.sponsor);

    const objective = reduceOutreachCommand(
      goal.nextSpec,
      command('SET_OBJECTIVE', { value: 'Secure committee support' }),
    );
    expect(objective.nextSpec.goal.objective).toBe('Secure committee support');
  });

  it('detects deterministic no-op commands', () => {
    const blank = createBlankCampaignSpecV1();
    const first = reduceOutreachCommand(blank, command('SET_GOAL', { value: 'Same goal' }));
    const second = reduceOutreachCommand(first.nextSpec, command('SET_GOAL', { value: 'Same goal' }));
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(hashCampaignSpecV1(second.nextSpec)).toBe(hashCampaignSpecV1(first.nextSpec));
  });

  it('fails closed on an incompatible shared-thread/high-personalization combination', () => {
    const blank = createBlankCampaignSpecV1();
    const thread = reduceOutreachCommand(
      blank,
      command('SET_DELIVERY_PATTERN', { value: 'shared_thread' }),
    );
    expect(() =>
      reduceOutreachCommand(thread.nextSpec, command('SET_PERSONALIZATION', { value: 'high' })),
    ).toThrow(OutreachCommandError);
  });

  it('rejects future commands rather than silently ignoring them', () => {
    const blank = createBlankCampaignSpecV1();
    try {
      reduceOutreachCommand(blank, command('REQUEST_FULL_GENERATION', {}));
      throw new Error('expected reducer to reject future command');
    } catch (error) {
      expect(error).toBeInstanceOf(OutreachCommandError);
      expect((error as OutreachCommandError).code).toBe('OUTREACH_COMMAND_FUTURE_PHASE');
    }
  });

  it('restores by copying an authorized old snapshot into a new reduction result', () => {
    const blank = createBlankCampaignSpecV1();
    const changed = reduceOutreachCommand(blank, command('SET_GOAL', { value: 'Changed' }));
    const restore = reduceOutreachCommand(changed.nextSpec, {
      ...command('RESTORE_STATE_VERSION', { version: 1 }),
      restoreSpec: blank,
    });
    expect(restore.changed).toBe(true);
    expect(restore.nextSpec).toEqual(blank);
  });

  it('derives Phase 2 blockers without persisting a UI stage', () => {
    const readiness = deriveOutreachReadiness(
      createBlankCampaignSpecV1(),
      PHASE2_OUTREACH_FEATURE_AVAILABILITY,
    );
    expect(readiness.goalReady).toBe(false);
    expect(readiness.blockers).toEqual([
      'GOAL_MISSING',
      'SPONSOR_UNDECIDED',
      'TARGET_CRITERIA_MISSING',
      'TARGETS_NOT_IMPLEMENTED_YET',
      'DELIVERY_UNDECIDED',
      'CONTEXT_NOT_IMPLEMENTED_YET',
      'STRATEGY_INCOMPLETE',
      'GENERATION_NOT_AVAILABLE',
      'DRAFTS_NOT_AVAILABLE',
      'PREFLIGHT_NOT_AVAILABLE',
    ]);
  });
});
