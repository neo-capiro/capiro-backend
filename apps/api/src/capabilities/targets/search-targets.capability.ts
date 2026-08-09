import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DirectoryService } from '../../directory/directory.service.js';
import { CapabilityAuthorizationService } from '../capability-authorization.service.js';
import type { AuthorizedCapabilityContext } from '../capability-context.js';
import type { CapabilityDefinition, CapabilityRuntimeSchema } from '../capability-definition.js';
import { CapabilityError } from '../capability-errors.js';
import { assertCapabilityResult, type CapabilityResult } from '../capability-result.js';
import {
  recommendationRefForTarget,
  targetKeyForLocator,
  type OutreachTargetLocatorV1,
} from './outreach-target.contract.js';

export const TARGET_SEARCH_SOURCES = [
  'directory_member',
  'directory_staff',
  'state_legislator',
  'client_person',
  'engagement_contact',
  'client_recommendation',
] as const;

const criteriaSchema = z
  .object({
    governmentLevels: z
      .array(z.enum(['federal', 'state', 'local', 'agency', 'mixed']))
      .max(20)
      .default([]),
    chambers: z
      .array(z.enum(['house', 'senate', 'state_house', 'state_senate']))
      .max(20)
      .default([]),
    committees: z.array(z.string().min(1).max(120)).max(100).default([]),
    agencies: z.array(z.string().min(1).max(120)).max(100).default([]),
    states: z.array(z.string().min(1).max(120)).max(100).default([]),
    relationshipPreference: z.enum(['any', 'existing', 'new', 'mixed']).default('any'),
    includeStaff: z.boolean().default(true),
    includePrincipals: z.boolean().default(true),
  })
  .strict();

const searchInputSchema = z
  .object({
    query: z.string().max(500).nullable().default(null),
    clientId: z.string().uuid().nullable().default(null),
    sources: z.array(z.enum(TARGET_SEARCH_SOURCES)).max(TARGET_SEARCH_SOURCES.length).default([]),
    criteria: criteriaSchema.default({}),
    limit: z.number().int().min(1).max(50).default(20),
    excludeTargetKeys: z.array(z.string().min(1).max(384)).max(500).default([]),
    rejectedRecommendationRefs: z
      .array(z.string().regex(/^orec_[a-f0-9]{64}$/))
      .max(500)
      .default([]),
  })
  .strict();

export type SearchTargetsInput = z.infer<typeof searchInputSchema>;

export interface TargetRecommendationSignal {
  code:
    | 'committee_match'
    | 'issue_match'
    | 'district_nexus'
    | 'leadership'
    | 'client_recommendation'
    | 'client_contact'
    | 'recent_relationship'
    | 'directory_match'
    | 'current_role';
  label: string;
}

export interface TargetCandidateV1 {
  recommendationRef: string;
  targetKey: string;
  locator: OutreachTargetLocatorV1;
  displayName: string;
  title: string | null;
  organization: string | null;
  email: string | null;
  clientId: string | null;
  score: number;
  signals: TargetRecommendationSignal[];
  roleStatus: 'current' | 'historical' | 'unknown';
  emailStatus: 'available' | 'missing';
  jurisdiction: {
    governmentLevel: 'federal' | 'state' | 'corporate' | 'unknown';
    chamber: string | null;
    state: string | null;
    district: string | null;
    committees: string[];
    issueAreas: string[];
  };
}

export interface SearchTargetsData {
  candidates: TargetCandidateV1[];
  totalConsidered: number;
  unsupportedCriteria: string[];
}

const inputSchema: CapabilityRuntimeSchema<SearchTargetsInput> = {
  name: 'search_targets.input.v1',
  parse(value) {
    return searchInputSchema.parse(value);
  },
};

const outputSchema: CapabilityRuntimeSchema<CapabilityResult<SearchTargetsData>> = {
  name: 'search_targets.output.v1',
  parse(value) {
    return assertCapabilityResult<SearchTargetsData>(value, 'search_targets');
  },
};

@Injectable()
export class SearchTargetsCapability {
  constructor(
    private readonly prisma: PrismaService,
    private readonly directory: DirectoryService,
    private readonly authorization: CapabilityAuthorizationService,
  ) {}

  definition(): CapabilityDefinition<SearchTargetsInput, SearchTargetsData> {
    return {
      name: 'search_targets',
      description:
        'Search explainable government-affairs targets across the current Directory and authorized client contacts.',
      version: 1,
      readOnly: true,
      riskClass: 'read',
      surfaces: ['meri_chat', 'outreach', 'workspace', 'strategy', 'internal'],
      supportsClientScope: true,
      requiresClientScope: false,
      timeoutMs: 15_000,
      maxResultCount: 50,
      maxResultBytes: 192_000,
      provenanceRequired: true,
      inputSchema,
      outputSchema,
      execute: (ctx, input) => this.execute(ctx, input),
    };
  }

