import { createNewsletterBlock, defaultNewsletterConfig, defaultNewsletterStyles, NEWSLETTER_TEMPLATE_ID, NEWSLETTER_FONT_CATALOG } from '@capiro/shared/newsletter';
import { renderNewsletterBlock, newsletterSocialShareTarget } from '@capiro/shared/newsletter-render';
export function run() {
  const html = renderNewsletterBlock(createNewsletterBlock('paragraph', { id: 'browser', html: '<b>Browser</b>' }), { version: 1, styles: defaultNewsletterStyles(), sections: [] }, defaultNewsletterConfig());
  return { template: NEWSLETTER_TEMPLATE_ID, escaped: html.includes('&lt;b&gt;Browser&lt;/b&gt;'), refusedPublicCapability: newsletterSocialShareTarget('https://example.com/engagement/newsletter-public/token') === '', fontCount: NEWSLETTER_FONT_CATALOG.length };
}
