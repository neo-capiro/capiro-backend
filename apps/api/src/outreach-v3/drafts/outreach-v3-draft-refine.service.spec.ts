import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { OutreachResolvedTargetRefV1 } from '../../capabilities/targets/outreach-target.contract.js';
import { createBlankCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { buildOutreachV3GenerationPlan } from '../generation/outreach-v3-generation-plan.js';
import { OutreachV3DraftRefineService } from './outreach-v3-draft-refine.service.js';
import { OutreachV3DraftsController } from './outreach-v3-drafts.controller.js';

const CTX = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'standard_user',
} as TenantContext;
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const ARTIFACT_ID = '55555555-5555-4555-8555-555555555555';
const BASE_VERSION_ID = '44444444-4444-4444-8444-444444444444';
const INSTRUCTION = 'Cut the second paragraph and make the ask explicit.';

function target(): OutreachResolvedTargetRefV1 {
  return {
    targetKey: 'directory_member:alpha',
    locator: { source: 'directory_member', id: 'alpha' },
    displayName: 'Alpha',
    email: 'alpha@example.test',
    phone: null,
    title: 'Policy Director',
    organization: 'Office',
    clientId: null,
    jurisdiction: {
      governmentLevel: 'federal',
      chamber: 'house',
      state: 'MD',
      district: '01',
      committees: [],
      issueAreas: [],
    },
    roleStatus: 'current',
    emailStatus: 'available',
    profileStatus: 'complete',
    sourceSnapshot: { system: 'directory', version: '1', lastVerifiedAt: null },
    snapshotHash: 'a'.repeat(64),
  } as OutreachResolvedTargetRefV1;
}

function currentSession(
  options: { stateVersion?: number; status?: string; blocked?: boolean } = {},
) {
  const spec = createBlankCampaignSpecV1();
  spec.targeting.selectedTargetRefs = [target()];
  spec.delivery = { pattern: 'personalized_separate', personalization: 'high' };
  return {
    session: { id: SESSION_ID, status: options.status ?? 'active', title: 'Test campaign' },
    currentStateVersion: options.stateVersion ?? 6,
    specHash: 'b'.repeat(64),
    spec,
    readiness: {
      goalReady: true,
      sponsorResolved: true,
      targetCriteriaReady: true,
      targetsReady: true,
      deliveryReady: true,
      contextReady: true,
      contextEvidenceReady: true,
      strategyReady: true,
      // Deliberately false: refine gates on plan.eligible, which strips the
      // later-phase availability blockers below, NOT on this flag.
      sampleGenerationEligible: false,
      fullGenerationEligible: false,
      sendReviewEligible: false,
      blockers: options.blocked
        ? ['TARGETS_MISSING', 'GENERATION_NOT_AVAILABLE']
        : ['GENERATION_NOT_AVAILABLE', 'DRAFTS_NOT_AVAILABLE', 'PREFLIGHT_NOT_AVAILABLE'],
    },
    pendingProposalCount: 0,
  } as any;
}

function manifest() {
  return {
    contextPacketId: 'packet-1',
    packetHash: 'c'.repeat(64),
    evidenceCountsByType: {},
    included: [],
    exclusions: [],
    failures: [],
    criticalFailures: [],
    oldestSourceAt: null,
    newestSourceAt: null,
    policy: {
      policyId: 'policy',
      version: '1',
      label: 'Policy',
      jurisdiction: 'federal',
      audienceType: 'congressional',
    },
    provider: 'openai',
    model: 'model',
    planModel: null,
    promptSpecVersion: 'v1',
    emailScopeLabel: 'My mailbox',
    standingMemoryCount: 0,
    criticalMissingContext: [],
    disclosures: [],
  } as any;
}

/**
 * A draft store that reproduces the REAL persistence semantics this feature has
 * to live with:
 *
 *  - createEditedVersion is append-only and ALWAYS advances currentVersion,
 *    409ing on a stale base.
 *  - upsertGeneratedVersionOrCandidate returns a NON-advancing candidate when
 *    the current version is `manually_authored`.
 *
 * Modelling the candidate behavior (rather than only asserting the method is
 * unused) is what makes the trap test bite: a future refactor onto that path
 * fails on a currentVersion that did not move, not merely on a spy assertion.
 */