  async execute(
    ctx: AuthorizedCapabilityContext,
    rawInput: SearchTargetsInput,
  ): Promise<CapabilityResult<SearchTargetsData>> {
    const input = searchInputSchema.parse(rawInput);
    const clientId = input.clientId ?? ctx.clientScope?.clientId ?? null;
    if (ctx.clientScope && clientId && ctx.clientScope.clientId !== clientId) {
      throw new CapabilityError(
        'CAPABILITY_INVALID_SCOPE',
        'The requested client does not match the authorized campaign scope.',
        false,
        true,
      );
    }
    if (clientId) await this.authorization.authorizeClient(ctx, clientId);

    const sources = new Set(
      input.sources.length
        ? input.sources
        : [
            'directory_member',
            'directory_staff',
            'state_legislator',
            ...(clientId
              ? (['client_person', 'engagement_contact', 'client_recommendation'] as const)
              : []),
          ],
    );
    const criteriaHash = hashCriteria(input.criteria);
    const excludedKeys = new Set(input.excludeTargetKeys);
    const rejectedRefs = new Set(input.rejectedRecommendationRefs);
    const candidates = new Map<string, TargetCandidateV1>();
    const provenance: CapabilityResult<SearchTargetsData>['provenance'] = [];
    const unsupportedCriteria: string[] = [];
    let directorySnapshot = 'current';

    if (input.criteria.governmentLevels.includes('agency')) {
      unsupportedCriteria.push('Agency personnel are not available in the current target directory.');
    }
    if (input.criteria.governmentLevels.includes('local')) {
      unsupportedCriteria.push('Local-government personnel are not available in the current target directory.');
    }
    if (input.criteria.agencies.length) {
      unsupportedCriteria.push('Agency filters are preserved but cannot be resolved by Phase 4 target sources.');
    }

    if (sources.has('directory_member') && input.criteria.includePrincipals) {
      const payload = await this.directory.getContacts({
        q: input.query ?? undefined,
        state: input.criteria.states,
        committee: input.criteria.committees,
        page: 1,
        pageSize: Math.min(100, Math.max(input.limit * 3, 25)),
      });
      directorySnapshot = payload.sourceId;
      for (const contact of payload.contacts) {
        if (contact.chamber === 'Governor') continue;
        if (!matchesChamber(contact.chamber, input.criteria.chambers)) continue;
        const locator: OutreachTargetLocatorV1 = {
          source: 'directory_member',
          id: contact.id,
        };
        const targetKey = targetKeyForLocator(locator);
        const signals: TargetRecommendationSignal[] = [
          { code: 'directory_match', label: 'Matches the current Directory search.' },
        ];
        let score = 0.42;
        const committeeMatches = intersectText(contact.committees, input.criteria.committees);
        if (committeeMatches.length) {
          score += 0.24;
          signals.push({
            code: 'committee_match',
            label: `Committee match: ${committeeMatches.slice(0, 2).join(', ')}`,
          });
        }
        const issueMatches = intersectText(contact.focusAreas, input.criteria.committees);
        if (issueMatches.length) {
          score += 0.08;
          signals.push({ code: 'issue_match', label: 'Issue portfolio overlaps the target criteria.' });
        }
        if ((contact.leadershipPositions ?? []).length) {
          score += 0.04;
          signals.push({ code: 'leadership', label: 'Holds a current leadership position.' });
        }
        if (!contact.outgoingStatus) {
          score += 0.05;
          signals.push({ code: 'current_role', label: 'Current role is present in the Directory.' });
        }
        if (contact.lastTouchpoint) {
          score += 0.08;
          signals.push({ code: 'recent_relationship', label: 'Capiro has prior relationship activity.' });
        }
        this.addCandidate(candidates, {
          locator,
          targetKey,
          displayName: contact.fullName || contact.memberName,
          title: contact.title || null,
          organization: contact.office || null,
          email: normalizeEmail(contact.email),
          clientId: null,
          score,
          signals,
          roleStatus: contact.outgoingStatus ? 'historical' : 'current',
          jurisdiction: {
            governmentLevel: 'federal',
            chamber: contact.chamber,
            state: contact.state || null,
            district: contact.district || null,
            committees: contact.committees ?? [],
            issueAreas: contact.focusAreas ?? [],
          },
          criteriaHash,
          rejectedRefs,
          excludedKeys,
        });
      }
    }

    if (sources.has('directory_staff') && input.criteria.includeStaff) {
      const payload = await this.directory.getStaffers({
        q: input.query ?? undefined,
        state: input.criteria.states,
        page: 1,
        pageSize: Math.min(100, Math.max(input.limit * 3, 25)),
      });
      for (const staff of payload.staffers) {
        if (!matchesChamber(staff.member.chamber, input.criteria.chambers)) continue;
        const locator: OutreachTargetLocatorV1 = { source: 'directory_staff', id: staff.id };
        const targetKey = targetKeyForLocator(locator);
        const issueMatches = intersectText(staff.issueAreas, input.criteria.committees);
        const signals: TargetRecommendationSignal[] = [
          { code: 'directory_match', label: 'Current staff match from the Directory.' },
          { code: 'current_role', label: 'Current staff role is present in the Directory.' },
        ];
        let score = 0.5;
        if (issueMatches.length) {
          score += 0.14;
          signals.push({ code: 'issue_match', label: 'Staff issue portfolio overlaps the target criteria.' });
        }
        this.addCandidate(candidates, {
          locator,
          targetKey,
          displayName: staff.fullName,
          title: staff.title || null,
          organization: staff.member.fullName,
          email: normalizeEmail(staff.email),
          clientId: null,
          score,
          signals,
          roleStatus: 'current',
          jurisdiction: {
            governmentLevel: 'federal',
            chamber: staff.member.chamber,
            state: staff.member.state || null,
            district: staff.member.district || null,
            committees: [],
            issueAreas: staff.issueAreas ?? [],
          },
          criteriaHash,
          rejectedRefs,
          excludedKeys,
        });
      }
    }

    if (
      sources.has('state_legislator') &&
      (input.criteria.governmentLevels.length === 0 ||
        input.criteria.governmentLevels.some((level) => level === 'state' || level === 'mixed'))
    ) {
      const rows = await this.prisma.stateLegislator.findMany({
        where: {
          ...(input.query
            ? { name: { contains: input.query, mode: 'insensitive' as const } }
            : {}),
          ...(input.criteria.states.length ? { state: { in: input.criteria.states } } : {}),
          ...(stateChambers(input.criteria.chambers).length
            ? { chamber: { in: stateChambers(input.criteria.chambers) } }
            : {}),
        },
        select: {
          id: true,
          name: true,
          party: true,
          state: true,
          chamber: true,
          district: true,
          committees: true,
        },
        orderBy: [{ state: 'asc' }, { name: 'asc' }],
        take: Math.min(input.limit * 3, 100),
      });
      for (const row of rows) {
        const committees = committeeNames(row.committees);
        const locator: OutreachTargetLocatorV1 = { source: 'state_legislator', id: row.id };
        const targetKey = targetKeyForLocator(locator);
        const matches = intersectText(committees, input.criteria.committees);
        const signals: TargetRecommendationSignal[] = [
          { code: 'directory_match', label: 'Matches current state-legislator data.' },
          { code: 'current_role', label: 'Current state legislative record.' },
        ];
        let score = 0.4;
        if (matches.length) {
          score += 0.22;
          signals.push({ code: 'committee_match', label: `Committee match: ${matches.slice(0, 2).join(', ')}` });
        }
        this.addCandidate(candidates, {
          locator,
          targetKey,
          displayName: row.name,
          title: `${row.state ?? ''} ${row.chamber ?? ''} legislator`.trim() || null,
          organization: null,
          email: null,
          clientId: null,
          score,
          signals,
          roleStatus: 'current',
          jurisdiction: {
            governmentLevel: 'state',
            chamber: row.chamber,
            state: row.state,
            district: row.district,
            committees,
            issueAreas: [],
          },
          criteriaHash,
          rejectedRefs,
          excludedKeys,
        });
      }
    }

    if (clientId) {
      await this.prisma.withTenantUser(ctx.tenantId, ctx.actorUserId, async (tx) => {
        if (sources.has('client_person')) {
          const people = await tx.clientPerson.findMany({
            where: {
              tenantId: ctx.tenantId,
              clientId,
              ...(input.query
                ? {
                    OR: [
                      { name: { contains: input.query, mode: 'insensitive' } },
                      { title: { contains: input.query, mode: 'insensitive' } },
                      { role: { contains: input.query, mode: 'insensitive' } },
                      { email: { contains: input.query, mode: 'insensitive' } },
                    ],
                  }
                : {}),
            },
            orderBy: [{ lastContact: 'desc' }, { name: 'asc' }],
            take: Math.min(input.limit * 2, 100),
          });
          for (const person of people) {
            const locator: OutreachTargetLocatorV1 = {
              source: 'client_person',
              id: person.id,
              clientId,
            };
            const targetKey = targetKeyForLocator(locator);
            const signals: TargetRecommendationSignal[] = [
              { code: 'client_contact', label: 'Saved client contact.' },
            ];
            let score = 0.66;
            if (person.lastContact) {
              score += 0.15;
              signals.push({ code: 'recent_relationship', label: 'Has recorded client relationship history.' });
            }
            this.addCandidate(candidates, {
              locator,
              targetKey,
              displayName: person.name,
              title: person.title ?? person.role,
              organization: null,
              email: normalizeEmail(person.email),
              clientId,
              score,
              signals,
              roleStatus: 'unknown',
              jurisdiction: {
                governmentLevel: 'corporate',
                chamber: null,
                state: null,
                district: null,
                committees: [],
                issueAreas: [],
              },
              criteriaHash,
              rejectedRefs,
              excludedKeys,
            });
          }
        }

        if (sources.has('engagement_contact')) {
          const contacts = await tx.engagementContact.findMany({
            where: {
              tenantId: ctx.tenantId,
              clientId,
              ...(input.query
                ? {
                    OR: [
                      { fullName: { contains: input.query, mode: 'insensitive' } },
                      { title: { contains: input.query, mode: 'insensitive' } },
                      { organization: { contains: input.query, mode: 'insensitive' } },
                      { email: { contains: input.query, mode: 'insensitive' } },
                    ],
                  }
                : {}),
            },
            orderBy: [{ updatedAt: 'desc' }, { fullName: 'asc' }],
            take: Math.min(input.limit * 2, 100),
          });
          for (const contact of contacts) {
            const locator: OutreachTargetLocatorV1 = {
              source: 'engagement_contact',
              id: contact.id,
              clientId,
            };
            const targetKey = targetKeyForLocator(locator);
            this.addCandidate(candidates, {
              locator,
              targetKey,
              displayName: contact.fullName || contact.email || 'Unnamed contact',
              title: contact.title,
              organization: contact.organization,
              email: normalizeEmail(contact.email),
              clientId,
              score: 0.63,
              signals: [{ code: 'client_contact', label: 'Known Engagement contact for this client.' }],
              roleStatus: 'unknown',
              jurisdiction: {
                governmentLevel: 'unknown',
                chamber: null,
                state: null,
                district: null,
                committees: [],
                issueAreas: [],
              },
              criteriaHash,
              rejectedRefs,
              excludedKeys,
            });
          }
        }

        if (sources.has('client_recommendation')) {
          const cached = await tx.clientTargetRecommendation.findUnique({
            where: { clientId },
            select: { recommendations: true, computedAt: true },
          });
          const recommendations = Array.isArray(cached?.recommendations)
            ? cached!.recommendations
            : [];
          for (const raw of recommendations) {
            if (!raw || typeof raw !== 'object') continue;
            const value = raw as Record<string, unknown>;
            const memberId = typeof value.memberId === 'string' ? value.memberId : '';
            if (!memberId) continue;
            const locator: OutreachTargetLocatorV1 = {
              source: 'directory_member',
              id: memberId,
            };
            const targetKey = targetKeyForLocator(locator);
            const signals: TargetRecommendationSignal[] = [
              { code: 'client_recommendation', label: 'Existing client-specific office recommendation.' },
            ];
            for (const tag of Array.isArray(value.tags) ? value.tags : []) {
              if (tag === 'committee') signals.push({ code: 'committee_match', label: 'Committee jurisdiction signal.' });
              if (tag === 'district') signals.push({ code: 'district_nexus', label: 'Client facility/district nexus.' });
              if (tag === 'issue') signals.push({ code: 'issue_match', label: 'Client issue overlap.' });
              if (tag === 'leadership') signals.push({ code: 'leadership', label: 'Leadership position.' });
            }
            this.addCandidate(candidates, {
              locator,
              targetKey,
              displayName: String(value.office ?? memberId),
              title: null,
              organization: String(value.office ?? '') || null,
              email: null,
              clientId: null,
              score: Math.max(0, Math.min(1, Number(value.score ?? 0.5))),
              signals,
              roleStatus: 'current',
              jurisdiction: {
                governmentLevel: 'federal',
                chamber: typeof value.chamber === 'string' ? value.chamber : null,
                state: typeof value.state === 'string' ? value.state : null,
                district: null,
                committees: typeof value.committee === 'string' ? [value.committee] : [],
                issueAreas: [],
              },
              criteriaHash,
              rejectedRefs,
              excludedKeys,
            });
            if (cached?.computedAt) {
              provenance.push({
                recordType: 'client_target_recommendation',
                recordId: clientId,
                sourceSystem: 'capiro',
                sourceDate: cached.computedAt.toISOString(),
                lastVerifiedAt: cached.computedAt.toISOString(),
                retrievedAt: new Date().toISOString(),
                verificationClass: 'derived',
                classification: 'recommendation',
              });
            }
          }
        }
      });
    }

    const ordered = [...candidates.values()]
      .sort((a, b) => b.score - a.score || compare(a.targetKey, b.targetKey))
      .slice(0, input.limit);
    const now = new Date().toISOString();
    if (ordered.some((candidate) => candidate.locator.source.startsWith('directory_'))) {
      provenance.push({
        recordType: 'directory_snapshot',
        recordId: directorySnapshot,
        sourceSystem: 'capiro_directory',
        sourceDate: null,
        lastVerifiedAt: null,
        retrievedAt: now,
        verificationClass: 'authoritative',
        classification: 'fact',
      });
    }
    return {
      capability: 'search_targets',
      schemaVersion: 1,
      data: {
        candidates: ordered,
        totalConsidered: candidates.size,
        unsupportedCriteria: [...new Set(unsupportedCriteria)].sort(compare),
      },
      provenance,
      exclusions: [],
      scope: { tenantId: ctx.tenantId, clientId },
      freshness: {
        asOf: now,
        degraded: unsupportedCriteria.length > 0,
        reasons: [...new Set(unsupportedCriteria)].sort(compare),
      },
      authorization: { filtered: false, restrictedCount: 0 },
    };
  }

