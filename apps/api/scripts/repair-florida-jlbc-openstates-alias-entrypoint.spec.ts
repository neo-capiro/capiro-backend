import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dispatcher = readFileSync(join(__dirname, 'entrypoint-dispatcher.inc'), 'utf8');
const script = readFileSync(join(__dirname, 'repair-florida-jlbc-openstates-alias.ts'), 'utf8');

describe('exact Florida JLBC alias repair entrypoint', () => {
  it('exposes only the dedicated one-pair verb in the production dispatcher', () => {
    expect(dispatcher).toMatch(
      /repair-florida-jlbc-openstates-alias\)[\s\S]*repair-florida-jlbc-openstates-alias\.ts "\$@"/,
    );
    expect(script).toContain('FLORIDA_JLBC_ALIAS_REVIEW');
    expect(script).not.toContain('--manifest');
  });

  it('defaults to dry-run and requires explicit writer quiescence for apply', () => {
    expect(script).toContain("args.includes('--apply')");
    expect(script).toContain("args.includes('--writers-quiesced')");
    expect(script).toContain('FLORIDA_JLBC_ALIAS_REPAIR_WRITERS_QUIESCED');
    expect(script).toContain('FLORIDA_JLBC_ALIAS_REPAIR_PLAN_HASH');
    expect(script).toContain('FLORIDA_JLBC_ALIAS_REPAIR_CONFIRMATION');
  });
});
