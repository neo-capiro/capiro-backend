/** Phase 6 Workstream J — deterministic appropriations report-language action extraction. */
import { sha256CanonicalJson, type JsonValue } from '../../../contracts/canonical-json.js';
import type { BudgetLineIdentityV1 } from '../../../contracts/extraction-artifact-v1.js';
import {
  appropriationsLanguageFactV1Schema,
  defenseBudgetStageActionV1Schema,
  type AppropriationsLanguageFactV1,
  type DefenseBudgetStageActionTypeV1,
  type DefenseBudgetStageActionV1,
} from './defense-budget-stage-action-v1.js';

export interface ComposeAppropriationsLanguageActionsV1Input {
  stage: 'hac_d' | 'sac_d' | 'appropriations_conference' | 'public_law';
  sourceDocumentId: string;
  sourceSha256: string;
  fiscalYear: number;
  text: string;
  evidenceIds: string[];
  identity?: BudgetLineIdentityV1;
  packageScope?: string;
  accountScope?: string;
}

export interface AppropriationsLanguageActionsV1 {
  languageFact: AppropriationsLanguageFactV1;
  actions: DefenseBudgetStageActionV1[];
}

function authority(stage: ComposeAppropriationsLanguageActionsV1Input['stage']): string {
  if (stage === 'hac_d') return 'hacd_appropriations';
  if (stage === 'sac_d') return 'sacd_appropriations';
  if (stage === 'appropriations_conference') return 'appropriations_conference';
  return 'enacted_public_law';
}

function vehicleClass(
  stage: ComposeAppropriationsLanguageActionsV1Input['stage'],
): DefenseBudgetStageActionV1['vehicleClass'] {
  if (stage === 'appropriations_conference') return 'conference_report';
  if (stage === 'public_law') return 'public_law';
  return 'committee_report';
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function classifyAppropriationsLanguageActionTypesV1(
  text: string,
): DefenseBudgetStageActionTypeV1[] {
  const normalized = normalize(text);
  const types: DefenseBudgetStageActionTypeV1[] = [];
  if (
    /\bnone of the funds\b|\bno funds\b|\bmay not\b|\bshall not (?:be )?obligated\b/.test(
      normalized,
    )
  ) {
    types.push('restriction');
  }
  if (
    /\bsubmit (?:a |the )?report\b|\bprovide (?:a |the )?report\b|\breport to (?:the )?congress\b/.test(
      normalized,
    )
  ) {
    types.push('reporting_requirement');
  }
  if (
    /\bcommittee directs\b|\bdirects the (?:secretary|department)\b|\bshall brief\b|\bprovide (?:a |the )?briefing\b/.test(
      normalized,
    )
  ) {
    types.push('directive');
  }
  if (/\bgeneral provision\b|\bgeneral provisions\b/.test(normalized)) {
    types.push('general_provision');
  }
  return [...new Set(types.length > 0 ? types : ['other'])];
}

export function composeAppropriationsLanguageActionsV1(
  input: ComposeAppropriationsLanguageActionsV1Input,
): AppropriationsLanguageActionsV1 {
  if (input.text.trim().length === 0) throw new Error('appropriations language text is blank');
  if (input.evidenceIds.length === 0) throw new Error('appropriations language requires evidence');
  const scopeCount = [input.identity, input.packageScope, input.accountScope].filter(
    (value) => value != null,
  ).length;
  if (scopeCount !== 1) throw new Error('appropriations language requires exactly one source scope');
  const actionTypes = classifyAppropriationsLanguageActionTypesV1(input.text);
  const actions = actionTypes.map((actionType, index) =>
    defenseBudgetStageActionV1Schema.parse({
      schemaVersion: 'defense_budget_stage_action_v1',
      actionId: `language_action_${sha256CanonicalJson({
        sourceDocumentId: input.sourceDocumentId,
        sourceSha256: input.sourceSha256,
        fiscalYear: input.fiscalYear,
        stage: input.stage,
        text: normalize(input.text),
        actionType,
        index,
        identity: input.identity ?? null,
        packageScope: input.packageScope ?? null,
        accountScope: input.accountScope ?? null,
      } as unknown as JsonValue)}`,
      track: 'appropriations',
      stage: input.stage,
      authority: authority(input.stage),
      vehicleClass: vehicleClass(input.stage),
      actionType,
      ...(input.identity != null ? { identity: input.identity } : {}),
      ...(input.packageScope != null ? { packageScope: input.packageScope } : {}),
      ...(input.accountScope != null ? { accountScope: input.accountScope } : {}),
      fiscalYear: input.fiscalYear,
      direction: 'neutral',
      rationale: input.text,
      evidenceIds: [...new Set(input.evidenceIds)].sort(),
      languageEvidenceIds: [...new Set(input.evidenceIds)].sort(),
      directOrDerived: 'direct',
    }),
  );
  const languageFact = appropriationsLanguageFactV1Schema.parse({
    languageFactId: `language_fact_${sha256CanonicalJson({
      sourceDocumentId: input.sourceDocumentId,
      sourceSha256: input.sourceSha256,
      fiscalYear: input.fiscalYear,
      text: normalize(input.text),
      evidenceIds: [...new Set(input.evidenceIds)].sort(),
    } as unknown as JsonValue)}`,
    stage: input.stage,
    sourceDocumentId: input.sourceDocumentId,
    sourceSha256: input.sourceSha256,
    text: input.text,
    evidenceIds: [...new Set(input.evidenceIds)].sort(),
    actionIds: actions.map((action) => action.actionId),
  });
  return { languageFact, actions };
}
