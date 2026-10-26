/** Pure receiving contracts. These parsers validate wire data, never authorize an action. */
import { savedSurvey } from './newsletter-survey-receiving.js';
import type {
  NewsletterCampaign,
  NewsletterCampaignConfig,
  NewsletterCheck,
  NewsletterComment,
  NewsletterDesign,
  NewsletterLibraryItem,
  NewsletterPreview,
  NewsletterStage,
  NewsletterWriteReceipt,
  NewsletterSaveRefusal,
} from './newsletter.js';
import {
  NEWSLETTER_BLOCK_KINDS,
  NEWSLETTER_SOCIAL_PLATFORMS,
  NEWSLETTER_SOCIAL_SHARE_PLATFORMS,
  NEWSLETTER_SOCIAL_ICON_STYLES,
} from './newsletter.js';

import {
  array,
  bool,
  literal,
  nullable,
  number,
  object,
  receive,
  refuse,
  revision,
  row,
  snapshot,
  text,
  timestamp,
  uuid,
  vocabulary,
  workspaceUuid,
  JSON_RECEIVE_LIMITS as NEWSLETTER_RECEIVE_LIMITS,
  type Json as NewsletterJson,
  type JsonObject as NewsletterJsonObject,
  type ReceiveResult as NewsletterReceiveResult,
  type Rule,
} from './json-receiving.js';
export type {
  Json as NewsletterJson,
  JsonObject as NewsletterJsonObject,
  ReceiveResult as NewsletterReceiveResult,
} from './json-receiving.js';
export { JSON_RECEIVE_LIMITS as NEWSLETTER_RECEIVE_LIMITS } from './json-receiving.js';

/** Canonical immutable draft response vocabulary; policy remains in the Core owner. */
export type DraftGenerationStatus = 'generated' | 'manually_authored' | 'generation_failed';
export type DraftAuditStatus =
  | 'not_required'
  | 'pending'
  | 'passed'
  | 'warning'
  | 'held'
  | 'unavailable';
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
/** The section endpoint never returns template design/config or a write receipt. */
export type NewsletterSectionLibraryItem = Omit<
  NewsletterLibraryItem,
  'design' | 'config' | 'section'
> &
  Required<Pick<NewsletterLibraryItem, 'section'>>;
export interface NewsletterLibraryList {
  items: NewsletterSectionLibraryItem[];
}
/** A saved template has design content and optional legacy company/footer configuration. */
export type NewsletterTemplateLibraryItem = Omit<NewsletterLibraryItem, 'section' | 'design'> &
  Required<Pick<NewsletterLibraryItem, 'design'>>;
