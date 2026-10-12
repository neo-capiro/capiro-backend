import { createNewsletterBlock, type NewsletterStage } from '@capiro/shared/newsletter';
import { newsletterSocialShareUrl } from '@capiro/shared/newsletter-render';
createNewsletterBlock('invented-kind');
const stage: NewsletterStage = { id: 123, documentId: 'd', revision: 1, name: 'n', createdAt: 'now', route: '/' };
newsletterSocialShareUrl('invented-platform', 'https://example.test');
export { stage };
