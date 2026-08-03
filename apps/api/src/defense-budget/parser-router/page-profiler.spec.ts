import { describe, it, expect } from '@jest/globals';
import {
  pageProfileV1Schema,
  documentProfileSummaryV1Schema,
  documentProfileResultV1Schema,
  profilingThresholdsV1Schema,
  DEFAULT_PROFILING_THRESHOLDS,
  computeProfilingConfigSha256,
  computeProfileContentSha256,
  parseDocumentProfileResultV1,
} from './page-profiler.js';

describe('page-profiler', () => {
  /* B1: Page profile schema */
  describe('page profile schema', () => {
    it('accepts a valid page profile', () => {
      const profile = {
        page: 1,
        width: '612',
        height: '792',
        rotation: 0,
        embeddedTextCharacters: 500,
        alphanumericCharacters: 300,
        wordCount: 80,
        imageCount: 0,
        imageAreaRatio: '0',
        vectorLineCount: 10,
        horizontalLineCount: 5,
        verticalLineCount: 5,
        tableLikeTextLineCount: 4,
        hasEmbeddedTextLayer: true,
        likelyImageOnly: false,
        likelyRotated: false,
        likelyTablePage: true,
        likelyMixedLayout: false,
        profileWarnings: [],
      };
      const parsed = pageProfileV1Schema.parse(profile);
      expect(parsed.page).toBe(1);
      expect(parsed.likelyTablePage).toBe(true);
    });

    it('rejects unknown fields', () => {
      const bad = {
        page: 1,
        width: '612',
        height: '792',
        rotation: 0,
        embeddedTextCharacters: 500,
        alphanumericCharacters: 300,
        wordCount: 80,
        imageCount: 0,
        imageAreaRatio: '0',
        vectorLineCount: 10,
        horizontalLineCount: 5,
        verticalLineCount: 5,
        tableLikeTextLineCount: 4,
        hasEmbeddedTextLayer: true,
        likelyImageOnly: false,
        likelyRotated: false,
        likelyTablePage: true,
        likelyMixedLayout: false,
        profileWarnings: [],
        extraField: 'bad',
      };
      expect(() => pageProfileV1Schema.parse(bad)).toThrow();
    });

    it('rejects non-positive page numbers', () => {
      const bad = {
        page: 0,
        width: '612',
        height: '792',
        rotation: 0,
        embeddedTextCharacters: 0,
        alphanumericCharacters: 0,
        wordCount: 0,
        imageCount: 0,
        imageAreaRatio: '0',
        vectorLineCount: 0,
        horizontalLineCount: 0,
        verticalLineCount: 0,
        tableLikeTextLineCount: 0,
        hasEmbeddedTextLayer: false,
        likelyImageOnly: false,
        likelyRotated: false,
        likelyTablePage: false,
        likelyMixedLayout: false,
        profileWarnings: [],
      };
      expect(() => pageProfileV1Schema.parse(bad)).toThrow();
    });
  });

  /* B2: Document profile summary */
  describe('document profile summary', () => {
    it('accepts a valid summary', () => {
      const summary = {
        pageCount: 10,
        imageOnlyPageCount: 2,
        tableLikelyPageCount: 5,
        mixedLayoutPageCount: 2,
        rotatedPageCount: 1,
        zeroContentPageCount: 0,
        estimatedPdfplumberPages: 8,
        estimatedCamelotPages: 5,
        estimatedDoclingPages: 2,
        estimatedPaddleocrPages: 2,
        estimatedLlamaparsePages: 0,
      };
      const parsed = documentProfileSummaryV1Schema.parse(summary);
      expect(parsed.pageCount).toBe(10);
    });

    it('rejects negative counts', () => {
      const bad = {
        pageCount: 10,
        imageOnlyPageCount: -1,
        tableLikelyPageCount: 5,
        mixedLayoutPageCount: 2,
        rotatedPageCount: 1,
        zeroContentPageCount: 0,
        estimatedPdfplumberPages: 8,
        estimatedCamelotPages: 5,
        estimatedDoclingPages: 2,
        estimatedPaddleocrPages: 2,
        estimatedLlamaparsePages: 0,
      };
      expect(() => documentProfileSummaryV1Schema.parse(bad)).toThrow();
    });
  });

  /* B3: Document profile result */
  describe('document profile result', () => {
    it('accepts a valid result', () => {
      const result = {
        schemaVersion: 'defense_budget_page_profile_v1',
        sourceSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        pages: [
          {
            page: 1,
            width: '612',
            height: '792',
            rotation: 0,
            embeddedTextCharacters: 100,
            alphanumericCharacters: 50,
            wordCount: 20,
            imageCount: 0,
            imageAreaRatio: '0',
            vectorLineCount: 0,
            horizontalLineCount: 0,
            verticalLineCount: 0,
            tableLikeTextLineCount: 0,
            hasEmbeddedTextLayer: true,
            likelyImageOnly: false,
            likelyRotated: false,
            likelyTablePage: false,
            likelyMixedLayout: false,
            profileWarnings: [],
          },
        ],
        summary: {
          pageCount: 1,
          imageOnlyPageCount: 0,
          tableLikelyPageCount: 0,
          mixedLayoutPageCount: 0,
          rotatedPageCount: 0,
          zeroContentPageCount: 0,
          estimatedPdfplumberPages: 1,
          estimatedCamelotPages: 0,
          estimatedDoclingPages: 0,
          estimatedPaddleocrPages: 0,
          estimatedLlamaparsePages: 0,
        },
        profileConfigSha256: 'e3d0f0c1a2b3e4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9',
        contentSha256: '0000000000000000000000000000000000000000000000000000000000000000',
      };
      // Recompute content SHA
      const { contentSha256: _ignored, ...rest } = result;
      const realSha = computeProfileContentSha256(rest as never);
      const valid = { ...result, contentSha256: realSha };
      const parsed = parseDocumentProfileResultV1(valid);
      expect(parsed.schemaVersion).toBe('defense_budget_page_profile_v1');
    });
  });

  /* B4: Profiling thresholds */
  describe('profiling thresholds', () => {
    it('default thresholds are valid', () => {
      const parsed = profilingThresholdsV1Schema.parse(DEFAULT_PROFILING_THRESHOLDS);
      expect(parsed.minimumEmbeddedTextCharacters).toBe(40);
      expect(parsed.imageOnlyAreaRatio).toBe(0.80);
      expect(parsed.minimumTableLikeTextLines).toBe(3);
    });

    it('produces deterministic config SHA', () => {
      const sha1 = computeProfilingConfigSha256(DEFAULT_PROFILING_THRESHOLDS);
      const sha2 = computeProfilingConfigSha256(DEFAULT_PROFILING_THRESHOLDS);
      expect(sha1).toBe(sha2);
      expect(sha1).toHaveLength(64);
    });

    it('different thresholds produce different SHAs', () => {
      const modified = { ...DEFAULT_PROFILING_THRESHOLDS, minimumEmbeddedTextCharacters: 50 };
      const sha1 = computeProfilingConfigSha256(DEFAULT_PROFILING_THRESHOLDS);
      const sha2 = computeProfilingConfigSha256(modified);
      expect(sha1).not.toBe(sha2);
    });
  });
});