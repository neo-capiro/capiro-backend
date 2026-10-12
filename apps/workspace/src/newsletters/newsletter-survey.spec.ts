import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  NEWSLETTER_SURVEY_SECTION_TYPES,
  createNewsletterBlock,
  createNewsletterSection,
  createNewsletterSurveyQuestion,
  defaultNewsletterSurveyDefinition,
  defaultNewsletterConfig,
  defaultNewsletterStyles,
  newsletterSourceClients,
  type NewsletterSavedSurvey,
} from '@capiro/shared/newsletter';
import { renderNewsletterDesign, newsletterPlainText } from '@capiro/shared/newsletter-render';
import {
  validateNewsletterDesign,
  validateNewsletterSurveyDefinition,
  validateNewsletterSavedSurvey,
} from './newsletter-validation.js';
import { NewsletterService } from './newsletter.service.js';
const id = '11111111-1111-4111-8111-111111111111',
  client = '22222222-2222-4222-8222-222222222222';
const ctx = { tenantId: '33333333-3333-4333-8333-333333333333', clerkUserId: 'owner' };
const saved = (): NewsletterSavedSurvey => ({
  id,
  name: 'Client policy priorities',
  revision: 1,
  status: 'draft',
  updatedAt: new Date().toISOString(),
  sourceClientIds: [client],
  definition: defaultNewsletterSurveyDefinition(),
});
const design = (block = createNewsletterBlock('survey')) => ({
  version: 1 as const,
  styles: defaultNewsletterStyles(),
  sections: [createNewsletterSection('Body', [block])],
});
describe('Saved survey drafts and newsletter buttons', () => {
  it.each(['text', 'image', 'video', null] as const)(
    'persists introduction selection %s without losing other media',
    (introductionType) => {
      const definition = defaultNewsletterSurveyDefinition();
      const intro = createNewsletterSurveyQuestion('introduction');
      Object.assign(intro, {
        introductionType,
        prompt: 'Client policy briefing',
        imageUrl: 'https://example.test/briefing.png',
        videoUrl: 'https://youtu.be/M7lc1UVf-VE',
      });
      definition.questions = [intro];
      expect(validateNewsletterSurveyDefinition(definition)).toEqual(definition);
    },
  );
  it('retains legacy combined introductions and rejects invalid or misplaced introduction choices', () => {
    const definition = defaultNewsletterSurveyDefinition();
    const intro = createNewsletterSurveyQuestion('introduction');
    delete intro.introductionType;
    definition.questions = [intro];
    expect(validateNewsletterSurveyDefinition(definition)).toEqual(definition);
    expect(() =>
      validateNewsletterSurveyDefinition({
        ...definition,
        questions: [{ ...intro, introductionType: 'unknown' }],
      }),
    ).toThrow();
    expect(() =>
      validateNewsletterSurveyDefinition({
        ...definition,
        questions: [{ ...intro, type: 'text', introductionType: 'image' }],
      }),
    ).toThrow();
  });
  it.each(NEWSLETTER_SURVEY_SECTION_TYPES)('persists the %s section type', (type) => {
    const definition = defaultNewsletterSurveyDefinition();
    const question = createNewsletterSurveyQuestion(type);
    question.prompt = 'What policy issue matters most to your team?';
    definition.questions.push(question);
    expect(validateNewsletterSurveyDefinition(definition)).toEqual(definition);
  });
  it('preserves branding, messages, choices, media and optional subscription configuration', () => {
    const definition = defaultNewsletterSurveyDefinition();
    definition.logoUrl = 'https://example.test/logo.png';
    definition.title = 'Policy priorities';
    definition.confirmation = 'Thank you.';
    const question = createNewsletterSurveyQuestion('checkbox');
    question.options = ['Funding', 'Regulations'];
    question.other = true;
    question.required = true;
    question.askToSubscribe = true;
    question.imageUrl = 'https://example.test/source.png';
    question.videoUrl = 'https://www.youtube.com/watch?v=M7lc1UVf-VE';
    definition.questions = [question];
    expect(validateNewsletterSurveyDefinition(definition)).toEqual(definition);
  });
  it('renders a styled Start Survey button and keeps a draft inactive', () => {
    const block = createNewsletterBlock('survey');
    block.survey!.saved = saved();
    block.url = 'https://example.test/ignored-poll';
    block.style = {
      align: 'right',
      radius: 1000,
      background: '#007c89',
      paddingTop: 18,
      paddingBottom: 18,
      paddingLeft: 36,
      paddingRight: 36,
    };
    block.survey!.blockBackground = '#eeeeee';
    const validated = validateNewsletterDesign(design(block));
    expect(validated.sections[0]!.blocks[0]).toEqual(block);
    const html = renderNewsletterDesign(validated, defaultNewsletterConfig());
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('Start Survey');
    expect(html).toContain('background:#eeeeee');
    expect(html).toContain('border-radius:1000px');
    expect(html).toContain('padding-top:18px');
    expect(html).toContain('padding-bottom:18px');
    expect(html).toContain('padding-left:36px');
    expect(html).toContain('padding-right:36px');
    expect(html).not.toContain('ignored-poll');
    expect(html).not.toContain('Very useful');
    expect(newsletterPlainText(validated, defaultNewsletterConfig())).toBe('Start Survey');
  });
  it('does not turn previously saved inline polls into survey buttons', () => {
    const block = createNewsletterBlock('survey');
    delete block.survey;
    block.text = '';
    block.question = 'How useful was this briefing?';
    const validated = validateNewsletterDesign(design(block));
    expect(validated.sections[0]!.blocks[0]!.survey).toBeUndefined();
    expect(
      renderNewsletterDesign(validated, defaultNewsletterConfig(), {
        surveyUrl: (_, answer) => `https://example.test/answer?value=${answer}`,
      }),
    ).toContain('How useful was this briefing?');
  });
  it('includes nested saved survey client provenance in Workspace and Outreach source checks', () => {
    const block = createNewsletterBlock('survey');
    block.survey!.saved = saved();
    const columns = createNewsletterBlock('columns', { columns: [[block], []] });
    expect(newsletterSourceClients(design(columns))).toEqual([client]);
  });
  it('keeps global button defaults while allowing mobile size and alignment', () => {
    const block = createNewsletterBlock('survey');
    block.linkedStyles = false;
    block.mobileStyle = {
      fontSize: 20,
      align: 'left',
      paddingTop: 8,
      paddingBottom: 8,
      paddingLeft: 16,
      paddingRight: 16,
    };
    const html = renderNewsletterDesign(design(block), defaultNewsletterConfig());
    expect(html).toContain(`.nl-block-${block.id}>div>a,.nl-block-${block.id}>div>span{`);
    expect(html).toContain('font-size:20px!important');
    expect(html).toContain('text-align:left!important');
  });
  it('rejects staging of missing or selected draft surveys', () => {
    const service: NewsletterService = Object.create(NewsletterService.prototype);
    const block = createNewsletterBlock('survey');
    expect(
      service
        .checks(design(block), defaultNewsletterConfig())
        .find((c) => c.id === `survey-${block.id}`)?.severity,
    ).toBe('error');
    block.survey!.saved = saved();
    expect(
      service
        .checks(design(block), defaultNewsletterConfig())
        .find((c) => c.id === `survey-${block.id}`)?.detail,
    ).toBe('Hosted surveys are not enabled for newsletters. Remove this block before staging.');
  });
  it.each(['javascript:alert(1)', 'mailto:policy@example.test', 'data:image/png;base64,AAAA'])(
    'rejects unsafe survey media %s',
    (url) => {
      const definition = defaultNewsletterSurveyDefinition();
      definition.logoUrl = url;
      expect(() => validateNewsletterSurveyDefinition(definition)).toThrow();
    },
  );
  it.each(['duplicate', 'oversize', 'range', 'choices', 'color', 'type'])(
    'rejects malformed %s survey data',
    (kind) => {
      const definition = defaultNewsletterSurveyDefinition();
      const question = createNewsletterSurveyQuestion('radio');
      definition.questions = [question];
      if (kind === 'duplicate') definition.questions.push(structuredClone(question));
      if (kind === 'oversize')
        definition.questions = Array.from({ length: 31 }, () =>
          createNewsletterSurveyQuestion('text'),
        );
      if (kind === 'range') question.range.min = question.range.max;
      if (kind === 'choices') question.options = ['Same', 'Same'];
      if (kind === 'color') definition.buttonColor = 'url(secret)';
      if (kind === 'type') (question as { type: string }).type = 'unknown';
      expect(() => validateNewsletterSurveyDefinition(definition)).toThrow();
    },
  );
  it('validates saved identity, revisions, source clients and button ownership', () => {
    const valid = saved();
    expect(validateNewsletterSavedSurvey(valid)).toEqual(valid);
    for (const value of [
      { ...saved(), id: 'fake' },
      { ...saved(), revision: 1.5 },
      { ...saved(), sourceClientIds: ['fake'] },
      { ...saved(), status: 'open' },
      { ...saved(), updatedAt: 'invalid' },
    ])
      expect(() => validateNewsletterSavedSurvey(value)).toThrow();
    const block = createNewsletterBlock('paragraph');
    block.survey = createNewsletterBlock('survey').survey;
    expect(() => validateNewsletterDesign(design(block))).toThrow();
  });
});
describe('Private durable survey draft library', () => {
  function fixture() {
    const row = {
      id,
      name: 'Original',
      tenantId: ctx.tenantId,
      ownerId: ctx.clerkUserId,
      kind: 'survey',
      updatedAt: new Date(),
      payload: {
        revision: 1,
        status: 'draft',
        sourceClientIds: [client],
        definition: defaultNewsletterSurveyDefinition(),
      },
    };
    const library = {
      findFirst: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([row]),
      create: jest.fn(async ({ data }) => ({ ...data, id, updatedAt: new Date() })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const service = new NewsletterService(
      { wsNewsletterLibraryItem: library } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const get = jest.spyOn(service, 'get').mockResolvedValue({
      design: design(),
      config: { ...defaultNewsletterConfig(), clientId: client },
    } as never);
    const assertClient = jest.fn().mockResolvedValue(undefined);
    Object.assign(service, { assertClient });
    return { service, library, row, get, assertClient };
  }
  it('creates a draft in the owned survey namespace with inherited source access', async () => {
    const f = fixture();
    const result = await f.service.saveSurvey(ctx, 'document', {
      name: ' Policy priorities ',
      definition: defaultNewsletterSurveyDefinition(),
    });
    expect(f.get).toHaveBeenCalledWith(ctx, 'document');
    expect(result.name).toBe('Policy priorities');
    expect(result.status).toBe('draft');
    expect(result.sourceClientIds).toEqual([client]);
    expect(f.library.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: ctx.tenantId,
        ownerId: ctx.clerkUserId,
        kind: 'survey',
      }),
    });
  });
  it('rejects author access before reading or writing the catalog', async () => {
    const f = fixture();
    f.get.mockRejectedValue(new NotFoundException());
    await expect(f.service.surveys(ctx, 'foreign')).rejects.toThrow(NotFoundException);
    await expect(
      f.service.saveSurvey(ctx, 'foreign', {
        name: 'Draft',
        definition: defaultNewsletterSurveyDefinition(),
      }),
    ).rejects.toThrow(NotFoundException);
    expect(f.library.findMany).not.toHaveBeenCalled();
    expect(f.library.create).not.toHaveBeenCalled();
  });
  it('filters revoked client sources and always scopes by tenant, owner and kind', async () => {
    const f = fixture();
    f.assertClient.mockRejectedValue(new NotFoundException());
    expect(await f.service.surveys(ctx, 'document')).toEqual({ items: [] });
    expect(f.library.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: ctx.tenantId, ownerId: ctx.clerkUserId, kind: 'survey' },
      }),
    );
  });
  it('uses an atomic JSON revision guard and preserves source provenance on update', async () => {
    const f = fixture();
    await f.service.saveSurvey(ctx, 'document', {
      id,
      revision: 1,
      name: 'Edited',
      definition: defaultNewsletterSurveyDefinition(),
    });
    expect(f.library.updateMany).toHaveBeenCalledWith({
      where: {
        id,
        tenantId: ctx.tenantId,
        ownerId: ctx.clerkUserId,
        kind: 'survey',
        payload: { path: ['revision'], equals: 1 },
      },
      data: {
        name: 'Edited',
        payload: expect.objectContaining({ revision: 2, sourceClientIds: [client] }),
      },
    });
  });
  it('retains sources from both the original survey and a newsletter used for a later edit', async () => {
    const f = fixture();
    const nextClient = '33333333-3333-4333-8333-333333333333';
    f.get.mockResolvedValue({
      design: design(),
      config: { ...defaultNewsletterConfig(), clientId: nextClient },
    } as never);
    await f.service.saveSurvey(ctx, 'another-document', {
      id,
      revision: 1,
      name: 'Updated from another client briefing',
      definition: defaultNewsletterSurveyDefinition(),
    });
    expect(f.library.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payload: expect.objectContaining({ sourceClientIds: [client, nextClient] }),
        }),
      }),
    );
    expect(f.assertClient.mock.calls.map((call) => call[1])).toEqual([client, nextClient]);
  });
  it('rejects an oversized retained source set before creating or updating a draft', async () => {
    const f = fixture();
    const large = {
      ...design(),
      sourceClientIds: Array.from(
        { length: 101 },
        (_, index) => `44444444-4444-4444-8444-${index.toString(16).padStart(12, '0')}`,
      ),
    };
    f.get.mockResolvedValue({ design: large, config: defaultNewsletterConfig() } as never);
    const input = { name: 'Too many sources', definition: defaultNewsletterSurveyDefinition() };
    await expect(f.service.saveSurvey(ctx, 'document', input)).rejects.toThrow('at most 100');
    await expect(
      f.service.saveSurvey(ctx, 'document', { ...input, id, revision: 1 }),
    ).rejects.toThrow('at most 100');
    expect(f.library.create).not.toHaveBeenCalled();
    expect(f.library.updateMany).not.toHaveBeenCalled();
  });
  it('rejects stale revisions and a concurrent update between read and write', async () => {
    const f = fixture();
    const input = {
      id,
      revision: 0,
      name: 'Edited',
      definition: defaultNewsletterSurveyDefinition(),
    };
    await expect(f.service.saveSurvey(ctx, 'document', input)).rejects.toThrow(ConflictException);
    expect(f.library.updateMany).not.toHaveBeenCalled();
    f.library.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.service.saveSurvey(ctx, 'document', { ...input, revision: 1 })).rejects.toThrow(
      ConflictException,
    );
  });
  it('rejects missing ownership and revoked client source access before updating', async () => {
    const f = fixture();
    f.library.findFirst.mockResolvedValueOnce(null);
    const input = {
      id,
      revision: 1,
      name: 'Edited',
      definition: defaultNewsletterSurveyDefinition(),
    };
    await expect(f.service.saveSurvey(ctx, 'document', input)).rejects.toThrow(NotFoundException);
    f.assertClient.mockRejectedValue(new NotFoundException());
    await expect(f.service.saveSurvey(ctx, 'document', input)).rejects.toThrow(NotFoundException);
    expect(f.library.updateMany).not.toHaveBeenCalled();
  });
});
