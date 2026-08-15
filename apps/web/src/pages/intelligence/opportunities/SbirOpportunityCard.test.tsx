import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App as AntApp } from 'antd';
import {
  SbirOpportunityCard,
  describeSbirCycle,
  sbirProgramLabel,
  type SbirCycleFacts,
  type SbirTopicFacts,
} from './SbirOpportunityCard.js';

/**
 * P43 — the SBIR card's acceptance, asserted against RENDERED TEXT.
 *
 * P43's acceptance line is "UI labels source, phase, cycle, and deadlines
 * honestly", and three of those four have a specific dishonest version that is
 * easy to reach by accident:
 *
 *   - SOURCE: labelling every topic "SBIR" because the rail is called SBIR/STTR.
 *     `program` lives on the CYCLE, and STTR requires a research partner, so the
 *     guess asserts the absence of a requirement.
 *   - PHASE: omitting a phase rather than saying the source publishes none.
 *   - CYCLE: collapsing "the source named no cycle" and "Capiro does not hold
 *     the cycle" into one "Unknown" — a fact about the source merged with a fact
 *     about our sync.
 *
 * Asserted on the DOM rather than on props, because each failure happens on the
 * way to the screen.
 */

const PHASE_GAP =
  'The source publishes no phase for this topic, so none is shown. This is a gap in the published contract, not a judgement about the topic.';
const ELIGIBILITY =
  'SBIR eligibility is not evaluated. It turns on US ownership, employee count and — for STTR — a research-institution partner, none of which Capiro holds as a structured fact. A small-business certification is not the same question as the SBIR size standard for this topic.';

function topic(over: Partial<SbirTopicFacts> = {}): SbirTopicFacts {
  return {
    topicNumber: 'A26-001',
    title: 'Autonomous sustainment diagnostics',
    agency: 'Department of Defense',
    year: 2026,
    solicitationNumber: 'DoD-SBIR-26.A',
    releaseDate: '2025-12-04',
    openDate: '2026-01-06',
    closeDate: '2026-02-04',
    solicitationStatus: 'Open',
    topicUrl: 'https://example.invalid/topic/9001',
    officialSolicitationUrl: 'https://www.dodsbirsttr.mil/submissions/solicitation/9001',
    ...over,
  };
}

function cycle(over: Partial<SbirCycleFacts> = {}): SbirCycleFacts {
  return {
    solicitationNumber: 'DoD-SBIR-26.A',
    cycleName: '26.A',
    program: 'SBIR',
    year: 2026,
    startDate: '2026-01-06',
    endDate: '2026-02-04',
    solicitationStatus: 'Open',
    solDownloadUrl: 'https://example.invalid/sol.pdf',
    ...over,
  };
}

function renderCard(props: Partial<Parameters<typeof SbirOpportunityCard>[0]> = {}) {
  return render(
    <AntApp>
      <SbirOpportunityCard
        facts={topic()}
        cycle={cycle()}
        clientName="Acme Defense"
        relevanceScore={54}
        phaseGapExplanation={PHASE_GAP}
        eligibilityReason={ELIGIBILITY}
        actions={['assess_fit']}
        onSelectClient={vi.fn()}
        onOpenDetail={vi.fn()}
        onAction={vi.fn()}
        {...props}
      />
    </AntApp>,
  );
}

afterEach(cleanup);

describe('source: SBIR vs STTR comes from the cycle, or not at all', () => {
  test('the program tag renders the cycle’s own value', () => {
    renderCard({ cycle: cycle({ program: 'STTR' }) });
    expect(screen.getByTestId('fo-sbir-program')).toHaveTextContent('STTR');
  });

  test('with no cycle held, it says the program is not stated — never "SBIR"', () => {
    // The easy mistake: the rail is called SBIR/STTR, so every topic looks like
    // an SBIR topic. STTR requires a research partner; guessing asserts the
    // absence of that requirement.
    renderCard({ cycle: null });
    expect(screen.getByTestId('fo-sbir-program-unknown')).toHaveTextContent('Program not stated');
    expect(screen.queryByTestId('fo-sbir-program')).not.toBeInTheDocument();

    // Scoped to the TAGS, not to the whole card. "SBIR" legitimately appears in
    // the cycle identifier `DoD-SBIR-26.A` — the provider's own string — and in
    // the eligibility reason. A blanket text scan would ban both and be
    // asserting the wrong thing; the claim is that no tag ASSERTS a program.
    const tagText = [...document.querySelectorAll('.ant-tag')].map((el) => el.textContent?.trim());
    expect(tagText).not.toContain('SBIR');
    expect(tagText).not.toContain('STTR');
  });

  test('a cycle held but with no program stated is still "not stated"', () => {
    renderCard({ cycle: cycle({ program: null }) });
    expect(screen.getByTestId('fo-sbir-program-unknown')).toBeInTheDocument();
    expect(sbirProgramLabel(cycle({ program: '   ' }))).toBeNull();
  });
});

