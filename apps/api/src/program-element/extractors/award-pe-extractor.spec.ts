import { describe, expect, test } from '@jest/globals';
import { AwardPeExtractorService, type AwardLike } from './award-pe-extractor.service.js';

const known = new Set(['0603270A', '0603250F', '0604201A', '1242C93000']);
const svc = new AwardPeExtractorService();

describe('AwardPeExtractorService.extractPeCode', () => {
  test('award with explicit, known PE field → extracted (uppercased)', () => {
    const award: AwardLike = { programElement: '0603270a', description: 'whatever' };
    expect(svc.extractPeCode(award, known)).toBe('0603270A');
  });

  test('award with PE in description → extracted', () => {
    const award: AwardLike = {
      description: 'R&D services supporting PE 0603250F electronic warfare',
    };
    expect(svc.extractPeCode(award, known)).toBe('0603250F');
  });

  test('award with no PE anywhere → null (NOT quarantined)', () => {
    const award: AwardLike = {
      description: 'Base operations support services, no program element',
    };
    expect(svc.extractPeCode(award, known)).toBeNull();
  });

  test('PE-shaped but not in known program_element set → null (filtered)', () => {
    const award: AwardLike = { programElement: '0609999Z', description: 'mentions 0609999Z' };
    expect(svc.extractPeCode(award, known)).toBeNull();
  });

  test('malformed PE-ish token → null', () => {
    const award: AwardLike = { description: 'contract 12345 ABC not a pe' };
    expect(svc.extractPeCode(award, known)).toBeNull();
  });

  test('explicit field takes precedence; falls back to description when explicit invalid', () => {
    const award: AwardLike = { programElement: 'N/A', description: 'work under 0604201A' };
    expect(svc.extractPeCode(award, known)).toBe('0604201A');
  });

  test('idempotent / deterministic — same input yields same output', () => {
    const award: AwardLike = { description: 'PE 0603270A and PE 0603250F both mentioned' };
    const a = svc.extractPeCode(award, known);
    const b = svc.extractPeCode(award, known);
    expect(a).toBe(b);
    expect(a).toBe('0603270A'); // first valid known match wins
  });

  test('award with explicit, known procurement BLIN field → extracted', () => {
    const award: AwardLike = { programElement: '1242c93000', description: 'whatever' };
    expect(svc.extractPeCode(award, known)).toBe('1242C93000');
  });

  test('award with a known BLIN in the description → extracted', () => {
    const award: AwardLike = {
      description: 'Delivery order under line 1242C93000, air defense targets',
    };
    expect(svc.extractPeCode(award, known)).toBe('1242C93000');
  });
});

describe('AwardPeExtractorService.resolvePe (tiered, with provenance)', () => {
  // '198' (F-35) maps to exactly one known PE → auto-resolves; '516' maps to two
  // → ambiguous, NOT auto-resolved here (read path fans out instead).
  const acqMap = new Map<string, Set<string>>([
    ['198', new Set(['0603270A'])],
    ['516', new Set(['0603250F', '0604201A'])],
  ]);

  test('explicit known PE → resolved with source=explicit', () => {
    const r = svc.resolvePe({ programElement: '0603270a' }, known, acqMap);
    expect(r).toEqual({ peCode: '0603270A', source: 'explicit' });
  });

  test('DoD acq program (1:1) with no PE in text → resolved via program map', () => {
    const r = svc.resolvePe(
      { description: 'F-35 production lot, no PE token', dodAcqProgramCode: '198' },
      known,
      acqMap,
    );
    expect(r).toEqual({ peCode: '0603270A', source: 'dod_acquisition_program' });
  });

  test('DoD acq program that maps to MULTIPLE PEs → not auto-resolved (ambiguous)', () => {
    const r = svc.resolvePe({ description: 'no pe here', dodAcqProgramCode: '516' }, known, acqMap);
    expect(r).toBeNull();
  });

  test("'000'/'NONE' acq codes are never linkable", () => {
    expect(svc.resolvePe({ dodAcqProgramCode: '000' }, known, acqMap)).toBeNull();
    expect(svc.resolvePe({ dodAcqProgramCode: 'NONE' }, known, acqMap)).toBeNull();
    expect(svc.resolvePe({ dodAcqProgramCode: '' }, known, acqMap)).toBeNull();
  });

  test('acq program code not in the map → falls through to description regex', () => {
    const r = svc.resolvePe(
      { description: 'work under 0604201A', dodAcqProgramCode: '999' },
      known,
      acqMap,
    );
    expect(r).toEqual({ peCode: '0604201A', source: 'description_regex' });
  });

  test('explicit beats acq-program tier (precedence order)', () => {
    const r = svc.resolvePe(
      { programElement: '0604201A', dodAcqProgramCode: '198' },
      known,
      acqMap,
    );
    expect(r).toEqual({ peCode: '0604201A', source: 'explicit' });
  });

  test('nothing resolvable → null, even with a description', () => {
    const r = svc.resolvePe(
      { description: 'base ops support', dodAcqProgramCode: '000' },
      known,
      acqMap,
    );
    expect(r).toBeNull();
  });

  test('empty map (default) → behaves like description-only resolution', () => {
    const r = svc.resolvePe({ description: 'under 0603250F', dodAcqProgramCode: '198' }, known);
    expect(r).toEqual({ peCode: '0603250F', source: 'description_regex' });
  });

  test('program maps to a PE that is NOT in known set → not resolved', () => {
    const m = new Map<string, Set<string>>([['198', new Set(['0609999Z'])]]);
    const r = svc.resolvePe({ dodAcqProgramCode: '198' }, known, m);
    expect(r).toBeNull();
  });

  test('explicit known BLIN → resolved with source=explicit', () => {
    const r = svc.resolvePe({ programElement: '1242c93000' }, known, acqMap);
    expect(r).toEqual({ peCode: '1242C93000', source: 'explicit' });
  });

  test('known BLIN in description, no acq-map hit → resolved via description regex', () => {
    const r = svc.resolvePe(
      { description: 'line 1242C93000', dodAcqProgramCode: '999' },
      known,
      acqMap,
    );
    expect(r).toEqual({ peCode: '1242C93000', source: 'description_regex' });
  });
});
