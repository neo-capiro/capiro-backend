"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NEWSLETTER_SYSTEM_FONTS = exports.newsletterDesignFontRequests = exports.newsletterWebFontUrls = exports.newsletterCatalogStyle = exports.newsletterCatalogFont = exports.NEWSLETTER_FONT_CATALOG = exports.NEWSLETTER_SURVEY_SECTION_TYPES = exports.NEWSLETTER_SOCIAL_ICON_STYLES = exports.NEWSLETTER_SOCIAL_SHARE_PLATFORMS = exports.NEWSLETTER_SOCIAL_PLATFORMS = exports.NEWSLETTER_COLUMN_RATIOS = exports.NEWSLETTER_BLOCK_LABELS = exports.NEWSLETTER_BLOCK_KINDS = exports.NEWSLETTER_TEMPLATE_ID = void 0;
exports.defaultNewsletterSocialShare = defaultNewsletterSocialShare;
exports.createNewsletterSurveyQuestion = createNewsletterSurveyQuestion;
exports.defaultNewsletterSurveyDefinition = defaultNewsletterSurveyDefinition;
exports.newsletterVideoSource = newsletterVideoSource;
exports.newsletterCustomVideoThumbnail = newsletterCustomVideoThumbnail;
exports.defaultNewsletterSocialSettings = defaultNewsletterSocialSettings;
exports.newsletterSocialPlatform = newsletterSocialPlatform;
exports.newsletterSocialSettings = newsletterSocialSettings;
exports.defaultNewsletterBrandKit = defaultNewsletterBrandKit;
exports.newsletterBrandButtonStyle = newsletterBrandButtonStyle;
exports.newsletterDesignFonts = newsletterDesignFonts;
exports.applyNewsletterBrandKit = applyNewsletterBrandKit;
exports.newsletterSourceClients = newsletterSourceClients;
exports.newsletterId = newsletterId;
exports.createNewsletterBlock = createNewsletterBlock;
exports.createNewsletterSection = createNewsletterSection;
exports.defaultNewsletterStyles = defaultNewsletterStyles;
exports.defaultNewsletterConfig = defaultNewsletterConfig;
exports.createNewsletterLayout = createNewsletterLayout;
exports.governmentAffairsNewsletter = governmentAffairsNewsletter;
exports.visitNewsletterBlocks = visitNewsletterBlocks;
exports.findNewsletterBlock = findNewsletterBlock;
exports.cloneNewsletterBlocks = cloneNewsletterBlocks;
exports.newsletterBlockVisible = newsletterBlockVisible;
/** The workspace newsletter's persisted design contract, shared by editor and API. */
const newsletter_fonts_js_1 = require("./newsletter-fonts.js");
exports.NEWSLETTER_TEMPLATE_ID = 'bp_weekly_newsletter';
exports.NEWSLETTER_BLOCK_KINDS = [
    'image',
    'heading',
    'paragraph',
    'button',
    'divider',
    'spacer',
    'video',
    'social',
    'logo',
    'survey',
    'code',
    'apps',
    'product',
    'product-rec',
    'footer',
    'columns',
];
exports.NEWSLETTER_BLOCK_LABELS = {
    image: 'Image',
    heading: 'Heading',
    paragraph: 'Paragraph',
    button: 'Button',
    divider: 'Divider',
    spacer: 'Spacer',
    video: 'Video',
    social: 'Social',
    logo: 'Logo',
    survey: 'Survey',
    code: 'Code',
    apps: 'Apps',
    product: 'Product',
    'product-rec': 'Product Rec',
    footer: 'Footer',
    columns: 'Columns',
};
exports.NEWSLETTER_COLUMN_RATIOS = ['1', '2', '3', '4', '1:2', '2:1', '1:3', '3:1'];
exports.NEWSLETTER_SOCIAL_PLATFORMS = [
    ['instagram', 'Instagram', 'https://instagram.com/'],
    ['facebook', 'Facebook', 'https://facebook.com/'],
    ['twitter', 'X (formerly Twitter)', 'https://x.com/'],
    ['tiktok', 'TikTok', 'https://www.tiktok.com/'],
    ['youtube', 'YouTube', 'https://www.youtube.com/'],
    ['website', 'Website', 'https://'],
    ['email', 'Email', 'mailto:'],
    ['pinterest', 'Pinterest', 'https://www.pinterest.com/'],
    ['whatsapp', 'WhatsApp', 'https://wa.me/'],
    ['threads', 'Threads', 'https://www.threads.net/'],
    ['bluesky', 'Bluesky', 'https://bsky.app/'],
    ['linkedin', 'LinkedIn', 'https://www.linkedin.com/'],
    ['patreon', 'Patreon', 'https://www.patreon.com/'],
    ['discord', 'Discord', 'https://discord.gg/'],
    ['snapchat', 'Snapchat', 'https://www.snapchat.com/'],
    ['telegram', 'Telegram', 'https://t.me/'],
    ['spotify', 'Spotify', 'https://open.spotify.com/'],
    ['twitch', 'Twitch', 'https://www.twitch.tv/'],
    ['reddit', 'Reddit', 'https://www.reddit.com/'],
];
exports.NEWSLETTER_SOCIAL_SHARE_PLATFORMS = [
    ['forward', 'Forward to a friend'],
    ['facebook', 'Facebook'],
    ['linkedin', 'LinkedIn'],
    ['pinterest', 'Pinterest'],
    ['twitter', 'X (formerly Twitter)'],
    ['instapaper', 'Instapaper'],
];
function defaultNewsletterSocialShare() {
    return {
        source: 'custom',
        customUrl: '',
        items: [
            { platform: 'facebook', label: 'Share' },
            { platform: 'linkedin', label: 'Share' },
        ],
    };
}
exports.NEWSLETTER_SOCIAL_ICON_STYLES = [
    ['color', 'Color Icons'],
    ['dark', 'Dark Icons'],
    ['light', 'Light Icons'],
    ['gray', 'Gray Icons'],
    ['color-white', 'Color with White Icons'],
    ['dark-white', 'Dark with White Icons'],
    ['light-black', 'Light with Black Icons'],
    ['gray-black', 'Gray with Black Icons'],
];
exports.NEWSLETTER_SURVEY_SECTION_TYPES = [
    ['introduction', 'Introduction'],
    ['radio', 'Radio Buttons'],
    ['checkbox', 'Checkboxes'],
    ['range', 'Range'],
    ['text', 'Open Text'],
    ['email', 'Email'],
    ['contact', 'Contact Information'],
    ['content', 'Content Block'],
];
function createNewsletterSurveyQuestion(type) {
    return {
        id: newsletterId(),
        type,
        prompt: '',
        required: false,
        options: [],
        other: false,
        range: { min: 1, max: 5, display: 'numbers' },
        contactField: 'firstName',
        askToSubscribe: false,
        imageUrl: '',
        alt: '',
        videoUrl: '',
        ...(type === 'introduction' ? { introductionType: null } : {}),
    };
}
function defaultNewsletterSurveyDefinition() {
    return {
        version: 1,
        questions: [],
        title: 'Tell us what matters to you',
        description: '',
        logoUrl: '',
        submitLabel: 'Submit',
        confirmation: 'Thank you for your feedback.',
        closedMessage: 'This survey is closed.',
        requiredMessage: 'Please answer this required question.',
        background: '#ffffff',
        buttonColor: '#007c89',
        buttonTextColor: '#ffffff',
    };
}
/** Resolve only known video URL formats; provider markup is never embedded in email. */
function newsletterVideoSource(value) {
    if (value.length > 2048)
        return null;
    let url;
    try {
        url = new URL(value.trim());
    }
    catch {
        return null;
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port)
        return null;
    const host = url.hostname.toLowerCase();
    let id = '';
    if (['youtu.be', 'www.youtu.be'].includes(host))
        id = url.pathname.match(/^\/([a-zA-Z0-9_-]{11})\/?$/)?.[1] || '';
    if ([
        'youtube.com',
        'www.youtube.com',
        'm.youtube.com',
        'music.youtube.com',
        'youtube-nocookie.com',
        'www.youtube-nocookie.com',
    ].includes(host)) {
        id =
            url.pathname === '/watch' && url.searchParams.getAll('v').length === 1
                ? url.searchParams.get('v') || ''
                : url.pathname.match(/^\/(?:embed|shorts|live)\/([a-zA-Z0-9_-]{11})\/?$/)?.[1] || '';
    }
    if (/^[a-zA-Z0-9_-]{11}$/.test(id))
        return { provider: 'youtube', url: `https://www.youtube.com/watch?v=${id}` };
    if (!['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(host))
        return null;
    const regular = /^\/\d{1,12}(?:\/[a-zA-Z0-9]{8,64})?\/?$/;
    const collection = /^\/(?:album|showcase)\/\d{1,12}\/video\/\d{1,12}\/?$/;
    const channel = /^\/(?:channels|ondemand)\/[a-zA-Z0-9_-]{1,100}\/\d{1,12}\/?$/;
    const group = /^\/groups\/[a-zA-Z0-9_-]{1,100}\/videos\/\d{1,12}\/?$/;
    if (host === 'player.vimeo.com') {
        const playerId = url.pathname.match(/^\/video\/(\d{1,12})\/?$/)?.[1];
        if (!playerId)
            return null;
        url.pathname = `/${playerId}`;
    }
    else if (![regular, collection, channel, group].some((pattern) => pattern.test(url.pathname)))
        return null;
    const hash = url.searchParams.get('h');
    if (hash && !/^[a-zA-Z0-9]{8,64}$/.test(hash))
        return null;
    url.protocol = 'https:';
    url.hostname = 'vimeo.com';
    url.hash = '';
    url.search = '';
    if (hash)
        url.searchParams.set('h', hash);
    return { provider: 'vimeo', url: url.href };
}
function newsletterCustomVideoThumbnail(block) {
    if (block.kind === 'video')
        block.video = { ...block.video, thumbnail: 'custom', sourceUrl: block.url };
}
function defaultNewsletterSocialSettings() {
    return {
        display: 'icon',
        iconStyle: 'dark',
        desktop: { layout: 'horizontal', size: 'large', spacing: 24 },
        mobile: { layout: 'horizontal', size: 'large', spacing: 24 },
    };
}
function newsletterSocialPlatform(item) {
    if (item.platform)
        return item.platform;
    const value = `${item.url} ${item.label}`.toLowerCase();
    const match = [
        [/instagram/, 'instagram'],
        [/facebook/, 'facebook'],
        [/twitter|x\.com/, 'twitter'],
        [/tiktok/, 'tiktok'],
        [/youtube|youtu\.be/, 'youtube'],
        [/mailto:|^email/, 'email'],
        [/pinterest/, 'pinterest'],
        [/whatsapp|wa\.me/, 'whatsapp'],
        [/threads/, 'threads'],
        [/bluesky|bsky/, 'bluesky'],
        [/linkedin/, 'linkedin'],
        [/patreon/, 'patreon'],
        [/discord/, 'discord'],
        [/snapchat/, 'snapchat'],
        [/telegram|t\.me\//, 'telegram'],
        [/spotify/, 'spotify'],
        [/twitch/, 'twitch'],
        [/reddit/, 'reddit'],
    ];
    return match.find(([pattern]) => pattern.test(value))?.[1] || 'website';
}
function newsletterSocialSettings(block) {
    return block.social || { ...defaultNewsletterSocialSettings(), display: 'text' };
}
var newsletter_fonts_js_2 = require("./newsletter-fonts.js");
Object.defineProperty(exports, "NEWSLETTER_FONT_CATALOG", { enumerable: true, get: function () { return newsletter_fonts_js_2.NEWSLETTER_FONT_CATALOG; } });
Object.defineProperty(exports, "newsletterCatalogFont", { enumerable: true, get: function () { return newsletter_fonts_js_2.newsletterCatalogFont; } });
Object.defineProperty(exports, "newsletterCatalogStyle", { enumerable: true, get: function () { return newsletter_fonts_js_2.newsletterCatalogStyle; } });
Object.defineProperty(exports, "newsletterWebFontUrls", { enumerable: true, get: function () { return newsletter_fonts_js_2.newsletterWebFontUrls; } });
Object.defineProperty(exports, "newsletterDesignFontRequests", { enumerable: true, get: function () { return newsletter_fonts_js_2.newsletterDesignFontRequests; } });
exports.NEWSLETTER_SYSTEM_FONTS = [
    'Arial',
    'Helvetica',
    'Courier New',
    'Georgia',
    'Times New Roman',
    'Verdana',
    'Tahoma',
    'Trebuchet MS',
];
function defaultNewsletterBrandKit() {
    return {
        revision: 1,
        updatedAt: '',
        logos: [],
        primaryLogoId: null,
        colors: { primary: ['#ffffff', '#141414', '#131a2b'], secondary: [] },
        fonts: { heading: 'Arial', body: 'Courier New', uploaded: [] },
        buttons: ['#ffffff', '#000000', '#131a2b', '#ffffff'].map((background, index) => ({
            id: `brand-button-${index + 1}`,
            name: `Button ${index + 1}`,
            shape: 'pill',
            variant: index === 3 ? 'outlined' : 'filled',
            background,
            color: index === 0 ? '#131a2b' : '#ffffff',
            fontFamily: 'Arial',
        })),
        primaryButtonId: null,
    };
}
function newsletterBrandButtonStyle(button) {
    const font = (0, newsletter_fonts_js_1.newsletterCatalogStyle)(button.fontFamily);
    return {
        background: button.variant === 'outlined' ? 'transparent' : button.background,
        color: button.color,
        fontFamily: button.fontFamily,
        fontWeight: font?.fontWeight ?? 400,
        bold: (font?.fontWeight ?? 400) >= 700,
        italic: font?.fontStyle === 'italic',
        radius: button.shape === 'pill' ? 1000 : button.shape === 'rounded' ? 8 : 0,
        borderStyle: button.variant === 'outlined' ? 'solid' : 'none',
        borderWidth: button.variant === 'outlined' ? 1 : 0,
        borderColor: button.background,
    };
}
function newsletterDesignFonts(design) {
    return [
        ...new Map([...(design.fonts ?? []), ...design.sections.flatMap((section) => section.fonts ?? [])].map((font) => [font.assetId, font])).values(),
    ];
}
function applyNewsletterBrandKit(design, kit) {
    design.fonts = [
        ...new Map([...newsletterDesignFonts(design), ...kit.fonts.uploaded].map((font) => [font.assetId, font])).values(),
    ];
    for (const types of [design.styles.text, design.styles.mobileText]) {
        for (const key of ['h1', 'h2', 'h3', 'h4'])
            Object.assign(types[key], {
                fontFamily: kit.fonts.heading,
                fontWeight: (0, newsletter_fonts_js_1.newsletterCatalogStyle)(kit.fonts.heading)?.fontWeight ?? 400,
                italic: (0, newsletter_fonts_js_1.newsletterCatalogStyle)(kit.fonts.heading)?.fontStyle === 'italic',
            });
        Object.assign(types.p, {
            fontFamily: kit.fonts.body,
            fontWeight: (0, newsletter_fonts_js_1.newsletterCatalogStyle)(kit.fonts.body)?.fontWeight ?? 400,
            italic: (0, newsletter_fonts_js_1.newsletterCatalogStyle)(kit.fonts.body)?.fontStyle === 'italic',
        });
    }
    const logo = kit.logos.find((logo) => logo.assetId === kit.primaryLogoId);
    const button = kit.buttons.find((button) => button.id === kit.primaryButtonId);
    if (button) {
        Object.assign(design.styles.button, newsletterBrandButtonStyle(button));
        Object.assign(design.styles.mobileButton, newsletterBrandButtonStyle(button));
    }
    visitNewsletterBlocks(design, (block) => {
        if (logo && block.kind === 'logo')
            Object.assign(block, {
                imageUrl: logo.url,
                url: logo.link,
                linkType: 'web',
                alt: logo.alt,
                text: '',
                crop: null,
            });
        if (button && block.kind === 'button') {
            Object.assign(block.style, newsletterBrandButtonStyle(button));
            Object.assign(block.mobileStyle, newsletterBrandButtonStyle(button));
        }
        if (block.kind === 'heading') {
            block.style.fontFamily = kit.fonts.heading;
            block.mobileStyle.fontFamily = kit.fonts.heading;
            for (const style of [block.style, block.mobileStyle])
                Object.assign(style, {
                    fontWeight: (0, newsletter_fonts_js_1.newsletterCatalogStyle)(kit.fonts.heading)?.fontWeight ?? 400,
                    italic: (0, newsletter_fonts_js_1.newsletterCatalogStyle)(kit.fonts.heading)?.fontStyle === 'italic',
                });
        }
        if (block.kind === 'paragraph') {
            block.style.fontFamily = kit.fonts.body;
            block.mobileStyle.fontFamily = kit.fonts.body;
            for (const style of [block.style, block.mobileStyle])
                Object.assign(style, {
                    fontWeight: (0, newsletter_fonts_js_1.newsletterCatalogStyle)(kit.fonts.body)?.fontWeight ?? 400,
                    italic: (0, newsletter_fonts_js_1.newsletterCatalogStyle)(kit.fonts.body)?.fontStyle === 'italic',
                });
        }
    });
}
function newsletterSourceClients(design, clientId) {
    const surveyClients = [];
    visitNewsletterBlocks(design, (block) => surveyClients.push(...(block.survey?.saved?.sourceClientIds || [])));
    return [
        ...new Set([
            ...(design.sourceClientIds ?? []),
            ...design.sections.flatMap((section) => section.sourceClientIds ?? []),
            ...surveyClients,
            ...(clientId ? [clientId] : []),
        ]),
    ];
}
function newsletterId() {
    // IDs identify nodes within a JSON document, not authorization boundaries.
    return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
}
function createNewsletterBlock(kind, overrides = {}) {
    return {
        id: newsletterId(),
        kind,
        html: '',
        text: kind === 'heading'
            ? 'Add heading text'
            : kind === 'survey'
                ? 'Start Survey'
                : kind === 'button'
                    ? 'Add button text'
                    : kind === 'paragraph'
                        ? 'Add your text here.'
                        : '',
        url: '',
        imageUrl: '',
        alt: '',
        headingLevel: 2,
        linkType: 'web',
        openNewTab: true,
        imageSize: 'fill',
        imageScale: 100,
        crop: null,
        items: kind === 'social'
            ? [
                { platform: 'facebook', label: 'Facebook', url: 'https://facebook.com/' },
                { platform: 'instagram', label: 'Instagram', url: 'https://instagram.com/' },
                { platform: 'twitter', label: 'X', url: 'https://x.com/' },
            ]
            : [],
        question: 'How useful was this update?',
        options: ['Very useful', 'Somewhat useful', 'Not useful'],
        sourceKind: 'news',
        ratio: '2',
        mobileOrientation: 'stacked',
        columns: kind === 'columns' ? [[], []] : [],
        style: {},
        mobileStyle: {},
        linkedStyles: true,
        visibility: { mode: 'all', rules: [] },
        ...(kind === 'social' ? { social: defaultNewsletterSocialSettings() } : {}),
        ...(kind === 'survey'
            ? {
                survey: {
                    kind: 'saved-survey',
                    saved: null,
                    blockBackground: '',
                    paddingLinked: false,
                },
                style: { align: 'center' },
            }
            : {}),
        ...(kind === 'video'
            ? {
                video: { thumbnail: 'auto', sourceUrl: '' },
                style: { paddingTop: 12, paddingBottom: 12, paddingLeft: 24, paddingRight: 24 },
            }
            : {}),
        ...overrides,
    };
}
function createNewsletterSection(name, blocks = []) {
    return { id: newsletterId(), name, style: {}, blocks };
}
function defaultNewsletterStyles() {
    const text = {
        p: { fontFamily: 'Courier New', fontSize: 14, color: '#ffffff', lineHeight: 1.4 },
        h1: { fontFamily: 'Arial', fontSize: 48, color: '#ffffff', bold: true, lineHeight: 1.1 },
        h2: { fontFamily: 'Arial', fontSize: 36, color: '#ffffff', bold: true, lineHeight: 1.2 },
        h3: { fontFamily: 'Arial', fontSize: 24, color: '#f05f26', bold: true, lineHeight: 1.3 },
        h4: { fontFamily: 'Arial', fontSize: 18, color: '#ffffff', bold: true, lineHeight: 1.3 },
    };
    return {
        background: '#141414',
        content: '#141414',
        backgroundImage: '',
        width: 660,
        mobilePadding: 16,
        text,
        mobileText: structuredClone(text),
        link: { color: '#ffffff', underline: true },
        button: {
            background: '#141414',
            color: '#ffffff',
            borderColor: '#f05f26',
            borderStyle: 'solid',
            borderWidth: 1,
            fontFamily: 'Arial',
            fontSize: 16,
            paddingTop: 12,
            paddingBottom: 12,
            paddingLeft: 24,
            paddingRight: 24,
            radius: 0,
        },
        divider: {
            borderStyle: 'solid',
            borderColor: '#777777',
            borderWidth: 1,
            paddingTop: 12,
            paddingBottom: 12,
        },
        image: { radius: 0, width: 100 },
        logo: { align: 'left' },
        linkedStyles: true,
        mobileButton: {},
        mobileDivider: {},
        mobileImage: {},
        mobileLogo: {},
    };
}
function defaultNewsletterConfig() {
    return {
        clientId: null,
        clientName: '',
        fromName: '',
        fromEmail: '',
        replyTo: '',
        subject: '',
        previewText: '',
        recipientIds: [],
        excludeRecipientIds: [],
        personalizeTo: false,
        toName: '*|FNAME|* *|LNAME|*',
        schedule: {
            mode: 'now',
            sendAt: null,
            timeZone: 'America/New_York',
            optimization: false,
            timewarp: false,
            batch: false,
            batchCount: 2,
            batchMinutes: 30,
            trigger: 'signup',
            triggerValue: '',
        },
        tracking: {
            opens: true,
            clicks: true,
            plainTextClicks: false,
            inbox: false,
            autoConvertVideo: false,
            ecommerce: false,
            googleAnalytics: false,
            googleAnalyticsTitle: '',
            clickTale: false,
        },
        autoResend: {
            enabled: false,
            afterDays: 3,
            time: '09:00',
            subject: '',
            audience: 'not-opened',
            ignoreBotOpens: true,
        },
        experiment: {
            enabled: false,
            subjects: ['', ''],
            testPercent: 20,
            winnerMetric: 'opens',
            waitHours: 4,
        },
        socialCard: { enabled: false, title: '', description: '', imageUrl: '' },
        shareSlug: '',
        company: '',
        mailingAddress: '',
        permissionReminder: 'You are receiving this briefing because you subscribed to updates from our team.',
        plainText: '',
        plainTextAuto: true,
    };
}
function createNewsletterLayout(columns = 1, code = false) {
    const content = code
        ? [createNewsletterBlock('code', { html: '<p>Add your newsletter HTML here.</p>' })]
        : [
            createNewsletterBlock('heading', { text: 'This week in policy', headingLevel: 1 }),
            ...(columns === 1
                ? [createNewsletterBlock('paragraph')]
                : [
                    createNewsletterBlock('columns', {
                        ratio: String(columns),
                        columns: Array.from({ length: columns }, () => [
                            createNewsletterBlock('paragraph'),
                        ]),
                    }),
                ]),
        ];
    return {
        version: 1,
        styles: defaultNewsletterStyles(),
        sections: [
            createNewsletterSection('Header', [createNewsletterBlock('logo', { text: 'YOUR FIRM' })]),
            createNewsletterSection('Body', content),
            createNewsletterSection('Footer', [createNewsletterBlock('footer')]),
        ],
    };
}
function governmentAffairsNewsletter() {
    const b = createNewsletterBlock;
    const paragraph = (text, style = {}) => b('paragraph', { text, style });
    const heading = (text, headingLevel = 2) => b('heading', { text, headingLevel });
    const button = (text, url) => b('button', { text, url });
    const columns = (left, right) => b('columns', { columns: [left, right] });
    return {
        version: 1,
        styles: defaultNewsletterStyles(),
        sections: [
            createNewsletterSection('Header', [
                b('paragraph', {
                    html: '<a href="*|ARCHIVE|*">View this email in your browser</a>',
                    style: { fontSize: 11, underline: true },
                }),
                b('divider'),
                b('logo', {
                    text: 'CAPIRO',
                    alt: 'Your firm logo',
                    style: {
                        color: '#f05f26',
                        fontSize: 64,
                        fontFamily: 'Arial',
                        bold: true,
                        paddingTop: 12,
                        paddingBottom: 24,
                    },
                }),
            ]),
            createNewsletterSection('Body', [
                b('divider'),
                paragraph('OCTOBER 6, 2026 · WEEKLY CLIENT BRIEFING', { fontSize: 12 }),
                b('divider'),
                heading('The week in policy.\nWhat it means for you.', 1),
                b('image', {
                    imageUrl: '/newsletter/capitol.png',
                    alt: 'Illustration of the U.S. Capitol',
                    style: { paddingTop: 16, paddingBottom: 24 },
                }),
                columns([
                    paragraph('LEGISLATIVE WATCH', { color: '#f05f26', bold: true }),
                    paragraph('H.R. XXXX · Sample Infrastructure Modernization Act\n\nIllustrative update: the committee has published proposed language for stakeholder review. Our team is tracking changes to eligibility, funding and reporting requirements.'),
                ], [
                    paragraph('WHAT THIS MEANS FOR YOUR TEAM', { color: '#f05f26', bold: true }),
                    paragraph('Use this space to connect a bill’s latest action to your client’s priorities. Summarize the impact, link to the source and explain the next decision or deadline. This preview uses sample material.'),
                ]),
                button('Read the bill update', 'https://www.congress.gov/'),
                b('spacer', { style: { height: 24 } }),
                heading('Your priorities.\nOur watchlist.\nA clear next step.'),
                heading('Plan for the week ahead.', 3),
                b('divider'),
                columns([
                    paragraph('UP NEXT · SAMPLE POLICY CALENDAR', { color: '#f05f26', bold: true }),
                    paragraph('Committee hearing · stakeholder comments · agency guidance\n\nHighlight the dates your client needs to know and the actions your team recommends.'),
                    button('Review upcoming hearings', 'https://www.congress.gov/committee-schedule'),
                ], [
                    b('image', {
                        imageUrl: '/newsletter/policy-desk.png',
                        alt: 'Illustration of a policy briefing desk',
                    }),
                ]),
                b('divider'),
                heading('News that moves\nyour agenda.'),
                b('image', {
                    imageUrl: '/newsletter/newsroom.png',
                    alt: 'Illustration of policy news headlines',
                }),
                columns([
                    paragraph('IN THE NEWS', { color: '#f05f26', bold: true }),
                    paragraph('Sample news brief: an agency outlines its next rulemaking priorities. Add a sourced headline, a concise summary and a note on why this development matters to your client.'),
                ], [
                    paragraph('OUR TAKE', { color: '#f05f26', bold: true }),
                    paragraph('Explain the implications in plain language. Separate the source’s reported facts from your analysis, and identify what your client should watch next.'),
                ]),
                button('Explore policy news', 'https://www.federalregister.gov/'),
                b('divider'),
                columns([
                    b('image', {
                        imageUrl: '/newsletter/social-update.png',
                        alt: 'Illustration of a social media update',
                    }),
                ], [
                    paragraph('ON OUR RADAR · SAMPLE TWEET', { color: '#f05f26', bold: true }),
                    paragraph('@PolicyDesk (illustrative)\n“Stakeholder input helps shape the next phase of policy work.”\n\nUse this section for a relevant tweet, its source link and context for your client.'),
                    button('Read the original post', 'https://x.com/'),
                ]),
                b('social', {
                    social: { ...defaultNewsletterSocialSettings(), display: 'text' },
                    items: [
                        { label: 'LINKEDIN', url: 'https://www.linkedin.com/' },
                        { label: 'X / TWITTER', url: 'https://x.com/' },
                        { label: 'WEBSITE', url: 'https://capiro.ai/' },
                    ],
                    style: { align: 'center', fontSize: 12, paddingTop: 24, paddingBottom: 24 },
                }),
            ]),
            createNewsletterSection('Footer', [
                b('footer', {
                    style: {
                        fontSize: 11,
                        align: 'center',
                        color: '#cccccc',
                        paddingTop: 24,
                        paddingBottom: 24,
                    },
                }),
                b('logo', {
                    text: 'CAPIRO',
                    alt: 'Your firm logo',
                    style: {
                        align: 'right',
                        fontFamily: 'Arial',
                        fontSize: 30,
                        bold: true,
                        color: '#f05f26',
                    },
                }),
            ]),
        ],
    };
}
function visitNewsletterBlocks(design, visit) {
    const walk = (blocks, section) => {
        for (const block of blocks) {
            visit(block, section);
            for (const column of block.columns)
                walk(column, section);
        }
    };
    for (const section of design.sections)
        walk(section.blocks, section);
}
function findNewsletterBlock(design, id) {
    let found = null;
    visitNewsletterBlocks(design, (block) => {
        if (block.id === id)
            found = block;
    });
    return found;
}
function cloneNewsletterBlocks(blocks) {
    return blocks.map((block) => ({
        ...structuredClone(block),
        id: newsletterId(),
        columns: block.columns.map(cloneNewsletterBlocks),
    }));
}
function newsletterBlockVisible(block, recipient) {
    if (block.visibility.mode === 'all')
        return true;
    if (!recipient)
        return false;
    return block.visibility.rules.every((rule) => {
        const raw = recipient[rule.field];
        const value = (Array.isArray(raw) ? raw.join(',') : String(raw ?? '')).toLowerCase();
        const match = rule.value.toLowerCase();
        switch (rule.operator) {
            case 'is':
                return value === match;
            case 'is-not':
                return value !== match;
            case 'contains':
                return value.includes(match);
            case 'does-not-contain':
                return !value.includes(match);
            case 'is-empty':
                return !value.trim();
            case 'is-not-empty':
                return Boolean(value.trim());
        }
    });
}
/** Pure receiving parsers and canonical read envelopes; no action is performed by parsing. */
__exportStar(require("./newsletter-receiving.js"), exports);
//# sourceMappingURL=newsletter.js.map