  private addCandidate(
    candidates: Map<string, TargetCandidateV1>,
    input: Omit<TargetCandidateV1, 'recommendationRef' | 'emailStatus'> & {
      criteriaHash: string;
      rejectedRefs: Set<string>;
      excludedKeys: Set<string>;
    },
  ): void {
    if (input.excludedKeys.has(input.targetKey)) return;
    const recommendationRef = recommendationRefForTarget({
      targetKey: input.targetKey,
      criteriaHash: input.criteriaHash,
      clientId: input.clientId,
    });
    if (input.rejectedRefs.has(recommendationRef)) return;
    const candidate: TargetCandidateV1 = {
      recommendationRef,
      targetKey: input.targetKey,
      locator: input.locator,
      displayName: input.displayName,
      title: input.title,
      organization: input.organization,
      email: input.email,
      clientId: input.clientId,
      score: Math.round(Math.max(0, Math.min(1, input.score)) * 1000) / 1000,
      signals: dedupeSignals(input.signals),
      roleStatus: input.roleStatus,
      emailStatus: input.email ? 'available' : 'missing',
      jurisdiction: input.jurisdiction,
    };
    const existing = candidates.get(candidate.targetKey);
    if (!existing || candidate.score > existing.score) candidates.set(candidate.targetKey, candidate);
    else if (existing) existing.signals = dedupeSignals([...existing.signals, ...candidate.signals]);
  }
}

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  return normalized.includes('@') ? normalized : null;
}

