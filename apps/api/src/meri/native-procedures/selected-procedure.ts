import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { MeriFirmSkillsService } from '../meri-firm-skills.service.js';
import {
  procedureManifestDigest,
  projectProcedureBinding,
} from '../meri-procedure-runtime.js';
import type {
  MeriProcedureCapability,
  MeriProcedureManifest,
  MeriProcedureScope,
} from '../skills/skill.types.js';

/**
 * Wave5 MO01/ST16 — native selected-procedure crossing.
 *
 * The browser (through A5's conversation/input owner) may send only a selection:
 * either an exact tenant firm row or one of the six canonical builtins. It never
 * sends instructions, tools or authority. This leaf resolves that selection
 * against the canonical owner, binds the exact version and manifest digest, and
 * returns one immutable admission carrying the whole manifest contract.
 *
 * A refusal is always NotFoundException. There is no legacy clioConversation or
 * meriv3 fallthrough: a selector that does not match the canonical owner is
 * refused, never reinterpreted.
 */

export const MERI_BUILTIN_PROCEDURE_IDS = [
  'briefing',
  'draft',
  'bill_analysis',
  'hearing_prep',
  'coalition_letter',
  'amendment_tracker',
] as const;
export type MeriBuiltinProcedureId = (typeof MERI_BUILTIN_PROCEDURE_IDS)[number];

export interface MeriFirmProcedureSelector {
  source: 'firm';
  recordId: string;
  version: number;
  manifestDigest: string;
}

export interface MeriBuiltinProcedureSelector {
  source: 'builtin';
  id: MeriBuiltinProcedureId;
  version: number;
  manifestDigest: string;
}

export type MeriSelectedProcedureSelector =
  | MeriFirmProcedureSelector
  | MeriBuiltinProcedureSelector;

export interface MeriSelectedProcedureIdentity {
  source: 'firm' | 'builtin';
  /** Tenant row id for firm; canonical builtin id for builtin. */
  id: string;
  /** Tenant row canonical skill id for firm; equal to id for builtin. */
  canonicalId: string;
  version: number;
}

export interface MeriSelectedProcedureAdmission {
  version: 1;
  tenantId: string;
  identity: MeriSelectedProcedureIdentity;
  manifestDigest: string;
  instruction: string;
  /** Full manifest content is preserved, not narrowed to policy only. */
  purpose: string;
  scopes: MeriProcedureScope[];
  evidencePrerequisites: string[];
  scope: 'general' | 'client' | 'portfolio' | 'external_entity';
  clientId: string | null;
  clientRequired: boolean;
  resolvedAt: number;
  validUntil: number;
  policy: {
    effectMode: 'read_only' | 'approval_required';
    allowedCapabilities: string[];
    allowedTools: string[];
    requiredTools: string[];
    prohibitedEffects: string[];
  };
  contract: {
    outputFields: string[];
    completionChecks: string[];
    coverageStates: string[];
    caseIds: string[];
  };
}

interface BuiltinProcedureEntry {
  version: number;
  instruction: string;
  manifest: MeriProcedureManifest;
}

const READ_ONLY_PROHIBITED = [
  'send or draft an external message',
  'create or update a task or record',
  'write memory',
] as const;

function capabilities(
  names: readonly MeriProcedureCapability[],
): MeriProcedureCapability[] {
  return [...names];
}

/**
 * Canonical in-code registry for the six builtins. Version 1 is the only
 * admitted version today; every entry is digest-pinned at resolution time so a
 * stored selector can be replayed and still proven against the exact text that
 * ran. Content mirrors the installed static skills (briefing, draft,
 * bill_analysis, hearing_prep, coalition_letter, amendment_tracker) but is
 * expressed as the persisted procedure contract so purpose, scope, evidence
 * prerequisites, capability/effect policy and completion checks all survive.
 */
export const MERI_BUILTIN_PROCEDURES: Readonly<
  Record<MeriBuiltinProcedureId, BuiltinProcedureEntry>
