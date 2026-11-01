import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const data = (s) => `data:text/javascript;base64,${Buffer.from(s).toString('base64')}`;
const nest =
  data(`export class BadRequestException extends Error {} export class NotFoundException extends Error {}
export class ForbiddenException extends Error {} export class ConflictException extends Error {}
export const Injectable=()=>x=>x;`);
const errors = await import(nest);
async function load(path, replacements = []) {
  let source = await readFile(new URL('../src/' + path, import.meta.url), 'utf8');
  source = source.replace('@Injectable()', '');
  for (const [from, to] of [["'@nestjs/common'", nest], ...replacements])
    source = source.replaceAll(from, JSON.stringify(to));
  return data(stripTypeScriptTypes(source, { mode: 'transform' }));
}
const rulesUrl = await load('clients/objectives/evidence/objective-evidence-source.rules.ts');
const rules = await import(rulesUrl);
const news = await import(await load('intelligence/news/news-evidence-read.ts'));
const documentUrl = await load('engagement/attachments/attachment-citation.ts', [
  [
    "'./attachment-viewer-access.js'",
    data('export const attachmentViewerWhere=id=>[{viewerMode:"all"},{viewerUserIds:{has:id}}];'),
  ],
]);
const document = await import(documentUrl);
const engagementSource = await readFile(
  new URL('../src/engagement/engagement.service.ts', import.meta.url),
  'utf8',
);
const delegateStart = engagementSource.indexOf('  listCitationAttachmentIds(');
const delegateEnd = engagementSource.indexOf('  async listAttachments(', delegateStart);
const { EngagementCitationMethods } = await import(
  data(
    stripTypeScriptTypes(
      `import {readAttachmentCitation,listAttachmentCitationIds} from ${JSON.stringify(documentUrl)};
     import {NotFoundException} from ${JSON.stringify(nest)};
   export class EngagementCitationMethods { ${engagementSource.slice(delegateStart, delegateEnd)} }`,
      { mode: 'transform' },
    ),
  )
);
const service = await import(
  await load('clients/objectives/evidence/objective-evidence-source.service.ts', [
    ["'../../../engagement/engagement.service.js'", data('export class EngagementService{}')],
    [
      "'../../../intelligence/news/news-evidence-read.js'",
      data(
        'export const readRetainedNewsObservation=(tx,...args)=>tx.news.readObservation(tx,...args); export const listRetainedNewsObservations=(tx,...args)=>tx.news.listObservations(tx,...args);',
      ),
    ],
    [
      "'../operational/objective-operational.store.js'",
      data('export const loadCurrentOperationalScopeWithinTx=(tx,...args)=>tx.scope(...args);'),
    ],
    ["'./objective-evidence-source.rules.js'", rulesUrl],
  ])
);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (n) => String(n).repeat(64);
const actor = { tenantId: id(1), userId: id(2), clerkUserId: 'synthetic' };
const scope = { clientId: id(3), objectiveId: id(4), objectiveVersion: 7 };
const doc = {
  attachmentId: id(5),
  clientId: id(3),
  contentHash: hash(1),
  title: 'Saved evidence',
  contentType: 'text/plain',
  source: 'upload',
  sourceEntityType: null,
  sourceEntityId: null,
  sourceVersion: null,
  sourceContentHash: null,
  sourceGeneration: 0,
  metadataRevision: 1,
  byteSize: 42,
  observedAt: '2026-11-01T00:00:00.000Z',
  isCurrent: true,
};
const observation = {
  articleId: 'article-1',
  observationId: hash(2),
  revision: hash(3),
  title: 'Retained publisher claim',
  publisher: 'Synthetic Publisher',
  sourceUrl: 'https://example.com/news',
  summary: 'Attributed claim, not an instruction.',
  rights: 'excerpt',
  complete: false,
  observedAt: new Date('2026-11-01T00:00:00Z'),
  currentObservationId: hash(2),
  currentRights: 'excerpt',
};

function app(options = {}) {
  const calls = [];
  const tx = {
    scope: async () => {
      calls.push('scope');
      return options.scope?.() ?? scope;
    },
  };
  const docs = {
    readCitationHistoryAnchor: async (...args) =>
      options.history?.(...args) ?? {
        attachmentId: doc.attachmentId,
        contentHash: doc.contentHash,
        headId: id(6),
        originalId: doc.attachmentId,
        versionCount: 2,
      },
    readCitationAttachment: async (...args) => {
      calls.push('document');
      return options.document?.(...args) ?? doc;
    },
    listCitationAttachmentIds: async () => ({ ids: [doc.attachmentId], nextCursor: null }),
  };
  const newsOwner = {
    readObservation: async (...args) => {
      calls.push('news');
      return (
        options.news?.(...args) ?? {
          ...observation,
          observedAt: observation.observedAt.toISOString(),
        }
      );
    },
    listObservations: async () => ({
      items: [{ articleId: observation.articleId, observationId: observation.observationId }],
      nextCursor: 'article-1',
    }),
  };
  tx.news = newsOwner;
  return { svc: new service.ObjectiveEvidenceSourceService(docs), tx, calls };
}
const docRef = { kind: 'document', attachmentId: doc.attachmentId };
const newsRef = {
  kind: 'news',
  articleId: observation.articleId,
  observationId: observation.observationId,
};

