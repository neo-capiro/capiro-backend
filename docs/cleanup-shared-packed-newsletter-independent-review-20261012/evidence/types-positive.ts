import { createNewsletterBlock, defaultNewsletterConfig, defaultNewsletterStyles, type NewsletterDesign, type NewsletterStage, type NewsletterBlockKind, type NewsletterSocialSharePlatform } from '@capiro/shared/newsletter';
import { renderNewsletterDesign, type NewsletterRenderOptions } from '@capiro/shared/newsletter-render';
const kind: NewsletterBlockKind = 'paragraph';
const platform: NewsletterSocialSharePlatform = 'linkedin';
const stage: NewsletterStage = { id: 'rich-stage-id', documentId: 'doc-id', revision: 4, name: 'Synthetic', createdAt: '2026-10-12T00:00:00Z', route: '/stage' };
const design: NewsletterDesign = { version: 1, styles: defaultNewsletterStyles(), sections: [{ id: 'section', name: 'Body', style: {}, blocks: [createNewsletterBlock(kind, { id: 'node-id' })] }] };
const options: NewsletterRenderOptions = { sanitizeHtml: (html: string) => html, rewriteLink: (url: string, blockId: string) => url + '#' + blockId };
const output: string = renderNewsletterDesign(design, defaultNewsletterConfig(), options);
void [output, stage, platform];
