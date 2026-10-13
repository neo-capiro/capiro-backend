import { BadRequestException } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';
import {
  NEWSLETTER_BLOCK_KINDS,
  createNewsletterBlock,
  defaultNewsletterConfig,
  defaultNewsletterStyles,
  NEWSLETTER_SOCIAL_PLATFORMS,
  NEWSLETTER_SOCIAL_SHARE_PLATFORMS,
  NEWSLETTER_SOCIAL_ICON_STYLES,
  NEWSLETTER_SURVEY_SECTION_TYPES,
  type NewsletterSurveyDefinition,
  type NewsletterSavedSurvey,
  type NewsletterSocialDevice,
  type NewsletterBlock,
  type NewsletterCampaignConfig,
  type NewsletterDesign,
  type NewsletterStyle,
} from '@capiro/shared/newsletter';
import { validateNewsletterFonts } from './newsletter-brand-validation.js';
import { newsletterSafeUrl, newsletterSocialShareTarget } from '@capiro/shared/newsletter-render';

export function sanitizeNewsletterHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'span',
      'div',
      'a',
      'h1',
      'h2',
      'h3',
      'h4',
      'ul',
      'ol',
      'li',
      'table',
      'thead',
      'tbody',
      'tr',
      'td',
      'th',
      'img',
      'hr',
      'blockquote',
      'pre',
      'code',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel', 'id'],
      img: ['src', 'alt', 'width', 'height'],
      '*': ['style'],
      td: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['https', 'http', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['https', 'http'] },
    allowProtocolRelative: false,
    allowedStyles: {
      '*': {
        color: [/^#[a-f0-9]{3,8}$/i],
        'background-color': [/^#[a-f0-9]{3,8}$/i],
        'font-size': [/^\d{1,3}px$/],
        'font-family': [/^[a-z0-9 ,"'-]{1,100}$/i],
        'font-weight': [/^(normal|bold|[1-9]00)$/],
        'font-style': [/^(normal|italic)$/],
        'text-align': [/^(left|center|right)$/],
        'text-decoration': [/^(none|underline|line-through)$/],
        'line-height': [/^[0-4](\.\d{1,2})?$/],
      },
    },
    transformTags: {
      a: (_tag, attrs) => ({
        tagName: 'a',
        attribs: {
          ...attrs,
          href: newsletterSafeUrl(attrs.href ?? '') || '#',
          rel: 'noopener noreferrer',
        },
      }),
    },
  });
}
function fail(message: string): never {
  throw new BadRequestException(message);
}
function obj(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function str(value: unknown, label: string, max = 10000): string {
  if (typeof value !== 'string' || value.length > max)
    fail(`${label} must be text of at most ${max} characters`);
  return value;
}
function num(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    fail(`${label} must be between ${min} and ${max}`);
  return value;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be true or false`);
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) fail(`${label} is invalid`);
  return value as T;
}
function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    fail(`${label} must contain at most ${max} items`);
  return value;
}
function id(value: unknown, label: string): string {
  const result = str(value, label, 100);
  if (!/^[a-z0-9_-]+$/i.test(result)) fail(`${label} is invalid`);
  return result;
}
function url(value: unknown, label: string, image = false): string {
  const raw = str(value, label, image ? 15000000 : 4000);
  if (!raw) return '';
  const safe = newsletterSafeUrl(raw, image);
  if (!safe) fail(`${label} must be a web, email, phone, or anchor link`);
  return safe;
}
export function validateNewsletterStyle(value: unknown): NewsletterStyle {
  const input = obj(value, 'Style');
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (entry === undefined || entry === null || entry === '') continue;
    if (['background', 'color', 'borderColor'].includes(key)) {
      const color = str(entry, key, 20);
      if (!/^(#[a-f0-9]{3}|#[a-f0-9]{6}|#[a-f0-9]{8}|transparent)$/i.test(color))
        fail(`${key} must be a hex color`);
      result[key] = color;
    } else if (key === 'fontFamily') {
      const font = str(entry, key, 100);
      if (!/^[a-z0-9 ,"'-]+$/i.test(font)) fail('Font family is invalid');
      result[key] = font;
    } else if (key === 'fontWeight') {
      const weight = num(entry, key, 100, 900);
      if (!Number.isInteger(weight)) fail('Font weight must be a whole number');
      result[key] = weight;
    } else if (
      [
        'fontSize',
        'letterSpacing',
        'paragraphSpacing',
        'paddingTop',
        'paddingBottom',
        'paddingLeft',
        'paddingRight',
        'margin',
        'borderWidth',
        'radius',
        'radiusTopLeft',
        'radiusTopRight',
        'radiusBottomRight',
        'radiusBottomLeft',
        'height',
        'width',
      ].includes(key)
    )
      result[key] = num(entry, key, 0, key === 'width' ? 100 : 1000);
    else if (key === 'lineHeight') result[key] = num(entry, key, 0.5, 4);
    else if (['bold', 'italic', 'underline', 'strike'].includes(key))
      result[key] = bool(entry, key);
    else if (key === 'align') result[key] = choice(entry, ['left', 'center', 'right'], key);
    else if (key === 'direction') result[key] = choice(entry, ['ltr', 'rtl'], key);
    else if (key === 'borderStyle')
      result[key] = choice(
        entry,
        ['none', 'solid', 'dashed', 'dotted', 'double', 'inset', 'outset', 'groove', 'ridge'],
        key,
      );
    else fail(`Unknown style property: ${key}`);
  }
  return result as NewsletterStyle;
}
export function validateNewsletterDesign(value: unknown): NewsletterDesign {
  const input = obj(value, 'Design');
  if (input.version !== 1) fail('Unsupported newsletter design version');
  const sourceClients = (value: unknown) =>
    array(value ?? [], 'Source clients', 100).map((value) => {
      if (
        typeof value !== 'string' ||
        !/^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value)
      )
        fail('Source client ID is invalid');
      return value;
    });
  const rawStyles = obj(input.styles, 'Email styles');
  const styles = defaultNewsletterStyles();
  for (const key of ['background', 'content'] as const) {
    const color = str(rawStyles[key], key, 20);
    if (!/^#[a-f0-9]{6}$/i.test(color)) fail(`${key} must be a hex color`);
    styles[key] = color;
  }
  styles.backgroundImage = url(rawStyles.backgroundImage, 'Background image', true);
  styles.width = num(rawStyles.width, 'Email width', 320, 1200);
  styles.mobilePadding = num(rawStyles.mobilePadding, 'Mobile padding', 0, 100);
  styles.linkedStyles = bool(rawStyles.linkedStyles, 'Linked email styles');
  for (const key of ['text', 'mobileText'] as const) {
    const typeStyles = obj(rawStyles[key], key);
    for (const level of ['p', 'h1', 'h2', 'h3', 'h4'] as const)
      styles[key][level] = validateNewsletterStyle(typeStyles[level]);
  }
  for (const key of [
    'link',
    'button',
    'divider',
    'image',
    'logo',
    'mobileButton',
    'mobileDivider',
    'mobileImage',
    'mobileLogo',
  ] as const)
    styles[key] = validateNewsletterStyle(rawStyles[key]);
  const ids = new Set<string>();
  let count = 0;
  const uniqueId = (value: unknown, label: string) => {
    const key = id(value, label);
    if (ids.has(key)) fail('Newsletter node IDs must be unique');
    ids.add(key);
    return key;
  };
  const block = (value: unknown, depth = 0): NewsletterBlock => {
    if (++count > 500 || depth > 6) fail('Newsletter is too large or deeply nested');
    const row = obj(value, 'Block');
    const kind = choice(row.kind, NEWSLETTER_BLOCK_KINDS, 'Block kind');
    const result = createNewsletterBlock(kind);
    result.id = uniqueId(row.id, 'Block ID');
    result.html = sanitizeNewsletterHtml(str(row.html, 'Block HTML', 200000));
    result.text = str(row.text, 'Block text', 200000);
    result.url = url(row.url, 'Block link');
    result.imageUrl = url(row.imageUrl, 'Image', true);
    result.alt = str(row.alt, 'Alt text', 1000);
    delete result.video;
    if (row.video !== undefined) {
      if (kind !== 'video') fail('Only Video blocks may contain video settings');
      const video = obj(row.video, 'Video settings');
      result.video = {
        thumbnail: choice(video.thumbnail, ['auto', 'custom'], 'Video thumbnail'),
        sourceUrl: url(video.sourceUrl, 'Video thumbnail source'),
        ...(video.paddingLinked === undefined
          ? {}
          : { paddingLinked: bool(video.paddingLinked, 'Linked video padding') }),
      };
    }
    delete result.social;
    if (row.social !== undefined) {
      if (kind !== 'social') fail('Only Social blocks may contain social settings');
      const social = obj(row.social, 'Social settings');
      const device = (value: unknown): NewsletterSocialDevice => {
        const valueObject = obj(value, 'Social device settings');
        const spacing = num(valueObject.spacing, 'Social spacing', 2, 60);
        if (!Number.isInteger(spacing) || spacing % 2)
          fail('Social spacing must use steps of 2 pixels');
        return {
          layout: choice(valueObject.layout, ['horizontal', 'vertical'], 'Social layout'),
          size: choice(valueObject.size, ['small', 'medium', 'large'], 'Social size'),
          spacing,
        };
      };
      result.social = {
        display: choice(social.display, ['icon', 'icon-text', 'text'], 'Social display'),
        iconStyle: choice(
          social.iconStyle,
          NEWSLETTER_SOCIAL_ICON_STYLES.map(([key]) => key),
          'Social icon style',
        ),
        desktop: device(social.desktop),
        mobile: device(social.mobile),
      };
      if (social.mode !== undefined)
        result.social.mode = choice(social.mode, ['follow', 'share'] as const, 'Social type');
      for (const key of ['followDisplay', 'shareDisplay'] as const)
        if (social[key] !== undefined)
          result.social[key] = choice(
            social[key],
            ['icon', 'icon-text', 'text'] as const,
            'Social display',
          );
      if (social.share !== undefined) {
        const share = obj(social.share, 'Social sharing');
        const customUrl = str(share.customUrl, 'Custom share URL', 4000);
        if (customUrl && !newsletterSocialShareTarget(customUrl))
          fail('Custom sharing requires a web URL without recipient action capabilities');
        const seen = new Set<string>();
        result.social.share = {
          source: choice(share.source, ['campaign', 'custom'], 'Content to share'),
          customUrl,
          items: array(share.items, 'Share channels', 6).map((entry) => {
            const item = obj(entry, 'Share channel');
            const platform = choice(
              item.platform,
              NEWSLETTER_SOCIAL_SHARE_PLATFORMS.map(([key]) => key),
              'Share channel',
            );
            if (seen.has(platform)) fail('Share channels must be unique');
            seen.add(platform);
            return { platform, label: str(item.label, 'Share label', 1000) };
          }),
        };
      }
      if (result.social.mode === 'share' && !result.social.share)
        fail('Share mode requires its sharing settings');
    }
    if (row.app !== undefined) {
      if (kind !== 'apps') fail('Only Apps blocks may contain app content');
      const app = obj(row.app, 'App content');
      result.app = {
        kind: choice(app.kind, ['link-preview'], 'App'),
        sourceUrl: url(app.sourceUrl, 'Source URL'),
        title: str(app.title, 'Preview title', 2000),
        description: str(app.description, 'Preview description', 6000),
        imageUrl: url(app.imageUrl, 'Preview image', true),
        size: choice(app.size, ['small', 'medium', 'large'], 'Block size'),
        showImage: bool(app.showImage, 'Show image'),
        showDescription: bool(app.showDescription, 'Show description'),
        showBackground: bool(app.showBackground, 'Show background'),
      };
      if (result.app.sourceUrl && !/^https:\/\//i.test(result.app.sourceUrl))
        fail('Link previews require a public HTTPS source URL');
    }
    result.headingLevel = num(row.headingLevel, 'Heading level', 1, 4) as 1 | 2 | 3 | 4;
    if (!Number.isInteger(result.headingLevel)) fail('Heading level must be an integer');
    result.linkType = choice(
      row.linkType,
      ['web', 'email', 'phone', 'file', 'anchor'],
      'Link type',
    );
    result.openNewTab = bool(row.openNewTab, 'Open in new tab');
    result.imageSize = choice(row.imageSize, ['original', 'fill', 'scale'], 'Image size');
    result.imageScale = num(row.imageScale, 'Image scale', 1, 100);
    if (row.crop !== null) {
      const crop = obj(row.crop, 'Image crop');
      result.crop = {
        x: num(crop.x, 'Crop x', 0, 100),
        y: num(crop.y, 'Crop y', 0, 100),
        width: num(crop.width, 'Crop width', 1, 10000),
        height: num(crop.height, 'Crop height', 1, 10000),
      };
    }
    result.items = array(row.items, 'Block items', 30).map((value) => {
      const item = obj(value, 'Item');
      return {
        label: str(item.label, 'Item label', 1000),
        url: url(item.url, 'Item link'),
        ...(item.platform !== undefined
          ? {
              platform: choice(
                item.platform,
                NEWSLETTER_SOCIAL_PLATFORMS.map(([key]) => key),
                'Social platform',
              ),
            }
          : {}),
        ...(item.imageUrl !== undefined
          ? { imageUrl: url(item.imageUrl, 'Item image', true) }
          : {}),
        ...(item.price !== undefined ? { price: str(item.price, 'Item price', 100) } : {}),
        ...(item.description !== undefined
          ? { description: str(item.description, 'Item description') }
          : {}),
      };
    });
    result.question = str(row.question, 'Survey question', 1000);
    if (row.survey !== undefined) {
      if (kind !== 'survey') fail('Only Survey blocks may contain a saved survey');
      const survey = obj(row.survey, 'Survey button');
      result.survey = {
        kind: choice(survey.kind, ['saved-survey'] as const, 'Survey button'),
        saved: survey.saved === null ? null : validateNewsletterSavedSurvey(survey.saved),
        blockBackground: str(survey.blockBackground, 'Survey block background', 30),
        paddingLinked: bool(survey.paddingLinked, 'Linked survey padding'),
      };
      if (result.survey.blockBackground && !/^#[a-f\d]{3,8}$/i.test(result.survey.blockBackground))
        fail('Survey block background is invalid');
    } else delete result.survey; // Previously saved inline polls keep their original behavior.
    result.options = array(row.options, 'Survey options', 10).map((value) =>
      str(value, 'Survey option', 500),
    );
    result.sourceKind = choice(
      row.sourceKind,
      ['bill', 'news', 'tweet', 'event', 'product', 'people'],
      'Content source',
    );
    result.ratio = choice(
      row.ratio,
      ['1', '2', '3', '4', '1:2', '2:1', '1:3', '3:1'],
      'Column ratio',
    );
    result.mobileOrientation = choice(
      row.mobileOrientation,
      ['stacked', 'horizontal'],
      'Mobile orientation',
    );
    result.columns = array(row.columns, 'Columns', 4).map((value) =>
      array(value, 'Column blocks', 100).map((value) => block(value, depth + 1)),
    );
    if (kind === 'columns' && result.columns.length < 1) fail('Columns require a container');
    if (kind !== 'columns' && result.columns.length)
      fail('Only column blocks may contain children');
    result.style = validateNewsletterStyle(row.style);
    result.mobileStyle = validateNewsletterStyle(row.mobileStyle);
    result.linkedStyles = bool(row.linkedStyles, 'Linked block styles');
    const visibility = obj(row.visibility, 'Visibility');
    result.visibility = {
      mode: choice(visibility.mode, ['all', 'custom'], 'Visibility mode'),
      rules: array(visibility.rules, 'Visibility rules', 5).map((value) => {
        const rule = obj(value, 'Visibility rule');
        return {
          field: choice(
            rule.field,
            [
              'email',
              'firstName',
              'lastName',
              'company',
              'phone',
              'address',
              'birthday',
              'client',
              'tags',
            ],
            'Audience field',
          ),
          operator: choice(
            rule.operator,
            ['is', 'is-not', 'contains', 'does-not-contain', 'is-empty', 'is-not-empty'],
            'Rule operator',
          ),
          value: str(rule.value, 'Rule value', 1000),
        };
      }),
    };
    if (result.visibility.mode === 'custom' && !result.visibility.rules.length)
      fail('Custom visibility needs at least one rule');
    return result;
  };
  const sections = array(input.sections, 'Sections', 50).map((value) => {
    const section = obj(value, 'Section');
    return {
      id: uniqueId(section.id, 'Section ID'),
      name: str(section.name, 'Section name', 100),
      style: validateNewsletterStyle(section.style),
      blocks: array(section.blocks, 'Section blocks', 200).map((value) => block(value)),
      ...(section.sourceClientIds
        ? { sourceClientIds: sourceClients(section.sourceClientIds) }
        : {}),
      ...(section.fonts ? { fonts: validateNewsletterFonts(section.fonts, 100) } : {}),
    };
  });
  return {
    version: 1,
    styles,
    sections,
    ...(input.sourceClientIds ? { sourceClientIds: sourceClients(input.sourceClientIds) } : {}),
    ...(input.fonts ? { fonts: validateNewsletterFonts(input.fonts, 100) } : {}),
  };
}
export function validateNewsletterSurveyDefinition(value: unknown): NewsletterSurveyDefinition {
  const row = obj(value, 'Survey definition');
  if (row.version !== 1) fail('Unsupported survey version');
  const ids = new Set<string>();
  const questions = array(row.questions, 'Survey sections', 30).map((value) => {
    const question = obj(value, 'Survey section');
    const id = str(question.id, 'Survey section ID', 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) fail('Survey section IDs must be unique');
    ids.add(id);
    const range = obj(question.range, 'Survey range');
    const min = num(range.min, 'Range minimum', 0, 10);
    const max = num(range.max, 'Range maximum', 1, 10);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min >= max)
      fail('Survey range is invalid');
    const options = array(question.options, 'Survey choices', 30).map((v) =>
      str(v, 'Survey choice', 500),
    );
    if (new Set(options).size !== options.length) fail('Survey choices must be unique');
    const imageUrl = url(question.imageUrl, 'Survey image', true);
    const videoUrl = url(question.videoUrl, 'Survey video');
    const mediaUrl = (value: string) => !value || /^https?:\/\//i.test(value);
    if (!mediaUrl(imageUrl) || !mediaUrl(videoUrl)) fail('Survey media needs an HTTP(S) URL');
    if (question.introductionType !== undefined && question.type !== 'introduction')
      fail('Introduction type belongs to an introduction section');
    return {
      id,
      type: choice(
        question.type,
        NEWSLETTER_SURVEY_SECTION_TYPES.map(([key]) => key),
        'Survey section type',
      ),
      prompt: str(question.prompt, 'Survey question', 6000),
      required: bool(question.required, 'Required question'),
      options,
      other: bool(question.other, 'Other choice'),
      range: {
        min,
        max,
        display: choice(
          range.display,
          ['numbers', 'stars', 'emojis', 'hearts'] as const,
          'Range display',
        ),
      },
      contactField: choice(
        question.contactField,
        ['firstName', 'lastName', 'age', 'gender', 'address'] as const,
        'Contact field',
      ),
      askToSubscribe: bool(question.askToSubscribe, 'Ask to subscribe'),
      imageUrl,
      alt: str(question.alt, 'Survey image description', 2000),
      videoUrl,
      ...(question.introductionType === undefined
        ? {}
        : {
            introductionType:
              question.introductionType === null
                ? null
                : choice(
                    question.introductionType,
                    ['text', 'image', 'video'] as const,
                    'Introduction type',
                  ),
          }),
    };
  });
  const color = (key: string) => {
    const value = str(row[key], key, 30);
    if (!/^#[a-f\d]{6}$/i.test(value)) fail(`${key} is invalid`);
    return value;
  };
  const logoUrl = url(row.logoUrl, 'Survey logo', true);
  if (logoUrl && !/^https?:\/\//i.test(logoUrl)) fail('Survey logo needs an HTTP(S) URL');
  return {
    version: 1,
    questions,
    title: str(row.title, 'Survey title', 500),
    description: str(row.description, 'Survey description', 6000),
    logoUrl,
    submitLabel: str(row.submitLabel, 'Submit button label', 100),
    confirmation: str(row.confirmation, 'Confirmation message', 2000),
    closedMessage: str(row.closedMessage, 'Closed survey message', 2000),
    requiredMessage: str(row.requiredMessage, 'Required response message', 2000),
    background: color('background'),
    buttonColor: color('buttonColor'),
    buttonTextColor: color('buttonTextColor'),
  };
}
export function validateNewsletterSavedSurvey(value: unknown): NewsletterSavedSurvey {
  const row = obj(value, 'Saved survey');
  const id = str(row.id, 'Saved survey ID', 36);
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) fail('Saved survey ID is invalid');
  const revision = num(row.revision, 'Survey revision', 1, 1_000_000);
  if (!Number.isInteger(revision)) fail('Survey revision must be an integer');
  const updatedAt = str(row.updatedAt, 'Survey saved time', 40);
  if (!Number.isFinite(Date.parse(updatedAt))) fail('Survey saved time is invalid');
  const sourceClientIds = array(row.sourceClientIds, 'Survey source clients', 100).map((value) => {
    const id = str(value, 'Survey client ID', 36);
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id))
      fail('Survey client ID is invalid');
    return id;
  });
  return {
    id,
    name: str(row.name, 'Saved survey name', 200),
    revision,
    status: choice(row.status, ['draft'] as const, 'Survey status'),
    updatedAt,
    sourceClientIds: [...new Set(sourceClientIds)],
    definition: validateNewsletterSurveyDefinition(row.definition),
  };
}
export function validateNewsletterConfig(value: unknown): NewsletterCampaignConfig {
  const input = obj(value, 'Campaign settings');
  const result = defaultNewsletterConfig();
  for (const key of [
    'clientName',
    'fromName',
    'fromEmail',
    'replyTo',
    'subject',
    'previewText',
    'toName',
    'company',
    'mailingAddress',
    'permissionReminder',
    'plainText',
    'shareSlug',
  ] as const)
    result[key] = str(input[key], key, key === 'plainText' ? 200000 : 4000);
  for (const key of ['fromName', 'fromEmail', 'replyTo', 'subject'] as const)
    if (/[\r\n]/.test(result[key])) fail(`${key} cannot contain newlines`);
  if (
    input.clientId !== null &&
    (typeof input.clientId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.clientId))
  )
    fail('Client ID is invalid');
  result.clientId = input.clientId as string | null;
  for (const key of ['recipientIds', 'excludeRecipientIds'] as const)
    result[key] = array(input[key], key, 10000).map((value) => id(value, key));
  result.personalizeTo = bool(input.personalizeTo, 'Personalize To');
  result.plainTextAuto = bool(input.plainTextAuto, 'Automatic plain text');
  const schedule = obj(input.schedule, 'Schedule');
  result.schedule = {
    mode: choice(schedule.mode, ['now', 'scheduled', 'triggered'], 'Send mode'),
    sendAt: schedule.sendAt === null ? null : str(schedule.sendAt, 'Send time', 100),
    timeZone: str(schedule.timeZone, 'Time zone', 100),
    optimization: bool(schedule.optimization, 'Send time optimization'),
    timewarp: bool(schedule.timewarp, 'Timewarp'),
    batch: bool(schedule.batch, 'Batch delivery'),
    batchCount: num(schedule.batchCount, 'Batch count', 1, 26),
    batchMinutes: num(schedule.batchMinutes, 'Batch minutes', 5, 60),
    trigger: choice(
      schedule.trigger,
      ['signup', 'tag_added', 'campaign_sent', 'campaign_link_click', 'merge_changed'],
      'Trigger',
    ),
    triggerValue: str(schedule.triggerValue, 'Trigger value', 1000),
  };
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: result.schedule.timeZone });
  } catch {
    fail('Time zone is invalid');
  }
  if (result.schedule.sendAt && !Number.isFinite(Date.parse(result.schedule.sendAt)))
    fail('Send time is invalid');
  const tracking = obj(input.tracking, 'Tracking');
  for (const key of [
    'opens',
    'clicks',
    'plainTextClicks',
    'inbox',
    'autoConvertVideo',
    'ecommerce',
    'googleAnalytics',
    'clickTale',
  ] as const)
    result.tracking[key] = bool(tracking[key], key);
  result.tracking.googleAnalyticsTitle = str(
    tracking.googleAnalyticsTitle,
    'Google Analytics title',
    300,
  );
  const resend = obj(input.autoResend, 'Automatic resend');
  result.autoResend = {
    enabled: bool(resend.enabled, 'Automatic resend'),
    afterDays: num(resend.afterDays, 'Resend days', 1, 30),
    time: str(resend.time, 'Resend time', 5),
    subject: str(resend.subject, 'Resend subject', 500),
    audience: choice(resend.audience, ['not-opened', 'engaged-not-opened'], 'Resend segment'),
    ignoreBotOpens: bool(resend.ignoreBotOpens, 'Ignore bot opens'),
  };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result.autoResend.time)) fail('Resend time is invalid');
  const experiment = obj(input.experiment, 'A/B test');
  result.experiment = {
    enabled: bool(experiment.enabled, 'A/B test enabled'),
    subjects: array(experiment.subjects, 'A/B subjects', 3).map((value) =>
      str(value, 'A/B subject', 500),
    ),
    testPercent: num(experiment.testPercent, 'Test percentage', 1, 100),
    winnerMetric: choice(experiment.winnerMetric, ['opens', 'clicks'], 'Winner metric'),
    waitHours: num(experiment.waitHours, 'Test duration', 1, 168),
  };
  if (
    result.experiment.enabled &&
    (result.experiment.subjects.length < 2 ||
      result.experiment.subjects.some((subject) => !subject.trim() || /[\r\n]/.test(subject)))
  )
    fail('A/B testing needs at least two subject lines');
  const card = obj(input.socialCard, 'Social card');
  result.socialCard = {
    enabled: bool(card.enabled, 'Social card enabled'),
    title: str(card.title, 'Social card title', 500),
    description: str(card.description, 'Social card description', 4000),
    imageUrl: url(card.imageUrl, 'Social card image', true),
  };
  return result;
}
