import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateSavedSearchDto,
  PatchSavedSearchDto,
} from './funding-opportunity-saved-search.controller.js';

const fullCriteria = {
  schemaVersion: 2,
  mode: 'all',
  clientId: null,
  query: '  autonomous ground vehicle  ',
  sources: ['sam_gov'],
  types: ['solicitation'],
  lifecycle: ['active'],
  agencies: ['Army'],
  sectors: ['defense'],
  naicsCodes: ['541715'],
  pscCodes: ['R425'],
  setAsideCodes: [],
  eligibility: [],
  posted: [],
  geography: ['VA'],
  applicantTypes: [],
  funding: [],
  costShare: [],
  methods: [],
  disbursement: [],
  grantPrerequisites: [],
  codes: [],
  deadlineWindow: '90d',
  deadlineFrom: '2026-09-20',
  deadlineTo: '2026-12-20',
  sort: 'deadline',
  direction: 'asc',
  page: 1,
  pageSize: 50,
  retiredField: 'preserve-me',
};

describe('FundingOpportunitySavedSearchController DTOs', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

  it('accepts a complete criteria object under the real global validation settings', async () => {
    const dto = plainToInstance(CreateSavedSearchDto, {
      name: 'AGV search',
      visibility: 'tenant',
      criteria: fullCriteria,
    });
    await expect(validate(dto, { whitelist: true, forbidNonWhitelisted: true })).resolves.toEqual([]);
    await expect(pipe.transform({ name: 'AGV search', visibility: 'tenant', criteria: fullCriteria }, {
      type: 'body', metatype: CreateSavedSearchDto, data: '',
    } as any)).resolves.toMatchObject({ criteria: fullCriteria });
  });

  it('requires criteria and rejects non-object criteria instead of silently stripping fields', async () => {
    const missing = plainToInstance(CreateSavedSearchDto, { name: 'missing', visibility: 'tenant' });
    const scalar = plainToInstance(CreateSavedSearchDto, { name: 'scalar', visibility: 'tenant', criteria: 'bad' });
    expect((await validate(missing, { whitelist: true, forbidNonWhitelisted: true })).length).toBeGreaterThan(0);
    expect((await validate(scalar, { whitelist: true, forbidNonWhitelisted: true })).length).toBeGreaterThan(0);
  });

  it('allows unsupported criteria keys to reach the normalizer while rejecting unknown top-level body keys', async () => {
    const transformed = await pipe.transform({ name: 'AGV search', visibility: 'tenant', criteria: fullCriteria }, {
      type: 'body', metatype: CreateSavedSearchDto, data: '',
    } as any);
    expect(transformed.criteria.retiredField).toBe('preserve-me');
    await expect(pipe.transform({ name: 'AGV search', visibility: 'tenant', criteria: fullCriteria, alerts: { enabled: true } }, {
      type: 'body', metatype: CreateSavedSearchDto, data: '',
    } as any)).rejects.toBeTruthy();
  });

  it('validates partial patch criteria as an object when supplied', async () => {
    const dto = plainToInstance(PatchSavedSearchDto, { criteria: fullCriteria });
    await expect(validate(dto, { whitelist: true, forbidNonWhitelisted: true })).resolves.toEqual([]);
  });
});

void fullCriteria;

// Keep the production DTOs exercised through the actual ValidationPipe rather
// than testing only decorator metadata.
