import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CompanyDossierQueryDto,
  CreateProspectDto,
  ListProspectsQueryDto,
  PreviewDuplicateHintsDto,
  SavePreferencesDto,
  SearchCandidatesQueryDto,
  UpdateProspectDto,
  transformQueryBoolean,
} from './business-development.dto.js';

/**
 * DTO/query contract. The critical regression: URL query booleans arrive as
 * STRINGS, and `@Type(() => Boolean)` coerces the literal string 'false' to
 * boolean true. The query DTOs must use transformQueryBoolean so 'false'
 * STAYS false, and an invalid boolean string is rejected by @IsBoolean().
 */
describe('transformQueryBoolean', () => {
  test("'false' string becomes boolean false", () => {
    expect(transformQueryBoolean({ value: 'false' })).toBe(false);
  });
  test("'true' string becomes boolean true", () => {
    expect(transformQueryBoolean({ value: 'true' })).toBe(true);
  });
  test("'0' becomes false and '1' becomes true", () => {
    expect(transformQueryBoolean({ value: '0' })).toBe(false);
    expect(transformQueryBoolean({ value: '1' })).toBe(true);
  });
  test('real booleans are untouched', () => {
    expect(transformQueryBoolean({ value: false })).toBe(false);
    expect(transformQueryBoolean({ value: true })).toBe(true);
  });
  test('garbage passes through unchanged so @IsBoolean() rejects it', () => {
    expect(transformQueryBoolean({ value: 'yes' })).toBe('yes');
    expect(transformQueryBoolean({ value: undefined })).toBeUndefined();
  });
});

describe('ListProspectsQueryDto', () => {
  test('literal query string false stays boolean false (regression: was true)', () => {
    const dto = plainToInstance(ListProspectsQueryDto, {
      conflictExcluded: 'false',
      linkedClient: 'false',
      includeDismissed: 'false',
    });
    expect(dto.conflictExcluded).toBe(false);
    expect(dto.linkedClient).toBe(false);
    expect(dto.includeDismissed).toBe(false);
  });

  test('literal query string true parses to true', () => {
    const dto = plainToInstance(ListProspectsQueryDto, { linkedClient: 'true' });
    expect(dto.linkedClient).toBe(true);
  });

  test('invalid boolean string is rejected by validation', async () => {
    const dto = plainToInstance(ListProspectsQueryDto, { linkedClient: 'maybe' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'linkedClient')).toBe(true);
  });

  test('status accepts active|dismissed|all and rejects others', async () => {
    for (const status of ['active', 'dismissed', 'all']) {
      const dto = plainToInstance(ListProspectsQueryDto, { status });
      expect((await validate(dto)).length).toBe(0);
    }
    const bad = plainToInstance(ListProspectsQueryDto, { status: 'archived' });
    expect((await validate(bad)).some((e) => e.property === 'status')).toBe(true);
  });

  test('stage filter validates against the enum', async () => {
    const ok = plainToInstance(ListProspectsQueryDto, { stage: 'researching' });
    expect((await validate(ok)).length).toBe(0);
    const bad = plainToInstance(ListProspectsQueryDto, { stage: 'dreaming' });
    expect((await validate(bad)).some((e) => e.property === 'stage')).toBe(true);
  });

  test('a fully-filtered query parses and validates', async () => {
    const dto = plainToInstance(ListProspectsQueryDto, {
      status: 'all',
      stage: 'qualified',
      ownerId: '5d33ca89-0000-4000-8000-000000000001',
      conflictExcluded: 'false',
      linkedClient: 'true',
      search: 'acme',
      limit: '50',
    });
    expect((await validate(dto)).length).toBe(0);
    expect(dto.conflictExcluded).toBe(false);
    expect(dto.linkedClient).toBe(true);
    expect(dto.limit).toBe(50);
  });
});

describe('UpdateProspectDto nextActionDueAt', () => {
  test('valid ISO date accepted', async () => {
    const dto = plainToInstance(UpdateProspectDto, {
      nextActionDueAt: '2026-10-01T12:00:00Z',
    });
    expect((await validate(dto)).length).toBe(0);
  });

  test('explicit null clears (allowed)', async () => {
    const dto = plainToInstance(UpdateProspectDto, { nextActionDueAt: null });
    expect((await validate(dto)).length).toBe(0);
  });

  test('non-date string rejected', async () => {
    const dto = plainToInstance(UpdateProspectDto, { nextActionDueAt: 'next tuesday' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'nextActionDueAt')).toBe(true);
  });

  test('watchRequested real boolean passes; string would be rejected', async () => {
    const ok = plainToInstance(UpdateProspectDto, { watchRequested: true });
    expect((await validate(ok)).length).toBe(0);
    const bad = plainToInstance(UpdateProspectDto, { watchRequested: 'sure' });
    expect((await validate(bad)).some((e) => e.property === 'watchRequested')).toBe(true);
  });
});

