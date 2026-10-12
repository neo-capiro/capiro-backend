import {
  defaultNewsletterSocialShare,
  type NewsletterBlock,
  type NewsletterSocialSharePlatform,
} from './newsletter.js';

/** Sharing never uses recipient archive/subscription capabilities or merge tags. */
export function newsletterSocialShareTarget(value: string): string {
  if (value.length > 4000 || /[\x00-\x1f\x7f]|\*\|/.test(value)) return '';
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    // The existing newsletter public routes carry recipient action capabilities.
    // Custom sharing must never export one of those routes to another service.
    const path = decodeURIComponent(url.pathname);
    if (/\/engagement\/newsletter-public(?:\/|$)/i.test(path)) return '';
    return url.href;
  } catch {
    return '';
  }
}

export function newsletterSocialShareUrl(
  platform: NewsletterSocialSharePlatform,
  target: string,
): string {
  const safe = newsletterSocialShareTarget(target);
  if (!safe) return '';
  const value = encodeURIComponent(safe);
  switch (platform) {
    case 'facebook':
      return `https://www.facebook.com/sharer/sharer.php?u=${value}`;
    case 'linkedin':
      return `https://www.linkedin.com/sharing/share-offsite/?url=${value}`;
    case 'pinterest':
      return `https://pinterest.com/pin/create/button/?url=${value}&media=Newsletter`;
    case 'twitter':
      return `https://twitter.com/intent/tweet?text=Newsletter:%20${value}`;
    case 'instapaper':
      return `https://www.instapaper.com/hello2?url=${value}&title=Newsletter`;
    // Forward to a friend requires its own read-only forwarding flow.
    case 'forward':
      return '';
    default:
      return '';
  }
}

export function newsletterSocialShareItems(block: NewsletterBlock) {
  const share = block.social?.share || defaultNewsletterSocialShare();
  const target = share.source === 'custom' ? share.customUrl : '';
  return share.items.map((item) => ({
    ...item,
    url: newsletterSocialShareUrl(item.platform, target),
  }));
}
