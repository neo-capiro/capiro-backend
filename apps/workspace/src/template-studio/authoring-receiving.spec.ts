import {
  parseWorkspaceBlueprintContentVersion,
  parseWorkspaceBlueprintDefinition,
  parseWorkspaceBlueprintCreated,
  parseWorkspaceBlueprintVersion,
  parseWorkspaceBlueprintSampleTest,
  parseWorkspaceThemeList,
  parseWorkspaceThemeDetail,
  parseWorkspaceThemeVersion,
  parseWorkspaceBrandAssetList,
  parseWorkspaceBrandAssetRegistered,
  parseWorkspaceBrandAssetDeleted,
  parseWorkspaceBrandUploadList,
} from '@capiro/shared/workspace-template-studio';
import { TemplateStudioService } from './template-studio.service.js';
import { TemplateValidator } from './template-validator.js';
const id = (n: number) => `${n.toString().padStart(8, '0')}-1111-4111-8111-111111111111`;
const time = '2026-10-26T12:00:00.000Z';
const hash = 'a'.repeat(64);
const version = () => ({
  id: id(2),
  tenantId: id(3),
  blueprintId: id(1),
  version: 1,
  status: 'draft',
  definitionHash: hash,
  createdById: 'member',
  createdAt: time,
  publishedAt: null,
  retiredAt: null,
  definition: {},
});
const themeVersion = () => ({
  id: id(5),
  tenantId: id(3),
  themeId: id(4),
  version: 1,
  status: 'draft',
  settingsHash: hash,
  createdById: 'member',
  createdAt: time,
  publishedAt: null,
  retiredAt: null,
  settings: {},
});
const theme = () => ({
  id: id(4),
  tenantId: id(3),
  slug: 'firm',
  name: 'Firm',
  description: null,
  ownerId: 'member',
  createdAt: time,
  updatedAt: time,
  versions: [themeVersion()],
});
const asset = () => ({
  id: id(6),
  tenantId: id(3),
  objectKey: 'key',
  filename: 'logo.png',
  mimeType: 'image/png',
  sizeBytes: 12,
  url: 'https://assets.example.test/logo.png',
  available: true,
  scanDisclosure: null,
  uploadedById: 'member',
  createdAt: time,
});
it('receives the actual producer sample and refuses a required-answer failure', async () => {
  const saved = definition();
  saved.intakeQuestions[0]!.required = true;
  const db = {
    wsBlueprint: { findFirst: jest.fn(async () => ({ id: id(1), tenantId: id(3) })) },
    wsBlueprintVersion: { findFirst: jest.fn(async () => ({ ...version(), definition: saved })) },
  };
  const service = new TemplateStudioService(db as never, new TemplateValidator());
  const expected = { blueprintId: id(1), versionId: id(2), definitionHash: hash };
  const result = await service.testVersion(id(3), id(1), id(2), { answers: { q: 'Yes' } });
  expect(parseWorkspaceBlueprintSampleTest(result, expected)).toEqual({ ok: true, value: result });
  expect(result.intake).toEqual({ q: 'Yes' });
  await expect(service.testVersion(id(3), id(1), id(2), { answers: {} })).rejects.toMatchObject({
    status: 422,
  });
});
function definition() {
  return {
    schemaVersion: 1,
    documentType: { id: 'brief', label: 'Brief', product: 'Brief' },
    intakeQuestions: [
      {
        id: 'q',
        label: 'Question',
        required: false,
        answerSource: 'user',
        condition: { field: 'other', operator: 'equals', value: 'yes' },
      },
    ],
    sections: [
      {
        id: 's',
        title: 'Summary',
        purpose: '',
        instructions: '',
        required: false,
        removable: true,
        reorderable: true,
        lockedByDefault: false,
        targetWords: { min: 0, max: 100 },
        evidenceRules: [],
      },
    ],
    evidencePolicy: {
      minimumSources: 0,
      primarySourcesPreferred: true,
      citationRequiredFor: [],
      freshnessRules: [{ sourceType: 'primary', maximumAgeDays: 7, currentCycleRequired: true }],
    },
    contentRules: {
      requiredTerms: [],
      prohibitedTerms: [],
      requiredDisclaimers: [],
      instructions: [],
    },
    defaultTheme: { id: 'default', name: 'Default', settings: { pageSize: 'letter' } },
  };
}
it('receives an initial empty draft but does not pretend it is a complete definition', () => {
  expect(parseWorkspaceBlueprintContentVersion(version(), { blueprintId: id(1) })).toEqual({
    ok: true,
    value: version(),
  });
  expect(parseWorkspaceBlueprintDefinition({}).ok).toBe(false);
  const metadata = parseWorkspaceBlueprintVersion(version(), {
    blueprintId: id(1),
    versionId: id(2),
  });
  expect(metadata.ok && metadata.value).not.toHaveProperty('definition');
});
it('receives complete canonical definition without normalizing or dropping fields', () => {
  expect(parseWorkspaceBlueprintDefinition(definition())).toEqual({
    ok: true,
    value: definition(),
  });
});
it.each([
  (d: ReturnType<typeof definition>) => {
    d.sections[0]!.targetWords.max = -1;
  },
  (d: ReturnType<typeof definition>) => {
    d.intakeQuestions[0]!.condition.operator = 'arbitrary';
  },
  (d: ReturnType<typeof definition>) => {
    (d.sections[0] as unknown as Record<string, unknown>).removable = 'false';
  },
  (d: ReturnType<typeof definition>) => {
    (d.defaultTheme as unknown as Record<string, unknown>).settings = [];
  },
])('refuses malformed nested definition fields', (mutate) => {
  const d = definition();
  mutate(d);
  expect(parseWorkspaceBlueprintDefinition(d).ok).toBe(false);
});
it('binds existing and created version responses to their requested parent and version', () => {
  expect(parseWorkspaceBlueprintContentVersion(version(), { blueprintId: id(8) }).ok).toBe(false);
  expect(
    parseWorkspaceBlueprintContentVersion(version(), { blueprintId: id(1), versionId: id(8) }).ok,
  ).toBe(false);
  expect(
    parseWorkspaceBlueprintContentVersion({ ...version(), definition: [] }, { blueprintId: id(1) })
      .ok,
  ).toBe(false);
});
it('receives actual firm create metadata and binds product/slug', () => {
  const created = { ...theme(), scope: 'firm', product: 'Brief' };
  delete (created as { versions?: unknown }).versions;
  expect(parseWorkspaceBlueprintCreated(created, { slug: 'firm', product: 'Brief' }).ok).toBe(true);
  expect(parseWorkspaceBlueprintCreated(created, { slug: 'other', product: 'Brief' }).ok).toBe(
    false,
  );
  expect(
    parseWorkspaceBlueprintCreated(
      { ...created, scope: 'capiro', tenantId: null },
      { slug: 'firm', product: 'Brief' },
    ).ok,
  ).toBe(false);
});
it('binds successful sample tests to exact saved hash and preserves actual answers/outline', () => {
  const expected = { blueprintId: id(1), versionId: id(2), definitionHash: hash };
  const result = {
    ...expected,
    passed: true,
    intake: { answer: 'Yes' },
    outline: [{ id: 's', title: 'Summary', targetWords: { min: 0, max: 10 } }],
    errors: [],
  };
  expect(parseWorkspaceBlueprintSampleTest(result, expected)).toEqual({ ok: true, value: result });
  expect(
    parseWorkspaceBlueprintSampleTest(result, { ...expected, definitionHash: 'b'.repeat(64) }).ok,
  ).toBe(false);
  expect(parseWorkspaceBlueprintSampleTest({ ...result, passed: false }, expected).ok).toBe(false);
  expect(parseWorkspaceBlueprintSampleTest({ ...result, errors: ['failure'] }, expected).ok).toBe(
    false,
  );
});
it('receives theme latest list, parent POST and exact version GET', () => {
  expect(parseWorkspaceThemeList([theme()]).ok).toBe(true);
  expect(parseWorkspaceThemeDetail(theme(), { slug: 'firm' }).ok).toBe(true);
  expect(parseWorkspaceThemeDetail(theme(), { themeId: id(4) }).ok).toBe(true);
  expect(parseWorkspaceThemeVersion(themeVersion(), { themeId: id(4), versionId: id(5) }).ok).toBe(
    true,
  );
});
it('refuses cross-parent/cross-tenant theme children, wrong version and unordered history', () => {
  expect(
    parseWorkspaceThemeDetail(
      { ...theme(), versions: [{ ...themeVersion(), themeId: id(8) }] },
      { themeId: id(4) },
    ).ok,
  ).toBe(false);
  expect(
    parseWorkspaceThemeDetail(
      { ...theme(), versions: [{ ...themeVersion(), tenantId: id(8) }] },
      { themeId: id(4) },
    ).ok,
  ).toBe(false);
  expect(parseWorkspaceThemeVersion(themeVersion(), { themeId: id(4), versionId: id(8) }).ok).toBe(
    false,
  );
  const descending = [{ ...themeVersion(), id: id(9), version: 2 }, themeVersion()];
  expect(
    parseWorkspaceThemeDetail({ ...theme(), versions: descending }, { themeId: id(4) }).ok,
  ).toBe(false);
  expect(parseWorkspaceThemeList([{ ...theme(), versions: descending }]).ok).toBe(false);
});
it('receives available/unavailable assets and binds registration/removal', () => {
  expect(
    parseWorkspaceBrandAssetList([asset(), { ...asset(), url: null, available: false }]).ok,
  ).toBe(true);
  expect(
    parseWorkspaceBrandAssetRegistered({ ...asset(), attachmentId: id(7) }, { attachmentId: id(7) })
      .ok,
  ).toBe(true);
  expect(
    parseWorkspaceBrandAssetRegistered({ ...asset(), attachmentId: id(7) }, { attachmentId: id(8) })
      .ok,
  ).toBe(false);
  expect(
    parseWorkspaceBrandAssetDeleted({ assetId: id(6), deleted: true }, { assetId: id(6) }).ok,
  ).toBe(true);
  expect(
    parseWorkspaceBrandAssetDeleted({ assetId: id(6), deleted: true }, { assetId: id(8) }).ok,
  ).toBe(false);
});
it('receives exact usable-upload fields and rejects zero bytes or foreign URL schemes', () => {
  const upload = {
    id: id(7),
    tenantId: id(3),
    s3Key: 'key',
    fileName: 'logo.png',
    contentType: 'image/png',
    contentLength: 12,
    downloadUrl: 'https://assets.example.test/logo.png',
    scanDisclosure: null,
  };
  expect(parseWorkspaceBrandUploadList([upload])).toEqual({ ok: true, value: [upload] });
  expect(parseWorkspaceBrandUploadList([{ ...upload, contentLength: 0 }]).ok).toBe(false);
  expect(
    parseWorkspaceBrandUploadList([{ ...upload, downloadUrl: 'javascript:alert(1)' }]).ok,
  ).toBe(false);
});
it.each([
  'javascript:alert(1)',
  'http://assets.example.test/image.png',
  'https://user:password@assets.example.test/image.png',
])('refuses non-reader asset URL %s', (url) => {
  expect(parseWorkspaceBrandAssetList([{ ...asset(), url }]).ok).toBe(false);
});
it('refuses non-JSON snapshots without invoking getters and clones received data', () => {
  const getter = jest.fn();
  const evil = Object.defineProperty(version(), 'definition', { get: getter, enumerable: true });
  expect(parseWorkspaceBlueprintContentVersion(evil, { blueprintId: id(1) }).ok).toBe(false);
  expect(getter).not.toHaveBeenCalled();
  const d = definition(),
    parsed = parseWorkspaceBlueprintDefinition(d);
  d.sections[0]!.title = 'changed';
  expect(parsed.ok && parsed.value.sections[0]!.title).toBe('Summary');
});
