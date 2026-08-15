import { describe, expect, test } from '@jest/globals';
import {
  decideEntityResolutionStagePolicy,
  ENTITY_RESOLUTION_CANDIDATE_ONLY_STAGES,
  ENTITY_RESOLUTION_STAGE_ORDER,
  nextEntityResolutionStage,
  shouldContinueEntityResolution,
} from './entity-resolution-stage-policy.js';

describe('Universal Entity Resolution stage policy', () => {
  test('preserves the required deterministic-to-public fallback order', () => {
    expect(ENTITY_RESOLUTION_STAGE_ORDER).toEqual([
      'existing_canonical',
      'crm_identity',
      'contact_email',
      'email_domain',
      'directory_government_id',
      'sam_uei_cage',
      'usaspending',
      'lda',
      'sec_cik',
      'official_website',
      'public_web',
      'model_candidate_reconciliation',
    ]);
    expect(nextEntityResolutionStage('existing_canonical')).toBe('crm_identity');
    expect(nextEntityResolutionStage('public_web')).toBe(
      'model_candidate_reconciliation',
    );
    expect(nextEntityResolutionStage('model_candidate_reconciliation')).toBeNull();
  });

  test('allows exact authoritative public identifiers to register globally', () => {
    expect(
      decideEntityResolutionStagePolicy('sam_uei_cage', {
        candidateCount: 1,
        evidenceKinds: ['exact_authoritative_identifier'],
      }),
    ).toEqual(
      expect.objectContaining({
        autoResolve: true,
        mayRegisterGlobalPublic: true,
        requiresHumanConfirmation: false,
      }),
    );
  });

  test('keeps private CRM and email identity tenant scoped', () => {
    for (const [stage, evidenceKind] of [
      ['crm_identity', 'tenant_source_id'],
      ['contact_email', 'verified_email'],
    ] as const) {
      expect(
        decideEntityResolutionStagePolicy(stage, {
          candidateCount: 1,
          evidenceKinds: [evidenceKind],
        }),
      ).toEqual(
        expect.objectContaining({
          autoResolve: true,
          mayRegisterGlobalPublic: false,
        }),
      );
    }
  });

  test('never lets public web or a model suggestion auto-select or register identity', () => {
    expect(ENTITY_RESOLUTION_CANDIDATE_ONLY_STAGES).toEqual([
      'public_web',
      'model_candidate_reconciliation',
    ]);

    expect(
      decideEntityResolutionStagePolicy('public_web', {
        candidateCount: 1,
        evidenceKinds: ['public_web_claim'],
      }),
    ).toEqual(
      expect.objectContaining({
        autoResolve: false,
        mayRegisterGlobalPublic: false,
        candidateOnly: true,
        requiresHumanConfirmation: true,
      }),
    );

    expect(
      decideEntityResolutionStagePolicy('model_candidate_reconciliation', {
        candidateCount: 1,
        evidenceKinds: ['model_suggestion'],
      }),
    ).toEqual(
      expect.objectContaining({
        autoResolve: false,
        mayRegisterGlobalPublic: false,
        candidateOnly: true,
        requiresHumanConfirmation: true,
      }),
    );
  });

  test('does not let later fallback override conflicting authoritative identifiers', () => {
    expect(
      decideEntityResolutionStagePolicy('sec_cik', {
        candidateCount: 2,
        evidenceKinds: ['exact_authoritative_identifier'],
        conflictingIdentifiers: true,
      }),
    ).toEqual(
      expect.objectContaining({
        autoResolve: false,
        requiresHumanConfirmation: true,
        reason: 'conflicting_identifiers',
      }),
    );

    expect(
      shouldContinueEntityResolution({
        stage: 'sec_cik',
        status: 'ambiguous',
        resolutionMethod: 'conflicting_identifiers',
      }),
    ).toBe(false);
  });

  test('continues automatically when a stage is merely unresolved', () => {
    expect(
      shouldContinueEntityResolution({
        stage: 'lda',
        status: 'unresolved',
      }),
    ).toBe(true);
  });
});
