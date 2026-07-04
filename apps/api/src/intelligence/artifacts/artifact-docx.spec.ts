import { renderArtifactDocx } from './artifact-docx.js';

/**
 * The renderer is pure (no network, no DB). We assert it produces a real .docx
 * (a ZIP — the OOXML container — whose bytes start with the `PK` local-file
 * header) and that it never throws on the bounded markdown the generator emits,
 * including thin/empty bodies.
 */
describe('renderArtifactDocx', () => {
  const SAMPLE = [
    '# Internal Brief: FY27 mark on PE 0603270A',
    '',
    'The HASC added **$42.0M** over the request for PE 0603270A [c1].',
    '',
    '## Sources',
    '',
    '- c1: HASC FY2027 markup, p.214',
    '',
    '## Caveats',
    '',
    'Conference has not yet reconciled the House and Senate positions.',
    '',
  ].join('\n');

  it('renders a valid .docx (ZIP) buffer from a full artifact body', async () => {
    const buf = await renderArtifactDocx({
      title: 'Internal Brief: FY27 mark on PE 0603270A',
      bodyText: SAMPLE,
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
    // OOXML .docx is a ZIP: first two bytes are 'P','K' (0x50, 0x4B).
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });

  it('does not throw on an empty body or a missing title', async () => {
    await expect(renderArtifactDocx({ title: '', bodyText: '' })).resolves.toBeInstanceOf(Buffer);
  });

  it('does not throw on a body with only prose (no sections)', async () => {
    const buf = await renderArtifactDocx({
      title: 'Talking Points',
      bodyText: 'Point one about the program.\n\nPoint two about funding.',
    });
    expect(buf.length).toBeGreaterThan(0);
  });
});
