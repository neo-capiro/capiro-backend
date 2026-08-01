/**
 * Source-type mapping contract for the governed-memory backfill classifier.
 *
 * The classifier quarantines any row whose sourceTypeFor() resolves to 'unknown'
 * without a source_ref. A production source that is not mapped therefore makes
 * its entire cohort unclassifiable: on live capiro-dev the first prepared job
 * quarantined 7930 of 7939 rows (99.9%) purely because graph-email,
 * meeting-service, manual, meri and ingest all fell through to 'unknown'.
 *
 * These tests pin the real cohorts observed by diag-memory-governance so the
 * mapping cannot silently regress, and assert that every returned value stays
 * inside the canonical MEMORY_SOURCE_TYPES vocabulary.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MEMORY_SOURCE_TYPES } from '@capiro/meriv2-core';

const storePath = path.join(__dirname, 'lib', 'memory-governance-backfill-store.ts');
const storeSource = readFileSync(storePath, 'utf8');

/** Extract the sourceTypeFor body so we can assert on its vocabulary statically. */
function sourceTypeForBody(): string {
  const match = /function sourceTypeFor\(row: LegacyRow\): string \{([\s\S]*?)\n\}/.exec(
    storeSource,
  );
  const body = match?.[1];
  if (!body) throw new Error('sourceTypeFor(row: LegacyRow) not found in the backfill store.');
  return body;
}

describe('governed-memory backfill source-type mapping', () => {
  it('only ever returns values from the canonical MEMORY_SOURCE_TYPES vocabulary', () => {
    const returned = [...sourceTypeForBody().matchAll(/return '([a-z_]+)'/g)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    );
    expect(returned.length).toBeGreaterThan(0);
    const vocabulary = new Set<string>(MEMORY_SOURCE_TYPES);
    const outside = returned.filter((value) => !vocabulary.has(value));
    expect(outside).toEqual([]);
  });

  it.each([
    // [source, expected source_type, why]
    ['graph-email', 'external_primary_source', 'synced mail thread, not firm-authored guidance'],
    ['meeting-service', 'confirmed_meeting_outcome', 'same outcomes the legacy meeting source had'],
    ['meri', 'steward_extraction', 'assistant-produced extraction'],
    ['ingest', 'legacy_projection', 'generic legacy ingest pipeline'],
  ])('maps the live %s cohort to %s (%s)', (source, expected) => {
    expect(sourceTypeForBody()).toContain(`row.source === '${source}'`);
    expect(sourceTypeForBody()).toContain(`'${expected}'`);
  });

  it('treats human-authored manual notes as user_message, never approved_document_edit', () => {
    const body = sourceTypeForBody();
    // approved_document_edit implies the Settings independent-review path; a
    // legacy note never went through it, so claiming that would overstate authority.
    expect(body).toContain("row.source === 'manual' && row.provenance === 'human'");
    expect(body).not.toContain("return 'approved_document_edit'");
  });

  it('keeps explicit type and slug rules ahead of source fallbacks', () => {
    const body = sourceTypeForBody();
    const firmPlaybook = body.indexOf("'firm_playbook'");
    const clioProjection = body.indexOf("row.slug.startsWith('clio:')");
    const graphEmail = body.indexOf("row.source === 'graph-email'");
    // A typed/slugged row carries a stronger classification than its raw source.
    expect(firmPlaybook).toBeGreaterThanOrEqual(0);
    expect(clioProjection).toBeGreaterThanOrEqual(0);
    expect(graphEmail).toBeGreaterThan(firmPlaybook);
    expect(graphEmail).toBeGreaterThan(clioProjection);
  });

  it('still quarantines on ambiguity, duplicates and class/scope mismatch', () => {
    // Widening the source vocabulary must not weaken the other three guards.
    const quarantine = /const quarantined =\s*([\s\S]*?);/.exec(storeSource);
    const expression = (quarantine?.[1] ?? '').replace(/\s+/g, ' ');
    expect(expression).not.toEqual('');
    expect(expression).toContain("classified.confidence === 'ambiguous'");
    expect(expression).toContain('duplicate');
    expect(expression).toContain('missingSource');
    expect(expression).toContain('classScopeMismatch');
  });

  it('leaves quarantined rows in the legacy vocabulary rather than guessing', () => {
    expect(storeSource).toContain("memoryClass: quarantined ? 'legacy_unclassified'");
    expect(storeSource).toContain("governedStatus: quarantined ? 'pending_review'");
  });
});
