// GenerateBatchEmailDto recipient cap (W0.4). The @ArrayMaxSize(100) bounds the
// synchronous per-recipient AI fan-out; without a failing test, raising/removing
// the cap would let a 101+ batch through to 100+ billable calls under the ALB
// timeout. Validated directly with class-validator (no app boot).

import 'reflect-metadata';
import { describe, expect, test } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { GenerateBatchEmailDto } from './engagement.controller.js';

function recipients(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    email: `r${i}@mail.house.gov`,
    name: `R${i}`,
  }));
}

function recipientsError(count: number) {
  const dto = plainToInstance(GenerateBatchEmailDto, {
    templateId: 'system-outreach-message',
    recipients: recipients(count),
  });
  const errors = validateSync(dto as object, { whitelist: true, forbidNonWhitelisted: true });
  return errors.find((e) => e.property === 'recipients');
}

describe('GenerateBatchEmailDto recipients cap (W0.4)', () => {
  test('100 recipients: no arrayMaxSize violation', () => {
    // Assert specifically on the arrayMaxSize constraint so nested-item validation
    // (if OutreachRecipientDto ever tightens) can't mask the cap check.
    expect(recipientsError(100)?.constraints?.arrayMaxSize).toBeUndefined();
  });

  test('101 recipients: arrayMaxSize violation with the actionable message', () => {
    const err = recipientsError(101);
    expect(err?.constraints?.arrayMaxSize).toBeDefined();
    expect(err?.constraints?.arrayMaxSize).toContain('100');
  });
});
