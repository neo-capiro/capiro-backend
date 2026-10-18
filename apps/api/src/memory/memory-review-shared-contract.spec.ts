import { describe, expect, it } from '@jest/globals';
import type {
  MemoryReviewDetail as SharedDetail,
  MemoryReviewInboxItem as SharedItem,
  MemoryReviewInboxPage as SharedPage,
} from '@capiro/shared/memory-review';
import type {
  MemoryReviewDetail as ApiDetail,
  MemoryReviewInboxItem as ApiItem,
  MemoryReviewInboxPage as ApiPage,
} from './memory-review-inbox.service.js';

/**
 * capiro-backend #85 publishes the native memory review wire parsers as the
 * public contract (`@capiro/shared/memory-review`). This server keeps its own
 * response types; tsc (which includes specs) proves every server response is
 * assignable to the shared public shape, so the two cannot drift apart
 * silently. The parsers themselves are covered by the shared package's spec.
 */
const item: (value: ApiItem) => SharedItem = (value) => value;
const page: (value: ApiPage) => SharedPage = (value) => value;
const detail: (value: ApiDetail) => SharedDetail = (value) => value;

describe('memory review server types vs the shared public contract (#85)', () => {
  it('keeps the server inbox item, page and detail assignable to the shared types', () => {
    expect([item, page, detail].every((fn) => typeof fn === 'function')).toBe(true);
  });
});
