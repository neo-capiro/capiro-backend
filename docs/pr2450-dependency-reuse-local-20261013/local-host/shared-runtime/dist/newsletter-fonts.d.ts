import type { NewsletterDesign } from './newsletter.js';
export interface NewsletterCatalogFont {
    label: string;
    family: string;
    weight: number;
    italic: boolean;
}
/** The two default Brand Kit selections are retained alongside the rendered catalog. */
export declare const NEWSLETTER_FONT_CATALOG: readonly NewsletterCatalogFont[];
export declare function newsletterCatalogFont(value: string): NewsletterCatalogFont | undefined;
export declare function newsletterCatalogStyle(value: string): {
    fontFamily: string;
    fontWeight: number;
    fontStyle: 'normal' | 'italic';
} | undefined;
export interface NewsletterFontRequest {
    value: string;
    bold?: boolean;
    italic?: boolean;
    weight?: number;
}
/** Only known catalog families are sent to a fixed public stylesheet origin. */
export declare function newsletterWebFontUrls(requests: readonly NewsletterFontRequest[]): string[];
/** Extract font settings, including inline rich text, without exposing message text. */
export declare function newsletterDesignFontRequests(design: NewsletterDesign): NewsletterFontRequest[];
//# sourceMappingURL=newsletter-fonts.d.ts.map