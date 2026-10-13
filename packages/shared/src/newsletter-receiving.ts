/** Pure receiving contracts. These parsers validate wire data, never authorize an action. */
import type {
  NewsletterCampaign,
  NewsletterCampaignConfig,
  NewsletterCheck,
  NewsletterDesign,
  NewsletterStage,
} from './newsletter.js';
import {
  NEWSLETTER_BLOCK_KINDS,
  NEWSLETTER_SOCIAL_PLATFORMS,
  NEWSLETTER_SOCIAL_SHARE_PLATFORMS,
  NEWSLETTER_SOCIAL_ICON_STYLES,
  NEWSLETTER_SURVEY_SECTION_TYPES,
} from './newsletter.js';

/** Canonical immutable draft response vocabulary; policy remains in the Core owner. */
export type DraftGenerationStatus = 'generated' | 'manually_authored' | 'generation_failed';
export type DraftAuditStatus =
  'not_required' | 'pending' | 'passed' | 'warning' | 'held' | 'unavailable';
export type DraftApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';
/** One check name + severity. Never spans, evidence or raw auditor internals. */
export interface DraftAuditCheckDto {
  check: string;
  severity: string;
}
export interface OutreachDraftVersionDto {
  id: string;
  artifactId: string;
  outreachRecordId: string;
  version: number;
  sourceVersionId: string | null;
  generationKey: string;
  recipientKey: string;
  audienceKind: string;
  subject: string;
  body: string;
  contentHash: string;
  generationStatus: DraftGenerationStatus;
  auditStatus: DraftAuditStatus;
  approvalStatus: DraftApprovalStatus;
  auditDecision: string | null;
  auditChecks: DraftAuditCheckDto[];
  reviewRequestId: string | null;
  provider: string | null;
  model: string | null;
  promptSpecVersion: string | null;
  /** Server-derived lifecycle fact, not a receiving-parser permission decision. */
  sendable: boolean;
  createdAt: string;
  contextNote?: string;
}
export interface NewsletterDocumentList {
  items: NewsletterCampaign[];
}
/** Saved-state rendering; the owner does not return a document/revision token here. */
export interface NewsletterPreview {
  html: string;
  plainText: string;
  checks: NewsletterCheck[];
}
export type NewsletterJson =
  null | boolean | number | string | NewsletterJson[] | NewsletterJsonObject;
export interface NewsletterJsonObject {
  [key: string]: NewsletterJson;
}
export interface NewsletterHtmlCheck {
  provider: 'Mailtrap';
  issues: string[];
  report: NewsletterJsonObject;
  revision: number;
  checkedAt: string;
}
/** Owned immutable rich-stage read, distinct from the Workspace creation receipt. */
export interface NewsletterOutreachStage {
  id: string;
  documentId: string;
  revision: number;
  name: string;
  config: NewsletterCampaignConfig;
  design: NewsletterDesign;
}
export interface NewsletterOutreachVersion extends OutreachDraftVersionDto {
  recipientEmail: string;
}
export interface NewsletterOutreachTest {
  id: string;
  requestKey: string;
  senderConnectionId: string;
  versionId: string;
}
export interface NewsletterOutreachRecord {
  id: string;
  /** The persisted Core field is a string, not a closed UI lifecycle enum. */
  status: string;
  name: string;
  stage: NewsletterOutreachStage;
  targets: NewsletterJsonObject[];
  senderConnectionId: string | null;
  subject: string;
  versions: NewsletterOutreachVersion[];
  intentId: string | null;
  excluded: string[];
  tests: NewsletterOutreachTest[];
}
export interface NewsletterReservedMetadata {
  newsletterStageId?: string;
  newsletterRevision?: number;
}
export type NewsletterRecordDiscriminator =
  | { kind: 'ordinary'; metadata: NewsletterReservedMetadata }
  | { kind: 'rich'; metadata: NewsletterReservedMetadata & { newsletterStageId: string } };
