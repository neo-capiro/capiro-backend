import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { ChatMessageRetrieval, GroundingCaveat } from '../../components/chat/chat-store.js';
import type { MeriEvidenceClaim, MeriEvidenceSource, MeriEvidenceStat } from './MeriEvidenceTray.js';
import { MeriEvidenceTab } from './MeriEvidenceTab.js';

const SOURCES: MeriEvidenceSource[] = [
  {
    icon: 'File05',
    provider: 'CAPIRO INTELLIGENCE',
    date: 'AUG 14, 2026',
    title: 'HASC FY27 committee report',
    snippet: 'The committee recommends $182.2M.',
    locator: 'REPORT P. 187',
  },
];

const STATS: MeriEvidenceStat[] = [
  { label: 'CLAIMS CHECKED · 2', tone: 'n' },
  { label: 'UNSUPPORTED · 1', tone: 'w' },
];

const CLAIMS: MeriEvidenceClaim[] = [
  { state: 'verified', claim: 'HASC authorised $182.2M against a $167.5M request.' },
  { state: 'unsupported', claim: 'The committee voted it out unanimously.' },
];

function retrieval(overrides: {
  requiredDomains?: string[];
  missingDomains?: string[];
  partialDomains?: string[];
  searchedDomains?: string[];
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
      searchedDomains: overrides.searchedDomains,
    },
  };
}

describe('MeriEvidenceTab', () => {
  test('renders sources with a relocated SOURCES · N section label and verification stats/claims', () => {
    render(
      <MeriEvidenceTab
        sources={SOURCES}
        verifyStats={STATS}
        claims={CLAIMS}
        groundingCaveat={null}
        retrieval={null}
      />,
    );

    expect(screen.getByText('SOURCES · 1')).toBeTruthy();
    expect(screen.getByText(/HASC FY27 committee report/)).toBeTruthy();
    expect(screen.getByText('CLAIMS CHECKED · 2')).toBeTruthy();
    expect(screen.getByText('HASC authorised $182.2M against a $167.5M request.')).toBeTruthy();
    expect(screen.getByText('VERIFIED · TIED TO A CITED LOCATOR')).toBeTruthy();
  });

  test('clicking a source calls onOpenSource with the source and its index', () => {
    const onOpenSource = vi.fn();
    render(
      <MeriEvidenceTab sources={SOURCES} verifyStats={[]} claims={[]} groundingCaveat={null} retrieval={null} onOpenSource={onOpenSource} />,
    );
    fireEvent.click(screen.getByText(/HASC FY27 committee report/));
    expect(onOpenSource).toHaveBeenCalledWith(SOURCES[0], 0);
  });

  test('folds in a grounding warning from the raw groundingCaveat.findings, mirroring VNextMeriMessage.tsx\'s own mapping', () => {
    const caveat: GroundingCaveat = {
      topSeverity: 'high',
      findings: [{ check: 'reversed_budget_direction', severity: 'high', detail: 'The answer states funding fell when it rose.' }],
    };
    render(<MeriEvidenceTab sources={[]} verifyStats={[]} claims={[]} groundingCaveat={caveat} retrieval={null} />);

    expect(screen.getByText('Meri flagged a possible grounding issue — verify before relying on it.')).toBeTruthy();
    expect(screen.getByText('REVERSED BUDGET DIRECTION')).toBeTruthy();
    expect(screen.getByText('The answer states funding fell when it rose.')).toBeTruthy();
  });

  test('folds in a coverage warning using the same coverageWarningTone rule as MeriCoverageWarning', () => {
    render(
      <MeriEvidenceTab
        sources={[]}
        verifyStats={[]}
        claims={[]}
        groundingCaveat={null}
        retrieval={retrieval({ requiredDomains: ['committee_reports'], missingDomains: ['committee_reports'], searchedDomains: ['news'] })}
      />,
    );
    expect(screen.getByText('REQUIRED SOURCE MISSING')).toBeTruthy();
    expect(screen.getByText('Not searched: Committee Reports.')).toBeTruthy();
    expect(screen.getByText('SEARCHED · NEWS')).toBeTruthy();
  });

  test('renders neither warning when coverage is complete and there is no grounding caveat', () => {
    render(
      <MeriEvidenceTab sources={SOURCES} verifyStats={[]} claims={[]} groundingCaveat={null} retrieval={retrieval({})} />,
    );
    expect(screen.queryByText('REQUIRED SOURCE MISSING')).toBeNull();
    expect(screen.queryByText('PARTIAL COVERAGE')).toBeNull();
  });

  test('renders an empty state when there is nothing to show at all', () => {
    render(<MeriEvidenceTab sources={[]} verifyStats={[]} claims={[]} groundingCaveat={null} retrieval={null} />);
    expect(screen.getByText('No evidence was recorded for this turn.')).toBeTruthy();
  });

  test('drops CONTEXT USED entirely — that content already lives in the rail\'s own Context tab', () => {
    // Renders nothing for it, and never imports the context-packet shape —
    // checked against the actual JSX/imports, not this file's own prose
    // explaining *why* (which legitimately says "CONTEXT USED").
    render(<MeriEvidenceTab sources={SOURCES} verifyStats={STATS} claims={CLAIMS} groundingCaveat={null} retrieval={null} />);
    expect(screen.queryByText('CONTEXT USED')).toBeNull();
    expect(screen.queryByText(/INCLUDED ·/)).toBeNull();
    expect(screen.queryByText(/EXCLUDED ·/)).toBeNull();

    const source = readFileSync(resolve(process.cwd(), 'src/vnext/meri/MeriEvidenceTab.tsx'), 'utf8');
    expect(source).not.toContain('MeriContextPacket');
  });

  test('carries no raw hex/rgba literals — colour lives in CSS classes, not inline styles', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/vnext/meri/MeriEvidenceTab.tsx'), 'utf8');
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(source).not.toMatch(/rgba?\(/i);
    expect(source).not.toMatch(/style=\{/);
  });
});
