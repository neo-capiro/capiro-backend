import type { PrismaService } from '../../prisma/prisma.service.js';
import { NewsCatcherDashboardService } from './news-catcher-dashboard.service.js';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function prismaForClient(): PrismaService {
  return {
    withTenant: jest.fn(async (_tenantId: string, callback: (tx: unknown) => unknown) =>
      callback({
        client: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'client-1',
              name: 'Shiftwave',
              intakeData: {},
              issueCodes: [],
              capabilities: [],
            },
          ]),
        },
        clientIntelMapping: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      }),
    ),
    $queryRaw: jest.fn(),
  } as unknown as PrismaService;
}

function article(media: string) {
  return {
    _id: 'story-1',
    title: 'Shiftwave receives federal research award',
    link: 'https://example.test/shiftwave-award',
    media,
    name_source: 'Defense Example',
    published_date: '2026-08-08 12:00:00',
    description: 'A federal agency selected Shiftwave for a research award.',
    nlp: {
      summary: 'Shiftwave was selected by a federal agency.',
      ner_ORG: [{ entity_name: 'Shiftwave', count: 2 }],
    },
  };
}

describe('NewsCatcher dashboard thumbnails', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.NEWSCATCHER_API_KEY = 'test-news-key';
    process.env.NEWSCATCHER_BASE_URL = 'https://newscatcher.example.test/api';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    global.fetch = ORIGINAL_FETCH;
    jest.restoreAllMocks();
  });

  it('passes through a valid NewsCatcher media URL as imageUrl', async () => {
    global.fetch = jest.fn(async () =>
      new Response(
        JSON.stringify({ articles: [article('https://cdn.example.test/news/shiftwave.jpg')] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const service = new NewsCatcherDashboardService(prismaForClient());
    const result = await service.getDashboard('tenant-1');

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.imageUrl).toBe('https://cdn.example.test/news/shiftwave.jpg');
  });

  it('drops a non-http media value instead of exposing it to the browser', async () => {
    global.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ articles: [article('javascript:alert(1)')] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const service = new NewsCatcherDashboardService(prismaForClient());
    const result = await service.getDashboard('tenant-2');

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.imageUrl).toBeNull();
  });
});