export type NewsletterReceiveResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: 'invalid_json' | 'invalid_shape' | 'limit_exceeded' | 'identity_mismatch';
        path: string;
      };
    };
export interface NewsletterReceiveIdentity {
  documentId?: string;
  stageId?: string;
  recordId?: string;
  revision?: number;
  clientId?: string | null;
}
/** Resource syntax/binding is not evidence of actor, tenant, approval or ID-family authority. */
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
// Workspace's current HillDay source/document owner admits versions 1–8. Core stays 1–5.
const WORKSPACE_UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
// An embedded saved-survey snapshot is not a resource lookup or a stage capability.
const SAVED_SURVEY_ID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
/**
 * Wire-snapshot budgets, independent of request normalization. String capacity includes large
 * image URLs, rendered HTML and a 100-document list; these are explicit receiving limits.
 * Design collections additionally use the current Workspace 500-block/6-level limits.
 */
export const NEWSLETTER_RECEIVE_LIMITS = Object.freeze({
  jsonDepth: 64,
  jsonNodes: 2_000_000,
  objectKeys: 10_000,
  arrayLength: 100_000,
  stringLength: 200_000_000,
  totalStringLength: 1_000_000_000,
});
type Failure = Exclude<NewsletterReceiveResult<never>, { ok: true }>['error'];
const failures = new WeakMap<object, Failure>();
function refuse(path: string, code: Failure['code'] = 'invalid_shape'): never {
  const token = {};
  failures.set(token, { code, path });
  throw token;
}
function plain(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  if (proto === null || proto === Object.prototype) return true;
  // Permit another realm's ordinary Object.prototype without invoking its methods.
  if (Object.getPrototypeOf(proto) !== null) return false;
  const constructor = Object.getOwnPropertyDescriptor(proto, 'constructor');
  if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function')
    return false;
  const prototype = Object.getOwnPropertyDescriptor(constructor.value, 'prototype');
  return Boolean(prototype && 'value' in prototype && prototype.value === proto);
}
function snapshot(input: unknown, documentCount = 1): NewsletterJson {
  let nodes = 0;
  let characters = 0;
  const active = new Set<object>();
  const visit = (value: unknown, path: string, depth: number): NewsletterJson => {
    if (
      ++nodes > NEWSLETTER_RECEIVE_LIMITS.jsonNodes * documentCount ||
      depth > NEWSLETTER_RECEIVE_LIMITS.jsonDepth
    )
      refuse(path, 'limit_exceeded');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) refuse(path, 'invalid_json');
      return value;
    }
    if (typeof value === 'string') {
      characters += value.length;
      if (
        value.length > NEWSLETTER_RECEIVE_LIMITS.stringLength ||
        characters > NEWSLETTER_RECEIVE_LIMITS.totalStringLength
      )
        refuse(path, 'limit_exceeded');
      return value;
    }
    if (typeof value !== 'object') refuse(path, 'invalid_json');
    if (active.has(value)) refuse(path, 'invalid_json');
    const isArray = Array.isArray(value);
    if (!isArray && !plain(value)) refuse(path, 'invalid_json');
    const lengthDescriptor = isArray ? Object.getOwnPropertyDescriptor(value, 'length') : undefined;
    const length =
      lengthDescriptor && 'value' in lengthDescriptor ? (lengthDescriptor.value as number) : 0;
    if (
      isArray &&
      (!Number.isSafeInteger(length) ||
        length < 0 ||
        length > NEWSLETTER_RECEIVE_LIMITS.arrayLength)
    )
      refuse(path, 'limit_exceeded');
    const keys = Reflect.ownKeys(value);
    if (keys.length > (isArray ? length + 1 : NEWSLETTER_RECEIVE_LIMITS.objectKeys))
      refuse(path, isArray ? 'invalid_json' : 'limit_exceeded');
    if (isArray && keys.length !== length + 1) refuse(path, 'invalid_json');
    active.add(value);
    const copy: NewsletterJson[] | NewsletterJsonObject = isArray ? [] : {};
    for (const key of keys) {
      if (isArray && key === 'length') continue;
      if (typeof key !== 'string') refuse(path, 'invalid_json');
      characters += key.length;
      if (
        key.length > NEWSLETTER_RECEIVE_LIMITS.stringLength ||
        characters > NEWSLETTER_RECEIVE_LIMITS.totalStringLength
      )
        refuse(path, 'limit_exceeded');
      if (isArray && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))
        refuse(path, 'invalid_json');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        refuse(`${path}.${key}`, 'invalid_json');
      // defineProperty preserves JSON keys including __proto__ as inert own data, never setters.
      Object.defineProperty(copy, key, {
        value: visit(descriptor.value, `${path}.${key}`, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    active.delete(value);
    return copy;
  };
  return visit(input, '$', 0);
}
type Rule = (value: NewsletterJson, path: string) => void;
const text: Rule = (value, path) => {
  if (typeof value !== 'string') refuse(path);
};
const bool: Rule = (value, path) => {
  if (typeof value !== 'boolean') refuse(path);
};
const number: Rule = (value, path) => {
  if (typeof value !== 'number') refuse(path);
};
const revision: Rule = (value, path) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) refuse(path);
};
const uuid: Rule = (value, path) => {
  if (typeof value !== 'string' || !UUID.test(value)) refuse(path);
};
const workspaceUuid: Rule = (value, path) => {
  if (typeof value !== 'string' || !WORKSPACE_UUID.test(value)) refuse(path);
};
const savedSurveyId: Rule = (value, path) => {
  if (typeof value !== 'string' || !SAVED_SURVEY_ID.test(value)) refuse(path);
};
const savedSurveyTime: Rule = (value, path) => {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value)))
    refuse(path);
};
const timestamp: Rule = (value, path) => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    refuse(path);
};
const literal =
  (...values: (string | number)[]): Rule =>
  (value, path) => {
    if (!values.includes(value as string | number)) refuse(path);
  };