describe('phase: the absence is a row, never an omission', () => {
  test('the gap sentence renders verbatim', () => {
    renderCard();
    const gap = screen.getByTestId('fo-sbir-phase-gap');
    expect(gap).toHaveTextContent('The source publishes no phase for this topic');
    expect(gap).toHaveTextContent('gap in the published contract');
  });

  test('no phase value appears anywhere on the card', () => {
    // "Direct to Phase II" in a title is the provider describing a topic, not a
    // structured field. Nothing here may parse one out.
    renderCard({
      facts: topic({ title: 'Direct to Phase II autonomous diagnostics' }),
    });
    const text = document.body.textContent ?? '';
    // The title is rendered as given — that is the provider's text.
    expect(text).toContain('Direct to Phase II autonomous diagnostics');
    // But no FIELD labelled as a phase exists.
    expect(screen.queryByText(/^Phase$/)).not.toBeInTheDocument();
  });
});

describe('cycle: three different states get three different sentences', () => {
  test('the source stated no cycle', () => {
    renderCard({ facts: topic({ solicitationNumber: null }), cycle: null });
    expect(screen.getByTestId('fo-sbir-cycle')).toHaveTextContent(
      'The source states no solicitation cycle for this topic',
    );
  });

  test('the topic names a cycle Capiro does not hold — an orphan, which is legal', () => {
    // P42 has no FK on purpose: a topic may name a cycle never synced, and a
    // missing parent must not drop it.
    renderCard({ facts: topic({ solicitationNumber: 'DoD-SBIR-99.Z' }), cycle: null });
    const text = screen.getByTestId('fo-sbir-cycle');
    expect(text).toHaveTextContent('DoD-SBIR-99.Z');
    expect(text).toHaveTextContent('Capiro does not hold this cycle');
  });

  test('a held cycle is named', () => {
    renderCard();
    expect(screen.getByTestId('fo-sbir-cycle')).toHaveTextContent('DoD-SBIR-26.A · 26.A');
  });

  test('the two absences are never the same sentence', () => {
    // A fact about the SOURCE and a fact about CAPIRO'S SYNC send a reader to
    // two different places.
    const noneStated = describeSbirCycle({ solicitationNumber: null }, null);
    const notHeld = describeSbirCycle({ solicitationNumber: 'DoD-SBIR-99.Z' }, null);
    expect(noneStated).not.toBe(notHeld);
    expect(noneStated).toMatch(/source states no/i);
    expect(notHeld).toMatch(/Capiro does not hold/i);
  });
});

describe('deadlines and unknowns', () => {
  test('a null close date says the source stated none, never a blank or a dash', () => {
    renderCard({ facts: topic({ closeDate: null, openDate: null }) });
    expect(screen.getByTestId('fo-sbir-closes')).toHaveTextContent('Not stated by the source');
    expect(screen.getByTestId('fo-sbir-opens')).toHaveTextContent('Not stated by the source');
  });

  test('an unscored topic says so, while a genuine zero still renders 0', () => {
    renderCard({ relevanceScore: null });
    expect(screen.getByTestId('fo-sbir-relevance')).toHaveTextContent('Not scored yet');
    cleanup();
    renderCard({ relevanceScore: 0 });
    expect(screen.getByTestId('fo-sbir-relevance')).toHaveTextContent('0');
  });

  test('a missing topic number and agency each say so rather than rendering blank', () => {
    renderCard({ facts: topic({ topicNumber: null, agency: null }) });
    const identity = screen.getByTestId('fo-sbir-identity');
    expect(identity).toHaveTextContent('No topic number stated');
    expect(identity).toHaveTextContent('No agency stated');
  });
});

describe('eligibility is rendered verbatim, never summarised', () => {
  test('the whole reason appears, including the certification caveat', () => {
    renderCard();
    const eligibility = screen.getByTestId('fo-sbir-eligibility');
    expect(eligibility).toHaveTextContent('US ownership');
    expect(eligibility).toHaveTextContent('research-institution partner');
    // The part a summary would drop.
    expect(eligibility).toHaveTextContent('not the same question as the SBIR size standard');
  });

  test('the card never claims the client IS eligible', () => {
    renderCard();
    expect(document.body.textContent ?? '').not.toMatch(/\beligible\b/i);
  });
});

describe('a closed topic offers nothing', () => {
  test('an empty action list renders no action row at all', () => {
    // P43's acceptance. Absent rather than disabled: a disabled control that
    // never enables is a promise the surface does not keep.
    renderCard({ actions: [], facts: topic({ solicitationStatus: 'Closed' }) });
    expect(screen.queryByTestId('fo-sbir-actions')).not.toBeInTheDocument();
  });

  test('with no handler the actions are not rendered as controls either', () => {
    renderCard({ onAction: undefined });
    expect(screen.queryByTestId('fo-sbir-actions')).not.toBeInTheDocument();
  });

  test('no action is ever labelled Submit — the response goes through DSIP', () => {
    renderCard({
      actions: [
        'assess_fit',
        'confirm_small_business_and_partner_requirements',
        'contact_program_office',
        'prepare_white_paper',
      ],
    });
    const actions = screen.getByTestId('fo-sbir-actions');
    expect(actions).toHaveTextContent('Assess fit');
    expect(actions).toHaveTextContent('Prepare a white paper');
    expect(actions.textContent ?? '').not.toMatch(/submit/i);
  });

  test('the provider status renders verbatim rather than being rewritten', () => {
    renderCard({ facts: topic({ solicitationStatus: 'Closing Soon' }) });
    expect(screen.getByTestId('fo-sbir-status')).toHaveTextContent('Closing Soon');
  });
});
