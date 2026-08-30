import { describe, expect, it } from 'vitest';
import {
  CLIENT_EXPORT_READY_STATUSES,
  clientExportStatusLabel,
  isClientExportReadyStatus,
} from './step-review.js';

describe('vNext step client-export review policy', () => {
  it.each(['suggested', 'draft', 'internal_review'] as const)(
    'keeps %s work out of client-ready reports until a person promotes it',
    (status) => {
      expect(isClientExportReadyStatus(status)).toBe(false);
      expect(clientExportStatusLabel(status)).toBe('Not included');
    },
  );

  it.each(CLIENT_EXPORT_READY_STATUSES)(
    'treats %s work as client-export ready',
    (status) => {
      expect(isClientExportReadyStatus(status)).toBe(true);
      expect(clientExportStatusLabel(status)).toBe('Included');
    },
  );
});
