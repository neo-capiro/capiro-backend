"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NEWSLETTER_RECEIVE_LIMITS = void 0;
exports.parseNewsletterCampaign = parseNewsletterCampaign;
exports.parseNewsletterDocumentList = parseNewsletterDocumentList;
exports.parseNewsletterChecks = parseNewsletterChecks;
exports.parseNewsletterPreview = parseNewsletterPreview;
exports.parseNewsletterHtmlCheck = parseNewsletterHtmlCheck;
exports.parseNewsletterStageReceipt = parseNewsletterStageReceipt;
exports.parseNewsletterOutreachStage = parseNewsletterOutreachStage;
exports.parseNewsletterOutreachRecord = parseNewsletterOutreachRecord;
exports.parseNewsletterReservedMetadata = parseNewsletterReservedMetadata;
exports.parseNewsletterRecordDiscriminator = parseNewsletterRecordDiscriminator;
const newsletter_js_1 = require("./newsletter.js");
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
exports.NEWSLETTER_RECEIVE_LIMITS = Object.freeze({
    jsonDepth: 64,
    jsonNodes: 2_000_000,
    objectKeys: 10_000,
    arrayLength: 100_000,
    stringLength: 200_000_000,
    totalStringLength: 1_000_000_000,
});
const failures = new WeakMap();
function refuse(path, code = 'invalid_shape') {
    const token = {};
    failures.set(token, { code, path });
    throw token;
}
function plain(value) {
    const proto = Object.getPrototypeOf(value);
    if (proto === null || proto === Object.prototype)
        return true;
    // Permit another realm's ordinary Object.prototype without invoking its methods.
    if (Object.getPrototypeOf(proto) !== null)
        return false;
    const constructor = Object.getOwnPropertyDescriptor(proto, 'constructor');
    if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function')
        return false;
    const prototype = Object.getOwnPropertyDescriptor(constructor.value, 'prototype');
    return Boolean(prototype && 'value' in prototype && prototype.value === proto);
}
function snapshot(input, documentCount = 1) {
    let nodes = 0;
    let characters = 0;
    const active = new Set();
    const visit = (value, path, depth) => {
        if (++nodes > exports.NEWSLETTER_RECEIVE_LIMITS.jsonNodes * documentCount ||
            depth > exports.NEWSLETTER_RECEIVE_LIMITS.jsonDepth)
            refuse(path, 'limit_exceeded');
        if (value === null || typeof value === 'boolean')
            return value;
        if (typeof value === 'number') {
            if (!Number.isFinite(value))
                refuse(path, 'invalid_json');
            return value;
        }
        if (typeof value === 'string') {
            characters += value.length;
            if (value.length > exports.NEWSLETTER_RECEIVE_LIMITS.stringLength ||
                characters > exports.NEWSLETTER_RECEIVE_LIMITS.totalStringLength)
                refuse(path, 'limit_exceeded');
            return value;
        }
        if (typeof value !== 'object')
            refuse(path, 'invalid_json');
        if (active.has(value))
            refuse(path, 'invalid_json');
        const isArray = Array.isArray(value);
        if (!isArray && !plain(value))
            refuse(path, 'invalid_json');
        const lengthDescriptor = isArray ? Object.getOwnPropertyDescriptor(value, 'length') : undefined;
        const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : 0;
        if (isArray &&
            (!Number.isSafeInteger(length) ||
                length < 0 ||
                length > exports.NEWSLETTER_RECEIVE_LIMITS.arrayLength))
            refuse(path, 'limit_exceeded');
        const keys = Reflect.ownKeys(value);
        if (keys.length > (isArray ? length + 1 : exports.NEWSLETTER_RECEIVE_LIMITS.objectKeys))
            refuse(path, isArray ? 'invalid_json' : 'limit_exceeded');
        if (isArray && keys.length !== length + 1)
            refuse(path, 'invalid_json');
        active.add(value);
        const copy = isArray ? [] : {};
        for (const key of keys) {
            if (isArray && key === 'length')
                continue;
            if (typeof key !== 'string')
                refuse(path, 'invalid_json');
            characters += key.length;
            if (key.length > exports.NEWSLETTER_RECEIVE_LIMITS.stringLength ||
                characters > exports.NEWSLETTER_RECEIVE_LIMITS.totalStringLength)
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
const text = (value, path) => {
    if (typeof value !== 'string')
        refuse(path);
};
const bool = (value, path) => {
    if (typeof value !== 'boolean')
        refuse(path);
};
const number = (value, path) => {
    if (typeof value !== 'number')
        refuse(path);
};
const revision = (value, path) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
        refuse(path);
};
const uuid = (value, path) => {
    if (typeof value !== 'string' || !UUID.test(value))
        refuse(path);
};
const workspaceUuid = (value, path) => {
    if (typeof value !== 'string' || !WORKSPACE_UUID.test(value))
        refuse(path);
};
const savedSurveyId = (value, path) => {
    if (typeof value !== 'string' || !SAVED_SURVEY_ID.test(value))
        refuse(path);
};
const savedSurveyTime = (value, path) => {
    if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value)))
        refuse(path);
};
const timestamp = (value, path) => {
    if (typeof value !== 'string' ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value)
        refuse(path);
};
const literal = (...values) => (value, path) => {
    if (!values.includes(value))
        refuse(path);
};
const vocabulary = (values) => (value, path) => {
    if (typeof value !== 'string' || !values().includes(value))
        refuse(path);
};
const nullable = (rule) => (value, path) => {
    if (value !== null)
        rule(value, path);
};
const array = (rule, max = 100_000) => (value, path) => {
    if (!Array.isArray(value))
        refuse(path);
    if (value.length > max)
        refuse(path, 'limit_exceeded');
    value.forEach((item, index) => rule(item, `${path}.${index}`));
};
function row(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        refuse(path);
    return value;
}
function object(required, optional = {}) {
    return (value, path) => {
        const record = row(value, path);
        for (const [key, rule] of Object.entries(required)) {
            if (!Object.prototype.hasOwnProperty.call(record, key))
                refuse(`${path}.${key}`);
            rule(record[key], `${path}.${key}`);
        }
        for (const [key, rule] of Object.entries(optional))
            if (Object.prototype.hasOwnProperty.call(record, key))
                rule(record[key], `${path}.${key}`);
    };
}
const strings = array(text);
const clients = array(uuid, 100);
const style = object({}, {
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
    borderStyle: literal('none', 'solid', 'dashed', 'dotted', 'double', 'inset', 'outset', 'groove', 'ridge'),
    borderColor: text,
    borderWidth: number,
    radius: number,
    radiusTopLeft: number,
    radiusTopRight: number,
    radiusBottomRight: number,
    radiusBottomLeft: number,
    width: number,
    height: number,
});
const font = object({
    assetId: uuid,
    name: text,
    family: text,
    url: text,
    format: literal('truetype', 'opentype', 'woff', 'woff2'),
});
const fonts = array(font, 100);
const rule = object({
    field: literal('email', 'firstName', 'lastName', 'company', 'phone', 'address', 'birthday', 'client', 'tags'),
    operator: literal('is', 'is-not', 'contains', 'does-not-contain', 'is-empty', 'is-not-empty'),
    value: text,
});
const link = object({ label: text, url: text }, {
    imageUrl: text,
    price: text,
    description: text,
    platform: vocabulary(() => newsletter_js_1.NEWSLETTER_SOCIAL_PLATFORMS.map(([key]) => key)),
});
const socialDisplay = literal('icon', 'icon-text', 'text');
const socialDevice = object({
    layout: literal('horizontal', 'vertical'),
    size: literal('small', 'medium', 'large'),
    spacing: number,
});
const social = object({
    display: socialDisplay,
    iconStyle: vocabulary(() => newsletter_js_1.NEWSLETTER_SOCIAL_ICON_STYLES.map(([key]) => key)),
    desktop: socialDevice,
    mobile: socialDevice,
}, {
    mode: literal('follow', 'share'),
    followDisplay: socialDisplay,
    shareDisplay: socialDisplay,
    share: object({
        source: literal('campaign', 'custom'),
        customUrl: text,
        items: array(object({
            platform: vocabulary(() => newsletter_js_1.NEWSLETTER_SOCIAL_SHARE_PLATFORMS.map(([key]) => key)),
            label: text,
        }), 6),
    }),
});
const question = object({
    id: text,
    type: vocabulary(() => newsletter_js_1.NEWSLETTER_SURVEY_SECTION_TYPES.map(([key]) => key)),
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
}, { introductionType: nullable(literal('text', 'image', 'video')) });
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
const blockShape = object({
    id: text,
    kind: vocabulary(() => newsletter_js_1.NEWSLETTER_BLOCK_KINDS),
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
    columns: array(array((value, path) => {
        row(value, path);
    }, 100), 4),
    style,
    mobileStyle: style,
    linkedStyles: bool,
    visibility: object({ mode: literal('all', 'custom'), rules: array(rule, 5) }),
}, {
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
    video: object({ thumbnail: literal('auto', 'custom'), sourceUrl: text }, { paddingLinked: bool }),
    survey: object({
        kind: literal('saved-survey'),
        saved: nullable(savedSurvey),
        blockBackground: text,
        paddingLinked: bool,
    }),
});
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
const design = (value, path) => {
    object({
        version: literal(1),
        styles: emailStyles,
        sections: array(object({
            id: text,
            name: text,
            style,
            blocks: array(blockShape, 200),
        }, { sourceClientIds: clients, fonts }), 50),
    }, 
    // Save unions current and historical authorized clients after request normalization.
    // Persisted root provenance therefore uses the explicit receiving array budget.
    { sourceClientIds: array(workspaceUuid, exports.NEWSLETTER_RECEIVE_LIMITS.arrayLength), fonts })(value, path);
    const record = row(value, path);
    let count = 0;
    const visitBlock = (value, path, depth) => {
        if (++count > 500 || depth > 6)
            refuse(path, 'limit_exceeded');
        blockShape(value, path);
        const block = row(value, path);
        const columns = block.columns;
        columns.forEach((column, index) => column.forEach((child, childIndex) => visitBlock(child, `${path}.columns.${index}.${childIndex}`, depth + 1)));
    };
    record.sections.forEach((section, index) => section.blocks.forEach((block, blockIndex) => visitBlock(block, `${path}.sections.${index}.blocks.${blockIndex}`, 0)));
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
        trigger: literal('signup', 'tag_added', 'campaign_sent', 'campaign_link_click', 'merge_changed'),
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
const check = object({ id: text, severity: literal('error', 'warning', 'pass'), label: text, detail: text }, { blockId: text });
const stageRead = object({
    id: uuid,
    documentId: workspaceUuid,
    revision,
    name: text,
    config,
    design,
});
const draftVersion = object({
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
        if (typeof value !== 'string' || !/^sha256:[a-f\d]{64}$/i.test(value))
            refuse(path);
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
}, { contextNote: text });
function receive(input, rule, inspect, documentCount = 1) {
    try {
        const value = snapshot(input, documentCount);
        rule(value, '$');
        inspect?.(value);
        // Every known nested field has been structurally validated; extra JSON is preserved, not cast unchecked.
        return { ok: true, value: value };
    }
    catch (error) {
        const failure = error && (typeof error === 'object' || typeof error === 'function')
            ? failures.get(error)
            : undefined;
        return { ok: false, error: failure ?? { code: 'invalid_json', path: '$' } };
    }
}
function identity(value, expected, keys) {
    if (expected === undefined)
        return;
    const binding = snapshot(expected);
    const spec = row(binding, '$expected');
    const allowed = new Set(keys);
    for (const key of Object.keys(spec)) {
        if (!allowed.has(key))
            refuse(`$expected.${key}`);
        const wanted = spec[key];
        (key === 'revision'
            ? revision
            : key === 'clientId'
                ? nullable(workspaceUuid)
                : key === 'documentId'
                    ? workspaceUuid
                    : uuid)(wanted, `$expected.${key}`);
        const actual = value[key];
        const equal = typeof wanted === 'string' && typeof actual === 'string'
            ? wanted.toLowerCase() === actual.toLowerCase()
            : wanted === actual;
        if (!equal)
            refuse(`$.${key}`, 'identity_mismatch');
    }
}
function resourceIdentity(value, idKey, expected, hasClient = false) {
    identity({
        ...value,
        [idKey]: value.id,
        ...(hasClient ? { clientId: row(value.config, '$.config').clientId } : {}),
    }, expected, [
        idKey,
        ...(idKey === 'stageId' ? ['documentId'] : []),
        'revision',
        ...(hasClient ? ['clientId'] : []),
    ]);
}
/** Create, GET and CAS-save all return the same direct campaign shape; no wrapper is accepted. */
function parseNewsletterCampaign(value, expected) {
    return receive(value, campaign, (value) => resourceIdentity(row(value, '$'), 'documentId', expected, true));
}
function parseNewsletterDocumentList(value) {
    // Each list member can be a full independently bounded document.
    return receive(value, object({ items: array(campaign, 100) }), undefined, 100);
}
function parseNewsletterChecks(value) {
    return receive(value, array(check));
}
/** HTML is wire text here. Rendering in a browser still requires the consumer's sanitation boundary. */
function parseNewsletterPreview(value) {
    return receive(value, object({ html: text, plainText: text, checks: array(check) }));
}
function parseNewsletterHtmlCheck(value, expected) {
    return receive(value, object({
        provider: literal('Mailtrap'),
        issues: strings,
        report: (value, path) => {
            row(value, path);
        },
        revision,
        checkedAt: timestamp,
    }), (value) => identity(row(value, '$'), expected, ['revision']));
}
function parseNewsletterStageReceipt(value, expected) {
    return receive(value, object({
        id: uuid,
        documentId: workspaceUuid,
        revision,
        name: text,
        createdAt: timestamp,
        route: text,
    }), (value) => {
        const stage = row(value, '$');
        if ('design' in stage || 'config' in stage)
            refuse('$');
        const prefix = '/engagement/outreach?newsletterStage=';
        const route = stage.route;
        if (!route.startsWith(prefix))
            refuse('$.route');
        const target = route.slice(prefix.length);
        uuid(target, '$.route');
        if (target.toLowerCase() !== stage.id.toLowerCase())
            refuse('$.route', 'identity_mismatch');
        resourceIdentity(stage, 'stageId', expected);
    });
}
function parseNewsletterOutreachStage(value, expected) {
    return receive(value, stageRead, (value) => {
        const stage = row(value, '$');
        if ('createdAt' in stage || 'route' in stage)
            refuse('$');
        resourceIdentity(stage, 'stageId', expected, true);
    });
}
function parseNewsletterOutreachRecord(value, expected) {
    return receive(value, object({
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
        tests: array(object({ id: uuid, requestKey: text, senderConnectionId: uuid, versionId: uuid })),
    }), (value) => {
        const record = row(value, '$');
        const stage = row(record.stage, '$.stage');
        if ('createdAt' in stage || 'route' in stage)
            refuse('$.stage');
        identity({
            recordId: record.id,
            stageId: stage.id,
            documentId: stage.documentId,
            revision: stage.revision,
            clientId: row(stage.config, '$.stage.config').clientId,
        }, expected, ['recordId', 'stageId', 'documentId', 'revision', 'clientId']);
        const versions = record.versions;
        const versionIds = new Set();
        for (const [index, version] of versions.entries()) {
            if (version.outreachRecordId.toLowerCase() !== record.id.toLowerCase())
                refuse(`$.versions.${index}.outreachRecordId`, 'identity_mismatch');
            const id = version.id.toLowerCase();
            if (versionIds.has(id))
                refuse(`$.versions.${index}.id`);
            versionIds.add(id);
        }
        for (const [index, test] of record.tests.entries()) {
            // Historical intents can reference a prepared version omitted by current-version filtering.
            // Their presence never supplies approval for a currently returned version.
            if (record.senderConnectionId === null ||
                test.senderConnectionId.toLowerCase() !==
                    record.senderConnectionId.toLowerCase())
                refuse(`$.tests.${index}.senderConnectionId`, 'identity_mismatch');
        }
    });
}
/** Unrelated metadata is deliberately projected away. Null/absent metadata has no rich hint. */
function parseNewsletterReservedMetadata(value) {
    if (value === undefined || value === null)
        return { ok: true, value: {} };
    const result = receive(value, object({}, { newsletterStageId: uuid, newsletterRevision: revision }));
    if (!result.ok)
        return result;
    const parsed = {};
    if (Object.prototype.hasOwnProperty.call(result.value, 'newsletterStageId'))
        parsed.newsletterStageId = result.value.newsletterStageId;
    if (Object.prototype.hasOwnProperty.call(result.value, 'newsletterRevision'))
        parsed.newsletterRevision = result.value.newsletterRevision;
    return { ok: true, value: parsed };
}
/** Wrong-type rich hints fail before a generic plain-text writer can select the record. */
function parseNewsletterRecordDiscriminator(value) {
    const input = receive(value, object({ type: text }, {
        metadata: nullable((value, path) => {
            row(value, path);
        }),
    }));
    if (!input.ok)
        return input;
    const reserved = parseNewsletterReservedMetadata(Object.prototype.hasOwnProperty.call(input.value, 'metadata')
        ? input.value.metadata
        : undefined);
    if (!reserved.ok)
        return reserved;
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
//# sourceMappingURL=newsletter-receiving.js.map