import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Phase 5 no-duplicate-ingestion / no-network invariant (INV-0, binding).
 *
 * Scans the Phase 5 watch runner, CLI, guard, and service sources and
 * REJECTS, in CODE (comments stripped first so documentation language can
 * neither satisfy nor trip the scan):
 *   * provider/external HTTP or network imports/calls (src/external/, any
 *     HTTP client library, fetch(), node http/https request calls, raw
 *     net/tls/dgram sockets);
 *   * WRITES to the canonical global projections (any create/update/upsert/
 *     delete/createMany/updateMany/deleteMany call on the FederalAward,
 *     FederalAssistanceAward, SamOpportunity, TangoResourceSnapshot, or
 *     LdaFiling delegates) — Phase 5 only READS them;
 *   * polling/retry/sleep constructs (setTimeout/setInterval/sleep/retry
 *     loops) — the scheduler is the sole retry owner;
 *   * new ingestion surfaces (imports of ingestion/provider modules).
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const SCANNED_FILES = [
  'apps/api/src/business-development/bizdev-watch-runner.ts',
  'apps/api/src/business-development/bizdev-watch.service.ts',
  'apps/api/src/business-development/bizdev-watch.flag.guard.ts',
  'apps/api/scripts/run-bizdev-watch.ts',
];

/** Strip block + line comments so docs can never affect the scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Provider / external / network import or call patterns (code only). */
const FORBIDDEN_IMPORT_PATTERNS: Array<[RegExp, string]> = [
  [/from\s+['"][^'"]*\/external\/[^'"]*['"]/, 'import from src/external (provider client)'],
  [/from\s+['"](axios|node-fetch|got|undici|cross-fetch|superagent|request)['"]/, 'HTTP client library import'],
  [/from\s+['"]node:(net|tls|dgram|http|https|dns)['"]/, 'node network module import'],
  [/from\s+['"][^'"]*ingestion[^'"]*['"]/, 'ingestion module import'],
  [/from\s+['"][^'"]*(sam-|provider-)[a-z-]*client[^'"]*['"]/, 'provider client import'],
];

const FORBIDDEN_CALL_PATTERNS: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/, 'global fetch() call'],
  [/\bhttps?\.request\s*\(/, 'node http/https request call'],
  [/\baxios\s*[.(]/, 'axios call'],
  [/\bsetTimeout\s*\(/, 'setTimeout (polling/sleep)'],
  [/\bsetInterval\s*\(/, 'setInterval (polling)'],
  [/\bsleep\s*\(/, 'sleep call'],
  [/\bretry\s*\(/, 'retry loop call'],
];

/** Projection WRITE method invocations (reads use findMany/findFirst/count). */
const PROJECTION_WRITE_PATTERN =
  /\b(?:federalAward|federalAssistanceAward|samOpportunity|tangoResourceSnapshot|ldaFiling)\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;

const PROJECTION_RAW_WRITE_PATTERN =
  /\$(?:executeRaw|executeRawUnsafe)\s*`[^`]*\b(?:INSERT|UPDATE|DELETE)\b[^`]*(?:federal_awards|federal_assistance_awards|sam_opportunities|tango_resource_snapshots|lda_filings)/i;

describe('Phase 5 INV-0: no duplicate ingestion / no network (runner, CLI, guard, service)', () => {
  for (const rel of SCANNED_FILES) {
    const abs = path.join(REPO_ROOT, rel);
    test(`${rel}: no provider/network imports or calls, no projection writes, no polling, no new ingestion surface`, () => {
      const src = fs.readFileSync(abs, 'utf8');
      const code = stripComments(src);

      for (const [pattern, why] of FORBIDDEN_IMPORT_PATTERNS) {
        expect(`${rel}: ${why}`).toBe(`${rel}: ${why}`); // sanity label
        const hit = code.match(pattern);
        expect(hit === null ? `${rel}: ${why} — clean` : `${rel}: ${why} — VIOLATION: ${hit[0]}`).toBe(
          `${rel}: ${why} — clean`,
        );
      }
      for (const [pattern, why] of FORBIDDEN_CALL_PATTERNS) {
        const hit = code.match(pattern);
        expect(hit === null ? `${rel}: ${why} — clean` : `${rel}: ${why} — VIOLATION: ${hit[0]}`).toBe(
          `${rel}: ${why} — clean`,
        );
      }
      expect(code.match(PROJECTION_WRITE_PATTERN) === null).toBe(true);
      expect(code.match(PROJECTION_RAW_WRITE_PATTERN) === null).toBe(true);
    });
  }

  test('the scanned file set exists on disk (no silent skip)', () => {
    for (const rel of SCANNED_FILES) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
    }
  });
});
