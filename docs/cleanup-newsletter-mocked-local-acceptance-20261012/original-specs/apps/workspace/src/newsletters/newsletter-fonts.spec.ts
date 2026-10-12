import {
  createNewsletterBlock,
  defaultNewsletterConfig,
  governmentAffairsNewsletter,
  newsletterDesignFontRequests,
  newsletterWebFontUrls,
} from '@capiro/shared/newsletter';
import { newsletterStyleCss, renderNewsletterDesign } from '@capiro/shared/newsletter-render';
import {
  sanitizeNewsletterHtml,
  validateNewsletterDesign,
  validateNewsletterStyle,
} from './newsletter-validation.js';
describe('newsletter catalog typography', () => {
  it('retains a named weight/italic variant in validated designs and exported HTML', () => {
    const design = governmentAffairsNewsletter();
    design.sections[0]!.blocks = [
      createNewsletterBlock('heading', {
        style: { fontFamily: 'Open Sans Semi Bold Italic', fontWeight: 600, italic: true },
      }),
    ];
    const validated = validateNewsletterDesign(design);
    const html = renderNewsletterDesign(validated, defaultNewsletterConfig());
    expect(html).toContain("font-family:'Open Sans', Arial, sans-serif");
    expect(html).toContain('font-weight:600;font-style:italic');
    expect(html).toContain(
      'https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@1,600&amp;display=swap',
    );
    expect(() => validateNewsletterStyle({ fontWeight: 600.5 })).toThrow();
    expect(() => validateNewsletterStyle({ fontWeight: 1000 })).toThrow();
  });
  it('requests only catalog faces and sorts and deduplicates requested variants', () => {
    const urls = newsletterWebFontUrls([
      { value: 'Open Sans Bold Italic' },
      { value: 'Open Sans' },
      { value: 'Open Sans Semi Bold' },
      { value: 'Open Sans Bold Italic' },
      { value: 'Arial' },
      { value: 'https://untrusted.example/font' },
      { value: "x';}bad{" },
    ]);
    expect(urls).toEqual([
      'https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400;0,600;1,700&display=swap',
    ]);
    expect(
      newsletterStyleCss({ fontFamily: 'Open Sans Light', fontWeight: 300, bold: true }),
    ).toContain('font-weight:300');
  });
  it('loads inline rich text typography after a safe round trip without placing client text in a font request', () => {
    const design = governmentAffairsNewsletter();
    const text = sanitizeNewsletterHtml(
      '<p><span style="font-family: &quot;Open Sans&quot;, Arial, sans-serif;font-weight:600;font-style:italic">Private client briefing</span></p>',
    );
    expect(text).toContain('font-family:');
    design.sections[0]!.blocks = [createNewsletterBlock('paragraph', { html: text })];
    const urls = newsletterWebFontUrls(newsletterDesignFontRequests(design));
    expect(urls).toEqual([
      'https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@1,600&display=swap',
    ]);
    expect(urls.join('')).not.toContain('Private');
  });
});
