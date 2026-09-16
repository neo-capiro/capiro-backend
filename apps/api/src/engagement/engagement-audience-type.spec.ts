// The v2 wizard's ManualTab (StepRecipientsSelect.tsx) requires the user to
// pick an audience from a fixed 9-option list and sends it as
// `recipient.audienceType` on BOTH the record-create payload and
// generate-batch. Before this contract repair, `OutreachRecipientDto` did not
// whitelist `audienceType`, so the global ValidationPipe (whitelist +
// forbidNonWhitelisted) rejected the nested recipients array with
// "property audienceType should not exist" — the record save and the sync
// generate request both 400'd. `normalizeOutreachRecipients` also dropped the
// field before persistence. These tests pin the repaired contract:
//
//  - a real manual payload (verbatim shape the wizard sends) is accepted by
//    CreateOutreachRecordDto, GenerateBatchEmailDto, and the async
//    OutreachGenerateJobDto (which inherits the same nested DTO);
//  - an UNKNOWN audience value still rejects (no blanket whitelist loosening);
//  - directory-origin recipients that omit audienceType entirely still pass;
//  - the service-side normalizer retains a validated audienceType (it used to
//    silently strip the field before persistence).
//
// Validated directly with class-transformer/class-validator (no app boot),
// matching engagement-dto.spec.ts / engagement-outreach-clamp.spec.ts.

import 'reflect-metadata';
import { describe, expect, test } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';
import {
  CreateOutreachRecordDto,
  GenerateBatchEmailDto,
  OutreachGenerateJobDto,
} from './engagement.controller.js';
import {
  normalizeOutreachRecipients,
  type OutreachRecipientInput,
} from './engagement.service.js';

const opts = { whitelist: true, forbidNonWhitelisted: true } as const;

// Verbatim shape of the wizard's ManualTab onAdd() payload
// (StepRecipientsSelect.tsx add()): id `manual:<email>`, the chosen audience,
// and the fixed provenance reason.
const MANUAL_RECIPIENT = {
  id: 'manual:qa-generation@example.com',
  name: 'Quinn Generation',
  email: 'qa-generation@example.com',
  relevanceReason: 'Manually added',
  audienceType: 'internal_colleague',
};

// A directory-origin recipient: resolved from the directory, so it carries no
// audienceType and MUST still pass.
const DIRECTORY_RECIPIENT = {
  id: 'dir:contact-1',
  name: 'Directory Contact',
  email: 'contact@example.gov',
  directoryContactId: 'dc-1',
  directoryContactName: 'Directory Contact',
};

/** recipients -> [index] -> audienceType within a ValidationError tree. */
function nestedAudienceError(errors: ValidationError[]): ValidationError | undefined {
  return errors
    .find((e) => e.property === 'recipients')
    ?.children?.find((c) => c.property === '0')
    ?.children?.find((c) => c.property === 'audienceType');
}

describe('OutreachRecipientDto.audienceType contract', () => {
  test('create record accepts the manual recipient and preserves its audienceType', () => {
    const dto = plainToInstance(CreateOutreachRecordDto, {
      type: 'campaign',
      title: 'Q3 posture hearing follow-up',
      recipients: [MANUAL_RECIPIENT, DIRECTORY_RECIPIENT],
    });
    expect(validateSync(dto, opts)).toHaveLength(0);
    expect(dto.recipients?.[0]?.audienceType).toBe('internal_colleague');
    // Directory recipients may legitimately omit the field.
    expect(dto.recipients?.[1]?.audienceType).toBeUndefined();
  });

  test('sync generate-batch accepts the manual recipient with a valid audience', () => {
    const dto = plainToInstance(GenerateBatchEmailDto, {
      templateId: 'system-outreach-message',
      outreachRecordId: '11111111-1111-4111-8111-111111111111',
      recipients: [MANUAL_RECIPIENT],
    });
    expect(validateSync(dto, opts)).toHaveLength(0);
    expect(dto.recipients?.[0]?.audienceType).toBe('internal_colleague');
  });

  test('async generate-job DTO (inherits the same nested DTO) accepts the manual recipient', () => {
    const dto = plainToInstance(OutreachGenerateJobDto, {
      requestKey: 'request-key-1',
      templateId: 'system-outreach-message',
      recipients: [MANUAL_RECIPIENT],
    });
    expect(validateSync(dto, opts)).toHaveLength(0);
    expect(dto.recipients?.[0]?.audienceType).toBe('internal_colleague');
  });

  test('an unknown audience value still rejects (no blanket whitelist loosening)', () => {
    const dto = plainToInstance(CreateOutreachRecordDto, {
      type: 'campaign',
      title: 'Q3 posture hearing follow-up',
      recipients: [{ ...MANUAL_RECIPIENT, audienceType: 'space_alien' }],
    });
    const errors = validateSync(dto, opts);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('recipients');
    const nested = nestedAudienceError(errors);
    expect(nested).toBeDefined();
    expect(Object.keys(nested?.constraints ?? {})).toContain('isIn');
  });

  test('every wizard-supported audience value passes create', () => {
    // The exact 9 options from MANUAL_AUDIENCE_OPTIONS (StepRecipientsSelect.tsx).
    const supported = [
      'congressional_office',
      'federal_agency',
      'defense_acquisition_office',
      'state_legislator',
      'state_agency',
      'local_official',
      'coalition',
      'client_executive',
      'internal_colleague',
    ];
    const dto = plainToInstance(CreateOutreachRecordDto, {
      type: 'campaign',
      title: 'Audience sweep',
      recipients: supported.map((audienceType, i) => ({
        ...MANUAL_RECIPIENT,
        id: `manual:aud${i}@example.com`,
        email: `aud${i}@example.com`,
        audienceType,
      })),
    });
    expect(validateSync(dto, opts)).toHaveLength(0);
    expect(dto.recipients?.map((r) => r.audienceType)).toEqual(supported);
  });
});

describe('normalizeOutreachRecipients retains the validated audience', () => {
  test('a manual recipient keeps its audienceType through normalization', () => {
    const normalized = normalizeOutreachRecipients([MANUAL_RECIPIENT]);
    expect(normalized).toHaveLength(1);
    const recipient: OutreachRecipientInput | undefined = normalized[0];
    expect(recipient?.email).toBe('qa-generation@example.com');
    expect(recipient?.audienceType).toBe('internal_colleague');
  });

  test('an absent audienceType stays absent (directory recipients)', () => {
    const normalized = normalizeOutreachRecipients([DIRECTORY_RECIPIENT]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.audienceType).toBeUndefined();
  });

  test('an out-of-tuple value is dropped, not carried into persistence', () => {
    // Belt-and-braces: the DTO already rejects unknown values, but the
    // normalizer also runs on stored/legacy rows, so it must never carry an
    // unrecognized audience forward.
    const normalized = normalizeOutreachRecipients([
      { ...MANUAL_RECIPIENT, audienceType: 'space_alien' },
    ]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.audienceType).toBeUndefined();
  });
});