describe('create and pre-save duplicate DTOs', () => {
  test('create accepts only the exact pipeline stages', async () => {
    const ok = plainToInstance(CreateProspectDto, {
      displayName: 'Acme',
      stage: 'qualified',
    });
    expect((await validate(ok)).length).toBe(0);

    const bad = plainToInstance(CreateProspectDto, {
      displayName: 'Acme',
      stage: 'negotiating',
    });
    expect((await validate(bad)).some((error) => error.property === 'stage')).toBe(true);
  });

  test('duplicate preview validates the optional confirmed identity', async () => {
    const ok = plainToInstance(PreviewDuplicateHintsDto, {
      displayName: 'Acme',
      canonicalEntityId: '5d33ca89-0000-4000-8000-000000000001',
    });
    expect((await validate(ok)).length).toBe(0);

    const bad = plainToInstance(PreviewDuplicateHintsDto, {
      displayName: 'Acme',
      canonicalEntityId: 'not-a-uuid',
    });
    expect((await validate(bad)).some((error) => error.property === 'canonicalEntityId')).toBe(
      true,
    );
  });
});

describe('SavePreferencesDto bounds', () => {
  test('accepts small preference sets and rejects oversized arrays', async () => {
    const ok = plainToInstance(SavePreferencesDto, {
      practiceServiceAreas: ['appropriations'],
      agenciesIssues: ['defense'],
      geographies: ['Virginia'],
    });
    expect(await validate(ok)).toHaveLength(0);

    const oversized = plainToInstance(SavePreferencesDto, {
      practiceServiceAreas: Array.from({ length: 51 }, (_, index) => `area-${index}`),
    });
    expect(
      (await validate(oversized)).some((error) => error.property === 'practiceServiceAreas'),
    ).toBe(true);
  });
});

// ── Phase 2 — candidate search + dossier query DTOs ────────────────────────

describe('SearchCandidatesQueryDto boundaries', () => {
  test('q below the 2-character floor is rejected; 2 and 200 pass; 201 is rejected', async () => {
    const tooShort = plainToInstance(SearchCandidatesQueryDto, { q: 'a' });
    expect((await validate(tooShort)).some((e) => e.property === 'q')).toBe(true);

    const min = plainToInstance(SearchCandidatesQueryDto, { q: 'ab' });
    expect(await validate(min)).toHaveLength(0);

    const max = plainToInstance(SearchCandidatesQueryDto, { q: 'a'.repeat(200) });
    expect(await validate(max)).toHaveLength(0);

    const tooLong = plainToInstance(SearchCandidatesQueryDto, { q: 'a'.repeat(201) });
    expect((await validate(tooLong)).some((e) => e.property === 'q')).toBe(true);
  });

  test('q missing entirely is rejected (not optional)', async () => {
    const dto = plainToInstance(SearchCandidatesQueryDto, {});
    expect((await validate(dto)).some((e) => e.property === 'q')).toBe(true);
  });

  test('limit boundaries: 1 and 25 pass; 0 and 26 are rejected; string coerces', async () => {
    for (const limit of [1, 25]) {
      const dto = plainToInstance(SearchCandidatesQueryDto, { q: 'acme', limit });
      expect(await validate(dto)).toHaveLength(0);
    }
    for (const limit of [0, 26]) {
      const dto = plainToInstance(SearchCandidatesQueryDto, { q: 'acme', limit });
      expect((await validate(dto)).some((e) => e.property === 'limit')).toBe(true);
    }
    const coerced = plainToInstance(SearchCandidatesQueryDto, { q: 'acme', limit: '10' });
    expect(await validate(coerced)).toHaveLength(0);
    expect(coerced.limit).toBe(10);
  });

  test('offset boundaries: 0 and 500 pass; -1 and 501 are rejected', async () => {
    for (const offset of [0, 500]) {
      const dto = plainToInstance(SearchCandidatesQueryDto, { q: 'acme', offset });
      expect(await validate(dto)).toHaveLength(0);
    }
    for (const offset of [-1, 501]) {
      const dto = plainToInstance(SearchCandidatesQueryDto, { q: 'acme', offset });
      expect((await validate(dto)).some((e) => e.property === 'offset')).toBe(true);
    }
  });

  test('agency/issue/geography pass through bounded (max 200)', async () => {
    const ok = plainToInstance(SearchCandidatesQueryDto, {
      q: 'acme',
      agency: 'DoD',
      issue: 'defense',
      geography: 'VA',
    });
    expect(await validate(ok)).toHaveLength(0);
    const bad = plainToInstance(SearchCandidatesQueryDto, {
      q: 'acme',
      agency: 'a'.repeat(201),
    });
    expect((await validate(bad)).some((e) => e.property === 'agency')).toBe(true);
  });
});

describe('CompanyDossierQueryDto / dossier section boundaries', () => {
  const SECTIONS = [
    'identity',
    'government_exposure',
    'relevant_signals',
    'footprint',
    'lobbying',
    'people',
  ];

  test('every dossier section kind is accepted', async () => {
    for (const section of SECTIONS) {
      const dto = plainToInstance(CompanyDossierQueryDto, { section });
      expect(await validate(dto)).toHaveLength(0);
      expect(dto.section).toBe(section);
    }
  });

  test('unknown section values are rejected', async () => {
    for (const section of ['', ' Identity', 'identity ', 'exposure', 'jobs']) {
      const dto = plainToInstance(CompanyDossierQueryDto, { section });
      expect((await validate(dto)).some((e) => e.property === 'section')).toBe(true);
    }
  });

  test('section omitted is valid (full dossier request)', async () => {
    const dto = plainToInstance(CompanyDossierQueryDto, {});
    expect(await validate(dto)).toHaveLength(0);
  });
});
