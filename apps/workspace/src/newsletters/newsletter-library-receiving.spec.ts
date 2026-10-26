import {
  createNewsletterBlock,
  createNewsletterSection,
  defaultNewsletterConfig,
  governmentAffairsNewsletter,
  parseNewsletterCampaign,
  parseNewsletterLibraryItem,
  parseNewsletterLibraryList,
  type NewsletterCampaign,
  type NewsletterFont,
  type NewsletterSection,
} from '@capiro/shared/newsletter';
import { NewsletterService } from './newsletter.service.js';

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
const time = '2026-10-26T00:00:00.000Z';
const ctx = { tenantId: id(1), clerkUserId: 'user_synthetic' };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const font = (n: number): NewsletterFont => ({
  assetId: id(n),
  name: `Font ${n}`,
  family: `CapiroFont-${n}`,
  url: `https://example.test/${n}.woff2`,
  format: 'woff2',
});
const section = (): NewsletterSection => clone(createNewsletterSection('Saved section'));
const item = () => ({
  id: id(2),
  name: 'Saved section',
  folder: '',
  updatedAt: time,
  section: section(),
});
const campaign = (sections: NewsletterSection[]): NewsletterCampaign => ({
  id: id(3),
  name: 'Current document',
  ownerId: ctx.clerkUserId,
  revision: 1,
  status: 'draft',
  updatedAt: time,
  config: defaultNewsletterConfig(),
  design: { ...clone(governmentAffairsNewsletter()), sections },
});
function accepted<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
const refused = (value: unknown, code?: string) => {
  const result = parseNewsletterLibraryItem(value);
  expect(result.ok).toBe(false);
  if (!result.ok && code) expect(result.error.code).toBe(code);
};

it('receives actual service save/list responses, preserving document-wide clients and fonts', async () => {
  const document = campaign([section()]);
  document.design.sourceClientIds = Array.from({ length: 100 }, (_, n) => id(n + 10));
  document.design.sections[0]!.sourceClientIds = [id(200)];
  document.design.fonts = Array.from({ length: 100 }, (_, n) => font(n + 10));
  document.design.sections[0]!.fonts = [font(200)];
  let stored: unknown;
  const library = {
    create: jest.fn(
      async ({ data }) => (stored = { ...data, id: id(2), updatedAt: new Date(time) }),
    ),
    findMany: jest.fn(async () => [stored]),
  };
  const source = {
    resolveUserId: jest.fn().mockResolvedValue(id(4)),
    getClient: jest.fn().mockResolvedValue({ wallAllowed: true }),
  };
  const service = new NewsletterService(
    { wsNewsletterLibraryItem: library } as never,
    source as never,
    {} as never,
    {} as never,
  );
  jest.spyOn(service, 'get').mockResolvedValue(document);
  const saved = accepted(
    parseNewsletterLibraryItem(
      await service.saveLibrary(ctx, document.id, {
        name: ' Saved section ',
        sectionId: document.design.sections[0]!.id,
      }),
    ),
  );
  expect(saved.name).toBe('Saved section');
  expect(saved.folder).toBe('');
  expect(saved.section.sourceClientIds).toEqual([...document.design.sourceClientIds, id(200)]);
  expect(saved.section.fonts).toEqual([...document.design.fonts, font(200)]);
  const listed = accepted(parseNewsletterLibraryList(await service.library(ctx, 'section')));
  expect(listed.items).toEqual([saved]);
  expect(library.findMany).toHaveBeenCalledWith({
    where: { tenantId: ctx.tenantId, ownerId: ctx.clerkUserId, kind: 'section' },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });
});

it('deep-copies the exact section, including inert HTML, nested columns and optional JSON', () => {
  const value = item();
  const block = clone(createNewsletterBlock('columns'));
  const child = clone(createNewsletterBlock('paragraph'));
  child.html = '<script>inert wire text</script>';
  block.columns = [[child]];
  value.section.blocks = [block];
  Object.assign(value.section.style, { futureStyle: { color: '#123456' } });
  const got = accepted(parseNewsletterLibraryItem(value));
  expect(got).toEqual(value);
  got.section.blocks[0]!.columns[0]![0]!.html = 'Changed local copy';
  expect(child.html).toBe('<script>inert wire text</script>');
});

it('accepts absent legacy provenance but rejects explicit null or malformed provenance/fonts', () => {
  const value = item();
  delete value.section.sourceClientIds;
  delete value.section.fonts;
  expect(accepted(parseNewsletterLibraryItem(value)).section).toEqual(value.section);
  for (const delta of [
    { sourceClientIds: null },
    { sourceClientIds: ['bad'] },
    { fonts: null },
    { fonts: [{ ...font(8), format: 'exe' }] },
    { fonts: [{ ...font(8), assetId: 'bad' }] },
  ])
    refused({ ...value, section: { ...value.section, ...delta } });
  for (const delta of [
    { sourceClientIds: Array(100_001).fill(id(1)) },
    { fonts: Array(100_001).fill(font(1)) },
  ])
    refused({ ...value, section: { ...value.section, ...delta } }, 'limit_exceeded');
});

