import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  OUTREACH_FORMAT_PREVIEW_EMPTY_NOTE,
  OutreachFormatPreview,
} from './outreach-format-preview.js';
import { OUTREACH_EMAIL_FORMATS, outreachEmailFormatById } from './outreach-campaign-flow.js';
import { OUTREACH_TABLE_FORMAT_EMPTY_NOTE } from './outreach-email-format-preview.js';

/**
 * The preview's whole contract is that it invents nothing: every heading, fact,
 * row and closing line below has to be traceable to the letter passed in. So
 * these tests assert the letter's own words appear, AND that nothing appears
 * for a letter that does not carry it (no fact strip, no note column, no
 * footnote, no closing line).
 */
const SUBJECT = 'Week ahead — hearings & markups · 6 on your watch';

const BODY = [
  'Bottom line',
  'Six sessions in the next seven days touch watched defense equities.',
  '',
  'HOUSE',
  'Mon Aug 25 · 10:00 ET · HASC Tactical Air & Land',
  'Hearing: FY2027 aviation sustainment',
  '- Open packets for Mon HASC',
  '',
  '—',
  'Source: Capiro hearings feed',
  'Not a media clip service.',
].join('\n');

function renderPreview(formatId: string, over: { subject?: string; body?: string } = {}) {
  return render(
    <OutreachFormatPreview
      format={outreachEmailFormatById(formatId)}
      subject={over.subject ?? SUBJECT}
      body={over.body ?? BODY}
      kicker="Send update · Capiro · firm"
    />,
  );
}

describe('OutreachFormatPreview', () => {
  it('shows the letter unparsed in the standard-email format', () => {
    const { container } = renderPreview('standard');
    expect(screen.getByText(SUBJECT)).toBeInTheDocument();
    expect(screen.getByText('Send update · Capiro · firm')).toBeInTheDocument();
    // The raw letter, newlines and the em-dash rule intact — this is the only
    // format that does not tokenize.
    const body = container.querySelector('.ofpv__plain-body');
    expect(body?.textContent).toBe(BODY);
  });

  it('lays the same words out as a briefing card with a fact strip from the subject', () => {
    const { container } = renderPreview('briefing_card');
    expect(screen.getByText('Capiro briefing')).toBeInTheDocument();
    // Upper-case short lines become section rules; bullets lose their marker.
    expect(container.querySelector('.ofpv__block-head')?.textContent).toBe('HOUSE');
    expect(screen.getByText('Open packets for Mon HASC')).toBeInTheDocument();
    // The one figure the subject states, label above value.
    expect(screen.getByText('on your watch')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
    // Small print after the em-dash rule is not body copy.
    expect(screen.queryByText(/Not a media clip service/)).not.toBeInTheDocument();
  });

  it('hides the fact strip for a subject that states no figures', () => {
    const { container } = renderPreview('briefing_card', {
      subject: 'Official record · defense · week of Aug 18–22',
    });
    expect(container.querySelector('.ofpv__facts')).toBeNull();
  });

  it('builds status-table rows, the closing line and the source footnote', () => {
    const { container } = renderPreview('status_table');
    expect(screen.getByText('Item')).toBeInTheDocument();
    expect(screen.getByText('Detail')).toBeInTheDocument();
    expect(screen.getByText('Note')).toBeInTheDocument();
    const rows = container.querySelectorAll('.ofpv__trow');
    expect(rows.length).toBe(1);
    const row = rows[0] as HTMLElement;
    expect(within(row).getByText('Mon Aug 25')).toBeInTheDocument();
    expect(within(row).getByText('10:00 ET')).toBeInTheDocument();
    expect(within(row).getByText('HASC Tactical Air & Land')).toBeInTheDocument();
    expect(container.querySelector('.ofpv__close')?.textContent).toBe(
      'Six sessions in the next seven days touch watched defense equities.',
    );
    // Multiple source lines join with a single space, as the prototype does.
    expect(container.querySelector('.ofpv__foot')?.textContent).toBe(
      'Source: Capiro hearings feed Not a media clip service.',
    );
  });

  it('states plainly when a letter has no tabular rows instead of showing an empty table', () => {
    const { container } = renderPreview('status_table', {
      body: 'Dear staff,\nWe would value fifteen minutes on aviation sustainment.',
    });
    expect(screen.getByText(OUTREACH_TABLE_FORMAT_EMPTY_NOTE)).toBeInTheDocument();
    expect(container.querySelectorAll('.ofpv__trow').length).toBe(0);
    // No row carries a third field, so the Note column is not offered at all.
    expect(screen.queryByText('Note')).not.toBeInTheDocument();
  });

  it('groups the letter under its own headings in the timeline format', () => {
    const { container } = renderPreview('timeline');
    const heads = [...container.querySelectorAll('.ofpv__section-head')].map((n) => n.textContent);
    expect(heads).toEqual(['HOUSE']);
    // The leading section before the first heading renders with no head.
    expect(container.querySelectorAll('.ofpv__section').length).toBe(2);
    // Neither the closing line nor the footnote belongs to this format.
    expect(container.querySelector('.ofpv__close')).toBeNull();
    expect(container.querySelector('.ofpv__foot')).toBeNull();
  });

  it.each(OUTREACH_EMAIL_FORMATS.map((format) => format.id))(
    'says there is no letter yet rather than inventing one (%s)',
    (id) => {
      renderPreview(id, { body: '' });
      expect(screen.getByText(OUTREACH_FORMAT_PREVIEW_EMPTY_NOTE)).toBeInTheDocument();
      expect(screen.queryByText('Capiro briefing')).not.toBeInTheDocument();
      expect(screen.queryByText('Item')).not.toBeInTheDocument();
    },
  );
});