function draftStore(baseGenerationStatus: 'generated' | 'manually_authored') {
  const versions = [
    {
      id: BASE_VERSION_ID,
      artifactId: ARTIFACT_ID,
      outreachRecordId: SESSION_ID,
      version: 3,
      subject: 'Original subject',
      body: 'Original body, two paragraphs long.',
      generationStatus: baseGenerationStatus,
      auditStatus: 'passed',
      approvalStatus: 'not_required',
      sendable: true,
    },
  ];
  const artifact = {
    id: ARTIFACT_ID,
    outreachRecordId: SESSION_ID,
    generationKey: 'set-by-harness',
    recipientKey: 'directory_member:alpha',
    audienceKind: 'individual',
    currentVersion: 3,
    get current() {
      return versions.find((entry) => entry.version === this.currentVersion) ?? null;
    },
    get history() {
      return [...versions].reverse();
    },
  };

  const append = (
    subject: string,
    body: string,
    version: number,
    generationStatus: 'generated' | 'manually_authored',
  ) => {
    const created = {
      id: `version-${version}`,
      artifactId: ARTIFACT_ID,
      outreachRecordId: SESSION_ID,
      version,
      subject,
      body,
      generationStatus,
      auditStatus: 'pending',
      approvalStatus: 'not_required',
      sendable: false,
    };
    versions.push(created);
    return created;
  };

  const createEditedVersion = jest.fn(async (_ctx: unknown, artifactId: string, input: any) => {
    if (artifactId !== artifact.id) throw new NotFoundException('Draft not found');
    if (input.baseVersionId !== artifact.current?.id) {
      throw new ConflictException({
        statusCode: 409,
        error: 'OUTREACH_DRAFT_VERSION_STALE',
        message: 'A newer version of this draft exists.',
      });
    }
    const next = append(
      input.subject,
      input.body,
      artifact.currentVersion + 1,
      'manually_authored',
    );
    artifact.currentVersion = next.version;
    return next;
  });

  const upsertGeneratedVersionOrCandidate = jest.fn(async (_ctx: unknown, input: any) => {
    const guardEdited = artifact.current?.generationStatus === 'manually_authored';
    const nextVersion = guardEdited
      ? Math.max(...versions.map((entry) => entry.version)) + 1
      : artifact.currentVersion + 1;
    const created = append(input.subject, input.body, nextVersion, 'generated');
    if (!guardEdited) artifact.currentVersion = created.version;
    return guardEdited
      ? { ...created, mode: 'candidate', baseVersion: artifact.currentVersion }
      : { ...created, mode: 'current' };
  });

  return {
    versions,
    artifact,
    /** Versions numbered above currentVersion — i.e. unaccepted candidates. */
    get candidates() {
      return versions.filter((entry) => entry.version > artifact.currentVersion);
    },
    drafts: {
      listForOutreach: jest.fn(async () => [artifact]),
      createEditedVersion,
      upsertGeneratedVersionOrCandidate,
      upsertGeneratedVersion: jest.fn(),
    },
  };
}