export interface NewsletterTemplateLibraryList {
  items: NewsletterTemplateLibraryItem[];
}
/** An owned image item, including an upload response; never an upload-request receipt. */
export interface NewsletterAssetItem {
  id: string;
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** Managed public capability URL; syntax supplies neither origin trust nor current access. */
  url: string;
}
/** One requested page. Rows and total are separate current reads, not an atomic snapshot. */
export interface NewsletterAssetList {
  page: number;
  pageSize: 10 | 25 | 50 | 100;
  total: number;
  items: NewsletterAssetItem[];
}
export interface NewsletterAssetDetails extends NewsletterAssetItem {
  createdAt: string;
  sizeBytes: number;
  revisionNumber: number;
  currentRevision: boolean;
}
/** Actual persisted comment wire, including the service's document and tenant fields. */
export interface NewsletterReviewComment extends NewsletterComment {
  tenantId: string;
  documentId: string;
}
/** Current take-500 collection; neither completeness nor an acknowledged comment write. */
export interface NewsletterComments {
  items: NewsletterReviewComment[];
}
/** Saved rendered content and current role, never an editable campaign or revision receipt. */
export interface NewsletterReview {
  id: string;
  name: string;
  role: 'owner' | 'editor' | 'commenter' | 'viewer';
  html: string;
  comments: NewsletterReviewComment[];
}
/** Unbound rendering remains usable as content, never as an exact saved-revision receipt. */
export type NewsletterPreviewContent = Pick<NewsletterPreview, 'html' | 'plainText' | 'checks'>;
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
export interface NewsletterPrepareResult {
  versions: NewsletterOutreachVersion[];
  excluded: string[];
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
export interface NewsletterReceiveIdentity {
  documentId?: string;
  stageId?: string;
  recordId?: string;
  revision?: number;
  clientId?: string | null;
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
const sectionFields = { id: text, name: text, style, blocks: array(blockShape, 200) };
const sectionShape = object(sectionFields, { sourceClientIds: clients, fonts });
/** Share recursion and the aggregate block budget between document and library receiving. */
function sectionBlockInspector(): Rule {
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
  return (value, path) => {
    (row(value, path).blocks as NewsletterJson[]).forEach((block, index) =>
      visitBlock(block, `${path}.blocks.${index}`, 0),
    );
  };
}
const design: Rule = (value, path) => {
  object(
    { version: literal(1), styles: emailStyles, sections: array(sectionShape, 50) },
    // Save unions current and historical authorized clients after request normalization.
    // Persisted root provenance therefore uses the explicit receiving array budget.
    { sourceClientIds: array(workspaceUuid, NEWSLETTER_RECEIVE_LIMITS.arrayLength), fonts },
  )(value, path);
  const inspect = sectionBlockInspector();
  (row(value, path).sections as NewsletterJson[]).forEach((section, index) =>
    inspect(section, `${path}.sections.${index}`),
  );
};
const librarySection: Rule = (value, path) => {
  // saveLibrary copies document-wide client/font unions, not just this section's inputs.
  object(sectionFields, {
    sourceClientIds: array(workspaceUuid, NEWSLETTER_RECEIVE_LIMITS.arrayLength),
    fonts: array(font, NEWSLETTER_RECEIVE_LIMITS.arrayLength),
  })(value, path);
  sectionBlockInspector()(value, path);
};
const libraryItemFields: Record<string, Rule> = {
  id: workspaceUuid,
  name: (value, path) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 200) refuse(path);
  },
  folder: (value, path) => {
    if (typeof value !== 'string' || value.length > 100) refuse(path);
  },
  updatedAt: timestamp,
  section: librarySection,
};
const libraryItem: Rule = (value, path) => {
  object(libraryItemFields)(value, path);
  for (const key of Object.keys(row(value, path)))
    if (!Object.prototype.hasOwnProperty.call(libraryItemFields, key)) refuse(`${path}.${key}`);
};
const templateItemFields = {
  id: libraryItemFields.id!,
  name: libraryItemFields.name!,
  folder: libraryItemFields.folder!,
  updatedAt: libraryItemFields.updatedAt!,
  design,
};
// These are the existing config text guards, restricted to the producer's saved footer subset.
const templateConfigFields = { company: text, mailingAddress: text, permissionReminder: text };
const templateConfig: Rule = (value, path) => {
  object(templateConfigFields)(value, path);
  for (const key of Object.keys(row(value, path)))
    if (!Object.prototype.hasOwnProperty.call(templateConfigFields, key)) refuse(`${path}.${key}`);
};
const templateItem: Rule = (value, path) => {
  object(templateItemFields, { config: templateConfig })(value, path);
  for (const key of Object.keys(row(value, path)))
    if (key !== 'config' && !Object.prototype.hasOwnProperty.call(templateItemFields, key))
      refuse(`${path}.${key}`);
};
const assetFields = {
  id: workspaceUuid,
  name: (value: NewsletterJson, path: string) => {
    // upload sanitizes the original filename but can leave it empty or whitespace-only.
    if (typeof value !== 'string' || value.length > 200) refuse(path);
  },
  mimeType: literal('image/png', 'image/jpeg', 'image/gif', 'image/webp'),
  url: (value: NewsletterJson, path: string) => {
    if (typeof value !== 'string' || !/^https?:\/\/[^/]/i.test(value) || /[\s\\]/.test(value))
      refuse(path);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      refuse(path);
    }
    // The configured public base may include a port/path. Do not hardcode its origin,
    // infer ownership from its token, or turn receiving into permission to fetch it.
    const suffix = /\/workspace-api\/newsletters\/assets\/file\/[a-f0-9]{64}$/;
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !suffix.test(value) ||
      !suffix.test(url.pathname)
    )
      refuse(path);
  },
};
const assetItem: Rule = (value, path) => {
  object(assetFields)(value, path);
  for (const key of Object.keys(row(value, path)))
    if (!Object.prototype.hasOwnProperty.call(assetFields, key)) refuse(`${path}.${key}`);
};
const assetDetailFields = {
  ...assetFields,
  createdAt: timestamp,
  sizeBytes: (value: NewsletterJson, path: string) => {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > 10 * 1024 * 1024
    )
      refuse(path);
  },
  revisionNumber: revision,
  currentRevision: bool,
};
const commentFields = {
  id: workspaceUuid,
  tenantId: workspaceUuid,
  documentId: workspaceUuid,
  campaignId: workspaceUuid,
  authorId: text,
  authorName: text,
  blockId: nullable((value, path) => {
    if (typeof value !== 'string' || value.length > 100) refuse(path);
  }),
  parentId: nullable(workspaceUuid),
  message: (value: NewsletterJson, path: string) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 10000) refuse(path);
  },
  resolved: bool,
  createdAt: timestamp,
};
const comment: Rule = (value, path) => {
  object(commentFields)(value, path);
  for (const key of Object.keys(row(value, path)))
    if (!Object.prototype.hasOwnProperty.call(commentFields, key)) refuse(`${path}.${key}`);
};
const reviewFields = {
  id: workspaceUuid,
  name: (value: NewsletterJson, path: string) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 200) refuse(path);
  },
  role: literal('owner', 'editor', 'commenter', 'viewer'),
  html: text,
  comments: array(comment, 500),
};
function bindReviewComments(items: NewsletterJson, path: string, expected: unknown): string {
  const binding = row(snapshot(expected), '$expected');
  object({ documentId: workspaceUuid })(binding, '$expected');
  for (const key of Object.keys(binding)) if (key !== 'documentId') refuse(`$expected.${key}`);
  const documentId = (binding.documentId as string).toLowerCase();
  (items as NewsletterJsonObject[]).forEach((item, index) => {
    for (const key of ['documentId', 'campaignId'])
      if ((item[key] as string).toLowerCase() !== documentId)
        refuse(`${path}.${index}.${key}`, 'identity_mismatch');
  });
  return documentId;
}
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
/** Current document content only. It is not an acknowledgement of an earlier write. */
export function parseNewsletterCampaign(
  value: unknown,
  expected?: Pick<NewsletterReceiveIdentity, 'documentId' | 'revision' | 'clientId'>,
): NewsletterReceiveResult<NewsletterCampaign> {
  return receive(value, campaign, (value) =>
    resourceIdentity(row(value, '$'), 'documentId', expected, true),
  );
}
export type NewsletterWriteBinding = {
  requestId: string;
  inputHash?: string;
  contentHash?: string;
} & ({ operation: 'create' } | { operation: 'save'; documentId: string; previousRevision: number });
/** A committed receipt is usable only with the retained request binding. GET null
 * is handled separately by the caller; absence is never a permission to redispatch. */
