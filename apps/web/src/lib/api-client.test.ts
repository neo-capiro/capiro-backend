import { describe, expect, test } from 'vitest';
import { isGenerationUrl } from './api-client.js';

describe('isGenerationUrl', () => {
  test('matches AI content-generation endpoints (get the long timeout)', () => {
    const generationUrls = [
      '/api/engagement/outreach/generate-batch',
      '/api/intelligence/actions/generate',
      '/api/intelligence/actions/xyz/artifacts',
      '/api/engagement/attachments/abc/extract-text',
      '/api/clio/research/abc/clarify',
      // In-editor Meri assistant: bounded multi-round Sonnet+tool loop, runs
      // well past the 30s default on a "thinking" turn (regression guard).
      '/api/workspace/assistant',
      // "Let Meri draft an edit": single AI rewrite, can exceed 30s.
      '/api/workspace/documents/doc123/comments/c456/suggest',
    ];
    for (const url of generationUrls) {
      expect(isGenerationUrl(url), url).toBe(true);
    }
  });

  test('does not match ordinary fast endpoints (keep the tight default)', () => {
    const ordinaryUrls = [
      '/api/clients',
      '/api/engagement/outreach/audiences',
      '/api/intelligence/changes',
      // Ordinary workspace CRUD must stay on the tight 30s default.
      '/api/workspace/drafts/abc',
      '/api/workspace/documents/doc123/comments',
      undefined,
    ];
    for (const url of ordinaryUrls) {
      expect(isGenerationUrl(url), String(url)).toBe(false);
    }
  });
});
