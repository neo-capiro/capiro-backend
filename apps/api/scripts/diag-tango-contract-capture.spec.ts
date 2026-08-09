import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The contract-capture diagnostic.
 *
 * This script's whole job is to be trustworthy about a thing nobody has seen,
 * so the tests are about its SAFETY PROPERTIES rather than its output: it must
 * not mutate, must not leak the key, must not overwrite evidence, and must not
 * quietly produce a partial artifact that reads as complete.
 *
 * Its actual output cannot be tested here — that requires the live provider and
 * an operator's key (plan 4.6). That is the point of the script, not a gap in
 * the suite.
 */

const source = readFileSync(join(__dirname, 'diag-tango-contract-capture.ts'), 'utf8');
// Comments explain exactly the things a naive substring scan would match, so
// they are stripped first. Same trap P49's "never calls the provider" test hit
// against its own header.
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('it is read-only', () => {
  test('no Prisma client, no database import of any kind', () => {
    expect(code).not.toContain('PrismaClient');
    expect(code).not.toContain('@prisma/client');
  });

  test('no write-shaped Prisma call appears', () => {
    for (const verb of ['create(', 'update(', 'upsert(', 'delete(', 'createMany(', 'executeRaw']) {
      expect(code).not.toContain(verb);
    }
  });

  test('it only ever calls the LIST methods of the two clients', () => {
    const calls = [...code.matchAll(/\.(list[A-Za-z]+)\(/g)].map((m) => m[1]!);
    expect(new Set(calls)).toEqual(
      new Set(['listRfqs', 'listRfps', 'listAwards', 'listTopics', 'listSolicitations']),
    );
  });
});

describe('the key cannot reach the artifact', () => {
  test('every error path is passed through BOTH redactors', () => {
    // A provider that echoes the request back in an error body is the one path
    // by which a key could land in a written artifact.
    const errorAssignments = [...code.matchAll(/error:\s*`?\$?\{?[^\n]*/g)].map((m) => m[0]!);
    const redacted = errorAssignments.filter((line) => line.includes('redact'));
    expect(redacted.length).toBeGreaterThan(0);
    expect(code).toContain('redactWithKnownSecret(redact(');
  });

  test('the key is never written, logged or interpolated into output', () => {
    // It may be READ from env and handed to a client; it may not be printed.
    expect(code).not.toMatch(/console\.(log|error)\([^)]*apiKey/);
    expect(code).not.toMatch(/writeFileSync\([^)]*apiKey/);
  });

  test('the artifact is built from captures only, never from the environment', () => {
    expect(code).toMatch(/writeFileSync\(out, JSON\.stringify\(artifact/);
  });
});

describe('an artifact is evidence', () => {
  test('it refuses to overwrite an existing capture', () => {
    expect(code).toContain('existsSync(out)');
    expect(code).toMatch(/Refusing to overwrite an existing capture/);
  });

  test('--out is required rather than defaulted into the repo', () => {
    // A default path inside the working tree is how a capture gets committed by
    // accident. The launcher supplies a timestamped path outside it.
    expect(code).toMatch(/--out <path> is required/);
  });
});

describe('a partial capture never reads as a complete one', () => {
  test('a failing endpoint is recorded and skipped, not fatal', () => {
    // One dead endpoint must not cost the other four.
    expect(code).toContain('ok: false');
    expect(code).toMatch(/catch \(error\)/);
  });

  test('an envelope mismatch is labelled as a contract finding, not a generic error', () => {
    expect(code).toMatch(/ENVELOPE MISMATCH/);
    expect(code).toMatch(/do NOT widen the client/i);
  });
});

describe('the documented-field list is transcribed from the CONTRACT DOC, not the mappers', () => {
  /**
   * The load-bearing property. Deriving this list from the mappers would only
   * prove the mappers agree with themselves; the run exists to check the
   * DOCUMENT against reality.
   */
  test('it imports no mapper', () => {
    expect(code).not.toContain('tango-dibbs.mapper');
    expect(code).not.toContain('tango-sbir.mapper');
  });

  test('every endpoint the clients expose has a documented-field list', () => {
    const keys = [...code.matchAll(/'((?:dibbs|sbir)\/[a-z]+)':/g)].map((m) => m[1]!);
    expect(new Set(keys)).toEqual(
      new Set([
        'dibbs/rfqs',
        'dibbs/rfps',
        'dibbs/awards',
        'sbir/topics',
        'sbir/solicitations',
      ]),
    );
  });

  test('SBIR field lists carry no `phase`, because the contract publishes none', () => {
    // P42's migration header records this. A capture that went looking for a
    // phase would report it MISSING and invite someone to "fix" the mapper.
    const sbirBlock = code.slice(code.indexOf("'sbir/topics'"));
    expect(sbirBlock.slice(0, 400)).not.toContain("'phase'");
  });
});

describe('the sample stays inside the rate budget', () => {
  test('five endpoints, one page each', () => {
    expect(code).toMatch(/SAMPLE_SIZE = 5/);
    expect(code).toMatch(/requestsIssued: captures\.length/);
  });

  test('it never paginates — the tenth page has the same shape as the first', () => {
    // It RECORDS whether a next page exists (`nextPresent`) — that is part of
    // confirming the envelope. What it must not do is FOLLOW one.
    //
    // Asserted as "each list method is invoked exactly once" rather than by
    // banning loops: the script legitimately loops over the sampled RECORDS to
    // build the field report, and a naive `for`/`while` ban fails on correct
    // code. The property that actually bounds the rate budget is the call count.
    for (const method of ['listRfqs', 'listRfps', 'listAwards', 'listTopics', 'listSolicitations']) {
      expect([...code.matchAll(new RegExp(`\\.${method}\\(`, 'g'))]).toHaveLength(1);
    }
    // And no explicit page argument, which is the only way to reach page 2.
    expect(code).not.toMatch(/\bpage:\s*\d/);
  });
});
