import { describe, expect, test } from 'vitest';
import { coverageWarningTone } from './MeriCoverageWarning.js';
import type { ChatMessageRetrieval } from '../../components/chat/chat-store.js';

function retrieval(overrides: {
  requiredDomains?: string[];
  missingDomains?: string[];
  partialDomains?: string[];
  complete?: boolean;
}): ChatMessageRetrieval {
  return {
    plan: {
      subjectScope: 'client',
      targetHint: null,
      recipeTool: null,
      queryClass: 'lookup',
      requiredDomains: overrides.requiredDomains,
    },
    coverage: {
      complete: overrides.complete ?? true,
      stopReason: overrides.complete === false ? 'partial' : 'complete',
      missingDomains: overrides.missingDomains,
      partialDomains: overrides.partialDomains,
    },
  };
}

describe('coverageWarningTone', () => {
  test('no warning when coverage is complete and nothing required is missing', () => {
    expect(coverageWarningTone(retrieval({}))).toBeNull();
  });

  test('missing tone only when a REQUIRED domain is actually missing', () => {
    expect(
      coverageWarningTone(
        retrieval({ requiredDomains: ['committee_reports'], missingDomains: ['committee_reports'] }),
      ),
    ).toBe('missing');
  });

  test('a missing domain that was not required is only a partial warning', () => {
    expect(
      coverageWarningTone(
        retrieval({ requiredDomains: ['appropriations'], missingDomains: ['news'] }),
      ),
    ).toBe('partial');
  });

  test('incomplete coverage with no domain lists still warns partial', () => {
    expect(coverageWarningTone(retrieval({ complete: false }))).toBe('partial');
  });

  test('there is no conflict tone — the retrieval frame has no field for it', () => {
    const source = require('node:fs').readFileSync(
      require('node:path').resolve(process.cwd(), 'src/vnext/meri/MeriCoverageWarning.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/conflict:\s*\{/);
    expect(source).not.toContain('SOURCES DISAGREE');
  });

  test('stopReason is never rendered as a raw enum value', () => {
    const source = require('node:fs').readFileSync(
      require('node:path').resolve(process.cwd(), 'src/vnext/meri/MeriCoverageWarning.tsx'),
      'utf8',
    );
    // The raw field must always go through stopReasonCopy(), never interpolated directly.
    expect(source).not.toMatch(/\{retrieval\.coverage\.stopReason\}/);
  });
});
