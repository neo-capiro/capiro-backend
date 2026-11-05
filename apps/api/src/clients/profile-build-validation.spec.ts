// Keep this parser test independent of service construction and external I/O.
jest.mock('./clients.service.js', () => ({}));
jest.mock('./client-people.service.js', () => ({}));
jest.mock('./client-facilities.service.js', () => ({}));
jest.mock('./client-capabilities.service.js', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { parseProfileSave } from './profile-build-validation.js';

const command = {
  requestId: '10000000-0000-4000-8000-000000000001',
  expectedVersion: 'a'.repeat(64),
};
const parse = (value: Record<string, unknown>) => parseProfileSave({ ...command, ...value });

describe('person profile save validation', () => {
  it('keeps a name-only profile valid and normalizes the website before persistence', () => {
    expect(parse({ fields: { name: ' Example ', website: 'example.org' } }).fields).toEqual({
      name: 'Example',
      website: 'https://example.org/',
    });
  });

  it('normalizes official codes and preserves source attribution without claiming researched company identity', () => {
    const input = parse({ fields: { naicsCodes: [' 541330 ', '541330'], pscCodes: [' r425 '] } });
    expect(input.fields).toEqual({ naicsCodes: ['541330'], pscCodes: ['R425'] });
    expect(input.referenceMetadata?.naicsCodes?.[0]).toMatchObject({
      code: '541330',
      sourceType: 'person_entry',
      referenceStatus: 'verified',
      reference: { kind: 'naics', status: 'active' },
    });
    expect(input.referenceMetadata?.pscCodes?.[0]?.reference?.sourceUrl).toMatch(/^https:\/\//);
  });

  it('carries explicitly accepted suggestion citations through the profile-save parser', () => {
    const evidence = [{ label: 'Company description', excerpt: 'Engineering services', source: 'person_context' }];
    expect(parse({ fields: { naicsCodes: ['541330'] }, fieldEvidence: { naicsCodes: [{ code: '541330', evidence }] } })).toMatchObject({
      fieldEvidence: { naicsCodes: [{ code: '541330', evidence }] },
      referenceMetadata: { naicsCodes: [{ sourceType: 'person_entry' }] },
    });
  });

  it('permits format-valid manual values outside the catalog with an explicit unverified label', () => {
    const input = parse({ fields: { naicsCodes: ['99', '999999'], pscCodes: ['ZZZZ'] } });
    for (const metadata of Object.values(input.referenceMetadata!).flat()) {
      expect(metadata).toMatchObject({ sourceType: 'person_entry', referenceStatus: 'unverified' });
      expect(metadata?.label).toContain('unverified');
      expect(metadata).not.toHaveProperty('reference');
    }
  });

  it.each([
    { fields: { naicsCodes: '541330' } },
    { fields: { pscCodes: null } },
    { fields: { applicantTypes: 'Small business' } },
    { fields: { naicsCodes: ['54A330'] } },
    { fields: { naicsCodes: ['1'] } },
    { fields: { pscCodes: ['A12'] } },
    { fields: { pscCodes: ['1000'] } },
    { fields: { description: ['not text'] } },
    { fields: [] },
    { referenceMetadata: { naicsCodes: [{ referenceStatus: 'verified' }] } },
    { fields: { sbClassification: { sb: 'true' } } },
    { fields: { website: 'javascript:alert(1)' } },
    { fields: { primaryContactEmail: 'invalid' } },
  ])('rejects malformed or caller-supplied provenance (case %#)', (input) => {
    expect(() => parse(input)).toThrow(BadRequestException);
  });

  it('enforces exact handoff length and funding-priority boundaries', () => {
    expect(
      parse({
        fields: { cageCode: 'abc12', uei: 'abcdefghijkl', description: 'd'.repeat(600) },
        advocacy: {
          fundingPriorities: Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(120, 'p')),
        },
      }).fields,
    ).toMatchObject({ cageCode: 'ABC12', uei: 'ABCDEFGHIJKL' });
    for (const input of [
      { fields: { cageCode: '123456' } },
      { fields: { uei: '1'.repeat(13) } },
      { fields: { description: 'd'.repeat(601) } },
      { advocacy: { fundingPriorities: ['p'.repeat(121)] } },
      { advocacy: { fundingPriorities: Array(21).fill('priority') } },
      { advocacy: { fundingPriorities: [' '] } },
      { advocacy: { fundingPriorities: 'priority' } },
    ])
      expect(() => parse(input)).toThrow(BadRequestException);
  });

  it('accepts bounded boolean business classifications without projecting synthetic fields', () => {
    const input = parse({ fields: { sbClassification: { sb: true, veteran_owned: false } } });
    expect(input.fields).toEqual({ sbClassification: { sb: true, veteran_owned: false } });
    expect(input.referenceMetadata).toBeUndefined();
  });

  it('validates and normalizes locations without inventing a country or evidence', () => {
    const input = parse({
      locations: [
        { name: ' Office ', country: 'us', role: 'office', status: 'unknown' },
        { name: 'Other', country: '' },
      ],
    });
    expect(input.locations).toEqual([
      { name: 'Office', country: 'US', role: 'office', status: 'unknown' },
      { name: 'Other' },
    ]);
  });

  it.each([
    { locations: [{ name: 'Office', country: 'USA' }] },
    { locations: [{ name: 'Office', role: 'factory' }] },
    { locations: [{ name: 'Office', status: 'verified' }] },
    { locations: [{ name: 'Office', role: 'office', siteRole: 'research' }] },
    { locations: [{ name: 'Office', employeeCount: -1 }] },
    { locations: [{ name: 'Office', siteVerificationStatus: 'verified' }] },
    { locations: [{ name: 'Office', congressionalDistrict: '07' }] },
    { leadership: [{ name: 'Person', email: 'invalid' }] },
    { leadership: [{ name: 'Person', title: 't'.repeat(201) }] },
    { capabilities: [{ name: 'Capability', type: 'category' }] },
    { capabilities: [{ name: 'Capability', tags: 'tag' }] },
    { capabilities: [{ name: 'Capability', description: 'd'.repeat(601) }] },
    { capabilities: Array(101).fill({ name: 'Capability' }) },
    { advocacy: { engagementStartDate: '2026-02-30' } },
    { notes: { body: 'Note', sourceType: 'official' } },
  ])('rejects invalid section data instead of silently discarding it (case %#)', (input) => {
    expect(() => parse(input)).toThrow(BadRequestException);
  });

  it('accepts the manual frontend section contract with optional fields omitted', () => {
    expect(
      parse({
        leadership: [{ name: 'Person', title: '', email: '' }],
        capabilities: [{ name: 'System', type: 'platform', description: 'Named product' }],
        advocacy: {
          sectors: [],
          submissionTracks: [],
          issueCodes: [],
          fundingPriorities: [],
          engagementStartDate: '',
          internalNotes: '',
        },
        notes: ' A person-entered note ',
      }),
    ).toMatchObject({ notes: 'A person-entered note', capabilities: [{ type: 'platform' }] });
  });
});
