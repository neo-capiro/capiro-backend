export declare const NEWSLETTER_TEMPLATE_ID = "bp_weekly_newsletter";
export declare const NEWSLETTER_BLOCK_KINDS: readonly ["image", "heading", "paragraph", "button", "divider", "spacer", "video", "social", "logo", "survey", "code", "apps", "product", "product-rec", "footer", "columns"];
export type NewsletterBlockKind = (typeof NEWSLETTER_BLOCK_KINDS)[number];
export declare const NEWSLETTER_BLOCK_LABELS: Record<NewsletterBlockKind, string>;
export declare const NEWSLETTER_COLUMN_RATIOS: readonly ["1", "2", "3", "4", "1:2", "2:1", "1:3", "3:1"];
export type NewsletterVisibilityField = 'email' | 'firstName' | 'lastName' | 'company' | 'phone' | 'address' | 'birthday' | 'client' | 'tags';
export interface NewsletterRule {
    field: NewsletterVisibilityField;
    operator: 'is' | 'is-not' | 'contains' | 'does-not-contain' | 'is-empty' | 'is-not-empty';
    value: string;
}
export interface NewsletterStyle {
    background?: string;
    color?: string;
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: number;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    lineHeight?: number;
    letterSpacing?: number;
    paragraphSpacing?: number;
    direction?: 'ltr' | 'rtl';
    align?: 'left' | 'center' | 'right';
    paddingTop?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    paddingRight?: number;
    margin?: number;
    borderStyle?: 'none' | 'solid' | 'dashed' | 'dotted' | 'double' | 'inset' | 'outset' | 'groove' | 'ridge';
    borderColor?: string;
    borderWidth?: number;
    radius?: number;
    radiusTopLeft?: number;
    radiusTopRight?: number;
    radiusBottomRight?: number;
    radiusBottomLeft?: number;
    width?: number;
    height?: number;
}
export interface NewsletterLink {
    label: string;
    url: string;
    imageUrl?: string;
    price?: string;
    description?: string;
    platform?: NewsletterSocialPlatform;
}
export declare const NEWSLETTER_SOCIAL_PLATFORMS: readonly [readonly ["instagram", "Instagram", "https://instagram.com/"], readonly ["facebook", "Facebook", "https://facebook.com/"], readonly ["twitter", "X (formerly Twitter)", "https://x.com/"], readonly ["tiktok", "TikTok", "https://www.tiktok.com/"], readonly ["youtube", "YouTube", "https://www.youtube.com/"], readonly ["website", "Website", "https://"], readonly ["email", "Email", "mailto:"], readonly ["pinterest", "Pinterest", "https://www.pinterest.com/"], readonly ["whatsapp", "WhatsApp", "https://wa.me/"], readonly ["threads", "Threads", "https://www.threads.net/"], readonly ["bluesky", "Bluesky", "https://bsky.app/"], readonly ["linkedin", "LinkedIn", "https://www.linkedin.com/"], readonly ["patreon", "Patreon", "https://www.patreon.com/"], readonly ["discord", "Discord", "https://discord.gg/"], readonly ["snapchat", "Snapchat", "https://www.snapchat.com/"], readonly ["telegram", "Telegram", "https://t.me/"], readonly ["spotify", "Spotify", "https://open.spotify.com/"], readonly ["twitch", "Twitch", "https://www.twitch.tv/"], readonly ["reddit", "Reddit", "https://www.reddit.com/"]];
export type NewsletterSocialPlatform = (typeof NEWSLETTER_SOCIAL_PLATFORMS)[number][0];
export declare const NEWSLETTER_SOCIAL_SHARE_PLATFORMS: readonly [readonly ["forward", "Forward to a friend"], readonly ["facebook", "Facebook"], readonly ["linkedin", "LinkedIn"], readonly ["pinterest", "Pinterest"], readonly ["twitter", "X (formerly Twitter)"], readonly ["instapaper", "Instapaper"]];
export type NewsletterSocialSharePlatform = (typeof NEWSLETTER_SOCIAL_SHARE_PLATFORMS)[number][0];
export interface NewsletterSocialShare {
    source: 'campaign' | 'custom';
    customUrl: string;
    items: {
        platform: NewsletterSocialSharePlatform;
        label: string;
    }[];
}
export declare function defaultNewsletterSocialShare(): NewsletterSocialShare;
export declare const NEWSLETTER_SOCIAL_ICON_STYLES: readonly [readonly ["color", "Color Icons"], readonly ["dark", "Dark Icons"], readonly ["light", "Light Icons"], readonly ["gray", "Gray Icons"], readonly ["color-white", "Color with White Icons"], readonly ["dark-white", "Dark with White Icons"], readonly ["light-black", "Light with Black Icons"], readonly ["gray-black", "Gray with Black Icons"]];
export interface NewsletterSocialDevice {
    layout: 'horizontal' | 'vertical';
    size: 'small' | 'medium' | 'large';
    spacing: number;
}
export interface NewsletterSocialSettings {
    display: 'icon' | 'icon-text' | 'text';
    iconStyle: (typeof NEWSLETTER_SOCIAL_ICON_STYLES)[number][0];
    desktop: NewsletterSocialDevice;
    mobile: NewsletterSocialDevice;
    mode?: 'follow' | 'share';
    share?: NewsletterSocialShare;
    followDisplay?: NewsletterSocialSettings['display'];
    shareDisplay?: NewsletterSocialSettings['display'];
}
export interface NewsletterVideoSettings {
    thumbnail: 'auto' | 'custom';
    sourceUrl: string;
    paddingLinked?: boolean;
}
export declare const NEWSLETTER_SURVEY_SECTION_TYPES: readonly [readonly ["introduction", "Introduction"], readonly ["radio", "Radio Buttons"], readonly ["checkbox", "Checkboxes"], readonly ["range", "Range"], readonly ["text", "Open Text"], readonly ["email", "Email"], readonly ["contact", "Contact Information"], readonly ["content", "Content Block"]];
export type NewsletterSurveySectionType = (typeof NEWSLETTER_SURVEY_SECTION_TYPES)[number][0];
export interface NewsletterSurveyQuestion {
    id: string;
    type: NewsletterSurveySectionType;
    prompt: string;
    required: boolean;
    options: string[];
    other: boolean;
    range: {
        min: number;
        max: number;
        display: 'numbers' | 'stars' | 'emojis' | 'hearts';
    };
    contactField: 'firstName' | 'lastName' | 'age' | 'gender' | 'address';
    askToSubscribe: boolean;
    imageUrl: string;
    alt: string;
    videoUrl: string;
    /** Undefined preserves older combined introductions; null awaits an author choice. */
    introductionType?: 'text' | 'image' | 'video' | null;
}
export interface NewsletterSurveyDefinition {
    version: 1;
    questions: NewsletterSurveyQuestion[];
    title: string;
    description: string;
    logoUrl: string;
    submitLabel: string;
    confirmation: string;
    closedMessage: string;
    requiredMessage: string;
    background: string;
    buttonColor: string;
    buttonTextColor: string;
}
export interface NewsletterSavedSurvey {
    id: string;
    name: string;
    revision: number;
    status: 'draft';
    updatedAt: string;
    sourceClientIds: string[];
    definition: NewsletterSurveyDefinition;
}
export interface NewsletterSurveyButton {
    kind: 'saved-survey';
    saved: NewsletterSavedSurvey | null;
    blockBackground: string;
    paddingLinked: boolean;
}
export declare function createNewsletterSurveyQuestion(type: NewsletterSurveySectionType): NewsletterSurveyQuestion;
export declare function defaultNewsletterSurveyDefinition(): NewsletterSurveyDefinition;
/** Resolve only known video URL formats; provider markup is never embedded in email. */
export declare function newsletterVideoSource(value: string): {
    provider: 'youtube' | 'vimeo';
    url: string;
} | null;
export declare function newsletterCustomVideoThumbnail(block: NewsletterBlock): void;
export declare function defaultNewsletterSocialSettings(): NewsletterSocialSettings;
export declare function newsletterSocialPlatform(item: NewsletterLink): NewsletterSocialPlatform;
export declare function newsletterSocialSettings(block: NewsletterBlock): NewsletterSocialSettings;
export interface NewsletterBlock {
    id: string;
    kind: NewsletterBlockKind;
    html: string;
    text: string;
    url: string;
    imageUrl: string;
    alt: string;
    headingLevel: 1 | 2 | 3 | 4;
    linkType: 'web' | 'email' | 'phone' | 'file' | 'anchor';
    openNewTab: boolean;
    imageSize: 'original' | 'fill' | 'scale';
    imageScale: number;
    crop: {
        x: number;
        y: number;
        width: number;
        height: number;
    } | null;
    items: NewsletterLink[];
    question: string;
    options: string[];
    sourceKind: 'bill' | 'news' | 'tweet' | 'event' | 'product' | 'people';
    ratio: string;
    mobileOrientation: 'stacked' | 'horizontal';
    columns: NewsletterBlock[][];
    style: NewsletterStyle;
    mobileStyle: NewsletterStyle;
    linkedStyles: boolean;
    visibility: {
        mode: 'all' | 'custom';
        rules: NewsletterRule[];
    };
    app?: NewsletterLinkPreviewBlock;
    social?: NewsletterSocialSettings;
    video?: NewsletterVideoSettings;
    survey?: NewsletterSurveyButton;
}
export interface NewsletterLinkPreviewBlock {
    kind: 'link-preview';
    sourceUrl: string;
    title: string;
    description: string;
    imageUrl: string;
    size: 'small' | 'medium' | 'large';
    showImage: boolean;
    showDescription: boolean;
    showBackground: boolean;
}
export interface NewsletterSection {
    id: string;
    name: string;
    style: NewsletterStyle;
    blocks: NewsletterBlock[];
    /** Client access inherited by saved sections, including after copying. */
    sourceClientIds?: string[];
    /** Immutable font references carried with a reusable section. */
    fonts?: NewsletterFont[];
}
export interface NewsletterEmailStyles {
    background: string;
    content: string;
    backgroundImage: string;
    width: number;
    mobilePadding: number;
    text: Record<'p' | 'h1' | 'h2' | 'h3' | 'h4', NewsletterStyle>;
    link: NewsletterStyle;
    button: NewsletterStyle;
    divider: NewsletterStyle;
    image: NewsletterStyle;
    logo: NewsletterStyle;
    linkedStyles: boolean;
    mobileText: Record<'p' | 'h1' | 'h2' | 'h3' | 'h4', NewsletterStyle>;
    mobileButton: NewsletterStyle;
    mobileDivider: NewsletterStyle;
    mobileImage: NewsletterStyle;
    mobileLogo: NewsletterStyle;
}
export interface NewsletterDesign {
    version: 1;
    styles: NewsletterEmailStyles;
    sections: NewsletterSection[];
    sourceClientIds?: string[];
    fonts?: NewsletterFont[];
}
export interface NewsletterFont {
    assetId: string;
    name: string;
    family: string;
    url: string;
    format: 'truetype' | 'opentype' | 'woff' | 'woff2';
}
export interface NewsletterBrandLogo {
    assetId: string;
    name: string;
    url: string;
    link: string;
    alt: string;
}
export interface NewsletterBrandButton {
    id: string;
    name: string;
    shape: 'square' | 'rounded' | 'pill';
    variant: 'filled' | 'outlined';
    background: string;
    color: string;
    fontFamily: string;
}
export interface NewsletterBrandKit {
    revision: number;
    updatedAt: string;
    logos: NewsletterBrandLogo[];
    primaryLogoId: string | null;
    colors: {
        primary: string[];
        secondary: string[];
    };
    fonts: {
        heading: string;
        body: string;
        uploaded: NewsletterFont[];
    };
    buttons: NewsletterBrandButton[];
    primaryButtonId: string | null;
}
export { NEWSLETTER_FONT_CATALOG, newsletterCatalogFont, newsletterCatalogStyle, newsletterWebFontUrls, newsletterDesignFontRequests, type NewsletterCatalogFont, type NewsletterFontRequest, } from './newsletter-fonts.js';
export declare const NEWSLETTER_SYSTEM_FONTS: readonly ["Arial", "Helvetica", "Courier New", "Georgia", "Times New Roman", "Verdana", "Tahoma", "Trebuchet MS"];
export declare function defaultNewsletterBrandKit(): NewsletterBrandKit;
export declare function newsletterBrandButtonStyle(button: NewsletterBrandButton): NewsletterStyle;
export declare function newsletterDesignFonts(design: NewsletterDesign): NewsletterFont[];
export declare function applyNewsletterBrandKit(design: NewsletterDesign, kit: NewsletterBrandKit): void;
export declare function newsletterSourceClients(design: NewsletterDesign, clientId?: string | null): string[];
export interface NewsletterRecipient {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    company: string;
    phone: string;
    address: string;
    birthday: string;
    client: string;
    tags: string[];
    subscribed: boolean;
}
export interface NewsletterCampaignConfig {
    clientId: string | null;
    clientName: string;
    fromName: string;
    fromEmail: string;
    replyTo: string;
    subject: string;
    previewText: string;
    recipientIds: string[];
    excludeRecipientIds: string[];
    personalizeTo: boolean;
    toName: string;
    schedule: {
        mode: 'now' | 'scheduled' | 'triggered';
        sendAt: string | null;
        timeZone: string;
        optimization: boolean;
        timewarp: boolean;
        batch: boolean;
        batchCount: number;
        batchMinutes: number;
        trigger: 'signup' | 'tag_added' | 'campaign_sent' | 'campaign_link_click' | 'merge_changed';
        triggerValue: string;
    };
    tracking: {
        opens: boolean;
        clicks: boolean;
        plainTextClicks: boolean;
        inbox: boolean;
        autoConvertVideo: boolean;
        ecommerce: boolean;
        googleAnalytics: boolean;
        googleAnalyticsTitle: string;
        clickTale: boolean;
    };
    autoResend: {
        enabled: boolean;
        afterDays: number;
        time: string;
        subject: string;
        audience: 'not-opened' | 'engaged-not-opened';
        ignoreBotOpens: boolean;
    };
    experiment: {
        enabled: boolean;
        subjects: string[];
        testPercent: number;
        winnerMetric: 'opens' | 'clicks';
        waitHours: number;
    };
    socialCard: {
        enabled: boolean;
        title: string;
        description: string;
        imageUrl: string;
    };
    shareSlug: string;
    company: string;
    mailingAddress: string;
    permissionReminder: string;
    plainText: string;
    plainTextAuto: boolean;
}
export interface NewsletterCampaign {
    id: string;
    name: string;
    revision: number;
    status: 'draft' | 'staged';
    ownerId: string;
    updatedAt: string;
    config: NewsletterCampaignConfig;
    design: NewsletterDesign;
}
export interface NewsletterStage {
    id: string;
    documentId: string;
    revision: number;
    name: string;
    createdAt: string;
    route: string;
}
export interface NewsletterCheck {
    id: string;
    severity: 'error' | 'warning' | 'pass';
    label: string;
    detail: string;
    blockId?: string;
}
export interface NewsletterComment {
    id: string;
    campaignId: string;
    blockId: string | null;
    parentId: string | null;
    authorId: string;
    authorName: string;
    message: string;
    resolved: boolean;
    createdAt: string;
}
export interface NewsletterLibraryItem {
    id: string;
    name: string;
    folder: string;
    updatedAt: string;
    design?: NewsletterDesign;
    section?: NewsletterSection;
    config?: Pick<NewsletterCampaignConfig, 'company' | 'mailingAddress' | 'permissionReminder'>;
}
export interface NewsletterCapabilities {
    send: {
        available: boolean;
        reason: string | null;
    };
    inboxPreview: {
        available: boolean;
        reason: string | null;
    };
    ai: {
        available: boolean;
        reason: string | null;
    };
    imageAi?: {
        available: boolean;
        reason: string | null;
    };
    altTextAi?: {
        available: boolean;
        reason: string | null;
    };
    htmlCheck?: {
        available: boolean;
        reason: string | null;
    };
}
export declare function newsletterId(): string;
export declare function createNewsletterBlock(kind: NewsletterBlockKind, overrides?: Partial<NewsletterBlock>): NewsletterBlock;
export declare function createNewsletterSection(name: string, blocks?: NewsletterBlock[]): NewsletterSection;
export declare function defaultNewsletterStyles(): NewsletterEmailStyles;
export declare function defaultNewsletterConfig(): NewsletterCampaignConfig;
export declare function createNewsletterLayout(columns?: number, code?: boolean): NewsletterDesign;
export declare function governmentAffairsNewsletter(): NewsletterDesign;
export declare function visitNewsletterBlocks(design: NewsletterDesign, visit: (block: NewsletterBlock, section: NewsletterSection) => void): void;
export declare function findNewsletterBlock(design: NewsletterDesign, id: string): NewsletterBlock | null;
export declare function cloneNewsletterBlocks(blocks: NewsletterBlock[]): NewsletterBlock[];
export declare function newsletterBlockVisible(block: NewsletterBlock, recipient?: NewsletterRecipient): boolean;
/** Pure receiving parsers and canonical read envelopes; no action is performed by parsing. */
export * from './newsletter-receiving.js';
//# sourceMappingURL=newsletter.d.ts.map