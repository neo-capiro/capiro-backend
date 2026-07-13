/**
 * Regression guard for the G4 boot failure (2026-07-13): reviews.service.ts
 * imported DOCX_MIME/markdownToMemoDocInput from alert-memo.service.ts, which
 * imports ReviewsService — a circular ESM import that left `ReviewsService`
 * `undefined` at the point AlertMemoModule tried to inject it, crashing every
 * new api task on boot (Nest "can't resolve dependencies of AlertMemoService
 * … index [4]"). tsc + mocked jest both passed; nothing evaluated the real
 * module graph.
 *
 * This test evaluates BOTH real modules and asserts every class export is a
 * defined constructor — a reintroduced cycle makes one of them `undefined`
 * here, failing in CI before it can reach a task definition.
 */
import { AlertMemoService } from '../intelligence/alert-memo/alert-memo.service.js';
import { ReviewsService } from './reviews.service.js';
import { DOCX_MIME, markdownToMemoDocInput } from '../intelligence/alert-memo/alert-memo-docx.js';

describe('reviews ↔ alert-memo module graph (no circular import)', () => {
  it('both services are defined constructors at eval time (a cycle would undefined one)', () => {
    expect(typeof AlertMemoService).toBe('function');
    expect(typeof ReviewsService).toBe('function');
  });

  it('the shared docx helpers resolve from the neutral module (not the service)', () => {
    expect(typeof DOCX_MIME).toBe('string');
    expect(typeof markdownToMemoDocInput).toBe('function');
  });
});
