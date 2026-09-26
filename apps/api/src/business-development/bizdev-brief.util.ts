import { createHash } from 'node:crypto';
import type { EvidenceItem } from './bizdev-evidence.types.js';
import {
  BRIEF_CITATION_CAP,
  BRIEF_EVIDENCE_SNAPSHOT_CAP,
  BRIEF_SECTION_KEYS,
  BRIEF_TEXT_MAX,
  type BriefCitation,
  type BriefClaimCheck,
  type BriefClaimCheckOutcome,
  type BriefSectionDiff,
  type BriefSectionKey,
  type BriefSections,
  type BriefSectionContent,
  type BriefSourceSnapshot,
} from './bizdev-brief.types.js';

/**
 * Pure helpers for the Phase 4 brief service: hashing, section validation,
 * deterministic generation from dossier evidence, diffing, citation
 * validation, and the deterministic (non-LLM) claim checker. No I/O, no
 * Nestjs, no Prisma — everything here is directly unit-testable and shared
 * between create/refresh/save paths so all writers compute identical output
 * for identical evidence.
 */

// ── canonical JSON hashing ─────────────────────────────────────────────────

/** Deterministic canonical JSON: sorted keys, no whitespace, LF endings. */
export function canonicalJson(value: unknown): string {
  const s = JSON.stringify(sortJson(value));
  return s; // JSON.stringify never emits \r
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortJson((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** SHA-256 hex of canonical JSON (64 chars — matches VARCHAR(64)). */
export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export const hashSections = (sections: BriefSections): string => sha256Hex(sections);
export const hashSnapshot = (snapshot: BriefSourceSnapshot): string => sha256Hex(snapshot);

// ── section validation ──────────────────────────────────────────────────────

export interface SectionValidationIssue {
  section: BriefSectionKey | null;
  reason: string;
}

/**
 * Validate a sections payload: exactly the five keys, each with bounded text,
 * a valid provenance, and in-range citation indexes. Shape-only — never
 * interprets content.
 */
export function validateSections(
  input: unknown,
  citationCount: number,
): SectionValidationIssue[] {
  const issues: SectionValidationIssue[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return [{ section: null, reason: 'sections must be an object' }];
  }
  const record = input as Record<string, unknown>;
  for (const key of BRIEF_SECTION_KEYS) {
    if (!(key in record)) {
      issues.push({ section: key, reason: `missing section "${key}"` });
    }
  }
  const allowed = new Set<string>(BRIEF_SECTION_KEYS);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      issues.push({ section: null, reason: `unexpected section key "${key}"` });
    }
  }
  for (const key of BRIEF_SECTION_KEYS) {
    const value = record[key];
    if (value === undefined) continue; // reported as missing above
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ section: key, reason: 'section value must be an object' });
      continue;
    }
    const sec = value as Record<string, unknown>;
    const allowedSectionFields = new Set(['text', 'provenance', 'citationIndexes']);
    for (const field of Object.keys(sec)) {
      if (!allowedSectionFields.has(field)) {
        issues.push({ section: key, reason: `unexpected section field "${field}"` });
      }
    }
    if (typeof sec.text !== 'string' || sec.text.length === 0) {
      issues.push({ section: key, reason: 'text must be a non-empty string' });
    } else if (sec.text.length > BRIEF_TEXT_MAX) {
      issues.push({
        section: key,
        reason: `text exceeds ${BRIEF_TEXT_MAX} characters`,
      });
    }
    if (
      sec.provenance !== 'generated' &&
      sec.provenance !== 'edited'
    ) {
      issues.push({ section: key, reason: 'provenance must be generated or edited' });
    }
    const idx = sec.citationIndexes;
    if (!Array.isArray(idx)) {
      issues.push({ section: key, reason: 'citationIndexes must be an array' });
    } else {
      for (const i of idx) {
        if (
          typeof i !== 'number' ||
          !Number.isInteger(i) ||
          i < 0 ||
          i >= citationCount
        ) {
          issues.push({
            section: key,
            reason: `citation index ${String(i)} out of range (0..${citationCount - 1})`,
          });
        }
      }
    }
  }
  return issues;
}

