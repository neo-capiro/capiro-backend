import { createHash } from 'node:crypto';
import type { NodeDocumentDraftResponse } from '../meri/meri.types.js';

export const GENERATION_ASSURANCE_HOLD_REASON =
  'generated artifact verification did not pass — no Workspace or Outreach artifact was created; restore required context/provenance and retry';

export interface GeneratedDocumentAssurance {
  releaseable: boolean;
  blockers: string[];
  groundedFactRefs: string[];
  envelopeHash: string | null;
}

interface WireAssuranceEnvelope {
  version?: unknown;
  surface?: unknown;
  releaseDecision?: unknown;
  verifierVersion?: unknown;
  contextPacketId?: unknown;
  policyBinding?: unknown;
  generatedAt?: unknown;
  claimLedger?: { hash?: unknown };
  hash?: unknown;
  [key: string]: unknown;
}

/**
 * Legacy call shape used by ExecutionService. It can enforce only when the
 * operator explicitly selects ALL tenants and ALL assurance surfaces; tenant-
 * specific staging canaries must use generationReleaseModeForTenant at a
 * tenant-aware call site. This prevents a single global flag from arming two
 * independently deployed artifact writers.
 */
export function generationReleaseHoldEnforced(
  globalModeRaw: string | undefined = process.env.MERI_RELEASE_GATE,
  tenantCanariesRaw: string | undefined = process.env.MERI_RELEASE_GATE_TENANTS,
  surfacesRaw: string | undefined = process.env.MERI_RELEASE_GATE_SURFACES,
): boolean {
  return (
    normalize(globalModeRaw) === 'enforce' &&
    tokens(tenantCanariesRaw).includes('all') &&
    tokens(surfacesRaw).includes('all')
  );
}

export function generationReleaseModeForTenant(
  tenantId: string,
  surface: 'strategy' | 'outreach',
  globalModeRaw: string | undefined = process.env.MERI_RELEASE_GATE,
  tenantCanariesRaw: string | undefined = process.env.MERI_RELEASE_GATE_TENANTS,
  surfacesRaw: string | undefined = process.env.MERI_RELEASE_GATE_SURFACES,
): 'off' | 'shadow' | 'enforce' {
  const global = normalize(globalModeRaw);
  if (global !== 'shadow' && global !== 'enforce') return 'off';
  const tenants = tokens(tenantCanariesRaw);
  const surfaces = tokens(surfacesRaw);
  if (!tenants.includes('all') && !tenants.includes(normalize(tenantId))) return 'off';
  if (!surfaces.includes('all') && !surfaces.includes(surface)) return 'off';
  return global;
}

/**
 * Destination-side verification. Browser or upstream claims never authorize the
 * write: structural checks are recomputed here and the upstream envelope must be
 * internally consistent. A missing/tampered envelope remains observable while
 * dark and becomes a release blocker only when the tenant-aware rollout enforces.
 */
export function assessGeneratedDocumentForRelease(
  doc: NodeDocumentDraftResponse | null,
): GeneratedDocumentAssurance {
  const blockers: string[] = [];
  const groundedFactRefs: string[] = [];
  if (!doc) {
    blockers.push('Generation was unavailable.');
    return { releaseable: false, blockers, groundedFactRefs, envelopeHash: null };
  }

  if (doc.assurance?.held === true) {
    const reasons = (doc.assurance.blockers ?? []).filter(
      (reason): reason is string => typeof reason === 'string' && reason.trim().length > 0,
    );
    blockers.push(
      ...(reasons.length
        ? reasons.map((reason) => `Claim verification: ${reason}`)
        : ['Claim verification did not pass for the generated document.']),
    );
  }
  if (!doc.model?.trim()) blockers.push('The generation response did not identify the model used.');
  if (!Array.isArray(doc.sections) || doc.sections.length === 0) {
    blockers.push('The generation response contained no usable sections.');
  }
  if (!doc.groundingHealth) {
    blockers.push('The generation response did not include context health.');
  } else {
    if (doc.groundingHealth.status !== 'ok') {
      blockers.push(`Context health is ${doc.groundingHealth.status}.`);
    }
    if (doc.groundingHealth.missingRequired?.length) {
      blockers.push(
        `Required client context is missing: ${doc.groundingHealth.missingRequired.join(', ')}.`,
      );
    }
    if (doc.groundingHealth.openMaterialConflicts?.length) {
      blockers.push(
        `${doc.groundingHealth.openMaterialConflicts.length} material client-context conflict(s) remain unresolved.`,
      );
    }
  }
  for (const [index, section] of (doc.sections ?? []).entries()) {
    if (!section.heading?.trim() || !section.html?.trim()) {
      blockers.push(`Section ${index + 1} is empty or malformed.`);
      continue;
    }
    if (!section.sources?.length) {
      blockers.push(`Section "${section.heading}" has no provenance.`);
      continue;
    }
    for (const source of section.sources) {
      if (!source.section?.trim()) {
        blockers.push(`Section "${section.heading}" contains an invalid provenance entry.`);
      }
      if (source.ref?.startsWith('fact:')) groundedFactRefs.push(source.ref);
    }
  }

  const envelope = (doc.assurance as { envelope?: WireAssuranceEnvelope } | undefined)?.envelope;
  const envelopeErrors = verifyWireEnvelope(envelope, doc.assurance);
  blockers.push(...envelopeErrors.map((error) => `Assurance envelope: ${error}.`));
  if (
    envelope?.releaseDecision === 'hold' ||
    envelope?.releaseDecision === 'repair'
  ) {
    blockers.push(`Assurance envelope release decision is ${String(envelope.releaseDecision)}.`);
  }

  return {
    releaseable: blockers.length === 0,
    blockers: [...new Set(blockers)],
    groundedFactRefs: [...new Set(groundedFactRefs)],
    envelopeHash: typeof envelope?.hash === 'string' ? envelope.hash : null,
  };
}

function verifyWireEnvelope(
  envelope: WireAssuranceEnvelope | undefined,
  assurance: NodeDocumentDraftResponse['assurance'],
): string[] {
  if (!envelope) return ['missing'];
  const errors: string[] = [];
  if (envelope.version !== 'ga-assurance-envelope-v1') errors.push('unsupported version');
  if (envelope.surface !== 'strategy' && envelope.surface !== 'outreach') {
    errors.push('unexpected surface');
  }
  if (typeof envelope.generatedAt !== 'string' || !Number.isFinite(Date.parse(envelope.generatedAt))) {
    errors.push('invalid timestamp');
  }
  if (typeof envelope.verifierVersion !== 'string' || !envelope.verifierVersion.trim()) {
    errors.push('missing verifier version');
  }
  const suppliedHash = typeof envelope.hash === 'string' ? envelope.hash : '';
  const { hash: _hash, ...core } = envelope;
  if (!suppliedHash || suppliedHash !== sha256(stableStringify(core))) errors.push('hash mismatch');
  if (assurance?.decision && envelope.releaseDecision !== assurance.decision) {
    errors.push('release decision drift');
  }
  if (
    assurance?.ledgerHash &&
    (typeof envelope.claimLedger?.hash !== 'string' || envelope.claimLedger.hash !== assurance.ledgerHash)
  ) {
    errors.push('claim ledger drift');
  }
  return errors;
}

function tokens(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(/[,\s]+/)
    .map(normalize)
    .filter(Boolean);
}

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}
