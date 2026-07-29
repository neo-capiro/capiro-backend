import type { NodeDocumentDraftResponse } from '../meri/meri.types.js';

export const GENERATION_ASSURANCE_HOLD_REASON =
  'generated artifact verification did not pass — no Workspace or Outreach artifact was created; restore required context/provenance and retry';

export interface GeneratedDocumentAssurance {
  releaseable: boolean;
  blockers: string[];
  groundedFactRefs: string[];
}

/**
 * Master switch for actually WITHHOLDING a generated artifact. Dark by default.
 *
 * `assessGeneratedDocumentForRelease` is intentionally strict: Strategy execution
 * is an external client-facing surface, so it demands OK context health AND
 * per-section provenance on every section. Arming the hold therefore changes the
 * outcome of ordinary generations, not only bad ones — so it ships dark and is
 * armed per environment during the canary, while the assessment itself keeps
 * running and can be observed first.
 *
 * Parsed locally on purpose: apps/api-strategy does not depend on
 * @capiro/meriv2-core, and one switch does not justify a new cross-package
 * dependency. Keep the accepted value in sync with `resolveAssuranceReleaseMode`
 * in packages/meriv2-core/src/assurance/risk-gate.ts.
 */
export function generationReleaseHoldEnforced(
  raw: string | undefined = process.env.MERI_RELEASE_GATE,
): boolean {
  return (
    String(raw ?? '')
      .trim()
      .toLowerCase() === 'enforce'
  );
}

/**
 * Strategy execution is a high-risk client-facing surface. A model-shaped body
 * is not enough: context health must be OK and every persisted section must say
 * what source section/fact grounded it. This runs before any apps/api external
 * artifact create call.
 */
export function assessGeneratedDocumentForRelease(
  doc: NodeDocumentDraftResponse | null,
): GeneratedDocumentAssurance {
  const blockers: string[] = [];
  const groundedFactRefs: string[] = [];
  if (!doc) {
    blockers.push('Generation was unavailable.');
    return { releaseable: false, blockers, groundedFactRefs };
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
  return {
    releaseable: blockers.length === 0,
    blockers: [...new Set(blockers)],
    groundedFactRefs: [...new Set(groundedFactRefs)],
  };
}
