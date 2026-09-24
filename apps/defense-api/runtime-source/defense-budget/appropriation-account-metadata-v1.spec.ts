import { describe, expect, it } from '@jest/globals';
import {
  appropriationAccountMetadataV1,
  readAppropriationAccountMetadataV1,
} from './appropriation-account-metadata-v1.js';

describe('appropriation account lifecycle metadata', () => {
  it('round-trips a trimmed explicit account', () => {
    const metadata = appropriationAccountMetadataV1(' 2031A: Aircraft Procurement, Army ');
    expect(readAppropriationAccountMetadataV1(metadata)).toBe('2031A: Aircraft Procurement, Army');
  });

  it('treats an absent account as unsupported and refuses malformed values', () => {
    expect(readAppropriationAccountMetadataV1({})).toBeUndefined();
    expect(() => readAppropriationAccountMetadataV1({ appropriationAccount: '  ' })).toThrow(
      /nonblank string/,
    );
    expect(() => readAppropriationAccountMetadataV1({ appropriationAccount: 2031 })).toThrow(
      /nonblank string/,
    );
  });
});