// ── citation extraction + identity validation ──────────────────────────────

/**
 * Build the bounded citation list from dossier evidence, in deterministic
 * order. Citation identity = (sourceFamily, recordId): stable across
 * regenerations of the same evidence. Dates are copied verbatim from the
 * evidence item — never invented, never defaulted.
 */
export function citationsFromEvidence(evidence: EvidenceItem[]): BriefCitation[] {
  return evidence.slice(0, BRIEF_CITATION_CAP).map((item) => ({
    sourceFamily: item.sourceFamily,
    recordId: item.recordId ?? item.originalSourceId ?? '(no record id)',
    locator: item.locator,
    originalSourceName: item.originalSourceName,
    originalSourceId: item.originalSourceId,
    eventDate: item.eventDate,
    sourceUpdatedAt: item.sourceUpdatedAt,
    retrievedAt: item.fetchedAt,
    title: item.title,
    relationshipStrength: item.relationshipStrength,
    stage: item.stage,
  }));
}

export interface CitationIdentity {
  sourceFamily: string;
  recordId: string;
}

/** Stable identity of a citation for matching against authorized evidence. */
export const citationIdentity = (c: BriefCitation): CitationIdentity => ({
  sourceFamily: c.sourceFamily,
  recordId: c.recordId,
});

const sameIdentity = (a: CitationIdentity, b: CitationIdentity): boolean =>
  a.sourceFamily === b.sourceFamily && a.recordId === b.recordId;

/**
 * Validate submitted citations against the authorized citation set (from the
 * current dossier or the saved snapshot). Returns the issues; empty means all
 * identities are authorized and their dates are consistent.
 */
export function validateCitations(
  submitted: BriefCitation[],
  authorized: BriefCitation[],
): SectionValidationIssue[] {
  const issues: SectionValidationIssue[] = [];
  const authorizedIds = new Set(
    authorized.map((c) => {
      const id = citationIdentity(c);
      return `${id.sourceFamily}::${id.recordId}`;
    }),
  );
  submitted.forEach((c, i) => {
    const id = citationIdentity(c);
    if (!authorizedIds.has(`${id.sourceFamily}::${id.recordId}`)) {
      issues.push({
        section: null,
        reason: `citation ${i} (${id.sourceFamily} ${id.recordId}) is not from the authorized dossier evidence for this brief`,
      });
      return;
    }
    // Date consistency: a submitted citation may omit dates, but never
    // contradict the authorized record. Invented dates are rejected.
    const auth = authorized.find((a) => sameIdentity(citationIdentity(a), id))!;
    for (const field of ['eventDate', 'sourceUpdatedAt', 'retrievedAt'] as const) {
      if (c[field] != null && auth[field] != null && c[field] !== auth[field]) {
        issues.push({
          section: null,
          reason: `citation ${i} ${field} "${c[field]}" does not match the authorized record "${auth[field]}"`,
        });
      }
    }
  });
  return issues;
}

// ── deterministic section generation (no LLM) ────────────────────────────────

/** All evidence available for citation at generation time (bounded). */
export interface GenerationEvidence {
  identityName: string | null;
  identityBasis: string;
  evidence: EvidenceItem[];
}

/**
 * Deterministically generate the five sections from dossier evidence. Each
 * sentence restates only what an EvidenceItem records — no speculation, no
 * universal negatives, no invented dates. Wording is plain and honest; a
 * "no bounded match" result is always phrased as data scope, not absence.
 */