export function parseNewsletterWriteReceipt(
  value: unknown,
  expected: NewsletterWriteBinding,
): NewsletterReceiveResult<NewsletterWriteReceipt> {
  const hash: Rule = (value, path) => {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) refuse(path);
  };
  const fields = {
    requestId: workspaceUuid,
    operation: literal('create', 'save'),
    documentId: workspaceUuid,
    previousRevision: nullable(revision),
    revision,
    inputHash: hash,
    contentHash: hash,
    hashFormat: literal('newsletter-write-jcs-v1'),
    createdAt: timestamp,
  };
  return receive(value, object(fields), (value) => {
    const receipt = row(value, '$');
    for (const key of Object.keys(receipt))
      if (!Object.prototype.hasOwnProperty.call(fields, key)) refuse(`$.${key}`);
    if (receipt.operation === 'create') {
      if (receipt.previousRevision !== null || receipt.revision !== 1) refuse('$.revision');
    } else if (
      typeof receipt.previousRevision !== 'number' ||
      receipt.revision !== receipt.previousRevision + 1
    )
      refuse('$.revision');
    const binding = row(snapshot(expected), '$expected');
    object(
      { requestId: workspaceUuid, operation: literal('create', 'save') },
      { inputHash: hash, contentHash: hash },
    )(binding, '$expected');
    const keys = ['requestId', 'operation', 'inputHash', 'contentHash'];
    if (binding.operation === 'save') {
      object({ documentId: workspaceUuid, previousRevision: revision })(binding, '$expected');
      keys.push('documentId', 'previousRevision');
    }
    for (const key of Object.keys(binding)) {
      if (!keys.includes(key)) refuse(`$expected.${key}`);
      const wanted = binding[key],
        actual = receipt[key];
      const equal =
        key === 'requestId' || key === 'documentId'
          ? String(wanted).toLowerCase() === String(actual).toLowerCase()
          : wanted === actual;
      if (!equal) refuse(`$.${key}`, 'identity_mismatch');
    }
  });
}
/** Only the matched acknowledged attempt may be retired. Generic errors/absence are unknown. */
export function parseNewsletterSaveRefusal(
  value: unknown,
  expected: Pick<
    NewsletterSaveRefusal,
    'requestId' | 'operation' | 'documentId' | 'previousRevision'
  >,
): NewsletterReceiveResult<NewsletterSaveRefusal> {
  const bindingFields = {
    requestId: workspaceUuid,
    operation: literal('save'),
    documentId: workspaceUuid,
    previousRevision: revision,
  };
  const fields = {
    code: literal('NEWSLETTER_SAVE_CAS_REFUSED'),
    disposition: literal('not_committed'),
    ...bindingFields,
  };
  return receive(value, object(fields), (value) => {
    const refusal = row(value, '$');
    for (const key of Object.keys(refusal))
      if (!Object.prototype.hasOwnProperty.call(fields, key)) refuse(`$.${key}`);
    const binding = row(snapshot(expected), '$expected');
    object(bindingFields)(binding, '$expected');
    for (const key of Object.keys(binding)) {
      if (!Object.prototype.hasOwnProperty.call(bindingFields, key)) refuse(`$expected.${key}`);
      const equal =
        key === 'requestId' || key === 'documentId'
          ? String(binding[key]).toLowerCase() === String(refusal[key]).toLowerCase()
          : binding[key] === refusal[key];
      if (!equal) refuse(`$.${key}`, 'identity_mismatch');
    }
  });
}
export function parseNewsletterDocumentList(
  value: unknown,
): NewsletterReceiveResult<NewsletterDocumentList> {
  // Each list member can be a full independently bounded document.
  return receive(value, object({ items: array(campaign, 100) }), undefined, 100);
}
/** Current saved-section content only; templates and causal write receipts are not admitted. */
export function parseNewsletterLibraryItem(
  value: unknown,
): NewsletterReceiveResult<NewsletterSectionLibraryItem> {
  return receive(value, libraryItem);
}
/** The current visible collection, at most 500 rows. No pagination or lost-write proof. */
export function parseNewsletterLibraryList(
  value: unknown,
): NewsletterReceiveResult<NewsletterLibraryList> {
  return receive(
    value,
    object({ items: array(libraryItem, 500) }),
    (value) => {
      for (const key of Object.keys(row(value, '$'))) if (key !== 'items') refuse(`$.${key}`);
    },
    500,
  );
}
/** Acknowledged template content only. No document/request identity or save revision is echoed. */
export function parseNewsletterTemplateItem(
  value: unknown,
  expected?: { id: string },
): NewsletterReceiveResult<NewsletterTemplateLibraryItem> {
  return receive(value, templateItem, (parsed) => {
    if (expected === undefined) return;
    const binding = row(snapshot(expected), '$expected');
    object({ id: workspaceUuid })(binding, '$expected');
    for (const key of Object.keys(binding)) if (key !== 'id') refuse(`$expected.${key}`);
    if ((binding.id as string).toLowerCase() !== (row(parsed, '$').id as string).toLowerCase())
      refuse('$.id', 'identity_mismatch');
  });
}
/** Current visible templates, at most 500; never pagination, completeness or lost-write proof. */
export function parseNewsletterTemplateList(
  value: unknown,
): NewsletterReceiveResult<NewsletterTemplateLibraryList> {
  return receive(
    value,
    object({ items: array(templateItem, 500) }),
    (parsed) => {
      for (const key of Object.keys(row(parsed, '$'))) if (key !== 'items') refuse(`$.${key}`);
      const seen = new Set<string>();
      (row(parsed, '$').items as NewsletterJsonObject[]).forEach((item, index) => {
        const id = (item.id as string).toLowerCase();
        if (seen.has(id)) refuse(`$.items.${index}.id`);
        seen.add(id);
      });
    },
    500,
  );
}
/** Acknowledged item content only: no request identity, replay safety or inferred upload outcome. */
export function parseNewsletterAssetItem(
  value: unknown,
): NewsletterReceiveResult<NewsletterAssetItem> {
  return receive(value, assetItem);
}
export function parseNewsletterAssetList(
  value: unknown,
): NewsletterReceiveResult<NewsletterAssetList> {
  const fields = {
    page: (value: NewsletterJson, path: string) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100_000)
        refuse(path);
    },
    pageSize: literal(10, 25, 50, 100),
    total: (value: NewsletterJson, path: string) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) refuse(path);
    },
    items: array(assetItem, 100),
  };
  return receive(value, object(fields), (value) => {
    const page = row(value, '$');
    for (const key of Object.keys(page))
      if (!Object.prototype.hasOwnProperty.call(fields, key)) refuse(`$.${key}`);
    if ((page.items as NewsletterJson[]).length > (page.pageSize as number))
      refuse('$.items', 'limit_exceeded');
  });
}
/** The requested asset UUID is mandatory; its public URL token is a different identifier. */
export function parseNewsletterAssetDetails(
  value: unknown,
  expected: { assetId: string },
): NewsletterReceiveResult<NewsletterAssetDetails> {
  return receive(value, object(assetDetailFields), (value) => {
    const details = row(value, '$');
    for (const key of Object.keys(details))
      if (!Object.prototype.hasOwnProperty.call(assetDetailFields, key)) refuse(`$.${key}`);
    const binding = row(snapshot(expected), '$expected');
    object({ assetId: workspaceUuid })(binding, '$expected');
    for (const key of Object.keys(binding)) if (key !== 'assetId') refuse(`$expected.${key}`);
    if ((details.id as string).toLowerCase() !== (binding.assetId as string).toLowerCase())
      refuse('$.id', 'identity_mismatch');
  });
}
/** Current review only. Core still owns access; consumers must sanitize displayed HTML. */
export function parseNewsletterReview(
  value: unknown,
  expected: { documentId: string },
): NewsletterReceiveResult<NewsletterReview> {
  return receive(value, object(reviewFields), (value) => {
    const review = row(value, '$');
    for (const key of Object.keys(review))
      if (!Object.prototype.hasOwnProperty.call(reviewFields, key)) refuse(`$.${key}`);
    const documentId = bindReviewComments(review.comments!, '$.comments', expected);
    if ((review.id as string).toLowerCase() !== documentId) refuse('$.id', 'identity_mismatch');
  });
}
/** A current bounded read cannot settle an unknown comment mutation or imply mail delivery. */
export function parseNewsletterComments(
  value: unknown,
  expected: { documentId: string },
): NewsletterReceiveResult<NewsletterComments> {
  return receive(value, object({ items: array(comment, 500) }), (value) => {
    const comments = row(value, '$');
    for (const key of Object.keys(comments)) if (key !== 'items') refuse(`$.${key}`);
    bindReviewComments(comments.items!, '$.items', expected);
  });
}
export function parseNewsletterChecks(value: unknown): NewsletterReceiveResult<NewsletterCheck[]> {
  return receive(value, array(check));
}
/**
 * Supply both expected fields to receive a pinned preview. The one-argument form preserves
 * unpinned content compatibility and does not claim a saved revision. Any supplied pin must
 * be complete and valid. The digest is the producer's receipt, not a client-recomputed hash.
 * HTML remains wire text and still requires the consumer's sanitation boundary.
 */
