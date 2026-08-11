import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import {
  inferPlacementFromTitle,
  isHierarchyLevel,
  wouldCreateCycle,
  type HierarchyLevel,
} from './client-hierarchy.helpers.js';

export interface CreatePersonInput {
  name: string;
  title?: string;
  email?: string;
  phone?: string;
  role?: string;
  lastContact?: string;
  notes?: string;
}

export type UpdatePersonInput = Partial<CreatePersonInput>;

/**
 * Hierarchy edits are a separate input from ordinary contact edits: sending
 * `hierarchyLevel` marks the placement MANUAL, and manual placement must never
 * be a side effect of someone correcting a phone number.
 */
export interface UpdatePersonHierarchyInput {
  /** `null` clears the placement and returns the person to inference. */
  hierarchyLevel?: HierarchyLevel | null;
  reportsToPersonId?: string | null;
  /** Explicitly hand a person back to title inference. */
  resetToAutomatic?: boolean;
  reviewRequired?: boolean;
}

@Injectable()
export class ClientPeopleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientKb: ClientKbService,
  ) {}

  async listPeople(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
        select: { id: true },
      });
      if (!client) throw new NotFoundException('Client not found');
      return tx.clientPerson.findMany({
        where: { tenantId: ctx.tenantId, clientId },
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  async createPerson(ctx: TenantContext, clientId: string, input: CreatePersonInput) {
    const inferred = inferPlacementFromTitle(input.title);
    const person = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
        select: { id: true },
      });
      if (!client) throw new NotFoundException('Client not found');
      return tx.clientPerson.create({
        data: {
          tenantId: ctx.tenantId,
          clientId,
          name: input.name,
          title: input.title ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          role: input.role ?? null,
          lastContact: input.lastContact ? new Date(input.lastContact) : null,
          notes: input.notes ?? null,
          // A new contact is placed automatically from its title; an unknown
          // title lands unplaced and flagged rather than at the bottom.
          hierarchyLevel: inferred.level,
          placementConfidence: inferred.confidence,
          reviewRequired: inferred.reviewRequired,
          placementSource: 'auto_title',
        },
      });
    });
    // Client KB (F5): keep retrieval in sync with the People tab.
    this.clientKb.indexPersonFireAndForget(ctx.tenantId, person.id);
    return person;
  }

  /**
   * Manual placement (Figma `907:3028` Configure Hierarchy, `907:2919` person
   * drawer). Separate from `updatePerson` so an ordinary contact edit can never
   * silently convert an automatic placement into a manual one.
   */
  async updatePersonHierarchy(
    ctx: TenantContext,
    clientId: string,
    id: string,
    input: UpdatePersonHierarchyInput,
  ) {
    const person = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const roster = await tx.clientPerson.findMany({
        where: { tenantId: ctx.tenantId, clientId },
        select: { id: true, reportsToPersonId: true, title: true },
      });
      const existing = roster.find((entry) => entry.id === id);
      if (!existing) throw new NotFoundException('Person not found');

      if ('hierarchyLevel' in input && input.hierarchyLevel != null && !isHierarchyLevel(input.hierarchyLevel)) {
        throw new BadRequestException('Unknown hierarchy level');
      }

      if ('reportsToPersonId' in input && input.reportsToPersonId) {
        // Reports-to must name a live contact of THIS client. The database FK
        // enforces the same rule; this produces a usable message first.
        if (!roster.some((entry) => entry.id === input.reportsToPersonId)) {
          throw new BadRequestException('That manager is not a contact of this client');
        }
        if (wouldCreateCycle(roster, id, input.reportsToPersonId)) {
          throw new BadRequestException('That placement would create a reporting loop');
        }
      }

      // Returning a person to inference is explicit, never implied.
      if (input.resetToAutomatic) {
        const inferred = inferPlacementFromTitle(existing.title);
        return tx.clientPerson.update({
          where: { id },
          data: {
            hierarchyLevel: inferred.level,
            placementConfidence: inferred.confidence,
            reviewRequired: inferred.reviewRequired,
            placementSource: 'auto_title',
            ...('reportsToPersonId' in input ? { reportsToPersonId: input.reportsToPersonId ?? null } : {}),
          },
        });
      }

      return tx.clientPerson.update({
        where: { id },
        data: {
          ...('hierarchyLevel' in input ? { hierarchyLevel: input.hierarchyLevel ?? null } : {}),
          ...('reportsToPersonId' in input ? { reportsToPersonId: input.reportsToPersonId ?? null } : {}),
          // Any explicit placement is manual, and a manual placement carries no
          // confidence score — a person decided it.
          placementSource: 'manual',
          placementConfidence: null,
          reviewRequired: input.reviewRequired ?? false,
        },
      });
    });
    this.clientKb.indexPersonFireAndForget(ctx.tenantId, person.id);
    return person;
  }

  /**
   * Create-or-merge a person for the AUTOMATED import path (Meri's
   * update_client_profile, contact import). Distinct from createPerson, which
   * the People tab uses and which must keep creating exactly what the human
   * asked for — two real people can share a name.
   *
   * Enrichment is re-run constantly (research a client again, re-sync mail),
   * and the tool contract was "each person in people[] is APPENDED, never used
   * to delete existing ones". With no unique constraint on the table that meant
   * every re-run duplicated every contact: enrich a client twice and Jason Hay
   * appears twice.
   *
   * Identity is email when present (citext, so case-insensitive) and otherwise
   * an exact case-insensitive name match within this client. Merging only FILLS
   * BLANKS — an imported row never overwrites a value a human already curated,
   * except lastContact, which advances monotonically because a newer verified
   * contact date is strictly better information.
   */
  async upsertPersonForImport(ctx: TenantContext, clientId: string, input: CreatePersonInput) {
    const result = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
        select: { id: true },
      });
      if (!client) throw new NotFoundException('Client not found');

      const email = input.email?.trim() || null;
      const existing = email
        ? await tx.clientPerson.findFirst({
            where: { tenantId: ctx.tenantId, clientId, email },
          })
        : await tx.clientPerson.findFirst({
            where: {
              tenantId: ctx.tenantId,
              clientId,
              name: { equals: input.name, mode: 'insensitive' },
            },
          });

      const lastContact = input.lastContact ? new Date(input.lastContact) : null;
      if (!existing) {
        const created = await tx.clientPerson.create({
          data: {
            tenantId: ctx.tenantId,
            clientId,
            name: input.name,
            title: input.title ?? null,
            email,
            phone: input.phone ?? null,
            role: input.role ?? null,
            lastContact,
            notes: input.notes ?? null,
          },
        });
        return { person: created, created: true };
      }

      const fill = <T>(current: T | null, incoming: T | null | undefined): T | null | undefined =>
        current === null || current === undefined || current === ('' as unknown as T)
          ? (incoming ?? undefined)
          : undefined;
      const advanced =
        lastContact && (!existing.lastContact || lastContact > existing.lastContact)
          ? lastContact
          : undefined;
      const updated = await tx.clientPerson.update({
        where: { id: existing.id },
        data: {
          title: fill(existing.title, input.title),
          email: fill(existing.email, email),
          phone: fill(existing.phone, input.phone),
          role: fill(existing.role, input.role),
          notes: fill(existing.notes, input.notes),
          ...(advanced ? { lastContact: advanced } : {}),
        },
      });
      return { person: updated, created: false };
    });
    this.clientKb.indexPersonFireAndForget(ctx.tenantId, result.person.id);
    return result;
  }

  async updatePerson(ctx: TenantContext, clientId: string, id: string, input: UpdatePersonInput) {
    const person = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.clientPerson.findFirst({
        where: { id, tenantId: ctx.tenantId, clientId },
        select: { id: true, placementSource: true },
      });
      if (!existing) throw new NotFoundException('Person not found');
      // A changed title re-runs inference, but ONLY for a person whose
      // placement is still automatic. Manual placement always wins.
      const reinfer =
        'title' in input && existing.placementSource !== 'manual'
          ? inferPlacementFromTitle(input.title)
          : null;
      return tx.clientPerson.update({
        where: { id },
        data: {
          ...(reinfer
            ? {
                hierarchyLevel: reinfer.level,
                placementConfidence: reinfer.confidence,
                reviewRequired: reinfer.reviewRequired,
                placementSource: 'auto_title',
              }
            : {}),
          ...('name' in input ? { name: input.name } : {}),
          ...('title' in input ? { title: input.title ?? null } : {}),
          ...('email' in input ? { email: input.email ?? null } : {}),
          ...('phone' in input ? { phone: input.phone ?? null } : {}),
          ...('role' in input ? { role: input.role ?? null } : {}),
          ...('lastContact' in input
            ? { lastContact: input.lastContact ? new Date(input.lastContact) : null }
            : {}),
          ...('notes' in input ? { notes: input.notes ?? null } : {}),
        },
      });
    });
    this.clientKb.indexPersonFireAndForget(ctx.tenantId, person.id);
    return person;
  }

  async deletePerson(ctx: TenantContext, clientId: string, id: string) {
    const result = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.clientPerson.findFirst({
        where: { id, tenantId: ctx.tenantId, clientId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Person not found');
      await tx.clientPerson.delete({ where: { id } });
      return { deleted: true };
    });
    this.clientKb.purgeFireAndForget(ctx.tenantId, 'client_person', id);
    return result;
  }
}
