import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  INTERNAL_OUTREACH_RECORD_TYPES,
  ownOutreachRecordWhere,
} from '../../engagement/engagement-access.helpers.js';
import {
  OUTREACH_V3_ARTIFACT_ROOT_SCHEMA_VERSION,
  OUTREACH_V3_INTERNAL_RECORD_TYPE,
} from './outreach-v3-artifact-root.service.js';

/**
 * The reserved root type only works if the DATABASE also accepts it.
 *
 * `outreach_records_type_check` is created by
 * 20260505203000_engagement_outreach_records and rewritten by any migration
 * that widens the allowed set. The V3 root type was added to TypeScript without
 * ever widening that constraint, so `ensureRoot()` failed with SQLSTATE 23514
 * on the first sample generation of every campaign and the whole V3
 * generation/drafts/send path was dead in production. Nothing reconciled the
 * two halves — the service tested its own constant, the migrations tested
 * nothing — which is exactly how it stayed silent. This walks the migration
 * directory and asserts the LAST definition of the constraint admits the same
 * literal the service inserts.
 */
function apiRoot(): string {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, 'prisma'))) return cwd;
  return resolve(cwd, 'apps/api');
}

function lastOutreachRecordTypeCheck(): string {
  const migrations = resolve(apiRoot(), 'prisma/migrations');
  const dirs = readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  let latest: string | null = null;
  for (const dir of dirs) {
    const file = resolve(migrations, dir, 'migration.sql');
    if (!existsSync(file)) continue;
    const sql = readFileSync(file, 'utf8');
    // `\s` spans newlines, so this matches both the inline CREATE TABLE
    // form and the ALTER TABLE ... ADD CONSTRAINT form.
    const matches = sql.match(
      /"?outreach_records_type_check"?\s*CHECK\s*\(\s*"?type"?\s+IN\s*\(([^)]*)\)/gi,
    );
    if (matches?.length) latest = matches[matches.length - 1]!;
  }
  if (!latest) throw new Error('No migration defines outreach_records_type_check');
  return latest;
}

describe('Outreach V3 hidden artifact root', () => {
  it('reserves one internal record type outside Classic access predicates', () => {
    expect(OUTREACH_V3_INTERNAL_RECORD_TYPE).toBe('outreach_v3');
    expect(INTERNAL_OUTREACH_RECORD_TYPES).toContain(OUTREACH_V3_INTERNAL_RECORD_TYPE);
    expect(OUTREACH_V3_ARTIFACT_ROOT_SCHEMA_VERSION).toBe('outreach_v3_artifact_root_v1');
  });

  it('uses an AND exclusion that cannot be overwritten by a later Classic type filter', () => {
    const owner = ownOutreachRecordWhere('11111111-1111-4111-8111-111111111111');
    expect(owner).toEqual({
      createdByUserId: '11111111-1111-4111-8111-111111111111',
      AND: [{ type: { notIn: ['outreach_v3'] } }],
    });

    // This is the actual composition style used by Classic list queries: a
    // later `type` key cannot replace the separate AND exclusion.
    const crafted = { ...owner, type: 'outreach_v3' };
    expect(crafted.AND).toEqual([{ type: { notIn: ['outreach_v3'] } }]);
    expect(crafted.type).toBe('outreach_v3');
  });

  it('is admitted by the live outreach_records_type_check constraint', () => {
    const constraint = lastOutreachRecordTypeCheck();
    expect(constraint).toContain(`'${OUTREACH_V3_INTERNAL_RECORD_TYPE}'`);
    // The pre-existing Classic types must survive the widening.
    for (const kept of ['campaign', 'follow_up', 'prep', 'outbound_campaign']) {
      expect(constraint).toContain(`'${kept}'`);
    }
  });

  it('keeps the reserved root out of every Classic type the constraint allows', () => {
    // A reserved type is only hidden if Classic never asks for it by name.
    expect(['campaign', 'follow_up', 'prep', 'outbound_campaign']).not.toContain(
      OUTREACH_V3_INTERNAL_RECORD_TYPE,
    );
  });
});