export function parseNewsletterPreview(
  value: unknown,
  expected: Pick<NewsletterPreview, 'documentId' | 'revision'>,
): NewsletterReceiveResult<NewsletterPreview>;
export function parseNewsletterPreview(
  value: unknown,
): NewsletterReceiveResult<NewsletterPreviewContent>;
export function parseNewsletterPreview(
  value: unknown,
  expected?: Pick<NewsletterPreview, 'documentId' | 'revision'>,
): NewsletterReceiveResult<NewsletterPreviewContent> {
  return receive(
    value,
    (value, path) => {
      object({ html: text, plainText: text, checks: array(check) })(value, path);
      const preview = row(value, path);
      if (
        expected !== undefined ||
        ['documentId', 'revision', 'renderHash', 'hashFormat'].some((key) =>
          Object.prototype.hasOwnProperty.call(preview, key),
        )
      )
        object({
          documentId: workspaceUuid,
          revision,
          renderHash: (value, path) => {
            if (typeof value !== 'string' || !/^[a-f\d]{64}$/.test(value)) refuse(path);
          },
          hashFormat: literal('newsletter-render-json-v1'),
        })(value, path);
    },
    (value) => {
      if (expected === undefined) return;
      object({ documentId: workspaceUuid, revision })(snapshot(expected), '$expected');
      identity(row(value, '$'), expected, ['documentId', 'revision']);
    },
  );
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
        // Historical intents can reference a prepared version omitted by current-version filtering.
        // Their presence never supplies approval for a currently returned version.
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
/** Preparation imports immutable versions; it does not queue or deliver mail. */
export function parseNewsletterPrepareResult(
  value: unknown,
  expected: { recordId: string },
): NewsletterReceiveResult<NewsletterPrepareResult> {
  return receive(value, object({ versions: array(draftVersion, 500), excluded: strings }), (value) => {
    const binding = row(snapshot(expected), '$expected');
    uuid(binding.recordId!, '$expected.recordId');
    const seen = new Set<string>();
    for (const [index, item] of (row(value, '$').versions as NewsletterJsonObject[]).entries()) {
      const id = (item.id as string).toLowerCase();
      if ((item.outreachRecordId as string).toLowerCase() !== (binding.recordId as string).toLowerCase())
        refuse(`$.versions.${index}.outreachRecordId`, 'identity_mismatch');
      if (seen.has(id)) refuse(`$.versions.${index}.id`);
      seen.add(id);
    }
  });
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