it('requires the actual metadata, including an empty-string folder rather than absent/null', () => {
  const value = item();
  for (const key of Object.keys(value)) {
    const missing = { ...value };
    delete missing[key as keyof typeof missing];
    refused(missing);
    refused({ ...value, [key]: null });
  }
  for (const delta of [
    { id: 'bad' },
    { name: '' },
    { name: ' ' },
    { name: 'x'.repeat(201) },
    { folder: 'x'.repeat(101) },
    { updatedAt: '2026-10-26' },
    { updatedAt: 'invalid' },
  ])
    refused({ ...value, ...delta });
  accepted(
    parseNewsletterLibraryItem({ ...value, name: 'x'.repeat(200), folder: 'x'.repeat(100) }),
  );
  for (const value of [undefined, null, {}, []]) refused(value);
});

it('rejects templates, hybrids and fabricated causal fields on section items and list envelopes', () => {
  const value = item();
  const { section: _section, ...metadata } = value;
  refused({
    ...metadata,
    design: governmentAffairsNewsletter(),
    config: defaultNewsletterConfig(),
  });
  for (const extra of [
    { design: {} },
    { config: {} },
    { kind: 'template' },
    { revision: 1 },
    { requestId: id(4) },
    { toString: 'extra' },
  ])
    refused({ ...value, ...extra });
  for (const value of [
    null,
    {},
    { items: null },
    { items: [item()], cursor: 'next' },
    { items: [item()], revision: 1 },
    { items: [item(), null] },
  ])
    expect(parseNewsletterLibraryList(value).ok).toBe(false);
});

it('admits empty and 500-row visible collections, rejects 501 without truncation', () => {
  expect(accepted(parseNewsletterLibraryList({ items: [] })).items).toEqual([]);
  const items = Array.from({ length: 500 }, (_, n) => ({ ...item(), id: id(n + 10) }));
  expect(accepted(parseNewsletterLibraryList({ items })).items).toEqual(items);
  expect(parseNewsletterLibraryList({ items: [...items, item()] })).toMatchObject({
    ok: false,
    error: { code: 'limit_exceeded', path: '$.items' },
  });
});

it('rejects malformed section and recursively nested block content', () => {
  const value = item();
  for (const delta of [
    { id: null },
    { name: 9 },
    { style: null },
    { blocks: null },
    { blocks: [null] },
    { blocks: [createNewsletterBlock('paragraph'), {}] },
  ])
    refused({ ...value, section: { ...value.section, ...delta } });
  const block = clone(createNewsletterBlock('columns'));
  block.columns = [[{ ...clone(createNewsletterBlock('paragraph')), kind: 'invented' } as never]];
  refused({ ...value, section: { ...value.section, blocks: [block] } });
  block.columns = [
    [{ ...clone(createNewsletterBlock('paragraph')), style: { bold: 'yes' } } as never],
  ];
  refused({ ...value, section: { ...value.section, blocks: [block] } });
});

it('retains the 200 top-level, 500 total and six nested-level block limits', () => {
  const value = item();
  const leaf = clone(createNewsletterBlock('paragraph'));
  const columns = clone(createNewsletterBlock('columns'));
  columns.columns = Array.from({ length: 3 }, () => Array.from({ length: 100 }, () => clone(leaf)));
  value.section.blocks = [...Array.from({ length: 199 }, () => clone(leaf)), columns];
  accepted(parseNewsletterLibraryItem(value));
  columns.columns.push([clone(leaf)]);
  refused(value, 'limit_exceeded');
  value.section.blocks = Array.from({ length: 201 }, () => clone(leaf));
  refused(value, 'limit_exceeded');
  let nested = leaf;
  for (let i = 0; i < 6; i++) nested = { ...clone(columns), columns: [[nested]] };
  value.section.blocks = [nested];
  accepted(parseNewsletterLibraryItem(value));
  value.section.blocks = [{ ...clone(columns), columns: [[nested]] }];
  refused(value, 'limit_exceeded');
});

it('keeps one document aggregate block budget and independent budgets for library rows', () => {
  const value = item();
  value.section.blocks = Array.from({ length: 200 }, () =>
    clone(createNewsletterBlock('paragraph')),
  );
  const other = clone(value.section);
  const third = clone(value.section);
  third.blocks.length = 100;
  accepted(parseNewsletterCampaign(campaign([value.section, other, third])));
  third.blocks.push(clone(third.blocks[0]!));
  expect(parseNewsletterCampaign(campaign([value.section, other, third]))).toMatchObject({
    ok: false,
    error: { code: 'limit_exceeded' },
  });
  expect(accepted(parseNewsletterLibraryList({ items: [value, value, value] })).items).toHaveLength(
    3,
  );
});

it('rejects accessors, cycles and undefined without evaluating or normalizing hostile data', () => {
  const getter = jest.fn();
  const hostile = Object.defineProperty(item(), 'section', { get: getter, enumerable: true });
  refused(hostile, 'invalid_json');
  expect(getter).not.toHaveBeenCalled();
  const cyclic = item();
  Object.assign(cyclic.section, { cycle: cyclic });
  refused(cyclic, 'invalid_json');
  refused({ ...item(), folder: undefined }, 'invalid_json');
  refused({ ...item(), section: { ...section(), blocks: [() => undefined] } }, 'invalid_json');
});
