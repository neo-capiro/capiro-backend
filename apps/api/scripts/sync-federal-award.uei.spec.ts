import { describe, expect, it } from '@jest/globals';
import { parseRecipientUei } from './sync-federal-award.js';

describe('sync-federal-award parseRecipientUei', () => {
  it('normalizes a valid UEI', () => {
    expect(parseRecipientUei('qm4ezdv15jl8')).toBe('QM4EZDV15JL8');
  });
  it('returns null for missing/invalid', () => {
    expect(parseRecipientUei(null)).toBeNull();
    expect(parseRecipientUei(undefined)).toBeNull();
    expect(parseRecipientUei('')).toBeNull();
    expect(parseRecipientUei('SHORT')).toBeNull();
  });
});
