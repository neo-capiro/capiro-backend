import {
  createNewsletterBlock,
  createNewsletterSection,
  defaultNewsletterConfig,
  governmentAffairsNewsletter,
  parseNewsletterLibraryItem,
  parseNewsletterLibraryList,
  parseNewsletterTemplateItem,
  parseNewsletterTemplateList,
  type NewsletterCampaign,
} from '@capiro/shared/newsletter';
import { NewsletterService } from './newsletter.service.js';

const id = (n: number) => `${n.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const time = '2026-10-26T10:00:00.000Z';
const ctx = { tenantId: id(1), clerkUserId: 'user_synthetic_template_owner' };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const design = () => clone(governmentAffairsNewsletter());
const footer = () => ({
  company: 'Synthetic team',
  mailingAddress: 'Synthetic address',
  permissionReminder: 'Requested updates',
});
const item = () => ({
  id: id(2),
  name: 'Saved template',
  folder: '',
  updatedAt: time,
  design: design(),
  config: footer(),
});
function accepted<T>(value: { ok: true; value: T } | { ok: false; error: unknown }): T {
  expect(value).toMatchObject({ ok: true });
  if (!value.ok) throw new Error(JSON.stringify(value.error));
  return value.value;
}

it('receives actual current-server template save/list responses, retaining design sources and footer only', async () => {
  const document: NewsletterCampaign = {
    id: id(3),
    name: 'Current server content',
    ownerId: ctx.clerkUserId,
    revision: 7,
    status: 'draft',
    updatedAt: time,
    design: design(),
    config: { ...defaultNewsletterConfig(), ...footer(), clientId: id(4) },
  };
  document.design.sourceClientIds = [id(5)];
  let stored: unknown;
  const library = {
    create: jest.fn(
      async ({ data }) => (stored = { ...data, id: id(2), updatedAt: new Date(time) }),
    ),
    findMany: jest.fn(async () => [stored]),
  };
  const source = {
    resolveUserId: jest.fn().mockResolvedValue(id(6)),
    getClient: jest.fn().mockResolvedValue({ wallAllowed: true }),
  };
  const service = new NewsletterService(
    { wsNewsletterLibraryItem: library } as never,
    source as never,
    {} as never,
    {} as never,
  );
  const read = jest.spyOn(service, 'get').mockResolvedValue(document);
  const saved = accepted(
    parseNewsletterTemplateItem(
      await service.saveLibrary(ctx, document.id, { name: ' Template ', folder: ' Briefings ' }),
    ),
  );
  expect(read).toHaveBeenCalledWith(ctx, document.id);
  expect(saved.name).toBe('Template');
  expect(saved.folder).toBe('Briefings');
  expect(saved.config).toEqual(footer());
  expect(saved.design.sourceClientIds).toEqual([id(5), id(4)]);
  expect(library.create.mock.calls[0]![0].data.kind).toBe('template');
  const listed = accepted(parseNewsletterTemplateList(await service.library(ctx, 'template')));
  expect(listed.items).toEqual([saved]);
  expect(library.findMany).toHaveBeenCalledWith({
    where: { tenantId: ctx.tenantId, ownerId: ctx.clerkUserId, kind: 'template' },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });
  expect(source.getClient).toHaveBeenCalled();
  source.getClient.mockResolvedValue(null);
  expect(
    accepted(parseNewsletterTemplateList(await service.library(ctx, 'template'))).items,
  ).toEqual([]);
});

it('receives actual legacy design-only template list output with omitted config', async () => {
  const legacy = {
    id: id(2),
    name: 'Legacy layout',
    folder: '',
    updatedAt: new Date(time),
    payload: design(),
  };
  const service = new NewsletterService(
    { wsNewsletterLibraryItem: { findMany: jest.fn().mockResolvedValue([legacy]) } } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const wire = JSON.parse(JSON.stringify(await service.library(ctx, 'template')));
  const got = accepted(parseNewsletterTemplateList(wire));
  expect(got.items[0]!.design).toEqual(legacy.payload);
  expect('config' in got.items[0]!).toBe(false);
  expect(parseNewsletterTemplateItem({ ...item(), config: null }).ok).toBe(false);
});

it('binds an echoed saved template ID and rejects fabricated revision, document or request binding', () => {
  const value = item();
  expect(accepted(parseNewsletterTemplateItem(value, { id: id(2).toUpperCase() }))).toEqual(value);
  expect(parseNewsletterTemplateItem(value, { id: id(8) })).toEqual({
    ok: false,
    error: { code: 'identity_mismatch', path: '$.id' },
  });
  for (const expected of [
    null,
    {},
    { id: 'invalid' },
    { id: id(2), revision: 7 },
    { documentId: id(3) },
  ])
    expect(parseNewsletterTemplateItem(value, expected as never).ok).toBe(false);
});

it('keeps section receiving exact and admits inert nested design additions without cross-family confusion', () => {
  const sectionItem = {
    id: id(2),
    name: 'Section',
    folder: '',
    updatedAt: time,
    section: clone(createNewsletterSection('Section')),
  };
  expect(accepted(parseNewsletterLibraryItem(sectionItem))).toEqual(sectionItem);
  expect(accepted(parseNewsletterLibraryList({ items: [sectionItem] })).items).toEqual([
    sectionItem,
  ]);
  expect(parseNewsletterLibraryItem(item()).ok).toBe(false);
  expect(parseNewsletterLibraryList({ items: [item()] }).ok).toBe(false);
  expect(parseNewsletterTemplateItem(sectionItem).ok).toBe(false);
  expect(parseNewsletterTemplateItem({ ...item(), section: sectionItem.section }).ok).toBe(false);
  const value = item();
  Object.assign(value.design, { future: { keep: ['inert'] } });
  const got = accepted(parseNewsletterTemplateItem(value));
  expect(got).toEqual(value);
  got.design.sections[0]!.name = 'Local only';
  expect(value.design.sections[0]!.name).not.toBe('Local only');
});

it('receives an empty bounded list, rejects 501/duplicates and does not invent metadata or outcomes', () => {
  expect(accepted(parseNewsletterTemplateList({ items: [] })).items).toEqual([]);
  const minimal = { ...item(), design: { ...design(), sections: [] } };
  const items = Array.from({ length: 500 }, (_, n) => ({ ...minimal, id: id(n + 10) }));
  expect(accepted(parseNewsletterTemplateList({ items })).items).toHaveLength(500);
  expect(parseNewsletterTemplateList({ items: [...items, minimal] })).toMatchObject({
    ok: false,
    error: { code: 'limit_exceeded' },
  });
  expect(parseNewsletterTemplateList({ items: [minimal, minimal] }).ok).toBe(false);
  for (const value of [null, [], {}, { items: [], nextCursor: 'invented' }, { ok: true }])
    expect(parseNewsletterTemplateList(value).ok).toBe(false);
  for (const change of [
    { name: '' },
    { name: 'n'.repeat(201) },
    { folder: 'f'.repeat(101) },
    { updatedAt: '2026-10-26' },
    { revision: 1 },
    { requestId: id(9) },
    { config: { ...footer(), clientId: id(4) } },
    { config: { company: 'missing footer' } },
    { design: { ...design(), sections: null } },
  ])
    expect(parseNewsletterTemplateItem({ ...item(), ...change }).ok).toBe(false);
});

it('uses the existing full-design aggregate recursion budget and snapshot protections', () => {
  const value = item();
  const block = clone(createNewsletterBlock('paragraph'));
  value.design.sections = Array.from({ length: 3 }, () =>
    createNewsletterSection(
      'Full',
      Array.from({ length: 200 }, () => clone(block)),
    ),
  );
  expect(parseNewsletterTemplateItem(value)).toMatchObject({
    ok: false,
    error: { code: 'limit_exceeded' },
  });
  let called = 0;
  const getter = Object.defineProperty(item(), 'design', {
    enumerable: true,
    get() {
      called++;
      return design();
    },
  });
  const expected = Object.defineProperty({}, 'id', {
    enumerable: true,
    get() {
      called++;
      return id(2);
    },
  });
  const cycle: Record<string, unknown> = { ...item() };
  cycle.self = cycle;
  for (const bad of [
    getter,
    cycle,
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('hostile');
        },
      },
    ),
    { ...item(), design: undefined },
  ])
    expect(parseNewsletterTemplateItem(bad).ok).toBe(false);
  expect(parseNewsletterTemplateItem(item(), expected as never).ok).toBe(false);
  expect(called).toBe(0);
});