> = Object.freeze({
  briefing: {
    version: 1,
    instruction:
      'Create an actionable government-affairs briefing with key points, risks, and recommendations. Use authorized intelligence and public sources; cite every claim and state uncertainty.',
    manifest: {
      purpose:
        'Produce an actionable briefing on a bill, hearing, client matter or legislative development from authorized evidence.',
      scopes: ['general', 'client'],
      evidencePrerequisites: [
        'The subject bill, hearing, matter or development being briefed',
        'Authorized client context when the briefing is client-scoped',
        'Source locators and versions for every cited intelligence or public record',
      ],
      allowedCapabilities: capabilities(['client.read', 'documents.read']),
      output: {
        fields: [
          'executiveSummary',
          'signals',
          'opportunities',
          'risks',
          'recommendedActions',
          'citations',
        ],
        statuses: ['complete', 'partial', 'unknown'],
        coverageStates: ['checked', 'partial', 'unavailable'],
        unknownValue: 'unknown',
        preserveModality: true,
        honorRequestedWindow: true,
        defaultRecentWindowDays: null,
        reportPartialCoverage: true,
      },
      completion: [
        'State the recommended action and who must take it',
        'Cite a source for every risk and opportunity',
        'Flag uncertainty in outcome and timing rather than asserting it',
        'Exclude other-client and walled content',
        'Return no task, message, memory or other external effect',
      ],
      effectPolicy: { mode: 'read_only', prohibitedEffects: [...READ_ONLY_PROHIBITED] },
      examples: [
        'A hearing that may slip is reported as uncertain timing, not a confirmed date.',
        'A claim without an authorized source is omitted or marked unknown.',
      ],
      caseIds: ['ST-16', 'MO-01'],
    },
  },
  draft: {
    version: 1,
    instruction:
      'Draft the requested government-affairs document with a single clear ask, cited supporting evidence, and the client voice. Do not fabricate facts, signatories or statistics, and do not send it.',
    manifest: {
      purpose:
        'Draft a government-affairs document (letter, memo, comment or statement) for human review without sending or filing it.',
      scopes: ['general', 'client'],
      evidencePrerequisites: [
        'The recipient and the single ask being made',
        'Authorized client position and voice',
        'Cited supporting evidence for every factual assertion',
      ],
      allowedCapabilities: capabilities(['client.read', 'documents.read']),
      output: {
        fields: ['recipient', 'subject', 'ask', 'rationale', 'supportingEvidence', 'close', 'citations'],
        statuses: ['complete', 'partial', 'unknown'],
        coverageStates: ['checked', 'partial', 'unavailable'],
        unknownValue: 'unknown',
        preserveModality: true,
        honorRequestedWindow: true,
        defaultRecentWindowDays: null,
        reportPartialCoverage: true,
      },
      completion: [
        'Lead with one clear ask',
        'Cite a source for every factual claim',
        'Keep the client voice and stated positions intact',
        'Mark unknown facts instead of inventing them',
        'Return a draft only; no send, file or memory effect',
      ],
      effectPolicy: { mode: 'read_only', prohibitedEffects: [...READ_ONLY_PROHIBITED] },
      examples: [
        'A missing signatory list is returned as unknown, not fabricated.',
        'The draft is returned for human review and is never sent by the procedure.',
      ],
      caseIds: ['ST-16', 'MO-01'],
    },
  },
  bill_analysis: {
    version: 1,
    instruction:
      'Analyze the bill section by section for a lobbyist: what it does, who it helps or hurts, and the realistic path. Ground every claim in bill text plus authorized intelligence; cite sources and be explicit about uncertainty on outcome and timing.',
    manifest: {
      purpose:
        'Analyze a bill section by section and assess stakeholder impact and the realistic legislative path.',
      scopes: ['general', 'client'],
      evidencePrerequisites: [
        'The bill text or an official summary',
        'Sponsor, committee and status record',
        'Authorized client context when the analysis is client-scoped',
      ],
      allowedCapabilities: capabilities(['client.read']),
      output: {
        fields: [
          'summary',
          'keyProvisions',
          'stakeholders',
          'clientImpact',
          'likelyPath',
          'timing',
          'recommendedPosition',
          'citations',
        ],
        statuses: ['complete', 'partial', 'unknown'],
        coverageStates: ['checked', 'partial', 'unavailable'],
        unknownValue: 'unknown',
        preserveModality: true,
        honorRequestedWindow: true,
        defaultRecentWindowDays: null,
        reportPartialCoverage: true,
      },
      completion: [
        'Analyze each substantive section, not only the title',
        'Separate what the text does from what is predicted',
        'Cite bill text and authorized intelligence for every claim',
        'State uncertainty in vote count and timing',
        'Return no task, message, memory or other external effect',
      ],
      effectPolicy: { mode: 'read_only', prohibitedEffects: [...READ_ONLY_PROHIBITED] },
      examples: [
        'A provision that may be struck in markup is described as at risk, not enacted.',
      ],
      caseIds: ['ST-16', 'MO-01'],
    },
  },
  hearing_prep: {
    version: 1,
    instruction:
      'Prepare a witness or attendee for a congressional hearing: panel, likely lines of questioning per member, member dynamics and crisp talking points. Use authorized hearing and member intelligence; flag risks and landmines.',
    manifest: {
      purpose:
        'Prepare a witness or attendee for a congressional hearing from authorized hearing and member evidence.',
      scopes: ['general', 'client'],
      evidencePrerequisites: [
        'The hearing notice, agenda or witness list',
        'Member and committee records for likely questioning',
        'Authorized client context when preparation is client-scoped',
      ],
      allowedCapabilities: capabilities(['client.read', 'meetings.read']),
      output: {
        fields: [
          'hearingOverview',
          'panel',
          'likelyQuestions',
          'memberDynamics',
          'talkingPoints',
          'risks',
          'citations',
        ],
        statuses: ['complete', 'partial', 'unknown'],
        coverageStates: ['checked', 'partial', 'unavailable'],
        unknownValue: 'unknown',
        preserveModality: true,
        honorRequestedWindow: true,
        defaultRecentWindowDays: null,
        reportPartialCoverage: true,
      },
      completion: [
        'Attribute likely questions to a specific member or office',
        'Distinguish confirmed hearing facts from expected lines of questioning',
        'Cite the hearing and member sources used',
        'Name landmines explicitly rather than implying them',
        'Return no task, message, memory or other external effect',
      ],
      effectPolicy: { mode: 'read_only', prohibitedEffects: [...READ_ONLY_PROHIBITED] },
      examples: [
        'A member who has not announced questioning is not quoted as certain to ask.',
      ],
      caseIds: ['ST-16', 'MO-01'],
    },
  },
  coalition_letter: {
    version: 1,
    instruction:
      'Draft a coalition sign-on letter to a member, committee or agency. Lead with a single clear ask, support it with concrete rationale and district or economic nexus, and keep it tight and professional. No fabricated signatories or statistics.',
    manifest: {
      purpose:
        'Draft a coalition sign-on letter with one ask and cited, non-fabricated support.',
      scopes: ['general', 'client'],
      evidencePrerequisites: [
        'The recipient and the single ask',
        'Confirmed signatory authority and organization names',
        'Cited rationale and district or economic nexus',
      ],
      allowedCapabilities: capabilities(['client.read', 'documents.read']),
      output: {
        fields: ['recipient', 'subject', 'ask', 'rationale', 'supportingEvidence', 'signatories', 'close', 'citations'],
        statuses: ['complete', 'partial', 'unknown'],
        coverageStates: ['checked', 'partial', 'unavailable'],
        unknownValue: 'unknown',
        preserveModality: true,
        honorRequestedWindow: true,
        defaultRecentWindowDays: null,
        reportPartialCoverage: true,
      },
      completion: [
        'Lead with one clear ask',
        'Include only confirmed signatories',
        'Cite every statistic and factual claim',
        'Keep the letter tight and professional',
        'Return a draft only; no send, file or memory effect',
      ],
      effectPolicy: { mode: 'read_only', prohibitedEffects: [...READ_ONLY_PROHIBITED] },
      examples: [
        'An unconfirmed organization is not listed as a signatory.',
      ],
      caseIds: ['ST-16', 'MO-01'],
    },
  },
  amendment_tracker: {
    version: 1,
    instruction:
      'Track an amendment: sponsor, what it changes, current status, vote outlook and impact on the client. Ground in bill and markup intelligence; be explicit about whip-count uncertainty and never guarantee an outcome.',
    manifest: {
      purpose:
        'Track an amendment through sponsor, text change, status, vote outlook and client impact.',
      scopes: ['general', 'client'],
      evidencePrerequisites: [
        'The amendment text or sponsor record',
        'Current status and markup source',
        'Authorized client context when impact is client-scoped',
      ],
      allowedCapabilities: capabilities(['client.read']),
      output: {
        fields: ['amendment', 'sponsor', 'cosponsors', 'change', 'status', 'voteOutlook', 'clientImpact', 'nextSteps', 'citations'],
        statuses: ['complete', 'partial', 'unknown'],
        coverageStates: ['checked', 'partial', 'unavailable'],
        unknownValue: 'unknown',
        preserveModality: true,
        honorRequestedWindow: true,
        defaultRecentWindowDays: null,
        reportPartialCoverage: true,
      },
      completion: [
        'State exactly what the amendment changes',
        'Separate current status from predicted vote outlook',
        'Cite the amendment and status sources',
        'Never guarantee an outcome',
        'Return no task, message, memory or other external effect',
      ],
      effectPolicy: { mode: 'read_only', prohibitedEffects: [...READ_ONLY_PROHIBITED] },
      examples: [
        'A whip count described as likely is not reported as certain.',
      ],
      caseIds: ['ST-16', 'MO-01'],
    },
  },
});

