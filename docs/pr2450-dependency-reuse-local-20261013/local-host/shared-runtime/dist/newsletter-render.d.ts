import { type NewsletterSocialDevice, type NewsletterBlock, type NewsletterCampaignConfig, type NewsletterDesign, type NewsletterRecipient, type NewsletterStyle, type NewsletterFont } from './newsletter.js';
export { newsletterSocialShareTarget, newsletterSocialShareUrl, newsletterSocialShareItems, } from './newsletter-social-share.js';
export interface NewsletterRenderOptions {
    recipient?: NewsletterRecipient;
    liveMergeTags?: boolean;
    publicUrl?: string;
    archiveUrl?: string;
    unsubscribeUrl?: string;
    preferencesUrl?: string;
    sanitizeHtml?: (html: string) => string;
    rewriteLink?: (url: string, blockId: string) => string;
    surveyUrl?: (blockId: string, answer: string) => string;
    savedSurveyUrl?: (blockId: string) => string;
    editor?: boolean;
}
export declare function newsletterFontCss(fonts: NewsletterFont[]): string;
export declare function newsletterEscape(value: unknown): string;
export declare function newsletterSafeUrl(raw: string, allowImage?: boolean): string;
export declare function newsletterStyleCss(style: NewsletterStyle): string;
export declare function newsletterBundledImageUrl(url: string): string;
export declare function newsletterMergeText(value: string, config: NewsletterCampaignConfig, options?: NewsletterRenderOptions): string;
export declare function newsletterSocialIconSize(size: NewsletterSocialDevice['size']): 32 | 40 | 24;
export declare function renderNewsletterBlock(block: NewsletterBlock, design: NewsletterDesign, config: NewsletterCampaignConfig, options?: NewsletterRenderOptions): string;
export declare function renderNewsletterDesign(design: NewsletterDesign, config: NewsletterCampaignConfig, options?: NewsletterRenderOptions): string;
export declare function newsletterPlainText(design: NewsletterDesign, config: NewsletterCampaignConfig, options?: NewsletterRenderOptions): string;
//# sourceMappingURL=newsletter-render.d.ts.map