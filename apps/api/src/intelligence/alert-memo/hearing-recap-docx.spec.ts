import JSZip from 'jszip';
import {
  markdownToHearingRecapDocInput,
  renderHearingRecapDocx,
} from './hearing-recap-docx.js';

/** Unzip the generated DOCX and return the main document body XML. */
async function documentXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  return zip.file('word/document.xml')!.async('string');
}

const NARRATIVE = `# Hearing recap — Water, Wildlife and Fisheries

_Generated 9/16/2026, 5:33:03 PM · Meri synthesis_
_Prepared for Anduril · client priorities applied_
[Open the hearing room & transcript](/intelligence/hearing-watch/session-1)

## Executive summary

The subcommittee advanced three water bills with broad support.

## Key developments

### Golden mussel eradication funding

Witnesses pressed for dedicated eradication funding.

_Cited at 2:05 · 4:12_

### Tribal water settlements

The Agua Caliente settlement drew questions on implementation cost.

## Recommended next steps

- Track HR 3717 markup.
- Brief the client on settlement timelines.

## Sources & coverage

_Synthesis based on all 138 captured transcript segments (0:15–11:16 of the available recording)._
`;

describe('hearing-recap-docx — narrative rendering', () => {
  it('renders headings and narrative text with NO raw Markdown tokens or opaque ids', async () => {
    const input = markdownToHearingRecapDocInput(
      NARRATIVE,
      'Anduril',
      'Hearing recap — Water, Wildlife and Fisheries',
      { hearingTitle: 'Water, Wildlife and Fisheries Subcommittee legislative hearing' },
    );
    const xml = await documentXml(await renderHearingRecapDocx(input));

    // New narrative content is present as real text.
    expect(xml).toContain('Executive summary');
    expect(xml).toContain('Key developments');
    expect(xml).toContain('Golden mussel eradication funding');
    expect(xml).toContain('Tribal water settlements');
    expect(xml).toContain('Track HR 3717 markup.');
    // Readable timestamp citations survive.
    expect(xml).toContain('Cited at 2:05');
    // Honest coverage note survives.
    expect(xml).toContain('available recording');

    // Provenance/generated meta lines render as clean italic text — no leading
    // or trailing Markdown underscores left in the Word body.
    expect(xml).not.toContain('_Generated');
    expect(xml).not.toContain('synthesis_');
    expect(xml).not.toContain('_Prepared');
    expect(xml).not.toContain('applied_');
    expect(xml).toContain('Prepared for Anduril');

    // No raw Markdown structure leaked into the Word body.
    expect(xml).not.toContain('##');
    expect(xml).not.toContain('###');
    expect(xml).not.toContain('**');
    expect(xml).not.toContain('[segment:');
    expect(xml).not.toContain('[claim-');
    expect(xml).not.toContain('Source anchors');
  });

  it('defangs Markdown special characters in model text instead of rendering them', async () => {
    const md = `# Recap\n\n## Executive summary\n\n**Not bold** and a [tricky](https://x.example) link plus _emph_.`;
    const input = markdownToHearingRecapDocInput(md, 'Client', 'Recap');
    const xml = await documentXml(await renderHearingRecapDocx(input));
    // plain() strips emphasis so no literal ** or _ reaches the body.
    expect(xml).not.toContain('**');
    expect(xml).toContain('Not bold');
    // No hyperlink relationship is created from model text.
    expect(xml).not.toContain('https://x.example');
  });

  it('carries the concise title and keeps the formal hearing title as provenance', async () => {
    const input = markdownToHearingRecapDocInput('# Short\n\nBody.', 'Anduril', 'Short', {
      hearingTitle: 'A very long formal hearing title that was clipped',
    });
    const xml = await documentXml(await renderHearingRecapDocx(input));
    expect(xml).toContain('Short');
    expect(xml).toContain('HEARING:');
    expect(xml).toContain('A very long formal hearing title that was clipped');
  });

  it('produces a valid docx package with a document body', async () => {
    const input = markdownToHearingRecapDocInput(NARRATIVE, 'Anduril', 'Recap');
    const buffer = await renderHearingRecapDocx(input);
    expect(Buffer.isBuffer(buffer)).toBe(true);
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file('word/document.xml')).toBeTruthy();
  });
});
