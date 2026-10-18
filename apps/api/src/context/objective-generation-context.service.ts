import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  ClientObjectiveDestinationError,
  requireClientObjectiveDestinationRevision,
} from '@capiro/shared';
import { DirectoryService } from '../directory/directory.service.js';
import { RepresentationResolverService } from '../clients/representation-resolver.service.js';
import { requireObjectiveReady } from '../clients/objectives/objective-rules.js';
import { classifyStaffKind } from '../clients/client-targets.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readObjectiveSources } from './objective-generation-sources.js';
import { ObjectiveTypedContextError, projectObjectiveTypedContext } from './objective-generation-typed-context.js';
import {
  BackgroundSnapshotError,
  OBJECTIVE_BACKGROUND_FIELDS,
  ObjectivePacketBudgetError,
  objectivePacketAddition,
  readObjectiveBackground,
} from './objective-generation-background.js';
import type {
  StrategyContextPlaneBundle,
  StrategyContextPlaneInput,
} from './strategy-context-plane.service.js';

export function objectiveDigest(value: unknown): string {
  const stable = (v: any): any =>
    v instanceof Date
      ? v.toISOString()
      : Array.isArray(v)
        ? v.map(stable)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, stable(v[k])]),
            )
          : v;
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}
const ISSUE = {
  group: 'government_targets',
  code: 'REQUIRED_CONTEXT_UNAVAILABLE',
  message: 'Required relationship context could not be completely observed.',
};
export const OBJECTIVE_FIELD_INVENTORY: Record<string, string[]> = {
  ...OBJECTIVE_BACKGROUND_FIELDS,
  government_profile_support: [
    'id',
    'description',
    'product_description',
    'sector_tag',
    'sectors',
    'funding_priorities',
    'submission_tracks',
    'issue_codes',
    'uei',
    'cage_code',
    'naics_codes',
    'psc_codes',
    'applicant_types',
    'set_aside_certifications',
    'sb_classification',
    'sam_status',
    'sam_expiration_date',
    'lda_registrant_name',
    'ein',
  ],
  government_targets: [
    'id',
    'client_id',
    'member_id',
    'member_name',
    'source_directory',
    'party',
    'state',
    'chamber',
    'committee',
    'staff_kind',
    'tier',
    'source',
    'added_at',
  ],
  represented_facilities: [
    'id',
    'name',
    'address_line',
    'city',
    'state',
    'zip',
    'employee_count',
    'congressional_district',
    'state_house_district',
    'state_senate_district',
    'district_source',
    'geocoded_at',
  ],
  target_recommendations: ['id', 'computed_at', 'recommendations_jsonb'],
  member_notes: ['id', 'directory_contact_id', 'body', 'updated_at', 'scope'],
  state_directory: [
    'id',
    'name',
    'state',
    'chamber',
    'district',
    'party',
    'email',
    'source_evidence',
    'committees',
    'active',
    'synced_at',
  ],
  current_directory: ['targetId', 'detail', 'representedFacilities'],
  relationship_history: ['id', 'domain', 'provenance'],
};
export class ObjectiveContextIncomplete extends BadRequestException {
  constructor(group = 'government_targets', code = 'REQUIRED_CONTEXT_UNAVAILABLE') {
    super({
      code: 'OBJECTIVE_CONTEXT_INCOMPLETE',
      message:
        'Government relationship context is incomplete. Review its coverage before generating.',
      issues: [
        {
          group,
          code,
          message:
            code === 'REQUIRED_FIELDS_EXCEED_PACKET_BUDGET'
              ? 'Required fields do not fit the approved context budget; generation was not dispatched.'
              : 'Required context could not be completely observed.',
        },
      ],
    });
  }
}

