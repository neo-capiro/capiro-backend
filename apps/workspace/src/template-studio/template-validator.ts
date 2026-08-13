import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { WorkspaceBlueprintDefinition } from './template-definition.js';

/**
 * Schema + completeness validation for a WorkspaceBlueprintDefinition, plus the
 * stable content-addressed hash that pins an existing document to its published
 * version (Template Studio). Pure + deterministic — no DB, no I/O — so it is
 * safe to call from the service, the publish gate, and the test-run simulator.
 */
@Injectable()
export class TemplateValidator {
  /**
   * Validate a definition against the schema and the publish completeness
   * rules. Returns `{ valid, errors }`; `errors` is empty when valid. This is
   * the gate that publish() and test() both run before producing anything.
   */
  validate(definition: unknown): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      return { valid: false, errors: ['definition must be an object'] };
    }
    const d = definition as Partial<WorkspaceBlueprintDefinition>;

    if (d.schemaVersion !== 1) {
      errors.push('schemaVersion must be 1');
    }

    // ── documentType ──────────────────────────────────────────────────────
    const dt = d.documentType;
    if (!dt || typeof dt !== 'object') {
      errors.push('documentType is required');
    } else {
      if (typeof dt.id !== 'string' || !dt.id) errors.push('documentType.id is required');
      if (typeof dt.label !== 'string' || !dt.label) errors.push('documentType.label is required');
      if (typeof dt.product !== 'string' || !dt.product) errors.push('documentType.product is required');
    }

    // ── intakeQuestions ───────────────────────────────────────────────────
    if (!Array.isArray(d.intakeQuestions)) {
      errors.push('intakeQuestions must be an array');
    } else {
      d.intakeQuestions.forEach((q, i) => {
        if (!q || typeof q !== 'object') return errors.push(`intakeQuestions[${i}] is invalid`);
        if (typeof q.id !== 'string' || !q.id) errors.push(`intakeQuestions[${i}].id is required`);
        if (typeof q.label !== 'string' || !q.label) errors.push(`intakeQuestions[${i}].label is required`);
        if (typeof q.required !== 'boolean') errors.push(`intakeQuestions[${i}].required must be boolean`);
        const src = q.answerSource;
        if (!['user', 'client_profile', 'context', 'meri_recommendation'].includes(src as string)) {
          errors.push(`intakeQuestions[${i}].answerSource is invalid`);
        }
      });
    }

    // ── sections ──────────────────────────────────────────────────────────
    if (!Array.isArray(d.sections) || d.sections.length === 0) {
      errors.push('sections must be a non-empty array');
    } else if (Array.isArray(d.sections)) {
      d.sections.forEach((s, i) => {
        if (!s || typeof s !== 'object') return errors.push(`sections[${i}] is invalid`);
        if (typeof s.id !== 'string' || !s.id) errors.push(`sections[${i}].id is required`);
        if (typeof s.title !== 'string' || !s.title) errors.push(`sections[${i}].title is required`);
        if (typeof s.required !== 'boolean') errors.push(`sections[${i}].required must be boolean`);
        // Required sections must carry purpose + instructions (publish gate).
        if (s.required) {
          if (typeof s.purpose !== 'string' || !s.purpose) {
            errors.push(`sections[${i}].purpose is required for required section "${s.id ?? i}"`);
          }
          if (typeof s.instructions !== 'string' || !s.instructions) {
            errors.push(`sections[${i}].instructions is required for required section "${s.id ?? i}"`);
          }
        }
        if (
          !s.targetWords ||
          typeof s.targetWords.min !== 'number' ||
          typeof s.targetWords.max !== 'number' ||
          s.targetWords.min < 0 ||
          s.targetWords.max < s.targetWords.min
        ) {
          errors.push(`sections[${i}].targetWords must be { min, max } with min <= max`);
        }
      });
    }

    // ── evidencePolicy ────────────────────────────────────────────────────
    const ep = d.evidencePolicy;
    if (!ep || typeof ep !== 'object') {
      errors.push('evidencePolicy is required');
    } else {
      if (typeof ep.minimumSources !== 'number' || ep.minimumSources < 0) {
        errors.push('evidencePolicy.minimumSources must be a non-negative number');
      }
      if (typeof ep.primarySourcesPreferred !== 'boolean') {
        errors.push('evidencePolicy.primarySourcesPreferred must be boolean');
      }
      if (!Array.isArray(ep.citationRequiredFor)) {
        errors.push('evidencePolicy.citationRequiredFor must be an array');
      }
      if (!Array.isArray(ep.freshnessRules)) {
        errors.push('evidencePolicy.freshnessRules must be an array');
      }
    }

    // ── contentRules ──────────────────────────────────────────────────────
    const cr = d.contentRules;
    if (!cr || typeof cr !== 'object') {
      errors.push('contentRules is required');
    } else {
      if (!Array.isArray(cr.requiredTerms)) errors.push('contentRules.requiredTerms must be an array');
      if (!Array.isArray(cr.prohibitedTerms)) errors.push('contentRules.prohibitedTerms must be an array');
      if (!Array.isArray(cr.requiredDisclaimers)) errors.push('contentRules.requiredDisclaimers must be an array');
      if (!Array.isArray(cr.instructions)) errors.push('contentRules.instructions must be an array');
    }

    // ── approvalPolicy ────────────────────────────────────────────────────
    const ap = d.approvalPolicy;
    if (!ap || typeof ap !== 'object') {
      errors.push('approvalPolicy is required');
    } else {
      if (typeof ap.clientFacingApprovalRequired !== 'boolean') {
        errors.push('approvalPolicy.clientFacingApprovalRequired must be boolean');
      }
      if (!Array.isArray(ap.permittedApproverRoles)) {
        errors.push('approvalPolicy.permittedApproverRoles must be an array');
      }
    }

    // ── defaultTheme ──────────────────────────────────────────────────────
    const th = d.defaultTheme;
    if (!th || typeof th !== 'object') {
      errors.push('defaultTheme is required');
    } else {
      if (typeof th.id !== 'string' || !th.id) errors.push('defaultTheme.id is required');
      if (typeof th.name !== 'string' || !th.name) errors.push('defaultTheme.name is required');
      if (!th.settings || typeof th.settings !== 'object') {
        errors.push('defaultTheme.settings must be an object');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Stable SHA-256 hash of the canonicalized definition. This is the pin an
   * existing WsDraft stores against its blueprint version: a new published
   * version with a different hash does NOT retroactively move documents that
   * were already pinned. Deterministic — same definition always hashes the
   * same way regardless of key insertion order.
   */
  computeDefinitionHash(definition: WorkspaceBlueprintDefinition): string {
    // Canonical JSON: sorted keys, no whitespace. Throws on circular refs,
    // which a valid definition never has.
    const canonical = stableStringify(definition);
    return createHash('sha256').update(canonical).digest('hex');
  }
}

/**
 * Deterministic JSON stringifier (sorted object keys, deeply). Mirrors the
 * canonicalization Fast-JSON-Stringify / json-stable-stringify use so the hash
 * is order-independent. Hand-rolled to avoid an extra dep.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