function hashCriteria(criteria: SearchTargetsInput['criteria']): string {
  return createHash('sha256').update(stableJson(criteria), 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort(compare)
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function matchesChamber(chamber: string | null, criteria: SearchTargetsInput['criteria']['chambers']): boolean {
  if (!criteria.length) return true;
  const normalized = chamber?.toLowerCase();
  return criteria.some((value) => value === normalized);
}

function stateChambers(chambers: SearchTargetsInput['criteria']['chambers']): string[] {
  return chambers
    .filter((value) => value === 'state_house' || value === 'state_senate')
    .map((value) => (value === 'state_house' ? 'lower' : 'upper'));
}

function intersectText(values: readonly string[], queries: readonly string[]): string[] {
  const normalizedQueries = queries.map((value) => value.toLowerCase().trim()).filter(Boolean);
  if (!normalizedQueries.length) return [];
  return values.filter((value) => {
    const normalized = value.toLowerCase();
    return normalizedQueries.some((query) => normalized.includes(query) || query.includes(normalized));
  });
}

function committeeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      entry && typeof entry === 'object' && 'name' in entry
        ? String((entry as { name?: unknown }).name ?? '').trim()
        : '',
    )
    .filter(Boolean);
}

function dedupeSignals(signals: readonly TargetRecommendationSignal[]): TargetRecommendationSignal[] {
  const byCode = new Map<string, TargetRecommendationSignal>();
  for (const signal of signals) if (!byCode.has(signal.code)) byCode.set(signal.code, signal);
  return [...byCode.values()].sort((a, b) => compare(a.code, b.code));
}