const vocabulary =
  (values: () => readonly string[]): Rule =>
  (value, path) => {
    if (typeof value !== 'string' || !values().includes(value)) refuse(path);
  };
const nullable =
  (rule: Rule): Rule =>
  (value, path) => {
    if (value !== null) rule(value, path);
  };
const array =
  (rule: Rule, max = 100_000): Rule =>
  (value, path) => {
    if (!Array.isArray(value)) refuse(path);
    if (value.length > max) refuse(path, 'limit_exceeded');
    value.forEach((item, index) => rule(item, `${path}.${index}`));
  };
function row(value: NewsletterJson, path: string): NewsletterJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(path);
  return value;
}
function object(required: Record<string, Rule>, optional: Record<string, Rule> = {}): Rule {
  return (value, path) => {
    const record = row(value, path);
    for (const [key, rule] of Object.entries(required)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) refuse(`${path}.${key}`);
      rule(record[key]!, `${path}.${key}`);
    }
    for (const [key, rule] of Object.entries(optional))
      if (Object.prototype.hasOwnProperty.call(record, key)) rule(record[key]!, `${path}.${key}`);
  };
}
const strings = array(text);
const clients = array(uuid, 100);
const style = object(
  {},
  {
    background: text,
    color: text,
    fontFamily: text,
    fontSize: number,
    fontWeight: number,
    bold: bool,
    italic: bool,
    underline: bool,
    strike: bool,
    lineHeight: number,
    letterSpacing: number,
    paragraphSpacing: number,
    direction: literal('ltr', 'rtl'),
    align: literal('left', 'center', 'right'),
    paddingTop: number,
    paddingBottom: number,
    paddingLeft: number,
    paddingRight: number,
    margin: number,
    borderStyle: literal(
      'none',
      'solid',
      'dashed',
      'dotted',
      'double',
      'inset',
      'outset',
      'groove',
      'ridge',
    ),
    borderColor: text,
    borderWidth: number,
    radius: number,
    radiusTopLeft: number,
    radiusTopRight: number,
    radiusBottomRight: number,
    radiusBottomLeft: number,
    width: number,
    height: number,
  },
);
const font = object({
  assetId: uuid,
  name: text,
  family: text,
  url: text,
  format: literal('truetype', 'opentype', 'woff', 'woff2'),
});
const fonts = array(font, 100);
const rule = object({
  field: literal(
    'email',
    'firstName',
    'lastName',
    'company',
    'phone',
    'address',
    'birthday',
    'client',
    'tags',
  ),
  operator: literal('is', 'is-not', 'contains', 'does-not-contain', 'is-empty', 'is-not-empty'),
  value: text,
});
const link = object(
  { label: text, url: text },
  {
    imageUrl: text,
    price: text,
    description: text,
    platform: vocabulary(() => NEWSLETTER_SOCIAL_PLATFORMS.map(([key]) => key)),
  },
);
const socialDisplay = literal('icon', 'icon-text', 'text');
const socialDevice = object({
  layout: literal('horizontal', 'vertical'),
  size: literal('small', 'medium', 'large'),
  spacing: number,
});
const social = object(
  {
    display: socialDisplay,
    iconStyle: vocabulary(() => NEWSLETTER_SOCIAL_ICON_STYLES.map(([key]) => key)),
    desktop: socialDevice,
    mobile: socialDevice,
  },
  {
    mode: literal('follow', 'share'),
    followDisplay: socialDisplay,
    shareDisplay: socialDisplay,
    share: object({
      source: literal('campaign', 'custom'),
      customUrl: text,
      items: array(
        object({
          platform: vocabulary(() => NEWSLETTER_SOCIAL_SHARE_PLATFORMS.map(([key]) => key)),
          label: text,
        }),
        6,
      ),
    }),
  },
);
const question = object(
  {
    id: text,
    type: vocabulary(() => NEWSLETTER_SURVEY_SECTION_TYPES.map(([key]) => key)),
    prompt: text,
    required: bool,
    options: array(text, 30),
    other: bool,
    range: object({
      min: number,
      max: number,
      display: literal('numbers', 'stars', 'emojis', 'hearts'),
    }),
    contactField: literal('firstName', 'lastName', 'age', 'gender', 'address'),
    askToSubscribe: bool,
    imageUrl: text,
    alt: text,
    videoUrl: text,
  },
  { introductionType: nullable(literal('text', 'image', 'video')) },
);
const surveyDefinition = object({
  version: literal(1),
  questions: array(question, 30),
  title: text,
  description: text,
  logoUrl: text,
  submitLabel: text,
  confirmation: text,
  closedMessage: text,
  requiredMessage: text,
  background: text,
  buttonColor: text,
  buttonTextColor: text,
});
const savedSurvey = object({
  id: savedSurveyId,
  name: text,
  revision,
  status: literal('draft'),
  updatedAt: savedSurveyTime,
  sourceClientIds: array(workspaceUuid, 100),
  definition: surveyDefinition,
});
const blockShape = object(
  {
    id: text,
    kind: vocabulary(() => NEWSLETTER_BLOCK_KINDS),
    html: text,
    text,
    url: text,
    imageUrl: text,
    alt: text,
    headingLevel: literal(1, 2, 3, 4),
    linkType: literal('web', 'email', 'phone', 'file', 'anchor'),
    openNewTab: bool,
    imageSize: literal('original', 'fill', 'scale'),
    imageScale: number,
    crop: nullable(object({ x: number, y: number, width: number, height: number })),
    items: array(link, 30),
    question: text,
    options: array(text, 10),
    sourceKind: literal('bill', 'news', 'tweet', 'event', 'product', 'people'),
    ratio: text,
    mobileOrientation: literal('stacked', 'horizontal'),
    columns: array(
      array((value, path) => {
        row(value, path);
      }, 100),
      4,
    ),
    style,
    mobileStyle: style,
    linkedStyles: bool,
    visibility: object({ mode: literal('all', 'custom'), rules: array(rule, 5) }),
  },
  {
    app: object({
      kind: literal('link-preview'),
      sourceUrl: text,
      title: text,
      description: text,
      imageUrl: text,
      size: literal('small', 'medium', 'large'),
      showImage: bool,
      showDescription: bool,
      showBackground: bool,
    }),
    social,
    video: object(
      { thumbnail: literal('auto', 'custom'), sourceUrl: text },
      { paddingLinked: bool },
    ),
    survey: object({
      kind: literal('saved-survey'),
      saved: nullable(savedSurvey),
      blockBackground: text,
      paddingLinked: bool,
    }),
  },
);
const headingStyles = object({ p: style, h1: style, h2: style, h3: style, h4: style });
const emailStyles = object({
  background: text,
  content: text,
  backgroundImage: text,
  width: number,
  mobilePadding: number,
  text: headingStyles,
  mobileText: headingStyles,
  link: style,
  button: style,
  divider: style,
  image: style,
  logo: style,
  linkedStyles: bool,
  mobileButton: style,
  mobileDivider: style,
  mobileImage: style,
  mobileLogo: style,
});
const design: Rule = (value, path) => {
  object(
    {
      version: literal(1),
      styles: emailStyles,
      sections: array(
        object(
          {
            id: text,
            name: text,
            style,
            blocks: array(blockShape, 200),
          },
          { sourceClientIds: clients, fonts },
        ),
        50,
      ),
    },
    { sourceClientIds: clients, fonts },
  )(value, path);
  const record = row(value, path);
  let count = 0;
  const visitBlock = (value: NewsletterJson, path: string, depth: number): void => {
    if (++count > 500 || depth > 6) refuse(path, 'limit_exceeded');
    blockShape(value, path);
    const block = row(value, path);
    const columns = block.columns as NewsletterJson[][];
    columns.forEach((column, index) =>
      column.forEach((child, childIndex) =>
        visitBlock(child, `${path}.columns.${index}.${childIndex}`, depth + 1),
      ),
    );
  };
  (record.sections as NewsletterJsonObject[]).forEach((section, index) =>
    (section.blocks as NewsletterJson[]).forEach((block, blockIndex) =>
      visitBlock(block, `${path}.sections.${index}.blocks.${blockIndex}`, 0),
    ),
  );
};
const config = object({
  clientId: nullable(workspaceUuid),
  clientName: text,
  fromName: text,
  fromEmail: text,
  replyTo: text,
  subject: text,
  previewText: text,
  recipientIds: array(text, 10_000),
  excludeRecipientIds: array(text, 10_000),
  personalizeTo: bool,
  toName: text,
  schedule: object({
    mode: literal('now', 'scheduled', 'triggered'),
    sendAt: nullable(text),
    timeZone: text,
    optimization: bool,
    timewarp: bool,
    batch: bool,
    batchCount: number,
    batchMinutes: number,
    trigger: literal(
      'signup',
      'tag_added',
      'campaign_sent',
      'campaign_link_click',
      'merge_changed',
    ),
    triggerValue: text,
  }),
  tracking: object({
    opens: bool,
    clicks: bool,
    plainTextClicks: bool,
    inbox: bool,
    autoConvertVideo: bool,
    ecommerce: bool,
    googleAnalytics: bool,
    googleAnalyticsTitle: text,
    clickTale: bool,
  }),
  autoResend: object({
    enabled: bool,
    afterDays: number,
    time: text,
    subject: text,
    audience: literal('not-opened', 'engaged-not-opened'),
    ignoreBotOpens: bool,
  }),
  experiment: object({
    enabled: bool,
    subjects: array(text, 3),
    testPercent: number,
    winnerMetric: literal('opens', 'clicks'),
    waitHours: number,
  }),
  socialCard: object({ enabled: bool, title: text, description: text, imageUrl: text }),
  shareSlug: text,
  company: text,
  mailingAddress: text,
  permissionReminder: text,
  plainText: text,
  plainTextAuto: bool,
});
const campaign = object({
  id: workspaceUuid,
  name: text,
  revision,
  status: literal('draft', 'staged'),
  ownerId: text,
  updatedAt: timestamp,
  config,
  design,
});
const check = object(
  { id: text, severity: literal('error', 'warning', 'pass'), label: text, detail: text },
  { blockId: text },
);
const stageRead = object({
  id: uuid,
  documentId: workspaceUuid,
  revision,
  name: text,
  config,
  design,
});
const draftVersion = object(
  {
    id: uuid,
    artifactId: uuid,
    outreachRecordId: uuid,
    version: revision,
    sourceVersionId: nullable(uuid),
    generationKey: text,
    recipientKey: text,
    audienceKind: text,
    subject: text,
    body: text,
    contentHash: (value, path) => {
      if (typeof value !== 'string' || !/^sha256:[a-f\d]{64}$/i.test(value)) refuse(path);
    },
    generationStatus: literal('generated', 'manually_authored', 'generation_failed'),
    auditStatus: literal('not_required', 'pending', 'passed', 'warning', 'held', 'unavailable'),
    approvalStatus: literal('not_required', 'pending', 'approved', 'rejected'),
    auditDecision: nullable(text),
    auditChecks: array(object({ check: text, severity: text })),
    reviewRequestId: nullable(uuid),
    provider: nullable(text),
    model: nullable(text),
    promptSpecVersion: nullable(text),
    sendable: bool,
    createdAt: timestamp,
    recipientEmail: text,
  },
  { contextNote: text },
);
function receive<T>(
  input: unknown,
  rule: Rule,
  inspect?: (value: NewsletterJson) => void,
  documentCount = 1,
): NewsletterReceiveResult<T> {
  try {
    const value = snapshot(input, documentCount);
    rule(value, '$');
    inspect?.(value);
    // Every known nested field has been structurally validated; extra JSON is preserved, not cast unchecked.
    return { ok: true, value: value as T };
  } catch (error) {
    const failure =
      error && (typeof error === 'object' || typeof error === 'function')
        ? failures.get(error)
        : undefined;
    return { ok: false, error: failure ?? { code: 'invalid_json', path: '$' } };
  }
}
function identity(
  value: NewsletterJsonObject,
  expected: unknown,
  keys: ('documentId' | 'stageId' | 'recordId' | 'revision' | 'clientId')[],
): void {
  if (expected === undefined) return;
  const binding = snapshot(expected);
  const spec = row(binding, '$expected');
  const allowed = new Set(keys);
  for (const key of Object.keys(spec)) {
    if (!allowed.has(key as (typeof keys)[number])) refuse(`$expected.${key}`);
    const wanted = spec[key]!;
    (key === 'revision'
      ? revision
      : key === 'clientId'
        ? nullable(workspaceUuid)
        : key === 'documentId'
          ? workspaceUuid
          : uuid)(wanted, `$expected.${key}`);
    const actual = value[key];
    const equal =
      typeof wanted === 'string' && typeof actual === 'string'
        ? wanted.toLowerCase() === actual.toLowerCase()
        : wanted === actual;
    if (!equal) refuse(`$.${key}`, 'identity_mismatch');
  }
}
function resourceIdentity(
  value: NewsletterJsonObject,
  idKey: 'documentId' | 'stageId' | 'recordId',
  expected: unknown,
  hasClient = false,
): void {
  identity(
    {
      ...value,
      [idKey]: value.id!,
      ...(hasClient ? { clientId: row(value.config!, '$.config').clientId! } : {}),
    },
    expected,
    [
      idKey,
      ...(idKey === 'stageId' ? ['documentId' as const] : []),
      'revision',
      ...(hasClient ? ['clientId' as const] : []),
    ],
  );
}
/** Create, GET and CAS-save all return the same direct campaign shape; no wrapper is accepted. */
export function parseNewsletterCampaign(
  value: unknown,
  expected?: Pick<NewsletterReceiveIdentity, 'documentId' | 'revision' | 'clientId'>,
): NewsletterReceiveResult<NewsletterCampaign> {
  return receive(value, campaign, (value) =>
    resourceIdentity(row(value, '$'), 'documentId', expected, true),
  );
}
export function parseNewsletterDocumentList(
  value: unknown,
): NewsletterReceiveResult<NewsletterDocumentList> {
  // Each list member can be a full independently bounded document.
  return receive(value, object({ items: array(campaign, 100) }), undefined, 100);
}
export function parseNewsletterChecks(value: unknown): NewsletterReceiveResult<NewsletterCheck[]> {
  return receive(value, array(check));
}
/** HTML is wire text here. Rendering in a browser still requires the consumer's sanitation boundary. */
export function parseNewsletterPreview(value: unknown): NewsletterReceiveResult<NewsletterPreview> {
  return receive(value, object({ html: text, plainText: text, checks: array(check) }));
}
export function parseNewsletterHtmlCheck(
  value: unknown,
  expected?: Pick<NewsletterReceiveIdentity, 'revision'>,
): NewsletterReceiveResult<NewsletterHtmlCheck> {
  return receive(
    value,
    object({
      provider: literal('Mailtrap'),
      issues: strings,
      report: (value, path) => {
        row(value, path);
      },
      revision,
      checkedAt: timestamp,
    }),
    (value) => identity(row(value, '$'), expected, ['revision']),
  );
}
export function parseNewsletterStageReceipt(
  value: unknown,
  expected?: Pick<NewsletterReceiveIdentity, 'stageId' | 'documentId' | 'revision'>,
): NewsletterReceiveResult<NewsletterStage> {
  return receive(
    value,
    object({
      id: uuid,
      documentId: workspaceUuid,
      revision,
      name: text,
      createdAt: timestamp,
      route: text,
    }),
    (value) => {
      const stage = row(value, '$');
      if ('design' in stage || 'config' in stage) refuse('$');
      const prefix = '/engagement/outreach?newsletterStage=';
      const route = stage.route as string;
      if (!route.startsWith(prefix)) refuse('$.route');
      const target = route.slice(prefix.length);
      uuid(target, '$.route');
      if (target.toLowerCase() !== (stage.id as string).toLowerCase())
        refuse('$.route', 'identity_mismatch');
      resourceIdentity(stage, 'stageId', expected);
    },
  );
}
export function parseNewsletterOutreachStage(
  value: unknown,
  expected?: Pick<NewsletterReceiveIdentity, 'stageId' | 'documentId' | 'revision' | 'clientId'>,
): NewsletterReceiveResult<NewsletterOutreachStage> {
  return receive(value, stageRead, (value) => {
    const stage = row(value, '$');
    if ('createdAt' in stage || 'route' in stage) refuse('$');
    resourceIdentity(stage, 'stageId', expected, true);
  });
}
export function parseNewsletterOutreachRecord(
  value: unknown,
  expected?: NewsletterReceiveIdentity,
): NewsletterReceiveResult<NewsletterOutreachRecord> {
  return receive(
    value,
    object({
      id: uuid,
      status: text,
      name: text,
      stage: stageRead,
      targets: array((value, path) => {
        row(value, path);
      }, 500),
      senderConnectionId: nullable(uuid),
      subject: text,
      versions: array(draftVersion, 500),
      intentId: nullable(uuid),
      excluded: strings,
      tests: array(
        object({ id: uuid, requestKey: text, senderConnectionId: uuid, versionId: uuid }),
      ),
    }),
    (value) => {
      const record = row(value, '$');
      const stage = row(record.stage!, '$.stage');
      if ('createdAt' in stage || 'route' in stage) refuse('$.stage');
      identity(
        {
          recordId: record.id!,
          stageId: stage.id!,
          documentId: stage.documentId!,
          revision: stage.revision!,
          clientId: row(stage.config!, '$.stage.config').clientId!,
        },
        expected,
        ['recordId', 'stageId', 'documentId', 'revision', 'clientId'],
      );
      const versions = record.versions as NewsletterJsonObject[];
      const versionIds = new Set<string>();
      for (const [index, version] of versions.entries()) {
        if (
          (version.outreachRecordId as string).toLowerCase() !== (record.id as string).toLowerCase()
        )
          refuse(`$.versions.${index}.outreachRecordId`, 'identity_mismatch');
        const id = (version.id as string).toLowerCase();
        if (versionIds.has(id)) refuse(`$.versions.${index}.id`);
        versionIds.add(id);
      }
      for (const [index, test] of (record.tests as NewsletterJsonObject[]).entries()) {
        if (!versionIds.has((test.versionId as string).toLowerCase()))
          refuse(`$.tests.${index}.versionId`, 'identity_mismatch');
        if (
          record.senderConnectionId === null ||
          (test.senderConnectionId as string).toLowerCase() !==
            (record.senderConnectionId as string).toLowerCase()
        )
          refuse(`$.tests.${index}.senderConnectionId`, 'identity_mismatch');
      }
    },
  );
}
/** Unrelated metadata is deliberately projected away. Null/absent metadata has no rich hint. */
export function parseNewsletterReservedMetadata(
  value: unknown,
): NewsletterReceiveResult<NewsletterReservedMetadata> {
  if (value === undefined || value === null) return { ok: true, value: {} };
  const result = receive<NewsletterJsonObject>(
    value,
    object({}, { newsletterStageId: uuid, newsletterRevision: revision }),
  );
  if (!result.ok) return result;
  const parsed: NewsletterReservedMetadata = {};
  if (Object.prototype.hasOwnProperty.call(result.value, 'newsletterStageId'))
    parsed.newsletterStageId = result.value.newsletterStageId as string;
  if (Object.prototype.hasOwnProperty.call(result.value, 'newsletterRevision'))
    parsed.newsletterRevision = result.value.newsletterRevision as number;
  return { ok: true, value: parsed };
}
/** Wrong-type rich hints fail before a generic plain-text writer can select the record. */
export function parseNewsletterRecordDiscriminator(
  value: unknown,
): NewsletterReceiveResult<NewsletterRecordDiscriminator> {
  const input = receive<NewsletterJsonObject>(
    value,
    object(
      { type: text },
      {
        metadata: nullable((value, path) => {
          row(value, path);
        }),
      },
    ),
  );
  if (!input.ok) return input;
  const reserved = parseNewsletterReservedMetadata(
    Object.prototype.hasOwnProperty.call(input.value, 'metadata')
      ? input.value.metadata
      : undefined,
  );
  if (!reserved.ok) return reserved;
  const stageId = Object.prototype.hasOwnProperty.call(reserved.value, 'newsletterStageId')
    ? reserved.value.newsletterStageId
    : undefined;
  if (stageId === undefined)
    return { ok: true, value: { kind: 'ordinary', metadata: reserved.value } };
  if (input.value.type !== 'outbound_campaign')
    return { ok: false, error: { code: 'invalid_shape', path: '$.type' } };
  return {
    ok: true,
    value: {
      kind: 'rich',
      metadata: { ...reserved.value, newsletterStageId: stageId },
    },
  };
}
