import {
  parseNewsletterPreview,
  type NewsletterPreview,
  type NewsletterPreviewContent,
  type NewsletterReceiveResult,
} from '../../packages/shared/src/newsletter.js';

declare const wire: unknown;
declare const documentId: string;

const pinned: NewsletterReceiveResult<NewsletterPreview> = parseNewsletterPreview(wire, {
  documentId,
  revision: 3,
});
if (pinned.ok) {
  const format: 'newsletter-render-json-v1' = pinned.value.hashFormat;
  void format;
}

const unbound = parseNewsletterPreview(wire);
if (unbound.ok) {
  const content: NewsletterPreviewContent = unbound.value;
  // @ts-expect-error Content received without an expected identity cannot claim a pinned receipt.
  const receipt: NewsletterPreview = unbound.value;
  void content;
  void receipt;
}

// @ts-expect-error A consumer must bind both document and saved revision.
parseNewsletterPreview(wire, { documentId });
// @ts-expect-error A revision alone cannot bind a document.
parseNewsletterPreview(wire, { revision: 3 });
