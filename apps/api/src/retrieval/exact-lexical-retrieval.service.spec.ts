import { BadRequestException } from '@nestjs/common';
import {
  normalizeExactLexicalQuery,
  normalizeProgramAlias,
} from './exact-lexical-retrieval.service.js';

describe('Phase 11 exact lexical normalization', () => {
  it('normalizes domains without guessing identifier type', () => {
    expect(
      normalizeExactLexicalQuery({ kind: 'domain', value: 'https://www.Example.COM/path' }),
    ).toMatchObject({ kind: 'domain', normalizedIdentifier: 'example.com' });
  });

  it('normalizes UEI, CAGE, CIK and PE identifiers with the shared entity rules', () => {
    expect(normalizeExactLexicalQuery({ kind: 'uei', value: 'abc1-def2 ghi3' })).toMatchObject({
      normalizedIdentifier: 'ABC1DEF2GHI3',
    });
    expect(normalizeExactLexicalQuery({ kind: 'cage', value: '1a 2-b3' })).toMatchObject({
      normalizedIdentifier: '1A2B3',
    });
    expect(normalizeExactLexicalQuery({ kind: 'cik', value: '320193' })).toMatchObject({
      normalizedIdentifier: '0000320193',
    });
    expect(normalizeExactLexicalQuery({ kind: 'pe_code', value: '0605053-a' })).toMatchObject({
      normalizedIdentifier: '0605053A',
    });
  });

  it('rejects malformed UEI and CAGE values instead of inferring a different identifier', () => {
    expect(() => normalizeExactLexicalQuery({ kind: 'uei', value: 'SHORT' })).toThrow(
      BadRequestException,
    );
    expect(() => normalizeExactLexicalQuery({ kind: 'cage', value: 'TOO-LONG' })).toThrow(
      BadRequestException,
    );
  });

  it('accepts canonical and display federal bill identifiers deterministically', () => {
    expect(normalizeExactLexicalQuery({ kind: 'bill_id', value: '119-HR-8800' })).toMatchObject({
      canonicalBillId: '119-hr-8800',
      billType: 'hr',
      billNumber: '8800',
      congress: 119,
    });
    expect(
      normalizeExactLexicalQuery({ kind: 'bill_id', value: 'H.R. 8800', congress: 119 }),
    ).toMatchObject({
      canonicalBillId: '119-hr-8800',
      billType: 'hr',
      billNumber: '8800',
      congress: 119,
    });
    expect(normalizeExactLexicalQuery({ kind: 'bill_id', value: 'S. 123' })).toMatchObject({
      billType: 's',
      billNumber: '123',
      congress: undefined,
    });
  });

  it('rejects a fuzzy or malformed bill string', () => {
    expect(() => normalizeExactLexicalQuery({ kind: 'bill_id', value: 'the AI bill' })).toThrow(
      BadRequestException,
    );
  });

  it('uses the established ProgramAlias uppercase/punctuation normalization', () => {
    expect(normalizeProgramAlias('  Next-Gen  Aircraft & Sensors ')).toBe(
      'NEXT GEN AIRCRAFT SENSORS',
    );
  });
});