@Injectable()
export class ObjectiveGenerationContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly directory: DirectoryService,
    private readonly representation: RepresentationResolverService,
  ) {}

  /** Runtime-only scope/read results. Nothing here persists another context corpus. */
  async observe(input: StrategyContextPlaneInput) {
    if (
      input.mode !== 'draft' ||
      !input.objective ||
      !input.generationRequestId ||
      !input.generationType
    )
      throw new BadRequestException('Objective context requires an exact draft request');
    const initial = await this.snapshot(input, []);
    const contacts: any[] = [];
    const contactIds = initial.sources.government_targets.map((t) => String(t.member_id));
    const issues: (typeof ISSUE)[] = [];
    // Sequential bounded-reader work: no unbounded parallel Windows/provider fanout.
    for (const target of initial.sources.government_targets) {
      try {
        let detail: any;
        let facilities: Array<{ id: string; name: string }> | null = null;
        if (target.source_directory === 'staff') {
          const staff = await this.directory.getStaffDetail(target.member_id);
          detail = {
            id: staff.id,
            source: staff.source,
            identity: staff.identity,
            positions: staff.positions,
            staffKind: classifyStaffKind(staff),
            roles: staff.roles,
            issues: staff.issues,
            committeeAssociations: staff.committeeAssociations,
            memberAssociations: staff.memberAssociations,
            emails: staff.emails,
            socialContacts: staff.socialContacts,
            officeAddresses: staff.officeAddresses,
          };
          if (detail.staffKind == null) throw new ObjectiveContextIncomplete('current_directory');
        } else if (target.source_directory === 'congress') {
          const member = await this.directory.getMemberDetail(target.member_id);
          detail = {
            id: member.id,
            source: member.source,
            identity: member.identity,
            offices: member.offices,
            officeAddresses: member.officeAddresses,
            committees: member.committees,
            leaderships: member.leaderships,
            socialContacts: member.socialContacts,
            staffRoles: member.staffRoles,
            staffIssues: member.staffIssues,
          };
          const contact = (await this.directory.getAllContacts()).find((c) => c.id === member.id);
          if (!contact || !contact.state || !['House', 'Senate'].includes(contact.chamber))
            throw new ObjectiveContextIncomplete();
          const district = Number(contact.district);
          facilities = await this.representation.facilitiesForMember(
            input.tenantId,
            input.clientId,
            {
              type: 'federal',
              chamber: contact.chamber === 'Senate' ? 'senate' : 'house',
              state: contact.state,
              district: Number.isFinite(district) && district > 0 ? district : null,
            },
          );
        } else if (target.source_directory === 'state') {
          const state = initial.sources.state_directory.find((s) => s.id === target.member_id);
          if (!state || !state.active || !['lower', 'upper'].includes(state.chamber))
            throw new ObjectiveContextIncomplete();
          detail = state;
          facilities = await this.representation.facilitiesForMember(
            input.tenantId,
            input.clientId,
            { type: 'state', state: state.state, chamber: state.chamber, district: state.district },
          );
        } else throw new ObjectiveContextIncomplete();
        const required =
          target.source_directory === 'staff'
            ? [
                'id',
                'source',
                'identity',
                'staffKind',
                'positions',
                'roles',
                'issues',
                'committeeAssociations',
                'memberAssociations',
                'emails',
                'socialContacts',
                'officeAddresses',
              ]
            : target.source_directory === 'congress'
              ? [
                  'id',
                  'source',
                  'identity',
                  'offices',
                  'officeAddresses',
                  'committees',
                  'leaderships',
                  'socialContacts',
                  'staffRoles',
                  'staffIssues',
                ]
              : OBJECTIVE_FIELD_INVENTORY.state_directory!;
        if (required.some((key) => detail[key] === undefined))
          throw new ObjectiveContextIncomplete();
        contactIds.push(detail.id);
        contacts.push({ targetId: target.id, detail, representedFacilities: facilities });
      } catch {
        issues.push({ ...ISSUE });
      }
    }
    const ids = [...new Set(contactIds)].sort();
    const current = await this.snapshot(input, ids);
    // Membership changed during external observations: refuse, never substitute.
    for (const group of [
      'government_targets',
      'represented_facilities',
      'state_directory',
    ] as const) {
      if (objectiveDigest(initial.sources[group]) !== objectiveDigest(current.sources[group]))
        throw new ObjectiveContextIncomplete();
    }
    return {
      ...current,
      contacts,
      contactIds: ids,
      issues,
      externalDigest: objectiveDigest(contacts),
      localDigest: objectiveDigest(current.sources),
      observedAt: new Date().toISOString(),
    };
  }

  private async snapshot(input: StrategyContextPlaneInput, contactIds: string[]) {
    try {
      return await this.prisma.withTenant(input.tenantId, async (tx) => {
        const source = await requireClientObjectiveDestinationRevision(tx, input, {
          clientId: input.clientId,
          ...input.objective!,
        });
        const rows = await tx.$queryRaw<Array<{ snapshot: any }>>`
        SELECT snapshot FROM client_objective_revisions WHERE tenant_id=${input.tenantId}::uuid
          AND client_id=${input.clientId}::uuid AND id=${source.objectiveRevisionId}::uuid`;
        const saved = rows[0]?.snapshot;
        if (
          !saved ||
          saved.status !== 'ready' ||
          saved.deletedAt != null ||
          saved.id !== source.objectiveId ||
          saved.clientId !== source.clientId ||
          saved.version !== source.objectiveVersion
        )
          throw new BadRequestException('Objective must be ready before generating');
        const intent = {
          outcome: saved.outcome,
          governmentProblem: saved.governmentProblem,
          askType: saved.askType,
          minimumWin: saved.minimumWin,
          limits: saved.limits,
        };
        if (
          Object.entries({
            outcome: 2000,
            governmentProblem: 4000,
            minimumWin: 2000,
            limits: 4000,
          }).some(([k, max]) => typeof saved[k] !== 'string' || saved[k].length > max)
        )
          throw new BadRequestException('Invalid saved Objective');
        requireObjectiveReady(intent);
        return {
          source,
          intent,
          snapshotSha256: objectiveDigest(saved),
          sourceDigest: objectiveDigest({ source, intent }),
          background: await readObjectiveBackground(tx, input.tenantId, input.clientId),
          sources: await readObjectiveSources(
            tx,
            input.tenantId,
            input.clientId,
            contactIds,
            input.clerkUserId,
          ),
        };
      });
    } catch (error) {
      if (error instanceof BackgroundSnapshotError)
        throw new ObjectiveContextIncomplete('profile_fill_corpus');
      if (error instanceof ClientObjectiveDestinationError) {
        if (error.code === 'OBJECTIVE_VERSION_CONFLICT')
          throw new ConflictException({
            code: error.code,
            message: 'Objective changed. Refresh it before continuing.',
          });
        if (error.code === 'OBJECTIVE_DESTINATION_INVALID')
          throw new BadRequestException('Invalid Objective selector');
        throw new NotFoundException('Objective generation not found');
      }
      throw error;
    }
  }

  bind(
    input: StrategyContextPlaneInput,
    observed: Omit<Awaited<ReturnType<ObjectiveGenerationContextService['observe']>>, 'snapshotSha256'> & { snapshotSha256?: string },
    bundle: StrategyContextPlaneBundle,
    historyDigest: string,
    historyRecords: Record<string, any>[],
    prompt: {
      retrieval: string;
      steering: string;
      compose(intentText: string, recordsText: string): string;
    },
    historyObservedAt = new Date().toISOString(),
  ) {
    const { governedContext: governed } = bundle;
    const packet = governed.contextPacket;
    const coverage = bundle.coverage;
    if (
      observed.issues.length ||
      bundle.kind !== 'governed_packet' ||
      !packet.persisted ||
      !packet.packetId ||
      !packet.compiledAt ||
      packet.degraded ||
      !coverage.complete ||
      !coverage.paginationComplete ||
      coverage.truncated
    )
      throw new ObjectiveContextIncomplete();
    const { mailbox_authority: _mailboxAuthority, ...contextSources } = observed.sources;
    const groups: Record<string, any[]> = {
      ...contextSources,
      government_targets: observed.sources.government_targets.map((target) =>
        target.source_directory !== 'staff'
          ? target
          : {
              ...target,
              saved_staff_kind: target.staff_kind,
              staff_kind:
                observed.contacts.find((c) => c.targetId === target.id)?.detail.staffKind ?? null,
            },
      ),
      current_directory: observed.contacts,
      relationship_history: historyRecords,
      ...observed.background.groups,
    };
    for (const [group, fields] of Object.entries(OBJECTIVE_FIELD_INVENTORY)) {
      if (
        !Array.isArray(groups[group]) ||
        groups[group]!.some((record) => fields.some((field) => record[field] === undefined))
      )
        throw new ObjectiveContextIncomplete(group);
    }
    const manifest = Object.entries(groups).map(([group, records]) => ({
      group,
      expectedRecords: records.length,
      fieldInventory: OBJECTIVE_FIELD_INVENTORY[group],
      readRecords: records.length,
      enumerationComplete: true,
      fields: records.flatMap((record) => {
        const fields: any[] = [];
        const visit = (value: any, field: string) => {
          if (value && typeof value === 'object' && Object.keys(value).length) {
            for (const key of Object.keys(value).sort())
              visit(value[key], field ? `${field}.${key}` : key);
          } else
            fields.push({
              field,
              sourceReference: String(record.id ?? record.targetId ?? input.clientId),
              sourceVersionOrAsOf:
                record.updated_at ??
                record.updatedAt ??
                record.computed_at ??
                record.synced_at ??
                record.detail?.source?.lastUpdatedAt ??
                observed.observedAt,
              disposition: value == null ? 'absent' : 'included',
            });
        };
        visit(record, '');
        return fields;
      }),
    }));
    try {
      const { recordsText, intentText } = objectivePacketAddition(groups, observed.intent, prompt);
      // Compose from typed parts. Literal header/tag text inside authorized data
      // cannot redirect insertion or undercount the existing prompt budgets.
      governed.prompt = prompt.compose(intentText, recordsText);
    } catch (error) {
      if (error instanceof ObjectivePacketBudgetError)
        throw new ObjectiveContextIncomplete(error.group, 'REQUIRED_FIELDS_EXCEED_PACKET_BUDGET');
      throw error;
    }
    const coverageDigest = objectiveDigest({
      manifest,
      history: governed.retrieval.coverage,
      policy: 'objective-v1-required-lossless',
    });
    const inputDigest = objectiveDigest({
      sourceDigest: observed.sourceDigest,
      coverageDigest,
      packetId: packet.packetId,
      requestId: input.generationRequestId,
      type: input.generationType,
      localDigest: observed.localDigest,
      externalDigest: observed.externalDigest,
      historyDigest,
      promptDigest: objectiveDigest(governed.prompt),
    });
    if (input.objectiveTypedContext === true) {
      try {
        bundle.objectiveTypedContext = projectObjectiveTypedContext({
          tenantId: input.tenantId, clerkUserId: input.clerkUserId, requestId: input.generationRequestId,
          source: observed.source, intent: observed.intent, snapshotSha256: observed.snapshotSha256,
          sourceDigest: observed.sourceDigest, packetId: packet.packetId, compiledAt: packet.compiledAt,
          coverageDigest, prompt: governed.prompt, findings: observed.background.groups.profile_fill_findings,
          packetPersisted: packet.persisted, packetDegraded: packet.degraded, coverageComplete: coverage.complete,
          paginationComplete: coverage.paginationComplete, truncated: coverage.truncated,
        });
      } catch (error) {
        if (error instanceof ObjectiveTypedContextError) throw new ObjectiveContextIncomplete('profile_fill_corpus');
        throw error;
      }
    }
    return {
      tenantId: input.tenantId,
      clerkUserId: input.clerkUserId,
      requestId: input.generationRequestId,
      type: input.generationType,
      source: observed.source,
      intent: observed.intent,
      localDigest: observed.localDigest,
      externalDigest: observed.externalDigest,
      contactIds: observed.contactIds,
      observedAt: observed.observedAt,
      historyDigest,
      historyObservedAt,
      coverage: manifest,
      context: {
        reobservedAt: null,
        state: 'complete' as const,
        packetId: packet.packetId,
        compiledAt: packet.compiledAt,
        sourceDigest: observed.sourceDigest,
        coverageDigest,
        inputDigest,
        issues: [],
      },
    };
  }
}
