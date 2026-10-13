/** Reusable source/packed/browser qualification. Only the supplied public namespace is used. */
function runNewsletterReceivingCorpus(api) {
  const results = [];
  const check = (name, body) => {
    try {
      body();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String((error && error.message) || error) });
    }
  };
  const assert = (condition, detail = 'assertion failed') => {
    if (!condition) throw new Error(detail);
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const same = (actual, expected) =>
    assert(JSON.stringify(actual) === JSON.stringify(expected), 'data changed');
  const accepted = (result) => {
    assert(result.ok, 'expected acceptance: ' + JSON.stringify(result));
    return result.value;
  };
  const denied = (result, code) => {
    assert(!result.ok, 'expected refusal');
    if (code) assert(result.error.code === code, 'wrong refusal code');
  };
  const id = 'a1111111-1111-4111-8111-111111111111';
  const documentId = 'b2222222-2222-4222-8222-222222222222';
  const recordId = 'c3333333-3333-4333-8333-333333333333';
  const versionId = 'd4444444-4444-4444-8444-444444444444';
  const clientId = 'e5555555-5555-4555-8555-555555555555';
  const senderId = 'f6666666-6666-4666-8666-666666666666';
  const createdAt = '2026-10-12T12:34:56.123Z';
  const design = api.governmentAffairsNewsletter();
  const config = api.defaultNewsletterConfig();
  config.clientId = clientId.toUpperCase();
  config.subject = '  Preserved subject  ';
  config.plainText = 'Plain text\nkept exactly';
  const font = {
    assetId: id,
    name: 'Saved font',
    family: 'CapiroFont-' + id,
    url: 'https://example.test/font.woff2',
    format: 'woff2',
  };
  design.fonts = [font];
  design.sourceClientIds = [clientId.toUpperCase()];
  design.sections[0].fonts = [clone(font)];
  design.sections[0].sourceClientIds = [clientId];
  design.sections[0].style.radiusBottomLeft = 7;
  const legacyQuestion = api.createNewsletterSurveyQuestion('introduction');
  delete legacyQuestion.introductionType;
  const freshQuestion = api.createNewsletterSurveyQuestion('introduction');
  const definition = api.defaultNewsletterSurveyDefinition();
  definition.questions = [
    legacyQuestion,
    freshQuestion,
    api.createNewsletterSurveyQuestion('checkbox'),
  ];
  const survey = api.createNewsletterBlock('survey');
  survey.survey.saved = {
    id,
    name: 'Saved survey',
    revision: 3,
    status: 'draft',
    updatedAt: createdAt,
    sourceClientIds: [clientId],
    definition,
  };
  const social = api.createNewsletterBlock('social');
  social.social.mode = 'share';
  social.social.share = api.defaultNewsletterSocialShare();
  social.social.followDisplay = 'text';
  social.social.shareDisplay = 'icon-text';
  social.items[0].description = '  optional description  ';
  social.items[0].price = '$12';
  const video = api.createNewsletterBlock('video');
  video.video.paddingLinked = false;
  const app = api.createNewsletterBlock('apps');
  app.app = {
    kind: 'link-preview',
    sourceUrl: 'https://example.test/source',
    title: 'Title',
    description: 'Copy',
    imageUrl: '',
    size: 'small',
    showImage: false,
    showDescription: true,
    showBackground: false,
  };
  const columns = api.createNewsletterBlock('columns');
  columns.columns[0] = [survey, social, video, app];
  design.sections.push(api.createNewsletterSection('Preserved additions', [columns]));
  const additionIndex = design.sections.length - 1;
  design.additiveFutureJson = { preserve: ['nested', 7, false, null] };
  const doc = {
    id: documentId,
    name: '  Untouched name  ',
    revision: 4,
    status: 'staged',
    ownerId: 'user_Clerk_subject',
    updatedAt: createdAt,
    config,
    design,
  };
  const stage = {
    id,
    documentId,
    revision: 4,
    name: doc.name,
    config: clone(config),
    design: clone(design),
  };
  const receipt = {
    id,
    documentId,
    revision: 4,
    name: doc.name,
    createdAt,
    route: '/engagement/outreach?newsletterStage=' + id,
  };
  const version = {
    id: versionId,
    artifactId: documentId,
    outreachRecordId: recordId,
    version: 1,
    sourceVersionId: null,
    generationKey: 'newsletter:' + id,
    recipientKey: 'delivery:' + id,
    audienceKind: 'individual',
    subject: 'Subject',
    body: '<p>Body</p>',
    contentHash: 'sha256:3ee115206fa8b6523e5fd464a180dd692d49324fceb078c2e4b795e1ab137208',
    generationStatus: 'manually_authored',
    auditStatus: 'held',
    approvalStatus: 'pending',
    auditDecision: 'held',
    auditChecks: [{ check: 'opaque-server-check', severity: 'custom-severity' }],
    reviewRequestId: null,
    provider: null,
    model: null,
    promptSpecVersion: null,
    sendable: false,
    createdAt,
    contextNote: 'Optional source note',
    recipientEmail: '',
  };
  const record = {
    id: recordId,
    status: 'arbitrary-existing-status',
    name: stage.name,
    stage,
    targets: [{ type: 'group', nested: { ids: [id], settings: [1, true, null] } }],
    senderConnectionId: senderId,
    subject: 'Subject',
    versions: [version],
    intentId: null,
    excluded: ['excluded@example.test'],
    tests: [
      {
        id: documentId,
        requestKey: 'same-delivery-repeat',
        senderConnectionId: senderId,
        versionId,
      },
    ],
  };
  const checks = [
    {
      id: 'content',
      severity: 'warning',
      label: 'Local warning',
      detail: 'Advisory',
      blockId: 'n_non_uuid_node',
    },
  ];
  check('campaign exact deep preservation and detached snapshot', () => {
    const result = accepted(
      api.parseNewsletterCampaign(doc, {
        documentId: documentId.toUpperCase(),
        revision: 4,
        clientId,
      }),
    );
    same(result, doc);
    assert(
      result !== doc &&
        result.design !== doc.design &&
        result.design.sections !== doc.design.sections,
    );
    result.design.sections[0].name = 'Changed copy';
    assert(doc.design.sections[0].name !== 'Changed copy');
  });
  check('list direct envelope preserves complete documents', () =>
    same(accepted(api.parseNewsletterDocumentList({ items: [doc, clone(doc)] })), {
      items: [doc, clone(doc)],
    }),
  );
  check('list accepts empty result', () =>
    same(accepted(api.parseNewsletterDocumentList({ items: [] })), { items: [] }),
  );
  check('campaign create get save share one parser without defaults', () => {
    for (const status of ['draft', 'staged']) {
      const value = { ...doc, status };
      same(accepted(api.parseNewsletterCampaign(value)), value);
    }
  });
  check('preview keeps hostile HTML as untrusted wire text', () => {
    const preview = { html: '<script>untrusted()</script><p>copy</p>', plainText: 'copy', checks };
    same(accepted(api.parseNewsletterPreview(preview)), preview);
  });
  check('checks preserve arbitrary check ids and optional node ids', () =>
    same(accepted(api.parseNewsletterChecks(checks)), checks),
  );
  check('html check preserves opaque bounded provider report', () => {
    const value = {
      provider: 'Mailtrap',
      issues: ['warning'],
      report: { status: 'success', nested: [{ raw: 'kept', code: 7 }] },
      revision: 4,
      checkedAt: createdAt,
    };
    same(accepted(api.parseNewsletterHtmlCheck(value, { revision: 4 })), value);
  });
  check('stage receipt exact canonical route and case-bound identities', () =>
    same(
      accepted(
        api.parseNewsletterStageReceipt(receipt, {
          stageId: id.toUpperCase(),
          documentId,
          revision: 4,
        }),
      ),
      receipt,
    ),
  );
  check('stage read exact rich snapshot preserves spelling', () =>
    same(
      accepted(
        api.parseNewsletterOutreachStage(stage, { stageId: id, documentId, revision: 4, clientId }),
      ),
      stage,
    ),
  );
  check('rich record preserves server fact lifecycle fields targets and optional source note', () =>
    same(
      accepted(
        api.parseNewsletterOutreachRecord(record, {
          recordId,
          stageId: id,
          documentId,
          revision: 4,
          clientId,
        }),
      ),
      record,
    ),
  );
  check('rich record refuses a bare digest instead of canonical sha256-prefixed hash', () => {
    const value = clone(record);
    value.versions[0].contentHash = value.versions[0].contentHash.slice(7);
    denied(api.parseNewsletterOutreachRecord(value));
  });
  check('sendable is a supplied server boolean never recomputed', () => {
    const value = clone(record);
    value.versions[0].sendable = true;
    assert(accepted(api.parseNewsletterOutreachRecord(value)).versions[0].sendable === true);
  });
  check('record permits nullable sender and no tests', () => {
    const value = clone(record);
    value.senderConnectionId = null;
    value.tests = [];
    accepted(api.parseNewsletterOutreachRecord(value));
  });
  check('all current block kinds structurally supported', () => {
    const value = clone(doc);
    value.design.sections = [
      api.createNewsletterSection(
        'Kinds',
        api.NEWSLETTER_BLOCK_KINDS.map((kind) => api.createNewsletterBlock(kind)),
      ),
    ];
    accepted(api.parseNewsletterCampaign(value));
  });
  check('old video and social optional fields remain absent', () => {
    const value = clone(doc);
    const blocks = value.design.sections[additionIndex].blocks[0].columns[0];
    delete blocks[2].video.paddingLinked;
    delete blocks[1].social.mode;
    delete blocks[1].social.share;
    delete blocks[1].social.followDisplay;
    delete blocks[1].social.shareDisplay;
    same(accepted(api.parseNewsletterCampaign(value)), value);
  });
  check('old optional design and section provenance remain absent', () => {
    const value = clone(doc);
    delete value.design.fonts;
    delete value.design.sourceClientIds;
    for (const section of value.design.sections) {
      delete section.fonts;
      delete section.sourceClientIds;
    }
    same(accepted(api.parseNewsletterCampaign(value)), value);
  });
  check('nullable primary client remains valid without invented association', () => {
    const value = clone(doc);
    value.config.clientId = null;
    accepted(api.parseNewsletterCampaign(value, { clientId: null }));
  });
  check('document node ids are plain strings distinct from resource UUIDs', () => {
    const value = clone(doc);
    value.design.sections[0].id = 'n_editor_node';
    value.design.sections[0].blocks[0].id = 'plain_original_node';
    accepted(api.parseNewsletterCampaign(value));
  });
  check('valid JSON extra fields including inert prototype-looking keys survive', () => {
    const value = clone(doc);
    value.design.extra = JSON.parse('{"__proto__":{"polluted":true},"constructor":"wire"}');
    const parsed = accepted(api.parseNewsletterCampaign(value));
    same(parsed.design.extra, value.design.extra);
    assert({}.polluted === undefined);
  });
  check('wire output above request-body cap is not silently truncated', () => {
    const value = { html: 'x'.repeat(8 * 1024 * 1024 + 1), plainText: '', checks: [] };
    assert(accepted(api.parseNewsletterPreview(value)).html.length === value.html.length);
  });
  const mutateDoc = (name, body, code) =>
    check(name, () => {
      const value = clone(doc);
      body(value);
      denied(api.parseNewsletterCampaign(value), code);
    });
  for (const [name, body] of [
    [
      'missing design',
      (d) => {
        delete d.design;
      },
    ],
    [
      'missing nested config field',
      (d) => {
        delete d.config.tracking.opens;
      },
    ],
    [
      'nonboolean tracking',
      (d) => {
        d.config.tracking.opens = 'true';
      },
    ],
    [
      'nonfinite style',
      (d) => {
        d.design.sections[0].style.width = Infinity;
      },
    ],
    [
      'wrong design version',
      (d) => {
        d.design.version = 2;
      },
    ],
    [
      'unknown block kind',
      (d) => {
        d.design.sections[0].blocks[0].kind = 'script';
      },
    ],
    [
      'wrong optional font shape',
      (d) => {
        d.design.fonts[0].format = 'ttf';
      },
    ],
    [
      'font resource is a node id',
      (d) => {
        d.design.fonts[0].assetId = 'n_editor_node';
      },
    ],
    [
      'wrong provenance type',
      (d) => {
        d.design.sourceClientIds = [null];
      },
    ],
    [
      'wrong nested saved survey shape',
      (d) => {
        d.design.sections[
          additionIndex
        ].blocks[0].columns[0][0].survey.saved.definition.questions[0].range.min = '1';
      },
    ],
    [
      'wrong legacy introduction type',
      (d) => {
        d.design.sections[
          additionIndex
        ].blocks[0].columns[0][0].survey.saved.definition.questions[0].introductionType = false;
      },
    ],
    [
      'wrong optional link preview shape',
      (d) => {
        d.design.sections[additionIndex].blocks[0].columns[0][3].app.showImage = 0;
      },
    ],
    [
      'wrong optional social settings',
      (d) => {
        d.design.sections[additionIndex].blocks[0].columns[0][1].social.share.items[0].platform =
          'unknown';
      },
    ],
    [
      'wrong optional video settings',
      (d) => {
        d.design.sections[additionIndex].blocks[0].columns[0][2].video.paddingLinked = null;
      },
    ],
    [
      'fractional document revision',
      (d) => {
        d.revision = 1.5;
      },
    ],
    [
      'unsafe document revision',
      (d) => {
        d.revision = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      'invalid resource UUID version',
      (d) => {
        d.id = 'b2222222-2222-7222-8222-222222222222';
      },
    ],
    [
      'invalid nullable primary client',
      (d) => {
        d.config.clientId = '';
      },
    ],
    [
      'non-ISO owner timestamp',
      (d) => {
        d.updatedAt = 'yesterday';
      },
    ],
    [
      'campaign status is closed persisted vocabulary',
      (d) => {
        d.status = 'sent';
      },
    ],
    [
      'string required body',
      (d) => {
        d.design.sections[0].blocks[0].html = {};
      },
    ],
    [
      'wrong column child shape',
      (d) => {
        d.design.sections[additionIndex].blocks[0].columns[0][0] = [];
      },
    ],
  ])
    mutateDoc('campaign refuses ' + name, body);
  check('campaign refuses a guessed data wrapper', () =>
    denied(api.parseNewsletterCampaign({ data: doc })),
  );
  for (const [name, parser, value] of [
    ['document binding', api.parseNewsletterCampaign, doc],
    ['stage read binding', api.parseNewsletterOutreachStage, stage],
    ['stage receipt binding', api.parseNewsletterStageReceipt, receipt],
    ['record binding', api.parseNewsletterOutreachRecord, record],
  ])
    check(name + ' refuses a valid foreign resource', () =>
      denied(
        parser(
          value,
          name === 'document binding'
            ? { documentId: id }
            : name === 'record binding'
              ? { recordId: id }
              : { stageId: documentId },
        ),
        'identity_mismatch',
      ),
    );
  check('campaign refuses wrong client binding', () =>
    denied(api.parseNewsletterCampaign(doc, { clientId: documentId }), 'identity_mismatch'),
  );
  check('campaign refuses wrong revision binding', () =>
    denied(api.parseNewsletterCampaign(doc, { revision: 5 }), 'identity_mismatch'),
  );
  check('binding refuses malformed UUID and unsupported key', () => {
    denied(api.parseNewsletterCampaign(doc, { documentId: 'bad' }));
    denied(api.parseNewsletterCampaign(doc, { stageId: id }));
  });
  check('binding refuses own getter without invocation', () => {
    let reads = 0;
    const expected = {};
    Object.defineProperty(expected, 'documentId', {
      enumerable: true,
      get() {
        reads++;
        return documentId;
      },
    });
    denied(api.parseNewsletterCampaign(doc, expected));
    assert(reads === 0);
  });
  for (const [name, body] of [
    [
      'wrong version parent',
      (v) => {
        v.versions[0].outreachRecordId = id;
      },
    ],
    [
      'wrong version hash',
      (v) => {
        v.versions[0].contentHash = 'abc';
      },
    ],
    [
      'wrong server sendable type',
      (v) => {
        v.versions[0].sendable = 'true';
      },
    ],
    [
      'unknown audit state',
      (v) => {
        v.versions[0].auditStatus = 'future';
      },
    ],
    [
      'unknown approval state',
      (v) => {
        v.versions[0].approvalStatus = 'released';
      },
    ],
    [
      'unknown generation state',
      (v) => {
        v.versions[0].generationStatus = 'custom';
      },
    ],
    [
      'missing version audit checks',
      (v) => {
        delete v.versions[0].auditChecks;
      },
    ],
    [
      'wrong context note type',
      (v) => {
        v.versions[0].contextNote = null;
      },
    ],
    [
      'malformed recipient email field type',
      (v) => {
        v.versions[0].recipientEmail = false;
      },
    ],
    [
      'duplicate case-folded version id',
      (v) => {
        v.versions.push({ ...v.versions[0], id: versionId.toUpperCase() });
      },
    ],
    [
      'nonobject target',
      (v) => {
        v.targets = [[]];
      },
    ],
    [
      'wrong excluded field',
      (v) => {
        v.excluded = [{ email: 'x' }];
      },
    ],
    [
      'test foreign version',
      (v) => {
        v.tests[0].versionId = id;
      },
    ],
    [
      'test foreign sender',
      (v) => {
        v.tests[0].senderConnectionId = id;
      },
    ],
    [
      'test nullable sender conflict',
      (v) => {
        v.senderConnectionId = null;
      },
    ],
    [
      'missing record status',
      (v) => {
        delete v.status;
      },
    ],
  ])
    check('record refuses ' + name, () => {
      const value = clone(record);
      body(value);
      denied(api.parseNewsletterOutreachRecord(value));
    });
  check('receipt and stage-read shapes cannot substitute for each other', () => {
    denied(api.parseNewsletterStageReceipt(stage));
    denied(api.parseNewsletterOutreachStage(receipt));
  });
  check('mixed receipt and stage-read shape refuses both', () => {
    const mixed = { ...stage, ...receipt };
    denied(api.parseNewsletterStageReceipt(mixed));
    denied(api.parseNewsletterOutreachStage(mixed));
  });
  for (const route of [
    'https://example.test/?newsletterStage=' + id,
    '/engagement/outreach?newsletterStage=' + documentId,
    '/engagement/outreach?newsletterStage=' + id + '&extra=1',
    '/engagement/outreach?newsletterStage=bad',
  ])
    check('receipt refuses noncanonical route ' + route, () =>
      denied(api.parseNewsletterStageReceipt({ ...receipt, route })),
    );
  check('preview refuses malformed check severity and HTML field', () => {
    denied(api.parseNewsletterPreview({ html: 7, plainText: '', checks: [] }));
    denied(api.parseNewsletterChecks([{ ...checks[0], severity: 'held' }]));
  });
  check('html check refuses guessed report array and foreign revision', () => {
    const value = {
      provider: 'Mailtrap',
      issues: [],
      report: {},
      revision: 4,
      checkedAt: createdAt,
    };
    denied(api.parseNewsletterHtmlCheck({ ...value, report: [] }));
    denied(api.parseNewsletterHtmlCheck(value, { revision: 5 }), 'identity_mismatch');
  });
  check('metadata absent null ordinary and unrelated values projected away', () => {
    same(accepted(api.parseNewsletterReservedMetadata(undefined)), {});
    same(accepted(api.parseNewsletterReservedMetadata(null)), {});
    same(
      accepted(
        api.parseNewsletterReservedMetadata({ direction: 'to-clients', other: { nested: true } }),
      ),
      {},
    );
  });
  check('metadata preserves UUID case and positive safe integer', () =>
    same(
      accepted(
        api.parseNewsletterReservedMetadata({
          newsletterStageId: id.toUpperCase(),
          newsletterRevision: Number.MAX_SAFE_INTEGER,
          unrelated: true,
        }),
      ),
      { newsletterStageId: id.toUpperCase(), newsletterRevision: Number.MAX_SAFE_INTEGER },
    ),
  );
  check('ordinary and valid rich metadata discriminator', () => {
    assert(
      accepted(api.parseNewsletterRecordDiscriminator({ type: 'outbound_campaign' })).kind ===
        'ordinary',
    );
    assert(
      accepted(
        api.parseNewsletterRecordDiscriminator({ type: 'outbound_campaign', metadata: null }),
      ).kind === 'ordinary',
    );
    assert(
      accepted(
        api.parseNewsletterRecordDiscriminator({
          type: 'outbound_campaign',
          metadata: { newsletterRevision: 1 },
        }),
      ).kind === 'ordinary',
    );
    assert(
      accepted(
        api.parseNewsletterRecordDiscriminator({
          type: 'outbound_campaign',
          metadata: { newsletterStageId: id },
        }),
      ).kind === 'rich',
    );
  });
  for (const value of [
    '',
    null,
    false,
    7,
    [],
    {},
    'n_node',
    'a1111111-1111-7111-8111-111111111111',
  ])
    check('reserved stage hint refuses ' + JSON.stringify(value), () =>
      denied(api.parseNewsletterReservedMetadata({ newsletterStageId: value })),
    );
  for (const value of [0, -1, 1.1, '1', null, Number.MAX_SAFE_INTEGER + 1, Infinity, false])
    check('reserved revision refuses ' + String(value), () =>
      denied(api.parseNewsletterReservedMetadata({ newsletterRevision: value })),
    );
  check('wrong-type rich hint refuses before generic selection', () =>
    denied(
      api.parseNewsletterRecordDiscriminator({
        type: 'outreach_email',
        metadata: { newsletterStageId: id },
      }),
    ),
  );
  check('inherited reserved hints and absent metadata cannot discriminate a wire record', () => {
    const names = ['newsletterStageId', 'newsletterRevision', 'metadata'];
    const originals = names.map((name) => Object.getOwnPropertyDescriptor(Object.prototype, name));
    try {
      Object.defineProperty(Object.prototype, 'newsletterStageId', {
        value: id,
        configurable: true,
      });
      Object.defineProperty(Object.prototype, 'newsletterRevision', {
        value: 99,
        configurable: true,
      });
      Object.defineProperty(Object.prototype, 'metadata', {
        value: { newsletterStageId: id },
        configurable: true,
      });
      same(accepted(api.parseNewsletterReservedMetadata({ unrelated: true })), {});
      assert(
        accepted(api.parseNewsletterRecordDiscriminator({ type: 'outbound_campaign' })).kind ===
          'ordinary',
      );
      assert(
        accepted(
          api.parseNewsletterRecordDiscriminator({ type: 'outbound_campaign', metadata: {} }),
        ).kind === 'ordinary',
      );
    } finally {
      names.forEach((name, index) => {
        if (originals[index]) Object.defineProperty(Object.prototype, name, originals[index]);
        else delete Object.prototype[name];
      });
    }
  });
  check('nonobject metadata refuses', () => {
    for (const value of [[], 1, 'x', true]) denied(api.parseNewsletterReservedMetadata(value));
  });
  check('own accessor is refused without getter call', () => {
    let reads = 0;
    const value = clone(doc);
    Object.defineProperty(value.config, 'subject', {
      enumerable: true,
      get() {
        reads++;
        return 'getter';
      },
    });
    denied(api.parseNewsletterCampaign(value), 'invalid_json');
    assert(reads === 0);
  });
  check('array accessor is refused without getter call', () => {
    let reads = 0;
    const values = [doc];
    Object.defineProperty(values, '0', {
      enumerable: true,
      get() {
        reads++;
        return doc;
      },
    });
    denied(api.parseNewsletterDocumentList({ items: values }), 'invalid_json');
    assert(reads === 0);
  });
  check('toJSON function is refused without invoking it', () => {
    let calls = 0;
    const value = clone(doc);
    value.toJSON = () => {
      calls++;
      return doc;
    };
    denied(api.parseNewsletterCampaign(value), 'invalid_json');
    assert(calls === 0);
  });
  check('custom prototype is refused without inherited getter reads', () => {
    let reads = 0;
    const proto = {};
    Object.defineProperty(proto, 'name', {
      get() {
        reads++;
        return 'inherited';
      },
    });
    const value = Object.defineProperties(
      Object.create(proto),
      Object.getOwnPropertyDescriptors(doc),
    );
    denied(api.parseNewsletterCampaign(value), 'invalid_json');
    assert(reads === 0);
  });
  check('null-prototype JSON is accepted with full shape validation', () => {
    const value = Object.assign(Object.create(null), doc);
    same(accepted(api.parseNewsletterCampaign(value)), doc);
  });
  check('cyclic nested target is refused', () => {
    const value = clone(record);
    value.targets[0].cycle = value.targets[0];
    denied(api.parseNewsletterOutreachRecord(value), 'invalid_json');
  });
  check('shared acyclic JSON data is detached in both positions', () => {
    const value = clone(record);
    const shared = { valid: true };
    value.targets = [shared, shared];
    const parsed = accepted(api.parseNewsletterOutreachRecord(value));
    same(parsed.targets, [shared, shared]);
    assert(parsed.targets[0] !== parsed.targets[1]);
  });
  check('deep generic JSON budget is refused', () => {
    const value = clone(record);
    let cursor = value.targets[0];
    for (let i = 0; i < 70; i++) cursor = cursor.child = {};
    denied(api.parseNewsletterOutreachRecord(value), 'limit_exceeded');
  });
  check('sparse array is refused', () => {
    const values = [];
    values.length = 1;
    denied(api.parseNewsletterDocumentList({ items: values }), 'invalid_json');
  });
  check('array extra property is refused', () => {
    const values = [doc];
    values.extra = true;
    denied(api.parseNewsletterDocumentList({ items: values }), 'invalid_json');
  });
  check('symbol key is refused', () => {
    const value = clone(doc);
    value[Symbol('hidden')] = true;
    denied(api.parseNewsletterCampaign(value), 'invalid_json');
  });
  check('nonenumerable wire field is refused', () => {
    const value = clone(doc);
    Object.defineProperty(value, 'hidden', { value: true });
    denied(api.parseNewsletterCampaign(value), 'invalid_json');
  });
  check('primitive non-JSON values are refused', () => {
    for (const value of [undefined, NaN, Infinity, 1n, () => 1, new Date(createdAt)])
      denied(api.parseNewsletterCampaign(value));
  });
  check('throwing reflection trap returns refusal instead of escaping', () => {
    const value = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('trap');
        },
      },
    );
    denied(api.parseNewsletterCampaign(value), 'invalid_json');
  });
  check('list count bound uses current owner max100', () => {
    const items = Array.from({ length: 101 }, () => clone(doc));
    denied(api.parseNewsletterDocumentList({ items }), 'limit_exceeded');
  });
  for (const [name, body] of [
    [
      'section count',
      (d) => {
        d.design.sections = Array.from({ length: 51 }, () => clone(d.design.sections[0]));
      },
    ],
    [
      'section block count',
      (d) => {
        d.design.sections[0].blocks = Array.from({ length: 201 }, () =>
          api.createNewsletterBlock('paragraph'),
        );
      },
    ],
    [
      'total block count',
      (d) => {
        d.design.sections = [0, 1, 2].map(() =>
          api.createNewsletterSection(
            'Many',
            Array.from({ length: 167 }, () => api.createNewsletterBlock('paragraph')),
          ),
        );
      },
    ],
    [
      'column count',
      (d) => {
        d.design.sections[additionIndex].blocks[0].columns = [[], [], [], [], []];
      },
    ],
    [
      'column child count',
      (d) => {
        d.design.sections[additionIndex].blocks[0].columns[0] = Array.from({ length: 101 }, () =>
          api.createNewsletterBlock('paragraph'),
        );
      },
    ],
    [
      'source client count',
      (d) => {
        d.design.sourceClientIds = Array.from({ length: 101 }, () => clientId);
      },
    ],
    [
      'font count',
      (d) => {
        d.design.fonts = Array.from({ length: 101 }, () => clone(font));
      },
    ],
  ])
    mutateDoc('owner collection bound ' + name, body, 'limit_exceeded');
  check('owner depth0 through6 remains accepted', () => {
    const value = clone(doc);
    let block = api.createNewsletterBlock('paragraph');
    for (let i = 0; i < 6; i++)
      block = api.createNewsletterBlock('columns', { columns: [[block]] });
    value.design.sections = [api.createNewsletterSection('Depth', [block])];
    accepted(api.parseNewsletterCampaign(value));
  });
  check('owner depth7 is refused', () => {
    const value = clone(doc);
    let block = api.createNewsletterBlock('paragraph');
    for (let i = 0; i < 7; i++)
      block = api.createNewsletterBlock('columns', { columns: [[block]] });
    value.design.sections = [api.createNewsletterSection('Depth', [block])];
    denied(api.parseNewsletterCampaign(value), 'limit_exceeded');
  });
  return {
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed),
    cases: results,
  };
}
module.exports = { runNewsletterReceivingCorpus };
