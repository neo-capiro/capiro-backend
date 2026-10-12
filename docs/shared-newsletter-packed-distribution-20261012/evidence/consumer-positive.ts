import {
  createNewsletterBlock, defaultNewsletterConfig, defaultNewsletterStyles,
  type NewsletterDesign, type NewsletterStage, type NewsletterRecipient,
} from '@capiro/shared/newsletter';
import {
  renderNewsletterDesign, newsletterPlainText, newsletterSocialShareUrl,
  type NewsletterRenderOptions,
} from '@capiro/shared/newsletter-render';

const design: NewsletterDesign = {
  version: 1, styles: defaultNewsletterStyles(),
  sections: [{ id: 's', name: 'Synthetic', style: {}, blocks: [createNewsletterBlock('paragraph')] }],
};
const stage: NewsletterStage = { id: 'stage-id', documentId: 'rich-document-id', revision: 2,
  name: 'Synthetic', createdAt: '2026-10-12T12:00:00.000Z', route: '/workspace/newsletter' };
const recipient: NewsletterRecipient = { id: 'recipient-id', email: 'example@example.test',
  firstName: 'Example', lastName: '', company: '', phone: '', address: '', birthday: '',
  client: '', tags: [], subscribed: true };
const options: NewsletterRenderOptions = { recipient, liveMergeTags: true, sanitizeHtml: html => html,
  rewriteLink: (url, blockId) => `${url}#${blockId}`,
  surveyUrl: (blockId, answer) => `https://example.test/${blockId}/${answer}` };
const html: string = renderNewsletterDesign(design, defaultNewsletterConfig(), options);
const text: string = newsletterPlainText(design, defaultNewsletterConfig(), options);
const share: string = newsletterSocialShareUrl('linkedin', 'https://example.test/public');
export { design, stage, html, text, share };
