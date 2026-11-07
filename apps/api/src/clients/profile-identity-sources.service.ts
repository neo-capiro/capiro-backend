import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  VendorReferenceSamClient,
  type SamEntityRecord,
} from '../vendor-reference/vendor-reference-sam.client.js';
import { ProfileSuggestionSourcesService } from './profile-suggestion-sources.service.js';
import {
  identityName,
  type DiscoveredProfileIdentity,
  type ProfileIdentityInput,
  type ProfileIdentitySourceCandidate,
  type ProfileIdentityClaim,
} from './profile-identity.contracts.js';
import { ProfileIdentityWebService } from './profile-identity-web.service.js';

/** Read-only acquisition; the canonical identity owner is invoked only after explicit confirmation. */
@Injectable()
export class ProfileIdentitySourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sam: VendorReferenceSamClient,
    private readonly reader: ProfileSuggestionSourcesService,
    private readonly web: ProfileIdentityWebService,
  ) {}

  async discover(ctx: TenantContext, input: ProfileIdentityInput, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const candidates: DiscoveredProfileIdentity[] = [],
      sourceGaps: string[] = [];
    if (input.attachmentId) {
      const extracted = await this.documentCandidates(ctx, input, signal);
      candidates.push(...extracted.candidates);
      sourceGaps.push(...extracted.sourceGaps);
    }
    signal?.throwIfAborted();
    if (!input.name && input.website) {
      const extracted = await this.web.discover(ctx, input, signal);
      candidates.push(...extracted.candidates);
      sourceGaps.push(...extracted.sourceGaps);
    }
    signal?.throwIfAborted();
    const names = input.name
      ? [input.name]
      : [...new Set(candidates.map((candidate) => candidate.sourceCandidate.name))].slice(0, 4);
    const results = await Promise.allSettled(
      names.flatMap((name) => [
        this.samCandidates({ ...input, name }),
        this.ldaCandidates(
          name,
          input.identifiers?.some((id) => id.type === 'lda_client_id')
            ? Number(input.identifiers.find((id) => id.type === 'lda_client_id')!.value)
            : undefined,
        ),
        this.secCandidates(name, input.identifiers?.find((id) => id.type === 'cik')?.value),
        input.attachmentId && input.name
          ? Promise.resolve({ candidates: [], sourceGaps: [] })
          : this.web.discover(ctx, { ...input, name }, signal),
      ]),
    );
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        candidates.push(...result.value.candidates);
        sourceGaps.push(...result.value.sourceGaps);
      } else
        sourceGaps.push(
          `${['SAM.gov', 'LDA records', 'SEC records', 'Company and state-record websites'][index % 4]} could not be checked.`,
        );
    });
    signal?.throwIfAborted();
    if (input.attachmentId) await this.reader.identityDocument(ctx, input.attachmentId, signal);
    signal?.throwIfAborted();
    if (!names.length)
      sourceGaps.push('No source-supported company name was found in the provided source.');
    return { candidates, sourceGaps: [...new Set(sourceGaps)] };
  }

  private async documentCandidates(
    ctx: TenantContext,
    input: ProfileIdentityInput,
    signal?: AbortSignal,
  ) {
    // Authorize and verify the document bytes before any external acquisition.
    const source = await this.reader.identityDocument(ctx, input.attachmentId!, signal);
    signal?.throwIfAborted();
    // With a supplied name, the website does not depend on document inference.
    // Both reads share the preview lifetime and each runs only once.
    const results = await Promise.allSettled([
      this.web.fromDocument(ctx, input.name, source, signal),
      ...(input.name ? [this.web.discover(ctx, input, signal)] : []),
    ]);
    signal?.throwIfAborted();
    const document = results[0]!,
      website = results[1];
    if (document.status === 'rejected') throw document.reason;
    const result = document.value;
    return {
      candidates: [
        ...result.candidates,
        ...(website?.status === 'fulfilled' ? website.value.candidates : []),
      ],
      sourceGaps: [
        ...result.sourceGaps,
        ...(website?.status === 'fulfilled'
          ? website.value.sourceGaps
          : website
            ? ['Company and state-record websites could not be checked.']
            : []),
      ],
    };
  }

  private async samCandidates(input: ProfileIdentityInput) {
    const uei = input.identifiers?.find((id) => id.type === 'uei')?.value;
    const cage = input.identifiers?.find((id) => id.type === 'cage')?.value;
    const result = await (uei
      ? this.sam.lookupByUei(uei)
      : cage
        ? this.sam.lookupByCage(cage)
        : this.sam.lookupByName(input.name));
    return result.ok
      ? { candidates: result.entities.slice(0, 4).map((row) => this.fromSam(row)), sourceGaps: [] }
      : { candidates: [], sourceGaps: ['SAM.gov identity records are unavailable.'] };
  }
  private fromSam(row: SamEntityRecord): DiscoveredProfileIdentity {
    const url = `https://sam.gov/entity/${encodeURIComponent(row.uei)}/coreData`;
    const observedAt = new Date().toISOString();
    return {
      sourceCandidate: { source: 'sam', externalId: row.uei, name: row.legalBusinessName },
      sourceType: 'sam_entity',
      identifiers: [
        { type: 'uei', value: row.uei },
        ...(row.cageCode ? [{ type: 'cage', value: row.cageCode }] : []),
      ],
      ...(row.physicalAddress?.state ? { state: row.physicalAddress.state } : {}),
      ...(row.physicalAddress?.city ? { city: row.physicalAddress.city } : {}),
      evidence: [
        {
          label: 'SAM.gov entity record',
          url,
          source: 'sam_entity',
          observedAt,
          excerpt: `${row.legalBusinessName}; UEI ${row.uei}${row.cageCode ? `; CAGE ${row.cageCode}` : ''}`,
        },
      ],
      claims: row.dbaName
        ? [{ kind: 'alias', name: row.dbaName, sourceUrl: url, quote: row.dbaName }]
        : [],
    };
  }
  private async ldaCandidates(name: string, id?: number) {
    const rows = await this.prisma.ldaClient.findMany({
      where: id === undefined ? { name: { contains: name, mode: 'insensitive' } } : { id },
      take: 4,
      orderBy: [{ latestFilingYear: 'desc' }, { id: 'asc' }],
    });
    return {
      candidates: rows.map((row) => ({
        sourceCandidate: { source: 'lda' as const, externalId: String(row.id), name: row.name },
        sourceType: 'lda_client' as const,
        identifiers: [{ type: 'lda_client_id', value: String(row.id) }],
        ...(row.state ? { state: row.state } : {}),
        claims: [],
        evidence: [
          {
            label: 'LDA client record',
            url: `https://lda.gov/api/v1/clients/${row.id}/`,
            source: 'lda_client',
            observedAt: row.lastSyncedAt.toISOString(),
            excerpt: `${row.name}${row.state ? `; ${row.state}` : ''}`,
          },
        ],
      })),
      sourceGaps: [],
    };
  }
  private async secCandidates(name: string, cik?: string) {
    const rows = await this.prisma.secFiling.findMany({
      where: cik ? { cik } : { companyName: { contains: name, mode: 'insensitive' } },
      distinct: ['cik'],
      take: 4,
      orderBy: { filingDate: 'desc' },
    });
    return {
      candidates: rows.map((row) => ({
        sourceCandidate: { source: 'sec' as const, externalId: row.cik, name: row.companyName },
        sourceType: 'sec_filing' as const,
        identifiers: [{ type: 'cik', value: row.cik }],
        ...(row.stateOfIncorp ? { state: row.stateOfIncorp } : {}),
        claims: [],
        evidence: [
          {
            label: 'SEC company filing',
            url: row.url ?? `https://www.sec.gov/edgar/browse/?CIK=${encodeURIComponent(row.cik)}`,
            source: 'sec_filing',
            observedAt: row.syncedAt.toISOString(),
            excerpt: `${row.companyName}; CIK ${row.cik}`,
          },
        ],
      })),
      sourceGaps: [],
    };
  }

  /** Re-read a stable external identity at confirmation; never trust a preview payload as proof. */
  async refresh(
    ctx: TenantContext,
    selected: ProfileIdentitySourceCandidate,
    signal?: AbortSignal,
  ): Promise<DiscoveredProfileIdentity> {
    let candidates: DiscoveredProfileIdentity[];
    if (selected.source === 'sam') {
      const result = await this.sam.lookupByUei(selected.externalId);
      if (!result.ok)
        throw new ConflictException('SAM.gov identity cannot be rechecked; retry when available');
      candidates = result.entities
        .filter((row) => row.uei === selected.externalId)
        .map((row) => this.fromSam(row));
    } else if (
      selected.source === 'lda' &&
      /^\d{1,10}$/.test(selected.externalId) &&
      Number(selected.externalId) <= 2147483647
    )
      candidates = (await this.ldaCandidates('', Number(selected.externalId))).candidates;
    else if (selected.source === 'sec' && /^\d{1,10}$/.test(selected.externalId))
      candidates = (await this.secCandidates('', selected.externalId)).candidates;
    else if (selected.source === 'website') {
      const page = await this.reader.website(selected.externalId, signal);
      if (!page.text.includes(selected.name))
        throw new ConflictException('The company name is no longer present in the selected source');
      return {
        sourceCandidate: {
          source: 'website',
          externalId: page.url!,
          name: selected.name,
          ...(selected.website && new URL(selected.website).origin === new URL(page.url!).origin
            ? { website: selected.website }
            : {}),
        },
        sourceType: 'person_confirmed_website',
        identifiers: [],
        claims: [],
        evidence: [
          {
            label: 'Person-confirmed company website',
            url: page.url!,
            source: 'website',
            excerpt: selected.name,
            observedAt: page.observedAt,
          },
        ],
      };
    } else if (selected.source === 'document') {
      const source = await this.reader.identityDocument(ctx, selected.externalId, signal);
      if (!source.text.includes(selected.name))
        throw new ConflictException(
          'The company name is no longer present in the selected document',
        );
      return {
        sourceCandidate: {
          source: 'document',
          externalId: selected.externalId,
          name: selected.name,
        },
        sourceType: 'person_confirmed_document',
        identifiers: [],
        claims: [],
        evidence: [
          {
            label: source.label,
            attachmentId: selected.externalId,
            source: 'document',
            excerpt: selected.name,
            observedAt: source.observedAt,
          },
        ],
      };
    } else throw new NotFoundException('Identity source not found');
    const match = candidates.length === 1 ? candidates[0] : null;
    if (!match || identityName(match.sourceCandidate.name) !== identityName(selected.name))
      throw new ConflictException('The selected source identity changed; review candidates again');
    return match;
  }

  async validateClaims(
    ctx: TenantContext,
    selected: DiscoveredProfileIdentity,
    supplied: ProfileIdentityClaim[],
    signal?: AbortSignal,
  ) {
    const claims: ProfileIdentityClaim[] = [];
    const pages = new Map<string, string>();
    if (new Set(supplied.map((claim) => claim.sourceUrl ?? claim.attachmentId)).size > 5)
      throw new ConflictException('Choose identity evidence from no more than five source pages');
    for (const claim of supplied) {
      const known = selected.claims.find(
        (item) =>
          item.kind === claim.kind &&
          item.name === claim.name &&
          item.sourceUrl === claim.sourceUrl &&
          item.attachmentId === claim.attachmentId &&
          item.quote === claim.quote,
      );
      if (known) {
        claims.push(known);
        continue;
      }
      if (claim.attachmentId) {
        const source = await this.reader.identityDocument(ctx, claim.attachmentId, signal);
        if (
          !source.text.includes(claim.quote) ||
          !claim.quote.includes(claim.name) ||
          !source.text.includes(selected.sourceCandidate.name)
        )
          throw new ConflictException('The document relationship evidence changed');
        claims.push(claim);
        continue;
      }
      if (!claim.sourceUrl) throw new ConflictException('Identity relationship source is missing');
      if (!pages.has(claim.sourceUrl))
        pages.set(claim.sourceUrl, (await this.reader.website(claim.sourceUrl, signal)).text);
      const sameCompanyPage =
        selected.sourceCandidate.website &&
        new URL(selected.sourceCandidate.website).hostname === new URL(claim.sourceUrl).hostname;
      if (
        !pages.get(claim.sourceUrl)!.includes(claim.quote) ||
        !claim.quote.includes(claim.name) ||
        (!sameCompanyPage && !claim.quote.includes(selected.sourceCandidate.name))
      )
        throw new ConflictException(
          'An identity relationship quote changed or no longer identifies this company; review its source again',
        );
      claims.push(claim);
    }
    return claims;
  }
}
