import { createNewsletterBlock, type NewsletterStage } from '@capiro/shared/newsletter';
import { newsletterSocialShareUrl } from '@capiro/shared/newsletter-render';
createNewsletterBlock('invented-kind');
const stage: NewsletterStage = { id: 123, documentId: 'd', revision: 1, name: 'n', createdAt: 'now', route: '/' };
newsletterSocialShareUrl('invented-platform', 'https://example.test');
export { stage };

import {parseNewsletterOutreachStage,type NewsletterReceiveIdentity,type NewsletterPreview} from '@capiro/shared/newsletter';
const invalidIdentity:NewsletterReceiveIdentity={revision:'wrong'};
const invalidPreview:NewsletterPreview={html:123,plainText:'',checks:[]};
parseNewsletterOutreachStage({}, {recordId:'not-a-stage-binding'});
export {invalidIdentity,invalidPreview};