function harness(
  options: {
    baseGenerationStatus?: 'generated' | 'manually_authored';
    sessions?: any;
    generate?: jest.Mock;
    blocked?: boolean;
    status?: string;
    generationKey?: string;
    baseBody?: string;
  } = {},
) {
  const session = currentSession({ blocked: options.blocked, status: options.status });
  const plan = buildOutreachV3GenerationPlan({
    sessionId: SESSION_ID,
    stateVersion: session.currentStateVersion,
    specHash: session.specHash,
    spec: session.spec,
    readiness: session.readiness,
    pendingProposalCount: session.pendingProposalCount,
  });
  const store = draftStore(options.baseGenerationStatus ?? 'generated');
  store.artifact.generationKey = options.generationKey ?? plan.slots[0]!.generationKey;
  if (options.baseBody !== undefined) store.versions[0]!.body = options.baseBody;

  const sessions = options.sessions ?? { getSession: jest.fn().mockResolvedValue(session) };
  const preparation = {
    prepareSlot: jest.fn().mockImplementation(async (_ctx: unknown, _spec: unknown, slot: any) => ({
      slot,
      currentTargets: [target()],
      selectedItems: [],
      serverEvidence: [],
      sourceContextKeys: [],
    })),
  };
  const roots = { ensureRoot: jest.fn().mockResolvedValue({ outreachRecordId: SESSION_ID }) };
  const pinned = {
    provider: 'openai',
    model: 'model',
    planModel: null,
    promptSpecVersion: 'v1',
    policyId: 'policy',
    policyVersion: '1',
  };
  const generate =
    options.generate ??
    jest.fn().mockImplementation(async (_ctx: unknown, request: any) => ({
      outcome: 'ready',
      generationKey: request.recipient.generationKey,
      recipientKey: request.recipient.recipientKey,
      subject: 'Refined subject',
      body: 'Refined body with an explicit ask.',
      manifest: manifest(),
      sendable: false,
      pinned,
    }));
  const gateway = {
    enabled: true,
    resolvePinnedIdentity: jest.fn().mockResolvedValue({ pinned, creds: [{ provider: 'openai' }] }),
    generate,
  };
  const service = new OutreachV3DraftRefineService(
    sessions as any,
    preparation as any,
    roots as any,
    gateway as any,
    store.drafts as any,
  );
  return { service, plan, session, store, sessions, preparation, roots, gateway, generate, pinned };
}

const REFINE = { baseVersionId: BASE_VERSION_ID, instruction: INSTRUCTION };

