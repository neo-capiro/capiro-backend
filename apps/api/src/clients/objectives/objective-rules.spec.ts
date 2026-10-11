import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ObjectiveDraftDto, UpdateObjectiveDto } from './objective.dto.js';
import {
  normalizeObjectiveFields,
  objectiveReadiness,
  requireObjectiveReady,
} from './objective-rules.js';

const complete = {
  outcome: 'Enact authority',
  governmentProblem: 'Authority expires',
  askType: 'policy_authority',
  minimumWin: 'Extend one year',
  limits: '',
};

describe('Objective draft and readiness contract', () => {
  test('partial and empty drafts remain valid while readiness names missing fields', () => {
    const fields = { ...complete, outcome: '', governmentProblem: '   ', askType: null };
    expect(objectiveReadiness(fields)).toEqual({
      checklist: { outcome: false, governmentProblem: false, askType: false, minimumWin: true },
      completedFields: 1,
      requiredFields: 4,
      isReady: false,
    });
    expect(() => requireObjectiveReady(fields)).toThrow(BadRequestException);
  });

  test('the four fields suffice without limits, a cycle forecast, or Meri answers', () => {
    expect(objectiveReadiness(complete).isReady).toBe(true);
    expect(() => requireObjectiveReady(complete)).not.toThrow();
    expect(objectiveReadiness({ ...complete, askType: 'meri_propose' }).isReady).toBe(true);
  });

  test('normalizes only supplied fields and rejects unknown ask types', () => {
    expect(normalizeObjectiveFields({ outcome: '  Extend authority  ', askType: null })).toEqual({
      outcome: 'Extend authority',
      askType: null,
    });
    expect(() => normalizeObjectiveFields({ askType: 'guaranteed_funding' })).toThrow(
      BadRequestException,
    );
  });

  test('DTO rejects null text and protected/unknown fields instead of silently dropping them', async () => {
    const dto = plainToInstance(ObjectiveDraftDto, {
      outcome: null,
      tenantId: 'another-tenant',
      status: 'ready',
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((error) => error.property).sort()).toEqual(['outcome', 'status', 'tenantId']);
  });

  test('updates require an integer version and bounded text', async () => {
    const errors = await validate(
      plainToInstance(UpdateObjectiveDto, { expectedVersion: 0, minimumWin: 'x'.repeat(2001) }),
    );
    expect(errors.map((error) => error.property).sort()).toEqual(['expectedVersion', 'minimumWin']);
    expect(await validate(plainToInstance(ObjectiveDraftDto, {}))).toEqual([]);
  });
});
