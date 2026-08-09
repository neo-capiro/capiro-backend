import { describe, expect, it } from 'vitest';
import type { OutreachV3SessionEnvelope } from './contracts.js';
import { deriveOutreachV3Stage } from './useOutreachV3Session.js';

function session(): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'Campaign', status: 'active' },
    currentStateVersion: 1,
    specHash: 'hash',
    pendingProposalCount: 0,
    readiness: { blockers: [], warnings: [] },
    spec: {
      schemaVersion: 'outreach_campaign_spec_v1',
      goal: {
        goal: null,
        objective: null,
        topic: null,
        desiredOutcome: null,
        ask: { mode: 'undecided', text: null },
        whyNow: null,
      },
      sponsor: { kind: 'undecided', label: null, clientRefs: [] },
      targeting: {
        criteria: null,
        selectedTargetRefs: [],
        rejectedRecommendationRefs: [],
      },
      delivery: { pattern: 'undecided', personalization: 'undecided' },
      context: {
        requiredPolicyRefs: [],
        writingGuidanceRefs: [],
        campaignFactRefs: [],
        targetSpecificRefs: [],
        groupSafeRefs: [],
        excludedRefs: [],
      },
      strategy: {
        campaignAngle: null,
        tone: null,
        length: 'undecided',
        customLengthInstruction: null,
      },
    },
  };
}

function completeGoal(value: OutreachV3SessionEnvelope) {
  value.spec.goal = {
    goal: 'Protect funding',
    objective: 'Educate staff',
    topic: 'Ground Robotics',
    desiredOutcome: 'Request a meeting',
    ask: { mode: 'explicit', text: 'Request a staff briefing' },
    whyNow: 'Current mark',
  };
}

describe('deriveOutreachV3Stage', () => {
  it('starts with the goal and does not require a client', () => {
    expect(deriveOutreachV3Stage(session())).toBe('goal');
    const value = session();
    completeGoal(value);
    value.spec.sponsor.kind = 'none';
    expect(deriveOutreachV3Stage(value)).toBe('targets');
  });

  it('moves through canonical readiness rather than persisted UI step state', () => {
    const value = session();
    completeGoal(value);
    expect(deriveOutreachV3Stage(value)).toBe('sponsor');

    value.spec.sponsor.kind = 'firm';
    expect(deriveOutreachV3Stage(value)).toBe('targets');

    value.spec.targeting.selectedTargetRefs.push({
      targetKey: 'directory_staff:staff-1',
      locator: { source: 'directory_staff', id: 'staff-1' },
      displayName: 'Alex Morgan',
      title: 'Professional Staff Member',
      organization: 'HASC',
      email: 'alex@example.test',
      clientId: null,
      roleStatus: 'current',
      snapshotHash: 'a'.repeat(64),
      jurisdiction: {
        governmentLevel: 'federal',
        chamber: 'House',
        state: null,
        district: null,
        committees: ['HASC'],
        issueAreas: ['Ground Robotics'],
      },
    });
    expect(deriveOutreachV3Stage(value)).toBe('delivery');

    value.spec.delivery = { pattern: 'personalized_separate', personalization: 'light' };
    expect(deriveOutreachV3Stage(value)).toBe('context');

    value.spec.context.campaignFactRefs.push({
      contextKey: 'campaign_fact:campaign:government_record:hearing:h-1',
      locator: { source: 'government_record', id: 'h-1', category: 'hearing' },
      contextClass: 'campaign_fact',
      scope: { kind: 'campaign' },
      title: 'HASC hearing',
      summary: 'Verified hearing record',
      verificationClass: 'authoritative',
      sensitivity: 'normal',
      instructionsAllowed: false,
      usableAsEvidence: true,
      usableAsWritingGuidance: false,
      snapshotHash: 'b'.repeat(64),
    });
    expect(deriveOutreachV3Stage(value)).toBe('strategy');

    value.spec.strategy = {
      campaignAngle: 'Protect funding through staff education',
      tone: 'Direct and professional',
      length: 'short',
      customLengthInstruction: null,
    };
    expect(deriveOutreachV3Stage(value)).toBe('ready_for_generation');
  });

  it('does not infer planning completion from backend readiness alone', () => {
    const value = session();
    value.readiness = { ready: true, blockers: [] };
    expect(deriveOutreachV3Stage(value)).toBe('goal');
  });
});