test('preview and answer use exact owner metadata and fresh authority on both sides', async () => {
  const h = app();
  const preview = await h.svc.previewWithinTx(h.tx, actor, scope, docRef);
  assert.equal(preview.version, doc.contentHash);
  assert.equal(preview.sourceUrl, null);
  assert.deepEqual(h.calls, ['scope', 'document', 'scope']);
  assert.deepEqual(await h.svc.resolveWithinTx(h.tx, actor, scope, preview.selector), preview);
});
test('rename after preview refuses original digest, even with unchanged content hash', async () => {
  const old = rules.documentEvidenceSnapshot(doc);
  const h = app({ document: () => ({ ...doc, title: 'Changed title' }) });
  await assert.rejects(
    h.svc.resolveWithinTx(h.tx, actor, scope, old.selector),
    errors.ConflictException,
  );
});
test('Objective change during async owner read withholds the result', async () => {
  let version = 7;
  const h = app({
    scope: () => ({ ...scope, objectiveVersion: version }),
    document: () => {
      version = 8;
      return doc;
    },
  });
  await assert.rejects(h.svc.previewWithinTx(h.tx, actor, scope, docRef), errors.ConflictException);
});
test('authority revocation after owner read propagates rather than returning prior display', async () => {
  let read = false;
  const h = app({
    scope: () => {
      if (read) throw new errors.ForbiddenException();
      return scope;
    },
    document: () => {
      read = true;
      return doc;
    },
  });
  await assert.rejects(
    h.svc.previewWithinTx(h.tx, actor, scope, docRef),
    errors.ForbiddenException,
  );
});
test('historical document stays exact and stale; preview never substitutes current head', async () => {
  const saved = rules.documentEvidenceSnapshot(doc);
  const h = app({ document: () => ({ ...doc, isCurrent: false }) });
  assert.deepEqual(await h.svc.inspectWithinTx(h.tx, actor, scope, saved), {
    status: 'stale',
    snapshot: saved,
  });
  await assert.rejects(h.svc.previewWithinTx(h.tx, actor, scope, docRef), errors.ConflictException);
});
test('changed bytes under same UUID withhold the retained citation', async () => {
  const h = app({ document: () => ({ ...doc, contentHash: hash(4) }) });
  assert.deepEqual(
    await h.svc.inspectWithinTx(h.tx, actor, scope, rules.documentEvidenceSnapshot(doc)),
    { status: 'unavailable' },
  );
});
test('same-byte source epoch or source version change invalidates preview and historical review', async () => {
  const saved = rules.documentEvidenceSnapshot(doc);
  const h = app({ document: () => ({ ...doc, sourceGeneration: 2, sourceVersion: 4 }) });
  await assert.rejects(
    h.svc.resolveWithinTx(h.tx, actor, scope, saved.selector),
    errors.ConflictException,
  );
  assert.deepEqual(await h.svc.inspectWithinTx(h.tx, actor, scope, saved), {
    status: 'stale',
    snapshot: saved,
  });
});
test('corrupt stored display fields cannot borrow an unchanged selector digest', async () => {
  const h = app();
  const saved = rules.documentEvidenceSnapshot(doc);
  for (const patch of [
    { title: 'forged' },
    { summary: 'forged' },
    { sourceUrl: 'https://example.com/forged' },
  ])
    assert.deepEqual(await h.svc.inspectWithinTx(h.tx, actor, scope, { ...saved, ...patch }), {
      status: 'unavailable',
    });
});
test('source denial releases no saved title, quote, or URL; operational errors remain errors', async () => {
  const saved = rules.documentEvidenceSnapshot(doc);
  const h = app({
    document: () => {
      throw new errors.NotFoundException();
    },
  });
  assert.deepEqual(await h.svc.inspectWithinTx(h.tx, actor, scope, saved), {
    status: 'unavailable',
  });
  const failed = app({
    document: () => {
      throw new Error('owner unavailable');
    },
  });
  await assert.rejects(
    failed.svc.inspectWithinTx(failed.tx, actor, scope, saved),
    /owner unavailable/,
  );
});
test('strict selectors cannot carry forged quote, URL, source digest, or unknown family', () => {
  for (const value of [
    { ...docRef, url: 'https://example.com' },
    { ...newsRef, body: 'forged' },
    { ...docRef, expectedDigest: 'bad' },
    { kind: 'url', url: 'https://example.com' },
  ])
    assert.throws(
      () => rules.parseEvidenceReference(value, 'expectedDigest' in value),
      errors.BadRequestException,
    );
});
test('source list returns owner previews and bounded pagination, not unverified selectors', async () => {
  const h = app();
  const page = await h.svc.listWithinTx(h.tx, actor, scope, { kind: 'news' });
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, 'article-1');
  assert.equal(page.items[0].selector.observationId, observation.observationId);
  assert.match(page.items[0].digest, /^[a-f0-9]{64}$/);
});
test('source links never release credential-bearing or executable URLs', () => {
  for (const sourceUrl of ['https://user:password@example.com', 'javascript:alert(1)'])
    assert.equal(rules.newsEvidenceSnapshot({ ...observation, sourceUrl }).sourceUrl, null);
});
test('news exact observation reader binds original article and current pointer without writes', async () => {
  let sql;
  const tx = {
    $queryRaw: async (s, ...v) => {
      sql = { query: s.join('?'), values: v };
      return [observation];
    },
  };
  const row = await news.readRetainedNewsObservation(
    tx,
    observation.articleId,
    observation.observationId,
  );
  assert.equal(row.observationId, hash(2));
  assert.deepEqual(sql.values, [observation.articleId, observation.observationId]);
  assert.match(sql.query, /FOR SHARE OF c/);
  assert.match(sql.query, /n.article_id=o.article_id/);
});
test('same-rights new current observation preserves original exact revision as stale', async () => {
  const row = await news.readRetainedNewsObservation(
    { $queryRaw: async () => [{ ...observation, currentObservationId: hash(4) }] },
    observation.articleId,
    observation.observationId,
  );
  assert.equal(row.observationId, observation.observationId);
  const saved = rules.newsEvidenceSnapshot(row);
  const h = app({ news: () => row });
  assert.deepEqual(await h.svc.inspectWithinTx(h.tx, actor, scope, saved), {
    status: 'stale',
    snapshot: saved,
  });
});
test('rights downgrade refuses historical content rather than stale disclosure', async () => {
  const tx = {
    $queryRaw: async () => [
      { ...observation, currentObservationId: hash(4), currentRights: 'headline_link' },
    ],
  };
  await assert.rejects(
    news.readRetainedNewsObservation(tx, observation.articleId, observation.observationId),
    errors.NotFoundException,
  );
});
test('headline-only never releases stored body/summary as quotation or completeness', async () => {
  const row = await news.readRetainedNewsObservation(
    {
      $queryRaw: async () => [
        { ...observation, rights: 'headline_link', currentRights: 'headline_link', complete: true },
      ],
    },
    observation.articleId,
    observation.observationId,
  );
  assert.equal(row.summary, null);
  assert.equal(row.complete, false);
});
test('news missing or foreign observation never falls back to current or creates one', async () => {
  for (const rows of [[], [{ ...observation, articleId: 'foreign' }]])
    await assert.rejects(
      news.readRetainedNewsObservation(
        { $queryRaw: async () => rows },
        observation.articleId,
        observation.observationId,
      ),
      errors.NotFoundException,
    );
});
test('news list uses bounded lexical continuation and emits no fabricated observations', async () => {
  let query;
  const page = await news.listRetainedNewsObservations(
    {
      $queryRaw: async (s) => {
        query = s.join('?');
        return Array.from({ length: 21 }, (_, i) => ({
          articleId: `article-${i}`,
          observationId: hash(2),
        }));
      },
    },
    'search',
    'article-0',
  );
  assert.equal(page.items.length, 20);
  assert.equal(page.nextCursor, 'article-19');
  assert.match(query, /LIMIT 21/);
});