export function builtinProcedureDigest(id: MeriBuiltinProcedureId): string {
  return procedureManifestDigest(MERI_BUILTIN_PROCEDURES[id].manifest);
}

function refuse(): never {
  throw new NotFoundException('Selected procedure is unavailable');
}

const SELECTOR_KEYS = new Set([
  'source',
  'recordId',
  'id',
  'version',
  'manifestDigest',
]);
const DIGEST = /^[a-f0-9]{64}$/;
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Validates the closed public selector shape. The browser may only choose; it
 * cannot smuggle instructions, tools, authority or extra keys into admission.
 */
export function parseSelectedProcedureSelector(
  value: unknown,
): MeriSelectedProcedureSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!SELECTOR_KEYS.has(key)) refuse();
  }
  const { source, version, manifestDigest } = record;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) refuse();
  if (typeof manifestDigest !== 'string' || !DIGEST.test(manifestDigest)) refuse();

  if (source === 'firm') {
    const { recordId } = record;
    if (typeof recordId !== 'string' || !RECORD_ID.test(recordId)) refuse();
    if (Object.hasOwn(record, 'id')) refuse();
    return { source: 'firm', recordId, version, manifestDigest };
  }
  if (source === 'builtin') {
    const { id } = record;
    if (typeof id !== 'string' || !(MERI_BUILTIN_PROCEDURE_IDS as readonly string[]).includes(id)) {
      refuse();
    }
    if (Object.hasOwn(record, 'recordId')) refuse();
    return {
      source: 'builtin',
      id: id as MeriBuiltinProcedureId,
      version,
      manifestDigest,
    };
  }
  refuse();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function admission(
  input: {
    tenantId: string;
    clientId: string | null;
    now: number;
    identity: MeriSelectedProcedureIdentity;
    manifest: MeriProcedureManifest;
    instruction: string;
    clientRequired: boolean;
  },
): MeriSelectedProcedureAdmission {
  const projection = projectProcedureBinding({
    clientId: input.clientId,
    manifest: input.manifest,
    instruction: input.instruction,
    requiredTools: [],
    clientRequired: input.clientRequired,
    now: input.now,
  });
  return deepFreeze({
    version: 1 as const,
    tenantId: input.tenantId,
    identity: { ...input.identity },
    manifestDigest: projection.manifestDigest,
    instruction: projection.instruction,
    purpose: input.manifest.purpose,
    scopes: [...input.manifest.scopes],
    evidencePrerequisites: [...input.manifest.evidencePrerequisites],
    scope: projection.scope,
    clientId: projection.clientId,
    clientRequired: projection.clientRequired,
    resolvedAt: projection.resolvedAt,
    validUntil: projection.validUntil,
    policy: {
      effectMode: projection.policy.effectMode,
      allowedCapabilities: [...projection.policy.allowedCapabilities],
      allowedTools: [...projection.policy.allowedTools],
      requiredTools: [...projection.policy.requiredTools],
      prohibitedEffects: [...input.manifest.effectPolicy.prohibitedEffects],
    },
    contract: {
      outputFields: [...projection.contract.outputFields],
      completionChecks: [...projection.contract.completionChecks],
      coverageStates: [...projection.contract.coverageStates],
      caseIds: [...projection.contract.caseIds],
    },
  });
}

