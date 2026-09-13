import { PDFDocument } from 'pdf-lib';
import { meetingPrepPdfSections, renderMeetingPrepPdf } from './meeting-prep-pdf.js';
import { MEETING_BRIEFING_SECTIONS } from './meeting-prep-policy.js';

const legacy = {
  summary: 'Meet Mia to settle the implementation timeline.',
  agenda: ['Logistics', 'Open questions'],
  talkingPoints: ['We owe the timeline by Friday.'],
  risks: [],
  followUps: ['Send the timeline.'],
  emailEvidence: ['Sep 1 — Mia asked for a timeline.'],
};

describe('meeting prep PDF', () => {
  test('uses the seven-section briefing when one exists and was not edited, without sources', () => {
    const briefing = {
      version: 2,
      takeaways: [{ text: 'The client is waiting on our timeline.', factIds: [] }],
      sections: Object.fromEntries(
        MEETING_BRIEFING_SECTIONS.map((key) => [
          key,
          key === 'commitments'
            ? { status: 'evidence_found', items: [{ text: 'Send the timeline.', factIds: [] }], gap: '' }
            : { status: 'no_evidence', items: [], gap: 'No evidence was found in the searched scope.' },
        ]),
      ),
      facts: [],
      limitations: [],
    };
    const sections = meetingPrepPdfSections({
      ...legacy,
      generatedFrom: { briefing, grounding: { contentEdited: false, sources: [{ title: 'SECRET SOURCE' }] } },
    });
    expect(sections[0]).toEqual({ heading: 'Key takeaways', items: ['The client is waiting on our timeline.'] });
    expect(sections).toHaveLength(1 + MEETING_BRIEFING_SECTIONS.length);
    expect(sections.find((section) => section.heading === 'What we committed to doing')?.items).toEqual(['Send the timeline.']);
    expect(JSON.stringify(sections)).not.toContain('SECRET SOURCE');
  });

  test('falls back to the saved fields once the text has been edited', () => {
    const sections = meetingPrepPdfSections({
      ...legacy,
      generatedFrom: { briefing: { version: 2 }, grounding: { contentEdited: true } },
    });
    expect(sections.map((section) => section.heading)).toEqual([
      'Summary', 'Agenda', 'Talking Points', 'Watch-outs', 'Follow-ups', 'Email evidence',
    ]);
    expect(sections[2]).toMatchObject({ ordered: true, items: ['We owe the timeline by Friday.'] });
  });

  test('renders a titled, paginated PDF and survives characters the standard fonts cannot encode', async () => {
    const long = Array.from({ length: 120 }, (_, i) => `Point ${i + 1}: a sentence long enough to wrap onto a second line of the page \u{1F600} — “quoted”.`);
    const buffer = await renderMeetingPrepPdf({
      title: 'Prep - Capiro Walkthrough',
      subtitle: 'Tue, Sep 8, 3:00 PM',
      sections: [
        { heading: 'Summary', body: 'A short paragraph with an em dash — and an ellipsis…' },
        { heading: 'Talking Points', items: long, ordered: true },
        { heading: 'Empty', items: [], body: '' },
      ],
    });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    const pdf = await PDFDocument.load(buffer);
    expect(pdf.getTitle()).toBe('Prep - Capiro Walkthrough');
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });
});
