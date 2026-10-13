/** The workspace newsletter's persisted design contract, shared by editor and API. */
import { newsletterCatalogStyle } from './newsletter-fonts.js';
export const NEWSLETTER_TEMPLATE_ID = 'bp_weekly_newsletter';
export const NEWSLETTER_BLOCK_KINDS = [
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
] as const;
export type NewsletterBlockKind = (typeof NEWSLETTER_BLOCK_KINDS)[number];
export const NEWSLETTER_BLOCK_LABELS: Record<NewsletterBlockKind, string> = {
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
export const NEWSLETTER_COLUMN_RATIOS = ['1', '2', '3', '4', '1:2', '2:1', '1:3', '3:1'] as const;
export type NewsletterVisibilityField =
  | 'email'
  | 'firstName'
  | 'lastName'
  | 'company'
  | 'phone'
  | 'address'
  | 'birthday'
  | 'client'
  | 'tags';
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
  borderStyle?:
    'none' | 'solid' | 'dashed' | 'dotted' | 'double' | 'inset' | 'outset' | 'groove' | 'ridge';
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
export const NEWSLETTER_SOCIAL_PLATFORMS = [
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
] as const;
export type NewsletterSocialPlatform = (typeof NEWSLETTER_SOCIAL_PLATFORMS)[number][0];
export const NEWSLETTER_SOCIAL_SHARE_PLATFORMS = [
  ['forward', 'Forward to a friend'],
  ['facebook', 'Facebook'],
  ['linkedin', 'LinkedIn'],
  ['pinterest', 'Pinterest'],
  ['twitter', 'X (formerly Twitter)'],
  ['instapaper', 'Instapaper'],
] as const;
export type NewsletterSocialSharePlatform = (typeof NEWSLETTER_SOCIAL_SHARE_PLATFORMS)[number][0];
export interface NewsletterSocialShare {
  source: 'campaign' | 'custom';
  customUrl: string;
  items: { platform: NewsletterSocialSharePlatform; label: string }[];
}
export function defaultNewsletterSocialShare(): NewsletterSocialShare {
  return {
    source: 'custom',
    customUrl: '',
    items: [
      { platform: 'facebook', label: 'Share' },
      { platform: 'linkedin', label: 'Share' },
    ],
  };
}
export const NEWSLETTER_SOCIAL_ICON_STYLES = [
  ['color', 'Color Icons'],
  ['dark', 'Dark Icons'],
  ['light', 'Light Icons'],
  ['gray', 'Gray Icons'],
  ['color-white', 'Color with White Icons'],
  ['dark-white', 'Dark with White Icons'],
  ['light-black', 'Light with Black Icons'],
  ['gray-black', 'Gray with Black Icons'],
] as const;
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
export const NEWSLETTER_SURVEY_SECTION_TYPES = [
  ['introduction', 'Introduction'],
  ['radio', 'Radio Buttons'],
  ['checkbox', 'Checkboxes'],
  ['range', 'Range'],
  ['text', 'Open Text'],
  ['email', 'Email'],
  ['contact', 'Contact Information'],
  ['content', 'Content Block'],
] as const;
export type NewsletterSurveySectionType = (typeof NEWSLETTER_SURVEY_SECTION_TYPES)[number][0];
export interface NewsletterSurveyQuestion {
  id: string;
  type: NewsletterSurveySectionType;
  prompt: string;
  required: boolean;
  options: string[];
  other: boolean;
  range: { min: number; max: number; display: 'numbers' | 'stars' | 'emojis' | 'hearts' };
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
export function createNewsletterSurveyQuestion(
  type: NewsletterSurveySectionType,
): NewsletterSurveyQuestion {
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
export function defaultNewsletterSurveyDefinition(): NewsletterSurveyDefinition {
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
export function newsletterVideoSource(
  value: string,
): { provider: 'youtube' | 'vimeo'; url: string } | null {
  if (value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port)
    return null;
  const host = url.hostname.toLowerCase();
  let id = '';
  if (['youtu.be', 'www.youtu.be'].includes(host))
    id = url.pathname.match(/^\/([a-zA-Z0-9_-]{11})\/?$/)?.[1] || '';
  if (
    [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'music.youtube.com',
      'youtube-nocookie.com',
      'www.youtube-nocookie.com',
    ].includes(host)
  ) {
    id =
      url.pathname === '/watch' && url.searchParams.getAll('v').length === 1
        ? url.searchParams.get('v') || ''
        : url.pathname.match(/^\/(?:embed|shorts|live)\/([a-zA-Z0-9_-]{11})\/?$/)?.[1] || '';
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(id))
    return { provider: 'youtube', url: `https://www.youtube.com/watch?v=${id}` };
  if (!['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(host)) return null;
  const regular = /^\/\d{1,12}(?:\/[a-zA-Z0-9]{8,64})?\/?$/;
  const collection = /^\/(?:album|showcase)\/\d{1,12}\/video\/\d{1,12}\/?$/;
  const channel = /^\/(?:channels|ondemand)\/[a-zA-Z0-9_-]{1,100}\/\d{1,12}\/?$/;
  const group = /^\/groups\/[a-zA-Z0-9_-]{1,100}\/videos\/\d{1,12}\/?$/;
  if (host === 'player.vimeo.com') {
    const playerId = url.pathname.match(/^\/video\/(\d{1,12})\/?$/)?.[1];
    if (!playerId) return null;
    url.pathname = `/${playerId}`;
  } else if (![regular, collection, channel, group].some((pattern) => pattern.test(url.pathname)))
    return null;
  const hash = url.searchParams.get('h');
  if (hash && !/^[a-zA-Z0-9]{8,64}$/.test(hash)) return null;
  url.protocol = 'https:';
  url.hostname = 'vimeo.com';
  url.hash = '';
  url.search = '';
  if (hash) url.searchParams.set('h', hash);
  return { provider: 'vimeo', url: url.href };
}
export function newsletterCustomVideoThumbnail(block: NewsletterBlock) {
  if (block.kind === 'video')
    block.video = { ...block.video, thumbnail: 'custom', sourceUrl: block.url };
}
export function defaultNewsletterSocialSettings(): NewsletterSocialSettings {
  return {
    display: 'icon',
    iconStyle: 'dark',
    desktop: { layout: 'horizontal', size: 'large', spacing: 24 },
    mobile: { layout: 'horizontal', size: 'large', spacing: 24 },
  };
}
export function newsletterSocialPlatform(item: NewsletterLink): NewsletterSocialPlatform {
  if (item.platform) return item.platform;
  const value = `${item.url} ${item.label}`.toLowerCase();
  const match: [RegExp, NewsletterSocialPlatform][] = [
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
export function newsletterSocialSettings(block: NewsletterBlock): NewsletterSocialSettings {
  return block.social || { ...defaultNewsletterSocialSettings(), display: 'text' };
}
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
  crop: { x: number; y: number; width: number; height: number } | null;
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
  visibility: { mode: 'all' | 'custom'; rules: NewsletterRule[] };
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
  colors: { primary: string[]; secondary: string[] };
  fonts: { heading: string; body: string; uploaded: NewsletterFont[] };
  buttons: NewsletterBrandButton[];
  primaryButtonId: string | null;
}
export {
  NEWSLETTER_FONT_CATALOG,
  newsletterCatalogFont,
  newsletterCatalogStyle,
  newsletterWebFontUrls,
  newsletterDesignFontRequests,
  type NewsletterCatalogFont,
  type NewsletterFontRequest,
} from './newsletter-fonts.js';
export const NEWSLETTER_SYSTEM_FONTS = [
  'Arial',
  'Helvetica',
  'Courier New',
  'Georgia',
  'Times New Roman',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
] as const;
export function defaultNewsletterBrandKit(): NewsletterBrandKit {
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
export function newsletterBrandButtonStyle(button: NewsletterBrandButton): NewsletterStyle {
  const font = newsletterCatalogStyle(button.fontFamily);
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
export function newsletterDesignFonts(design: NewsletterDesign): NewsletterFont[] {
  return [
    ...new Map(
      [...(design.fonts ?? []), ...design.sections.flatMap((section) => section.fonts ?? [])].map(
        (font) => [font.assetId, font],
      ),
    ).values(),
  ];
}
export function applyNewsletterBrandKit(design: NewsletterDesign, kit: NewsletterBrandKit): void {
  design.fonts = [
    ...new Map(
      [...newsletterDesignFonts(design), ...kit.fonts.uploaded].map((font) => [font.assetId, font]),
    ).values(),
  ];
  for (const types of [design.styles.text, design.styles.mobileText]) {
    for (const key of ['h1', 'h2', 'h3', 'h4'] as const)
      Object.assign(types[key], {
        fontFamily: kit.fonts.heading,
        fontWeight: newsletterCatalogStyle(kit.fonts.heading)?.fontWeight ?? 400,
        italic: newsletterCatalogStyle(kit.fonts.heading)?.fontStyle === 'italic',
      });
    Object.assign(types.p, {
      fontFamily: kit.fonts.body,
      fontWeight: newsletterCatalogStyle(kit.fonts.body)?.fontWeight ?? 400,
      italic: newsletterCatalogStyle(kit.fonts.body)?.fontStyle === 'italic',
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
          fontWeight: newsletterCatalogStyle(kit.fonts.heading)?.fontWeight ?? 400,
          italic: newsletterCatalogStyle(kit.fonts.heading)?.fontStyle === 'italic',
        });
    }
    if (block.kind === 'paragraph') {
      block.style.fontFamily = kit.fonts.body;
      block.mobileStyle.fontFamily = kit.fonts.body;
      for (const style of [block.style, block.mobileStyle])
        Object.assign(style, {
          fontWeight: newsletterCatalogStyle(kit.fonts.body)?.fontWeight ?? 400,
          italic: newsletterCatalogStyle(kit.fonts.body)?.fontStyle === 'italic',
        });
    }
  });
}
export function newsletterSourceClients(
  design: NewsletterDesign,
  clientId?: string | null,
): string[] {
  const surveyClients: string[] = [];
  visitNewsletterBlocks(design, (block) =>
    surveyClients.push(...(block.survey?.saved?.sourceClientIds || [])),
  );
  return [
    ...new Set([
      ...(design.sourceClientIds ?? []),
      ...design.sections.flatMap((section) => section.sourceClientIds ?? []),
      ...surveyClients,
      ...(clientId ? [clientId] : []),
    ]),
  ];
}
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
  socialCard: { enabled: boolean; title: string; description: string; imageUrl: string };
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
  send: { available: boolean; reason: string | null };
  inboxPreview: { available: boolean; reason: string | null };
  ai: { available: boolean; reason: string | null };
  imageAi?: { available: boolean; reason: string | null };
  altTextAi?: { available: boolean; reason: string | null };
  htmlCheck?: { available: boolean; reason: string | null };
}

export function newsletterId(): string {
  // IDs identify nodes within a JSON document, not authorization boundaries.
  return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
}
export function createNewsletterBlock(
  kind: NewsletterBlockKind,
  overrides: Partial<NewsletterBlock> = {},
): NewsletterBlock {
  return {
    id: newsletterId(),
    kind,
    html: '',
    text:
      kind === 'heading'
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
    items:
      kind === 'social'
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
            kind: 'saved-survey' as const,
            saved: null,
            blockBackground: '',
            paddingLinked: false,
          },
          style: { align: 'center' },
        }
      : {}),
    ...(kind === 'video'
      ? {
          video: { thumbnail: 'auto' as const, sourceUrl: '' },
          style: { paddingTop: 12, paddingBottom: 12, paddingLeft: 24, paddingRight: 24 },
        }
      : {}),
    ...overrides,
  };
}
export function createNewsletterSection(
  name: string,
  blocks: NewsletterBlock[] = [],
): NewsletterSection {
  return { id: newsletterId(), name, style: {}, blocks };
}
export function defaultNewsletterStyles(): NewsletterEmailStyles {
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
export function defaultNewsletterConfig(): NewsletterCampaignConfig {
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
    permissionReminder:
      'You are receiving this briefing because you subscribed to updates from our team.',
    plainText: '',
    plainTextAuto: true,
  };
}
export function createNewsletterLayout(columns = 1, code = false): NewsletterDesign {
  const content = code
    ? [createNewsletterBlock('code', { html: '<p>Add your newsletter HTML here.</p>' })]
    : [
        createNewsletterBlock('heading', { text: 'This week in policy', headingLevel: 1 }),
        ...(columns === 1
          ? [createNewsletterBlock('paragraph')]
          : [
              createNewsletterBlock('columns', {
                ratio: String(columns) as NewsletterBlock['ratio'],
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
export function governmentAffairsNewsletter(): NewsletterDesign {
  const b = createNewsletterBlock;
  const paragraph = (text: string, style: NewsletterStyle = {}) => b('paragraph', { text, style });
  const heading = (text: string, headingLevel: 1 | 2 | 3 | 4 = 2) =>
    b('heading', { text, headingLevel });
  const button = (text: string, url: string) => b('button', { text, url });
  const columns = (left: NewsletterBlock[], right: NewsletterBlock[]) =>
    b('columns', { columns: [left, right] });
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
        columns(
          [
            paragraph('LEGISLATIVE WATCH', { color: '#f05f26', bold: true }),
            paragraph(
              'H.R. XXXX · Sample Infrastructure Modernization Act\n\nIllustrative update: the committee has published proposed language for stakeholder review. Our team is tracking changes to eligibility, funding and reporting requirements.',
            ),
          ],
          [
            paragraph('WHAT THIS MEANS FOR YOUR TEAM', { color: '#f05f26', bold: true }),
            paragraph(
              'Use this space to connect a bill’s latest action to your client’s priorities. Summarize the impact, link to the source and explain the next decision or deadline. This preview uses sample material.',
            ),
          ],
        ),
        button('Read the bill update', 'https://www.congress.gov/'),
        b('spacer', { style: { height: 24 } }),
        heading('Your priorities.\nOur watchlist.\nA clear next step.'),
        heading('Plan for the week ahead.', 3),
        b('divider'),
        columns(
          [
            paragraph('UP NEXT · SAMPLE POLICY CALENDAR', { color: '#f05f26', bold: true }),
            paragraph(
              'Committee hearing · stakeholder comments · agency guidance\n\nHighlight the dates your client needs to know and the actions your team recommends.',
            ),
            button('Review upcoming hearings', 'https://www.congress.gov/committee-schedule'),
          ],
          [
            b('image', {
              imageUrl: '/newsletter/policy-desk.png',
              alt: 'Illustration of a policy briefing desk',
            }),
          ],
        ),
        b('divider'),
        heading('News that moves\nyour agenda.'),
        b('image', {
          imageUrl: '/newsletter/newsroom.png',
          alt: 'Illustration of policy news headlines',
        }),
        columns(
          [
            paragraph('IN THE NEWS', { color: '#f05f26', bold: true }),
            paragraph(
              'Sample news brief: an agency outlines its next rulemaking priorities. Add a sourced headline, a concise summary and a note on why this development matters to your client.',
            ),
          ],
          [
            paragraph('OUR TAKE', { color: '#f05f26', bold: true }),
            paragraph(
              'Explain the implications in plain language. Separate the source’s reported facts from your analysis, and identify what your client should watch next.',
            ),
          ],
        ),
        button('Explore policy news', 'https://www.federalregister.gov/'),
        b('divider'),
        columns(
          [
            b('image', {
              imageUrl: '/newsletter/social-update.png',
              alt: 'Illustration of a social media update',
            }),
          ],
          [
            paragraph('ON OUR RADAR · SAMPLE TWEET', { color: '#f05f26', bold: true }),
            paragraph(
              '@PolicyDesk (illustrative)\n“Stakeholder input helps shape the next phase of policy work.”\n\nUse this section for a relevant tweet, its source link and context for your client.',
            ),
            button('Read the original post', 'https://x.com/'),
          ],
        ),
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
export function visitNewsletterBlocks(
  design: NewsletterDesign,
  visit: (block: NewsletterBlock, section: NewsletterSection) => void,
): void {
  const walk = (blocks: NewsletterBlock[], section: NewsletterSection) => {
    for (const block of blocks) {
      visit(block, section);
      for (const column of block.columns) walk(column, section);
    }
  };
  for (const section of design.sections) walk(section.blocks, section);
}
export function findNewsletterBlock(design: NewsletterDesign, id: string): NewsletterBlock | null {
  let found: NewsletterBlock | null = null;
  visitNewsletterBlocks(design, (block) => {
    if (block.id === id) found = block;
  });
  return found;
}
export function cloneNewsletterBlocks(blocks: NewsletterBlock[]): NewsletterBlock[] {
  return blocks.map((block) => ({
    ...structuredClone(block),
    id: newsletterId(),
    columns: block.columns.map(cloneNewsletterBlocks),
  }));
}
export function newsletterBlockVisible(
  block: NewsletterBlock,
  recipient?: NewsletterRecipient,
): boolean {
  if (block.visibility.mode === 'all') return true;
  if (!recipient) return false;
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