describe('Outreach V3 draft refinement persistence', () => {
  it('advances the current version when the base version was MANUALLY AUTHORED, and creates no candidate', async () => {
    // The V2 bug this guards: createEditedVersion stamps `manually_authored`
    // for every editKind, and upsertGeneratedVersionOrCandidate answers a
    // manually-authored current version with a non-advancing candidate. Refine
    // must not inherit that interaction — an Improve after a hand edit has to
    // visibly replace the draft.
    const h = harness({ baseGenerationStatus: 'manually_authored' });
    const version = await h.service.refine(CTX, SESSION_ID, ARTIFACT_ID, REFINE);

    expect(version.version).toBe(4);
    expect(h.store.artifact.currentVersion).toBe(4);
    expect(h.store.artifact.current?.id).toBe(version.id);
    expect(h.store.candidates).toEqual([]);
    expect(h.store.drafts.upsertGeneratedVersionOrCandidate).not.toHaveBeenCalled();
    expect(h.store.drafts.upsertGeneratedVersion).not.toHaveBeenCalled();
    expect(h.store.drafts.createEditedVersion).toHaveBeenCalledWith(CTX, ARTIFACT_ID, {
      baseVersionId: BASE_VERSION_ID,
      subject: 'Refined subject',
      body: 'Refined body with an explicit ask.',
      editKind: 'improve',
    });
  });

  it('advances the current version identically when the base version was GENERATED', async () => {
    const h = harness({ baseGenerationStatus: 'generated' });
    const version = await h.service.refine(CTX, SESSION_ID, ARTIFACT_ID, REFINE);

    expect(version.version).toBe(4);
    expect(h.store.artifact.currentVersion).toBe(4);
    expect(h.store.candidates).toEqual([]);
    expect(h.store.drafts.upsertGeneratedVersionOrCandidate).not.toHaveBeenCalled();
  });

  it('sends the current subject/body plus the instruction in revision mode, and never lets the gateway mint its own version', async () => {
    const h = harness();
    await h.service.refine(CTX, SESSION_ID, ARTIFACT_ID, REFINE);

    expect(h.generate).toHaveBeenCalledTimes(1);
    const request = h.generate.mock.calls[0]![1];
    expect(request.existingSubject).toBe('Original subject');
    expect(request.existingBody).toBe('Original body, two paragraphs long.');
    expect(request.reviseInstruction).toBe(INSTRUCTION);
    expect(request.runtimeAction).toBe('outreach_v3_generate');
    expect(request.pinned).toEqual(h.pinned);
    // No parent record ⇒ the gateway returns reviewable text instead of
    // persisting a `generated` version of its own, which would both double the
    // versions for one action and make our baseVersionId stale.
    expect(request.outreachRecordId).toBeUndefined();
    const enrichment = h.generate.mock.calls[0]![2];
    expect(enrichment.includeRelevantEmail).toBe(false);
    expect(Array.isArray(enrichment.auditLedger)).toBe(true);
  });

  it('refines exactly one slot and reauthorizes it before the model call', async () => {
    const h = harness();
    await h.service.refine(CTX, SESSION_ID, ARTIFACT_ID, REFINE);

    expect(h.preparation.prepareSlot).toHaveBeenCalledTimes(1);
    expect(h.preparation.prepareSlot.mock.calls[0]![2].generationKey).toBe(
      h.plan.slots[0]!.generationKey,
    );
    expect(h.preparation.prepareSlot.mock.invocationCallOrder[0]!).toBeLessThan(
      h.generate.mock.invocationCallOrder[0]!,
    );
  });

  it('blocks with 409 when no plan slot owns this draft artifact', async () => {
    const h = harness({ generationKey: 'v3:stale:target:directory_member:removed' });

    await expect(h.service.refine(CTX, SESSION_ID, ARTIFACT_ID, REFINE)).rejects.toMatchObject({
      code: 'OUTREACH_COMMAND_BLOCKED',
      httpStatus: 409,
    });
    expect(h.preparation.prepareSlot).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.store.drafts.createEditedVersion).not.toHaveBeenCalled();
  });

  it('surfaces a stale baseVersionId as the existing 409 stale-version conflict, before any model spend', async () => {
    const h = harness();

    let thrown: unknown;
    try {
      await h.service.refine(CTX, SESSION_ID, ARTIFACT_ID, {
        baseVersionId: '99999999-9999-4999-8999-999999999999',
        instruction: INSTRUCTION,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getStatus()).toBe(409);
    expect((thrown as ConflictException).getResponse()).toMatchObject({
      error: 'OUTREACH_DRAFT_VERSION_STALE',
      currentVersionId: BASE_VERSION_ID,
      currentVersion: 3,
    });
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('gates on plan.eligible rather than readiness.sampleGenerationEligible', async () => {
    // The happy-path harness already runs with sampleGenerationEligible false,
    // so a real planning blocker is what must stop refine.
    const ok = harness();
    await expect(ok.service.refine(CTX, SESSION_ID, ARTIFACT_ID, REFINE)).resolves.toMatchObject({
      version: 4,
    });
    expect(ok.session.readiness.sampleGenerationEligible).toBe(false);

    const h = harness({ blocked: true });
    await expect(h.service.refine(CTX, SESSION_ID, ARTIFACT_ID, REFINE)).rejects.toMatchObject({
      code: 'OUTREACH_COMMAND_BLOCKED',
      httpStatus: 409,
      safeMetadata: expect.objectContaining({ reason: 'generation_plan_not_eligible' }),
    });
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('does not reach preparation or a model when the governed gateway is dark', async () => {
    const h = harness();
    h.gateway.enabled = false;

    await expect(h.service.refine(CTX, SESSION_ID, ARTIFACT_ID, REFINE)).rejects.toMatchObject({
      code: 'OUTREACH_COMMAND_BLOCKED',
      httpStatus: 503,
    });
    expect(h.preparation.prepareSlot).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('refuses an archived session', async () => {
    const h = harness({ status: 'archived' });
    await expect(h.service.refine(CTX, SESSION_ID, ARTIFACT_ID, REFINE)).rejects.toMatchObject({
      code: 'OUTREACH_SESSION_ARCHIVED',
      httpStatus: 409,
    });
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('refuses to refine an empty body rather than silently generating a fresh draft', async () => {
    const h = harness({ baseBody: '   ' });
    await expect(h.service.refine(CTX, SESSION_ID, ARTIFACT_ID, REFINE)).rejects.toMatchObject({
      code: 'OUTREACH_COMMAND_BLOCKED',
      safeMetadata: expect.objectContaining({ reason: 'draft_body_empty' }),
    });
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('writes no version when governed generation does not return a ready draft', async () => {
    const generate = jest.fn().mockResolvedValue({
      outcome: 'blocked',
      generationKey: 'v3:blocked',
      recipientKey: 'blocked',
      subject: '',
      body: '',
      manifest: manifest(),
      sendable: false,
      error: 'AUDIENCE_POLICY_REQUIRED',
      pinned: { provider: 'openai', model: 'model' },
    });
    const h = harness({ generate });

    await expect(h.service.refine(CTX, SESSION_ID, ARTIFACT_ID, REFINE)).rejects.toBeInstanceOf(
      OutreachCommandError,
    );
    expect(h.store.drafts.createEditedVersion).not.toHaveBeenCalled();
    expect(h.store.artifact.currentVersion).toBe(3);
  });

  it('discards the refined text when Campaign Spec moves during the model call', async () => {
    const sessions = {
      getSession: jest
        .fn()
        .mockResolvedValueOnce(currentSession({ stateVersion: 6 }))
        .mockResolvedValueOnce(currentSession({ stateVersion: 7 })),
    };
    const h = harness({ sessions });

    await expect(h.service.refine(CTX, SESSION_ID, ARTIFACT_ID, REFINE)).rejects.toMatchObject({
      code: 'OUTREACH_STATE_CONFLICT',
      httpStatus: 409,
    });
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.store.drafts.createEditedVersion).not.toHaveBeenCalled();
    expect(h.store.artifact.currentVersion).toBe(3);
  });
});

describe('Outreach V3 refine route body validation', () => {
  function controller() {
    const refinements = { refine: jest.fn().mockResolvedValue({ id: 'version-4', version: 4 }) };
    const drafts = { listForOutreach: jest.fn().mockResolvedValue([{ id: ARTIFACT_ID }]) };
    const instance = new OutreachV3DraftsController({} as any, drafts as any, refinements as any);
    return { instance, drafts, refinements };
  }

  const reject = async (body: unknown) => {
    const c = controller();
    await expect(c.instance.refine(CTX, SESSION_ID, ARTIFACT_ID, body)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(c.refinements.refine).not.toHaveBeenCalled();
  };

  it('accepts exactly baseVersionId + a trimmed instruction and forwards the auth header', async () => {
    const c = controller();
    await c.instance.refine(
      CTX,
      SESSION_ID,
      ARTIFACT_ID,
      { baseVersionId: ` ${BASE_VERSION_ID} `, instruction: `  ${INSTRUCTION}  ` },
      'Bearer test',
    );
    expect(c.refinements.refine).toHaveBeenCalledWith(
      CTX,
      SESSION_ID,
      ARTIFACT_ID,
      { baseVersionId: BASE_VERSION_ID, instruction: INSTRUCTION },
      'Bearer test',
    );
  });

  it('rejects a non-object body, unknown fields, wrong types, an empty instruction and an oversized one', async () => {
    await reject(null);
    await reject([{ baseVersionId: BASE_VERSION_ID, instruction: INSTRUCTION }]);
    await reject({ baseVersionId: BASE_VERSION_ID, instruction: INSTRUCTION, editKind: 'improve' });
    await reject({ baseVersionId: BASE_VERSION_ID, instruction: INSTRUCTION, subject: 'x' });
    await reject({ baseVersionId: BASE_VERSION_ID });
    await reject({ baseVersionId: BASE_VERSION_ID, instruction: 42 });
    await reject({ baseVersionId: BASE_VERSION_ID, instruction: '   ' });
    await reject({ baseVersionId: BASE_VERSION_ID, instruction: 'x'.repeat(2001) });
  });

  it('404s an artifact from another campaign before it can reach a model', async () => {
    const c = controller();
    c.drafts.listForOutreach.mockResolvedValue([{ id: 'another-artifact' }]);
    await expect(
      c.instance.refine(CTX, SESSION_ID, ARTIFACT_ID, {
        baseVersionId: BASE_VERSION_ID,
        instruction: INSTRUCTION,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(c.refinements.refine).not.toHaveBeenCalled();
  });
});
