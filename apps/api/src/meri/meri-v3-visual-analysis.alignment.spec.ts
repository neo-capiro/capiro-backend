import type { TenantContext } from '@capiro/shared';
import { MeriV3VisualAnalysisService } from './meri-v3-visual-analysis.service.js';

const ctx = {
  tenantId: 'tenant-1',
  tenantSlug: 'capiro-internal',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
} as TenantContext;

const validSecondVisual = {
  chartType: 'bar',
  title: 'Valid second visual',
  xKey: 'name',
  series: [{ dataKey: 'value' }],
  data: [{ name: 'PE 2', value: 22.7 }],
};

describe('MeriV3 visual/PNG alignment', () => {
  test('an invalid first visual never shifts the second spec onto fig_1.png', async () => {
    let id = 0;
    const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: `artifact-${++id}`,
      title: data.title,
    }));
    const tx = {
      clioConversation: {
        findFirst: jest.fn(async () => ({ id: 'conversation-1', clientId: 'client-1' })),
      },
      clioArtifact: { create },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const tools = {
      executeFromAuthenticatedUser: jest.fn(async () => ({
        tool: 'run_analysis',
        ok: true,
        results: {
          findings: { largestCut: -22.7 },
          visuals: [
            {
              chartType: 'bar',
              title: 'Invalid first visual',
              xKey: 'name',
              series: [{ dataKey: 'value' }],
              data: [{ name: 'PE 1', value: '$10M' }],
            },
            validSecondVisual,
          ],
        },
        artifacts: [
          {
            title: 'Static first figure',
            metadata: { imageBase64: 'ZmlnMQ==', filename: 'fig_1.png' },
          },
          {
            title: 'Static second figure',
            metadata: { imageBase64: 'ZmlnMg==', filename: 'fig_2.png' },
          },
        ],
      })),
      analysisSandboxEnabled: jest.fn(async () => true),
    };
    const service = new MeriV3VisualAnalysisService(prisma as never, tools as never);

    const result = (await service.run(ctx, {
      conversationId: 'conversation-1',
      code: 'print(1)',
    })) as Record<string, unknown>;

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0].data).toEqual(
      expect.objectContaining({
        title: 'Static first figure',
        metadata: expect.objectContaining({
          filename: 'fig_1.png',
          imageBase64: 'ZmlnMQ==',
        }),
      }),
    );
    expect((create.mock.calls[0]?.[0].data.metadata as Record<string, unknown>).visualization).toBe(
      undefined,
    );

    expect(create.mock.calls[1]?.[0].data).toEqual(
      expect.objectContaining({
        title: 'Valid second visual',
        metadata: expect.objectContaining({
          filename: 'fig_2.png',
          imageBase64: 'ZmlnMg==',
          visualization: expect.objectContaining({ title: 'Valid second visual' }),
        }),
      }),
    );
    expect(result.visualWarnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Visualization 1 was rejected'),
        expect.stringContaining('Chart image 1 has no valid interactive specification'),
      ]),
    );
  });
});
