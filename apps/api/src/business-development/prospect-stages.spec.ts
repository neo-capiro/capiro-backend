import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateProspectDto,
  ListProspectsQueryDto,
  UpdateProspectDto,
} from './business-development.dto.js';
import { prospectStageCatalog, BIZDEV_STAGES } from './prospect-stages.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test.each(BIZDEV_STAGES)('accepts %s on create, list and update boundaries', async (stage) => {
  for (const dto of [
    plainToInstance(CreateProspectDto, { displayName: 'Synthetic', stage }),
    plainToInstance(ListProspectsQueryDto, { stage }),
    plainToInstance(UpdateProspectDto, { stage }),
  ]) {
    expect(await validate(dto)).toHaveLength(0);
  }
});
test('rejects unknown stages at every input boundary', async () => {
  for (const dto of [
    plainToInstance(CreateProspectDto, { displayName: 'Synthetic', stage: 'unknown' }),
    plainToInstance(ListProspectsQueryDto, { stage: 'unknown' }),
    plainToInstance(UpdateProspectDto, { stage: 'unknown' }),
  ]) {
    expect((await validate(dto)).some((error) => error.property === 'stage')).toBe(true);
  }
});
test('advertises the approved Figma vocabulary and blocks inferred legacy migration', () => {
  const catalog = prospectStageCatalog();
  expect(catalog.stages.map((stage) => stage.label)).toEqual([
    'Identified',
    'Initiated',
    'Engaged',
    'Proposal',
    'Negotiation',
    'Closed won',
    'Closed lost',
  ]);
  expect(catalog.createStage).toBe('identified');
  expect(catalog.allowLegacyTransitions).toBe(false);
  expect(catalog.legacyMapping).toBe('pending');
});
test('candidate SQL supports the full accepted vocabulary without updating rows/defaults/policies', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '../../prisma/migrations/20281011020000_portfolio_prospect_stages/migration.sql',
    ),
    'utf8',
  );
  const values = [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  expect(values.sort()).toEqual([...BIZDEV_STAGES].sort());
  expect(sql.replace(/--[^\n]*/g, '')).not.toMatch(
    /\b(UPDATE|DELETE|INSERT|DEFAULT|POLICY|DISABLE)\b/i,
  );
});
