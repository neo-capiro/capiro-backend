import assert from 'node:assert/strict';
import test from 'node:test';
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  CreatePeDataIssueDto,
  QueryProgramElementsDto,
  ResolveReconciliationDto,
  SetPeAlertEmailPrefDto,
  WatchProgramElementDto,
} from './dto/program-elements.dto.ts';

/**
 * DTO/error-behavior parity: the frozen contract's request bodies must
 * accept the same valid shapes and reject the same invalid shapes apps/api's
 * DTOs do (mirrors program-element.controller.ts's DTO decorators exactly).
 */
test('CreatePeDataIssueDto rejects an unknown issueType (matches apps/api @IsIn list)', async () => {
  const dto = plainToInstance(CreatePeDataIssueDto, { issueType: 'not_a_real_type', description: 'x' });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === 'issueType'));
});

test('CreatePeDataIssueDto accepts every apps/api-frozen issueType value', async () => {
  for (const issueType of ['value_incorrect', 'missing_value', 'wrong_source', 'wrong_stage_or_vehicle', 'wrong_pe_attribution', 'other']) {
    const dto = plainToInstance(CreatePeDataIssueDto, { issueType, description: 'ok' });
    const errors = await validate(dto);
    assert.equal(errors.length, 0, `issueType=${issueType} should validate cleanly`);
  }
});

test('CreatePeDataIssueDto rejects a non-http(s) suggestedSourceUrl', async () => {
  const dto = plainToInstance(CreatePeDataIssueDto, { issueType: 'other', description: 'x', suggestedSourceUrl: 'javascript:alert(1)' });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === 'suggestedSourceUrl'));
});

test('SetPeAlertEmailPrefDto only accepts off|daily|daily_plus_critical', async () => {
  const bad = plainToInstance(SetPeAlertEmailPrefDto, { mode: 'weekly' });
  assert.ok((await validate(bad)).length > 0);
  const good = plainToInstance(SetPeAlertEmailPrefDto, { mode: 'daily_plus_critical' });
  assert.equal((await validate(good)).length, 0);
});

test('ResolveReconciliationDto only accepts the three frozen decisions', async () => {
  const bad = plainToInstance(ResolveReconciliationDto, { decision: 'auto_accept' });
  assert.ok((await validate(bad)).length > 0);
  for (const decision of ['keep_current', 'accept_conflicting', 'manual_value']) {
    const good = plainToInstance(ResolveReconciliationDto, { decision });
    assert.equal((await validate(good)).length, 0, `decision=${decision} should validate cleanly`);
  }
});

test('WatchProgramElementDto requires a boolean watching field', async () => {
  const dto = plainToInstance(WatchProgramElementDto, { watching: true });
  assert.equal(dto.watching, true);
});

test('QueryProgramElementsDto rejects limit > 100 (matches apps/api @Max(100))', async () => {
  const dto = plainToInstance(QueryProgramElementsDto, { limit: 250 });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === 'limit'));
});

test('QueryProgramElementsDto rejects an unknown line_type NOT in the registry-reserved list is still permitted (no @IsIn on line_type here; contract query type allows free string)', async () => {
  const dto = plainToInstance(QueryProgramElementsDto, { line_type: 'RDTE_PE' });
  const errors = await validate(dto);
  assert.equal(errors.length, 0);
});