export function generateSections(evidence: GenerationEvidence): BriefSections {
  const cited = evidence.evidence.slice(0, BRIEF_CITATION_CAP);
  const citationIndexes = cited.map((_, i) => i);

  const listEvidence = (): string => {
    if (cited.length === 0) {
      return 'No ingested dossier evidence matched the checked scope for this organization.';
    }
    return cited
      .map((item, i) => {
        const when = item.eventDate ? ` (event date ${item.eventDate})` : '';
        const stage = item.stage ? `, recorded as "${item.stage}"` : '';
        return `${i + 1}. ${item.title}${when}${stage}.`;
      })
      .join('\n');
  };

  const directCount = cited.filter((c) => c.relationshipStrength === 'direct').length;
  const conditionalCount = cited.filter((c) => c.relationshipStrength === 'conditional').length;

  const sections: Record<BriefSectionKey, BriefSectionContent> = {
    companyAndFirmImplication: {
      text:
        `Company: ${evidence.identityName ?? 'identity not confirmed'} ` +
        `(identity basis: ${evidence.identityBasis}). ` +
        (directCount > 0
          ? `${directCount} checked dossier item(s) are directly tied to this organization by an exact identifier.`
          : 'No checked dossier item is directly tied by an exact identifier yet.')
        + (conditionalCount > 0
          ? ` ${conditionalCount} item(s) match by exact name only and remain to be verified.`
          : ''),
      provenance: 'generated',
      citationIndexes: [],
    },
    verifiedEvidence: {
      text: listEvidence(),
      provenance: 'generated',
      citationIndexes,
    },
    judgment: {
      text:
        cited.length === 0
          ? 'No judgment is offered: nothing in the checked dossier scope matched this organization, so there is nothing verified to weigh.'
          : directCount > 0
            ? `Based on ${directCount} directly-identified item(s) in the ingested dossier scope, this organization is worth a closer look; name-only matches (${conditionalCount}) still need verification.`
            : 'The matched dossier items are name-based only; verify the organization identity before relying on them.',
      provenance: 'generated',
      citationIndexes: cited.length > 0 ? citationIndexes.slice(0, 3) : [],
    },
    practicalAction: {
      text:
        cited.length === 0
          ? 'Suggested next step: confirm the organization identity (a registered UEI unlocks award and lobbying joins), then regenerate this brief.'
          : 'Suggested next step: review the cited dossier records, verify any name-only matches, and decide whether to advance this prospect to outreach.',
      provenance: 'generated',
      citationIndexes: [],
    },
    missingInformation: {
      text:
        'Checked but not found in the ingested scope: ' +
        (cited.length === 0
          ? 'no dossier evidence matched at all.'
          : directCount === 0
            ? 'no identifier-anchored record matched; only name-based matches were found.'
            : 'nothing further at this time; absence here reflects the checked scope, not the wider world.'),
      provenance: 'generated',
      citationIndexes: [],
    },
  };
  return sections;
}

/** Build the bounded source snapshot from the cited evidence. */
export function buildSourceSnapshot(
  generatedAt: string,
  identity: { canonicalEntityId: string | null; canonicalName: string | null; identityBasis: string },
  evidence: EvidenceItem[],
): BriefSourceSnapshot {
  return {
    generatedAt,
    identityBasis: identity.identityBasis,
    canonicalEntityId: identity.canonicalEntityId,
    canonicalName: identity.canonicalName,
    evidence: evidence.slice(0, BRIEF_EVIDENCE_SNAPSHOT_CAP),
  };
}

// ── diffing (refresh proposals) ─────────────────────────────────────────────

/** Per-section plain diff between a base version and a proposed one. */
export function diffSections(base: BriefSections, proposed: BriefSections): BriefSectionDiff[] {
  return BRIEF_SECTION_KEYS.map((section) => {
    const baseText = base[section]?.text ?? '';
    const proposedText = proposed[section]?.text ?? '';
    return { section, changed: baseText !== proposedText, baseText, proposedText };
  });
}

/**
 * Overlay user edits onto a generated proposal: a section whose base version
 * was user-edited keeps the user's text (refresh produces a proposal/diff
 * only and never overwrites user edits) unless the user explicitly accepts.
 */
