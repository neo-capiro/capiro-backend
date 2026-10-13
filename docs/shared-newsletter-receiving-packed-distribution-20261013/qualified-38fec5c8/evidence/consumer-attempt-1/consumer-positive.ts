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

import {
  parseNewsletterCampaign, parseNewsletterDocumentList, parseNewsletterPreview,
  parseNewsletterChecks, parseNewsletterHtmlCheck, parseNewsletterStageReceipt,
  parseNewsletterOutreachStage, parseNewsletterOutreachRecord, parseNewsletterReservedMetadata,
  parseNewsletterRecordDiscriminator, NEWSLETTER_RECEIVE_LIMITS,
  type NewsletterReceiveResult, type NewsletterCampaign, type NewsletterDocumentList,
  type NewsletterPreview, type NewsletterCheck, type NewsletterHtmlCheck, type NewsletterOutreachStage,
  type NewsletterOutreachRecord, type NewsletterReservedMetadata, type NewsletterRecordDiscriminator,
  type NewsletterReceiveIdentity, type DraftGenerationStatus, type DraftAuditStatus, type DraftApprovalStatus,
} from '@capiro/shared/newsletter';
declare const wire: unknown;
const identity: NewsletterReceiveIdentity = { revision:4, clientId:null };
const campaign: NewsletterReceiveResult<NewsletterCampaign> = parseNewsletterCampaign(wire,identity);
const list: NewsletterReceiveResult<NewsletterDocumentList> = parseNewsletterDocumentList(wire);
const preview: NewsletterReceiveResult<NewsletterPreview> = parseNewsletterPreview(wire);
const checks: NewsletterReceiveResult<NewsletterCheck[]> = parseNewsletterChecks(wire);
const htmlCheck: NewsletterReceiveResult<NewsletterHtmlCheck> = parseNewsletterHtmlCheck(wire,{revision:4});
const receipt: NewsletterReceiveResult<NewsletterStage> = parseNewsletterStageReceipt(wire,{revision:4});
const richStage: NewsletterReceiveResult<NewsletterOutreachStage> = parseNewsletterOutreachStage(wire,{revision:4});
const richRecord: NewsletterReceiveResult<NewsletterOutreachRecord> = parseNewsletterOutreachRecord(wire,identity);
const reserved: NewsletterReceiveResult<NewsletterReservedMetadata> = parseNewsletterReservedMetadata(wire);
const discriminator: NewsletterReceiveResult<NewsletterRecordDiscriminator> = parseNewsletterRecordDiscriminator(wire);
const generation: DraftGenerationStatus='generated';const audit:DraftAuditStatus='held';const approval:DraftApprovalStatus='pending';
if(campaign.ok){const subject:string=campaign.value.config.subject;void subject;}else{const path:string=campaign.error.path;void path;}
export {campaign,list,preview,checks,htmlCheck,receipt,richStage,richRecord,reserved,discriminator,generation,audit,approval,NEWSLETTER_RECEIVE_LIMITS};
