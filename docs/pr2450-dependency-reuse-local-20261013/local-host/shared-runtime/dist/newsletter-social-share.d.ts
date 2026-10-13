import { type NewsletterBlock, type NewsletterSocialSharePlatform } from './newsletter.js';
/** Sharing never uses recipient archive/subscription capabilities or merge tags. */
export declare function newsletterSocialShareTarget(value: string): string;
export declare function newsletterSocialShareUrl(platform: NewsletterSocialSharePlatform, target: string): string;
export declare function newsletterSocialShareItems(block: NewsletterBlock): {
    url: string;
    platform: NewsletterSocialSharePlatform;
    label: string;
}[];
//# sourceMappingURL=newsletter-social-share.d.ts.map