export function preserveUserEdits(
  base: BriefSections,
  proposed: BriefSections,
): BriefSections {
  const out = {} as Record<BriefSectionKey, BriefSectionContent>;
  for (const key of BRIEF_SECTION_KEYS) {
    const baseSec = base[key];
    const proposedSec = proposed[key];
    if (baseSec?.provenance === 'edited' && proposedSec.provenance === 'generated') {
      // The user edited this section and the refresh did not touch its
      // evidentiary basis — keep the user's text, provenance stays 'edited'.
      out[key] = { ...baseSec };
    } else if (baseSec?.provenance === 'edited' && proposedSec.text !== baseSec.text) {
      // Refresh changed the section content: keep the user's edit as the
      // primary text and surface the new generated text in the proposal.
      out[key] = { ...baseSec };
    } else {
      out[key] = { ...proposedSec };
    }
  }
  return out as BriefSections;
}

// ── deterministic claim checking (BD-CLAIM stays DARK; no Jev) ──────────────

/**
 * Deterministic claim validation against the authorized evidence. Supports
 * exactly three checkable shapes and answers each with
 * supported/qualified/unsupported — never a universal negative and never an
 * invented date or amount.
 */
export function checkClaimDeterministic(input: {
  claimType: 'identity' | 'citation' | 'exact_amount' | 'date' | 'stage';
  citation?: BriefCitation | null;
  expected?: string;
}): BriefClaimCheck {
  const { claimType, citation } = input;

  if (claimType === 'identity') {
    if (!citation) {
      return {
        claim: 'citation identity',
        citationIndex: null,
        outcome: { kind: 'unsupported', reason: 'no citation provided to check' },
      };
    }
    return {
      claim: 'citation identity',
      citationIndex: null,
      outcome: {
        kind: 'supported',
        basis: `citation resolves to ${citation.sourceFamily} record ${citation.recordId}`,
      },
    };
  }

  if (!citation) {
    return {
      claim: claimType,
      citationIndex: null,
      outcome: { kind: 'unsupported', reason: 'no citation provided to check' },
    };
  }

  const expected = input.expected ?? null;
  if (expected == null) {
    return {
      claim: claimType,
      citationIndex: null,
      outcome: { kind: 'unsupported', reason: `no expected ${claimType} value given` },
    };
  }

  switch (claimType) {
    case 'citation':
      return {
        claim: 'citation presence',
        citationIndex: null,
        outcome: {
          kind: 'supported',
          basis: 'citation record is present in the authorized evidence',
        },
      };
    case 'exact_amount': {
      // Citations do not carry numeric amounts; the evidence title/detail does.
      // We can only verify the amount appears verbatim in the record title.
      const inTitle = citation.title.includes(expected);
      return {
        claim: `exact amount ${expected}`,
        citationIndex: null,
        outcome: inTitle
          ? { kind: 'supported', basis: `amount appears verbatim in the cited record title` }
          : {
              kind: 'unsupported',
              reason:
                'the cited record does not state that exact amount; deterministic amount checking is limited to the cited record text',
            },
      };
    }
    case 'date': {
      const date = citation.eventDate;
      if (date == null) {
        return {
          claim: `date ${expected}`,
          citationIndex: null,
          outcome: {
            kind: 'unsupported',
            reason: 'the cited record does not state an event date',
          },
        };
      }
      return {
        claim: `date ${expected}`,
        citationIndex: null,
        outcome:
          date === expected
            ? { kind: 'supported', basis: `cited record event date is ${date}` }
            : {
                kind: 'qualified',
                reason: `cited record event date is ${date}, not ${expected}`,
              },
      };
    }
    case 'stage': {
      const stage = citation.stage;
      if (stage == null) {
        return {
          claim: `stage ${expected}`,
          citationIndex: null,
          outcome: {
            kind: 'unsupported',
            reason: 'the cited record does not state a lifecycle stage',
          },
        };
      }
      return {
        claim: `stage ${expected}`,
        citationIndex: null,
        outcome:
          stage === expected
            ? { kind: 'supported', basis: `cited record stage is "${stage}"` }
            : {
                kind: 'qualified',
                reason: `cited record stage is "${stage}", not "${expected}"`,
              },
      };
    }
  }
}

export type { BriefClaimCheckOutcome };
