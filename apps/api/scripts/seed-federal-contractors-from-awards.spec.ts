/**
 * Unit tests for the pure helpers that make award→contractor catalog seeding
 * safe to schedule. No DB.
 */
import { describe, expect, it } from '@jest/globals';
import {
  mergeContractorSeed,
  parseSeedArgs,
  pickUei,
} from './seed-federal-contractors-from-awards.js';

describe('seed-federal-contractors-from-awards helpers', () => {
  describe('pickUei', () => {
    it('accepts a canonical 12-char UEI', () => {
      expect(pickUei('qm4ezdv15jl8')).toBe('QM4EZDV15JL8');
      expect(pickUei('QN1BCFY7JDJ5')).toBe('QN1BCFY7JDJ5');
    });
    it('rejects short, long, or empty values', () => {
      expect(pickUei(null)).toBeNull();
      expect(pickUei('')).toBeNull();
      expect(pickUei('TOO-SHORT')).toBeNull();
      expect(pickUei('THISISWAYTOOLONG1')).toBeNull();
    });
  });

  describe('mergeContractorSeed', () => {
    const agg = {
      contractorName: 'L3HARRIS TECHNOLOGIES, INC.',
      awardCount: 149,
      totalObligated: 11_454_319_157.75,
      recipientUei: 'qm4ezdv15jl8',
    };

    it('fills UEI from awards when catalog row has none', () => {
      expect(mergeContractorSeed(null, agg)).toEqual({
        uei: 'QM4EZDV15JL8',
        totalContracts: agg.totalObligated,
      });
    });

    it('never clobbers an existing catalog UEI with awards UEI', () => {
      expect(
        mergeContractorSeed({ uei: 'AAAAAAAAAAAA', totalContracts: 1 }, agg),
      ).toEqual({
        uei: 'AAAAAAAAAAAA',
        totalContracts: agg.totalObligated,
      });
    });

    it('refreshes totals from the award aggregate', () => {
      expect(
        mergeContractorSeed({ uei: null, totalContracts: 99 }, { ...agg, recipientUei: null }),
      ).toEqual({
        uei: null,
        totalContracts: agg.totalObligated,
      });
    });
  });

  describe('parseSeedArgs', () => {
    it('defaults min-awards=1 and min-total=0', () => {
      expect(parseSeedArgs([])).toEqual({ minAwards: 1, minTotal: 0, limit: null });
    });
    it('parses flags', () => {
      expect(parseSeedArgs(['--min-awards', '3', '--min-total=1000', '--limit=50'])).toEqual({
        minAwards: 3,
        minTotal: 1000,
        limit: 50,
      });
    });
  });
});
