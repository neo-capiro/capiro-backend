import type { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';

type SetupClient = Prisma.ClientGetPayload<{
  select: { id: true; sectorTag: true; issueCodes: true };
}>;
type SetupCapability = Prisma.ClientCapabilityGetPayload<{
  select: { tags: true; description: true };
}>;

export class ClientMappingV1Setup {
  constructor(private readonly prisma: PrismaService) {}

  async getSetupCompleteness(clientId: string, tenantId: string) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId },
        select: { id: true, sectorTag: true, issueCodes: true },
      }),
    );
    if (!client) throw new NotFoundException('Client not found');

    const [confirmedMappings, caps] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clientIntelMapping.findMany({
          where: {
            clientId,
            confirmed: true,
            OR: [
              { source: { notIn: ['contracting', 'assistance_recipient'] } },
              { reviewStatus: 'confirmed', rollUpAwards: true },
            ],
          },
          select: { source: true },
        }),
      ),
      this.prisma.withTenant(tenantId, (tx) =>
        tx.clientCapability.findMany({
          where: { clientId },
          select: { tags: true, description: true },
        }),
      ),
    ]);

    const sources = new Set(confirmedMappings.map((m) => m.source));
    const issueCodeCount = Array.isArray(client.issueCodes) ? client.issueCodes.length : 0;
    const capWithTags = caps.filter(
      (c) => Array.isArray(c.tags) && (c.tags as unknown[]).length > 0,
    ).length;
    const capWithDesc = caps.filter(
      (c) => typeof c.description === 'string' && c.description.trim().length > 0,
    ).length;

    const checks = this.setupChecks(
      client,
      caps,
      sources,
      issueCodeCount,
      capWithTags,
      capWithDesc,
    );

    const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
    const doneWeight = checks.filter((c) => c.done).reduce((s, c) => s + c.weight, 0);
    const score = totalWeight > 0 ? Math.round((doneWeight / totalWeight) * 100) : 0;

    return {
      clientId,
      score,
      complete: checks.every((c) => c.done),
      checks: checks.map(({ weight: _weight, ...rest }) => rest),
    };
  }

  private setupChecks(
    client: SetupClient,
    caps: SetupCapability[],
    sources: Set<string>,
    issueCodeCount: number,
    capWithTags: number,
    capWithDesc: number,
  ) {
    const checks = [
      {
        key: 'lda',
        label: 'LDA mapping confirmed',
        done: sources.has('lda'),
        weight: 3,
        impact: 'Unlocks tracked bills, the office recommender, hearings, and regulations.',
        hint: 'Confirm it in Settings → Intelligence Mappings.',
      },
      {
        key: 'issue_codes',
        label: 'Issue codes set',
        done: issueCodeCount > 0 || sources.has('lda'),
        weight: 2,
        impact: 'Drives bill & regulation matching — even with no LDA mapping.',
        hint: 'Set LDA issue codes on the client form (Sector & Tracks); they auto-fill from the LDA match.',
      },
      {
        key: 'capabilities',
        label: 'Capabilities added',
        done: caps.length > 0,
        weight: 1,
        impact: 'Capabilities feed bill & regulation matching.',
        hint: "Add the client's products/services as capabilities.",
      },
      {
        key: 'capability_tags',
        label: 'Specific capability tags',
        done: capWithTags > 0,
        weight: 2,
        impact:
          'Specific tags (e.g. "hypersonics") sharpen which bills surface; vague tags add noise.',
        hint: 'Add specific tags to each capability; acronyms like EW/C2/ISR auto-expand.',
      },
      {
        key: 'capability_descriptions',
        label: 'Capability descriptions',
        done: capWithDesc > 0,
        weight: 1,
        impact: 'Descriptions power the semantic bill matcher.',
        hint: 'Write a sentence or two describing each capability.',
      },
      {
        key: 'sector',
        label: 'Sector set',
        done: Boolean(client.sectorTag),
        weight: 1,
        impact: 'Drives agency & regulation matching.',
        hint: 'Pick a sector on the client form.',
      },
      {
        key: 'contracting',
        label: 'Contracting mapping confirmed',
        done: sources.has('contracting'),
        weight: 1,
        impact: 'Federal obligations, return ratio, and real district-by-dollars nexus.',
        hint: 'Confirm in Settings → Intelligence Mappings (optional).',
      },
      {
        key: 'fec_employer',
        label: 'FEC employer mapping confirmed',
        done: sources.has('fec_employer'),
        weight: 1,
        impact: 'Employer-linked political-contribution panel.',
        hint: 'Confirm in Settings → Intelligence Mappings (optional).',
      },
    ];

    return checks;
  }
}