export interface SelectedProcedureResolutionInput {
  ctx: TenantContext;
  clientId: string | null;
  selector: MeriSelectedProcedureSelector;
  firmSkills: Pick<MeriFirmSkillsService, 'list' | 'resolveProcedureReference'>;
  now?: number;
}

/**
 * Resolve one selected procedure to an immutable admission bound to the exact
 * version and manifest digest. Both paths re-verify version and digest AFTER the
 * canonical read so a row edited mid-resolution cannot be admitted.
 */
export async function resolveSelectedProcedureAdmission(
  input: SelectedProcedureResolutionInput,
): Promise<MeriSelectedProcedureAdmission> {
  const now = input.now ?? Date.now();
  const selector = parseSelectedProcedureSelector(input.selector);

  if (selector.source === 'builtin') {
    const entry = MERI_BUILTIN_PROCEDURES[selector.id];
    if (!entry) refuse();
    if (entry.version !== selector.version) refuse();
    const digest = builtinProcedureDigest(selector.id);
    if (digest !== selector.manifestDigest) refuse();
    const result = admission({
      tenantId: input.ctx.tenantId,
      clientId: input.clientId,
      now,
      identity: {
        source: 'builtin',
        id: selector.id,
        canonicalId: selector.id,
        version: entry.version,
      },
      manifest: entry.manifest,
      instruction: entry.instruction,
      clientRequired: false,
    });
    if (result.manifestDigest !== selector.manifestDigest) refuse();
    return result;
  }

  // Firm: read the tenant-scoped row first to derive canonicalId without any
  // legacy id invention, then re-resolve through the canonical uncached owner.
  const rows = await input.firmSkills.list(input.ctx);
  const row = rows.find((candidate) => candidate.id === selector.recordId);
  if (!row || !row.enabled || !row.runnable) refuse();
  if (row.version !== selector.version) refuse();
  if (!row.procedureDigest || row.procedureDigest !== selector.manifestDigest) refuse();

  let resolved: Awaited<ReturnType<MeriFirmSkillsService['resolveProcedureReference']>>;
  try {
    resolved = await input.firmSkills.resolveProcedureReference(input.ctx.tenantId, {
      source: 'firm',
      recordId: row.id,
      canonicalId: row.skillId,
      version: row.version,
    });
  } catch {
    refuse();
  }
  const manifest = resolved.procedure;
  const identity = resolved.procedureBinding;
  if (!manifest || !identity) refuse();
  if (
    identity.recordId !== selector.recordId ||
    identity.canonicalId !== row.skillId ||
    identity.version !== selector.version
  ) {
    refuse();
  }
  const digest = procedureManifestDigest(manifest);
  if (digest !== selector.manifestDigest) refuse();

  const clientRequired = resolved.id === 'commitments_audit';
  if (clientRequired && !input.clientId) {
    throw new BadRequestException('Commitments & Deliverables requires a selected client');
  }

  const result = admission({
    tenantId: input.ctx.tenantId,
    clientId: input.clientId,
    now,
    identity: {
      source: 'firm',
      id: row.id,
      canonicalId: row.skillId,
      version: row.version,
    },
    manifest,
    instruction: resolved.systemAddendum,
    clientRequired,
  });
  if (result.manifestDigest !== selector.manifestDigest) refuse();
  return result;
}
