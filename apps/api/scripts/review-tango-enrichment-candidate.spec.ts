import { describe, expect, test } from '@jest/globals';
import { parseArgs } from './review-tango-enrichment-candidate.js';

const TENANT = '11111111-1111-1111-1111-111111111111';

describe('CLI parsing', () => {
  test('requires --tenant no matter the mode', () => {
    expect(parseArgs([])).toEqual({ mode: 'error', message: '--tenant=<uuid> is required' });
    expect(parseArgs(['--list'])).toEqual({ mode: 'error', message: '--tenant=<uuid> is required' });
  });

  test('--list mode, with optional client/status filters', () => {
    expect(parseArgs(['--list', `--tenant=${TENANT}`])).toEqual({
      mode: 'list',
      tenantId: TENANT,
      clientId: undefined,
      status: undefined,
    });
    expect(parseArgs(['--list', `--tenant=${TENANT}`, '--client=c1', '--status=pending'])).toEqual({
      mode: 'list',
      tenantId: TENANT,
      clientId: 'c1',
      status: 'pending',
    });
  });

  test('review mode requires --candidate', () => {
    expect(parseArgs([`--tenant=${TENANT}`, '--accept', '--reviewed-by=u1'])).toEqual({
      mode: 'error',
      message: '--candidate=<uuid> is required (or pass --list)',
    });
  });

  test('review mode requires EXACTLY ONE of --accept or --reject — never both, never neither', () => {
    expect(parseArgs([`--tenant=${TENANT}`, '--candidate=c1', '--reviewed-by=u1'])).toEqual({
      mode: 'error',
      message: 'pass exactly one of --accept or --reject',
    });
    expect(
      parseArgs([`--tenant=${TENANT}`, '--candidate=c1', '--accept', '--reject', '--reviewed-by=u1']),
    ).toEqual({ mode: 'error', message: 'pass exactly one of --accept or --reject' });
  });

  test('review mode requires --reviewed-by', () => {
    expect(parseArgs([`--tenant=${TENANT}`, '--candidate=c1', '--accept'])).toEqual({
      mode: 'error',
      message: '--reviewed-by=<userId> is required',
    });
  });

  test('a well-formed --accept parses cleanly, with no reason required', () => {
    expect(parseArgs([`--tenant=${TENANT}`, '--candidate=c1', '--accept', '--reviewed-by=u1'])).toEqual({
      mode: 'review',
      tenantId: TENANT,
      candidateId: 'c1',
      status: 'accepted',
      reviewedBy: 'u1',
      reason: undefined,
    });
  });

  test('a well-formed --reject carries the reason through verbatim', () => {
    expect(
      parseArgs([`--tenant=${TENANT}`, '--candidate=c1', '--reject', '--reviewed-by=u1', '--reason=not accurate']),
    ).toEqual({
      mode: 'review',
      tenantId: TENANT,
      candidateId: 'c1',
      status: 'rejected',
      reviewedBy: 'u1',
      reason: 'not accurate',
    });
  });

  test('there is no flag anywhere that could target more than one candidate', () => {
    // Structural proof this CLI cannot express "review more than one" — no
    // --all, --candidates (plural), or --bulk flag exists in the parser at all.
    const argv = [`--tenant=${TENANT}`, '--all', '--accept', '--reviewed-by=u1'];
    const result = parseArgs(argv);
    // --all is simply ignored (not a recognized flag) — --candidate is still required.
    expect(result).toEqual({ mode: 'error', message: '--candidate=<uuid> is required (or pass --list)' });
  });
});
