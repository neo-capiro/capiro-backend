import { describe, expect, it } from 'vitest';
import type {
  OutreachV3CampaignSpec,
  OutreachV3ResolvedTargetRef,
  OutreachV3SessionEnvelope,
} from '../../../pages/engagement/outreach/v3/contracts.js';
import {
  CLIENT_PROFILE_CONTEXT_OPTIONS,
  OUTREACH_WORKFLOW_TEMPLATES,
  guidedStepsForWorkflow,
  inferOutreachGuidedStep,
  inferOutreachWorkflowTemplate,
  manualProfileContextSelection,
  programElementContextSelection,
  subjectLineContextSelection,
  targetNoteContextSelection,
  workflowCampaignDefaults,
} from './outreach-v3-guided-workflow.js';

const target: OutreachV3ResolvedTargetRef = {
  targetKey: 'directory_member:person-1',
  locator: { source: 'directory_member', id: 'person-1' },
  displayName: 'Jordan Smith',
  title: 'Legislative Director',
  organization: 'Office of Representative Example',
  email: 'jordan@example.gov',
  clientId: null,
  roleStatus: 'current',
  snapshotHash: 'target-hash',
  jurisdiction: {
    governmentLevel: 'federal',
    chamber: 'house',
    state: 'VA',
    district: '01',
    committees: [],
    issueAreas: [],
  },
};

function emptySpec(): OutreachV3CampaignSpec {
  return {
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
  };
}

function sessionWith(spec: OutreachV3CampaignSpec): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'New outreach campaign', status: 'active' },
    currentStateVersion: 1,
    spec,
    specHash: 'spec-hash',
    readiness: { blockers: [] },
    pendingProposalCount: 0,
  };
}

describe('Outreach V3 guided workflow', () => {
  it('offers exactly the three built-in scratch workflows', () => {
    expect(OUTREACH_WORKFLOW_TEMPLATES.map((template) => template.id)).toEqual([
      'request_meeting',
      'send_update',
      'custom',
    ]);
  });

  it('offers only the six sponsor-profile context sections', () => {
    expect(CLIENT_PROFILE_CONTEXT_OPTIONS.map((option) => option.key)).toEqual([
      'overview',
      'relationships',
      'files',
      'program_elements',
      'capabilities',
      'locations',
    ]);
  });

  it('uses the campaign name as the meeting topic and exact subject guidance', () => {
    const defaults = workflowCampaignDefaults({
      templateId: 'request_meeting',
      campaignName: 'Autonomous systems briefing',
    });
    expect(defaults.goal.goal).toBe('Request a meeting');
    expect(defaults.goal.topic).toBe('Autonomous systems briefing');
    expect(defaults.goal.askMode).toBe('explicit');

    const subject = subjectLineContextSelection('Autonomous systems briefing');
    expect(subject.contextClass).toBe('writing_guidance');
    expect(subject.scope).toEqual({ kind: 'campaign' });
    expect(subject.locator).toMatchObject({
      source: 'manual',
      title: 'Campaign subject line',
      sourceLabel: 'outreach_review_packet',
    });
    expect(String(subject.locator.text)).toContain('Autonomous systems briefing');
  });

  it('creates strict manual client-profile context without promoting it to evidence', () => {
    const selection = manualProfileContextSelection({
      sectionLabel: 'Capabilities',
      text: 'Capability A',
    });
    expect(selection.contextClass).toBe('writing_guidance');
    expect(selection.scope).toEqual({ kind: 'campaign' });
    expect(selection.locator).toMatchObject({
      source: 'manual',
      title: 'Capabilities — client profile',
      sourceLabel: 'capiro_client_profile',
    });
    expect(selection.locator.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(selection.locator).not.toHaveProperty('clientId');
  });

  it('keeps an attendee note scoped to that attendee only', () => {
    const note = targetNoteContextSelection({ target, note: 'Mention the May briefing.' });
    expect(note).not.toBeNull();
    expect(note?.contextClass).toBe('target_specific');
    expect(note?.scope).toEqual({ kind: 'target', targetKey: target.targetKey });
    expect(String(note?.locator.text)).toContain('Jordan Smith');
    expect(targetNoteContextSelection({ target, note: '   ' })).toBeNull();
  });

  it('uses authoritative program-element locators for program-element evidence', () => {
    expect(programElementContextSelection('0605053A')).toEqual({
      locator: {
        source: 'government_record',
        category: 'program_element',
        id: '0605053A',
      },
      contextClass: 'campaign_fact',
      scope: { kind: 'campaign' },
    });
  });

  it('resumes at the first missing decision and recognizes a saved workflow', () => {
    const spec = emptySpec();
    expect(inferOutreachGuidedStep(sessionWith(spec))).toBe('template');

    spec.goal = {
      goal: 'Request a meeting',
      objective: 'Secure a meeting',
      topic: 'Autonomous systems briefing',
      desiredOutcome: 'Meeting accepted',
      ask: { mode: 'explicit', text: 'Reply with availability.' },
      whyNow: 'Timely briefing',
    };
    expect(inferOutreachWorkflowTemplate(sessionWith(spec))).toBe('request_meeting');
    expect(inferOutreachGuidedStep(sessionWith(spec))).toBe('sponsor');

    spec.sponsor = {
      kind: 'client',
      label: 'Example Client',
      clientRefs: [{ clientId: '8f7e6d5c-4b3a-4210-9fed-cba987654321' }],
    };
    expect(inferOutreachGuidedStep(sessionWith(spec))).toBe('target');

    spec.targeting.selectedTargetRefs = [target];
    expect(inferOutreachGuidedStep(sessionWith(spec))).toBe('context');
  });

  it('inserts a content-template and format step for the two fixed workflows, but not for custom', () => {
    expect(guidedStepsForWorkflow('request_meeting').map((step) => step.key)).toEqual([
      'template',
      'name',
      'content_template',
      'format',
      'sponsor',
      'target',
      'context',
      'review',
    ]);
    expect(guidedStepsForWorkflow('send_update').map((step) => step.key)).toEqual([
      'template',
      'name',
      'content_template',
      'format',
      'sponsor',
      'target',
      'context',
      'review',
    ]);
    expect(guidedStepsForWorkflow('custom').map((step) => step.key)).toEqual([
      'template',
      'name',
      'sponsor',
      'target',
      'context',
      'review',
    ]);
    expect(guidedStepsForWorkflow(null).map((step) => step.key)).toEqual([
      'template',
      'name',
      'sponsor',
      'target',
      'context',
      'review',
    ]);
  });
});