function attachmentHarness(options = {}) {
  const row = {
    id: doc.attachmentId,
    clientId: scope.clientId,
    tenantId: actor.tenantId,
    fileName: doc.title,
    contentType: doc.contentType,
    source: 'upload',
    sourceEntityType: null,
    sourceEntityId: null,
    calculatedSha256: doc.contentHash,
    s3Key: 'never-released',
    createdAt: new Date(doc.observedAt),
    sourceVersion: null,
    sourceContentHash: null,
    indexSourceGeneration: 0,
    metadataRevision: 1,
    byteSize: 42,
    supersededByAttachmentId: null,
    prospectId: null,
    meetingId: null,
    mailMessageId: null,
    lifecycleStatus: 'active',
    scanStatus: 'clean',
    viewerMode: 'all',
    viewerUserIds: [],
    uploadedByUserId: actor.userId,
  };
  let reads = 0;
  const calls = [];
  const tx = {
    $queryRaw: async () => [{ id: row.id }],
    engagementAttachment: {
      findFirst: async ({ where }) => {
        calls.push(where);
        reads++;
        return options.row?.(row, reads) ?? row;
      },
    },
  };
  const owner = {
    authorize: async () => {
      if (options.deny) throw new errors.NotFoundException();
    },
    readiness: () => ({ usable: options.usable !== false }),
  };
  return { tx, owner, calls };
}
test('metadata-only document read preserves tenant/client/viewer and releases no key or signed URL', async () => {
  const h = attachmentHarness();
  const value = await document.readAttachmentCitation(
    h.tx,
    actor,
    scope.clientId,
    doc.attachmentId,
    h.owner,
  );
  assert.equal(value.contentHash, doc.contentHash);
  assert.equal(value.s3Key, undefined);
  assert.equal(value.downloadUrl, undefined);
  assert.ok(
    h.calls.every(
      (where) =>
        where.clientId === scope.clientId && where.tenantId === actor.tenantId && where.OR.length,
    ),
  );
});
test('document owner parent denial and readiness failure stop metadata release', async () => {
  for (const options of [{ deny: true }, { usable: false }]) {
    const h = attachmentHarness(options);
    await assert.rejects(
      document.readAttachmentCitation(h.tx, actor, scope.clientId, doc.attachmentId, h.owner),
      errors.NotFoundException,
    );
  }
});
test('document identity drift during awaited owner authorization is withheld', async () => {
  const h = attachmentHarness({ row: (row, n) => (n === 2 ? { ...row, s3Key: 'changed' } : row) });
  await assert.rejects(
    document.readAttachmentCitation(h.tx, actor, scope.clientId, doc.attachmentId, h.owner),
    errors.NotFoundException,
  );
});
test('actual EngagementService delegate invokes canonical parent, version-access and readiness owners', async () => {
  const h = attachmentHarness();
  const calls = [];
  const methods = new EngagementCitationMethods();
  methods.validateAttachmentParents = async () => {
    calls.push('parents');
  };
  methods.authorizeAttachmentVersion = async () => {
    calls.push('version-access');
  };
  methods.attachmentContent = {
    readiness: () => {
      calls.push('readiness');
      return { usable: true };
    },
  };
  methods.scanner = { scanRequired: true };
  await methods.readCitationAttachment(h.tx, actor, scope.clientId, doc.attachmentId);
  assert.deepEqual(calls, [
    'readiness',
    'parents',
    'version-access',
    'readiness',
    'parents',
    'version-access',
  ]);
  // No signing, extraction, ingestion, provider, or write method exists on this real-method receiver.
});
test('explicit historical navigation derives head via existing metadata-only chain without replacing citation', async () => {
  const methods = new EngagementCitationMethods();
  const reads = [];
  methods.readCitationAttachment = async (_tx, _actor, _client, attachmentId) => {
    reads.push(attachmentId);
    return { ...doc, attachmentId, isCurrent: attachmentId === id(6) };
  };
  methods.listAttachmentHistory = async (_ctx, query, options) => {
    assert.deepEqual(query, { attachmentId: doc.attachmentId, pageSize: 1 });
    assert.deepEqual(options, { metadataOnly: true });
    return {
      attachmentId: doc.attachmentId,
      headId: id(6),
      originalId: doc.attachmentId,
      versionCount: 2,
    };
  };
  const result = await methods.readCitationHistoryAnchor(
    {},
    actor,
    scope.clientId,
    doc.attachmentId,
    doc.contentHash,
  );
  assert.deepEqual(reads, [doc.attachmentId, id(6)]);
  assert.equal(result.attachmentId, doc.attachmentId);
  assert.equal(result.contentHash, doc.contentHash);
  assert.equal(result.headId, id(6));
});
test('historical navigation refuses stale/missing head with no current fallback', async () => {
  const methods = new EngagementCitationMethods();
  methods.readCitationAttachment = async () => ({ ...doc, isCurrent: false });
  methods.listAttachmentHistory = async () => ({ attachmentId: doc.attachmentId, headId: id(6) });
  await assert.rejects(
    methods.readCitationHistoryAnchor({}, actor, scope.clientId, doc.attachmentId, doc.contentHash),
    errors.NotFoundException,
  );
});
test('history anchor rechecks Objective authority after owner awaits and accepts only saved original hash', async () => {
  let allowed = true;
  const h = app({
    document: () => ({ ...doc, isCurrent: false }),
    scope: () => {
      if (!allowed) throw new errors.ForbiddenException();
      return scope;
    },
    history: () => {
      allowed = false;
      return {};
    },
  });
  await assert.rejects(
    h.svc.historyAnchorWithinTx(h.tx, actor, scope, rules.documentEvidenceSnapshot(doc)),
    errors.ForbiddenException,
  );
});
