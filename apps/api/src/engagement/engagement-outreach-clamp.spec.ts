// Outreach DTO clamps must agree with the service-side normalizers.
//
// normalizeOutreachRecipients / normalizeOutreachContextPool (engagement.service.ts)
// already `.slice(0, N)` every field below. Before this fix the DTO *rejected* at
// the same N, so a value the service was written to store truncated instead 400'd
// the whole request. Because Phase 0 routes generation through ensureDraftRecord()
// first, a single over-long context title surfaced in the wizard as
// "email generation is failing" — the AI was never called.
//
// Validated directly with class-validator (no app boot), against the REAL DTOs.

import 'reflect-metadata';
import { describe, expect, test } from '@jest/globals';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateOutreachRecordDto, GenerateBatchEmailDto } from './engagement.controller.js';

const opts = { whitelist: true, forbidNonWhitelisted: true } as const;

function createRecord(body: Record<string, unknown>) {
  const dto = plainToInstance(CreateOutreachRecordDto, {
    type: 'campaign',
    title: 'Q3 posture hearing follow-up',
    ...body,
  });
  return { dto, errors: validateSync(dto as object, opts) };
}

// The real title that broke it: a 305-char document in the capiro-internal
// context library (doc-da1f87d8…, client "Aperture Defense Systems").
const LONG_TITLE = `Hearing recap — Armed Services Committee — Closed hearings to examine the posture of the Department of the Air Force in review of the Defense Authorization Request for Fiscal Year 2027 and the Future Years Defense Program; to be immediately followed by an open session at approximately 11-00 a.m. in .docx`;

describe('contextPool clamps instead of rejecting', () => {
  test('a 305-char library title is truncated to 240, not 400ed', () => {
    expect(LONG_TITLE.length).toBeGreaterThan(240);
    const { dto, errors } = createRecord({
      contextPool: [{ id: 'doc-1', sourceType: 'document', title: LONG_TITLE }],
    });
    expect(errors).toHaveLength(0);
    expect(dto.contextPool?.[0]?.title).toHaveLength(240);
    expect(dto.contextPool?.[0]?.title).toBe(LONG_TITLE.slice(0, 240));
  });

  test('an over-long summary is truncated to 2000 (20 of 124 real library items exceed it)', () => {
    const { dto, errors } = createRecord({
      contextPool: [{ id: 'debrief-1', sourceType: 'debrief', summary: 'x'.repeat(5888) }],
    });
    expect(errors).toHaveLength(0);
    expect(dto.contextPool?.[0]?.summary).toHaveLength(2000);
  });

  test('an over-long per-item note is truncated to 2000', () => {
    const { dto, errors } = createRecord({
      contextPool: [{ id: 'n', sourceType: 'note', note: 'y'.repeat(2500) }],
    });
    expect(errors).toHaveLength(0);
    expect(dto.contextPool?.[0]?.note).toHaveLength(2000);
  });

  test('a 600-item contextPool is clamped to the normalizer’s 500', () => {
    const { dto, errors } = createRecord({
      contextPool: Array.from({ length: 600 }, (_, i) => ({ id: `c${i}`, title: `Item ${i}` })),
    });
    expect(errors).toHaveLength(0);
    expect(dto.contextPool).toHaveLength(500);
  });
});

describe('recipient clamps instead of rejecting', () => {
  test('over-long office/committee/debriefSummary are truncated to normalizer bounds', () => {
    const { dto, errors } = createRecord({
      recipients: [
        {
          email: 'staffer@mail.house.gov',
          name: 'Jane Doe',
          office: 'O'.repeat(400),
          committee: 'C'.repeat(300),
          debriefSummary: 'D'.repeat(4000),
        },
      ],
    });
    expect(errors).toHaveLength(0);
    expect(dto.recipients?.[0]?.office).toHaveLength(240);
    expect(dto.recipients?.[0]?.committee).toHaveLength(160);
    expect(dto.recipients?.[0]?.debriefSummary).toHaveLength(2000);
  });

  test('ClampTo composes with EmptyToUndefined — empty stays undefined', () => {
    const { dto, errors } = createRecord({
      recipients: [{ email: 'a@b.gov', name: 'A', relevanceReason: '   ' }],
    });
    expect(errors).toHaveLength(0);
    expect(dto.recipients?.[0]?.relevanceReason).toBeUndefined();
  });

  test('email is NOT clamped — a malformed address is still rejected', () => {
    // Truncating an address would silently produce undeliverable mail, so this
    // field must keep failing loudly.
    const { errors } = createRecord({ recipients: [{ email: 'not-an-email', name: 'A' }] });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('recipients');
  });
});

describe('deliberate rejections are preserved', () => {
  test('GenerateBatchEmailDto still hard-rejects 101 recipients', () => {
    // The generate/send cap is NOT a normalizer mirror: silently dropping the
    // 101st recipient would lose mail the user asked to send.
    const dto = plainToInstance(GenerateBatchEmailDto, {
      templateId: 'system-outreach-message',
      recipients: Array.from({ length: 101 }, (_, i) => ({
        email: `r${i}@mail.house.gov`,
        name: `R${i}`,
      })),
    });
    const err = validateSync(dto as object, opts).find((e) => e.property === 'recipients');
    expect(err?.constraints?.arrayMaxSize).toContain('100');
  });

  test('an unknown context-pool field is still rejected by forbidNonWhitelisted', () => {
    const { errors } = createRecord({
      contextPool: [{ id: 'c1', title: 'ok', bogusField: 'nope' }],
    });
    expect(errors).toHaveLength(1);
  });
});
