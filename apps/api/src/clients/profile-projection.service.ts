import { profileCapabilityLifecycle } from './profile-capability-lifecycle.js';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { ClientsService, type UpdateClientInput } from './clients.service.js';
import { ClientPeopleService } from './client-people.service.js';
import { ClientFacilitiesService, type CreateFacilityInput } from './client-facilities.service.js';
import { ClientCapabilitiesService } from './client-capabilities.service.js';
import type { ProfileSubject } from './profile-subject.js';
import type { ReviewTransaction } from './client-profile-fill-review-store.js';
import { asRecord, asString, asStringArray } from './client-profile-fill.helpers.js';

const suppliedText = (row: Record<string, unknown>, key: string): string | undefined =>
  key in row ? String(row[key] ?? '').trim() : undefined;
const REGISTRATION = new Set([
  'samStatus',
  'samExpirationDate',
  'ein',
  'ldaRegistrantName',
  'sbClassification',
]);
export const MANUAL_FIELDS = new Set([
  'name',
  'website',
  'description',
  'productDescription',
  'primaryContactName',
  'primaryContactEmail',
  'primaryContactPhone',
  'uei',
  'cageCode',
  'naicsCodes',
  'pscCodes',
  'issueCodes',
  'applicantTypes',
  'setAsideCertifications',
  ...REGISTRATION,
]);

/** Existing domain services remain canonical projection owners; facts retain the subject's history. */
@Injectable()
export class ProfileProjectionService {
  constructor(
    private readonly clients: ClientsService,
    private readonly people: ClientPeopleService,
    private readonly facilities: ClientFacilitiesService,
    private readonly capabilities: ClientCapabilitiesService,
  ) {}

  async project(
    scope: ReviewTransaction,
    ctx: TenantContext,
    subject: ProfileSubject,
    fieldKey: string,
    value: unknown,
    provenance?: Prisma.InputJsonValue,
  ): Promise<unknown> {
    const tx = scope.tx;
    if (subject.kind === 'prospect') {
      if (['name', 'website', 'description'].includes(fieldKey))
        await tx.businessDevelopmentProspect.update({
          where: { id: subject.id },
          data: { [fieldKey === 'name' ? 'displayName' : fieldKey]: value },
        });
      return value;
    }
    if (MANUAL_FIELDS.has(fieldKey)) {
      if (REGISTRATION.has(fieldKey)) {
        const c = await tx.client.findFirst({
          where: { id: subject.id, tenantId: ctx.tenantId },
          select: { intakeData: true },
        });
        if (!c) throw new NotFoundException('Profile not found');
        await this.clients.updateInTransaction(
          tx,
          ctx,
          subject.id,
          {
            intakeData: {
              ...asRecord(c.intakeData),
              registration: { ...asRecord(asRecord(c.intakeData).registration), [fieldKey]: value },
            },
          },
          false,
        );
      } else
        await this.clients.updateInTransaction(
          tx,
          ctx,
          subject.id,
          { [fieldKey]: value } as UpdateClientInput,
          false,
        );
      scope.afterCommit.push(() => this.clients.indexProfileAfterCommit(ctx, subject.id));
      return value;
    }
    if (fieldKey.startsWith('federal_footprint.') || fieldKey.startsWith('lda-history:'))
      return value;
    const [section] = fieldKey.split('.'),
      row = asRecord(value);
    if (section === 'locations') {
      const role = asString(row.role) ?? asString(row.siteRole);
      const roleAliases: Record<string, string> = {
        hq: 'headquarters',
        factory: 'manufacturing',
        lab: 'research',
      };
      const data = {
        name: asString(row.name) ?? '',
        addressLine: suppliedText(row, 'addressLine'),
        city: suppliedText(row, 'city'),
        state: suppliedText(row, 'state'),
        zip: suppliedText(row, 'zip'),
        country: suppliedText(row, 'country'),
        siteRole: ((role && roleAliases[role]) ||
          role ||
          undefined) as CreateFacilityInput['siteRole'],
        siteStatus: (asString(row.status) ??
          asString(row.siteStatus) ??
          undefined) as CreateFacilityInput['siteStatus'],
        employeeCount: typeof row.employeeCount === 'number' ? row.employeeCount : undefined,
      };
      if (!data.name) throw new BadRequestException('Location name is required');
      const prior = asString(row.id)
        ? await tx.clientFacility.findFirst({
            where: { id: String(row.id), tenantId: ctx.tenantId, clientId: subject.id },
          })
        : null;
      if (row.id && !prior) throw new NotFoundException('Location not found');
      let saved;
      if (prior) {
        const result = await this.facilities.updateFacilityInTransaction(
          tx,
          ctx,
          subject.id,
          prior.id,
          data,
        );
        saved = result.facility;
        scope.afterCommit.push(() => this.facilities.afterFacilityUpdated(ctx, result));
      } else {
        saved = await this.facilities.createFacilityInTransaction(tx, ctx, subject.id, data);
        const created = saved;
        scope.afterCommit.push(() => this.facilities.afterFacilityCreated(ctx, created));
      }
      return { ...row, id: saved.id };
    }
    if (section === 'leadership') {
      const name = asString(row.name);
      if (!name) throw new BadRequestException('Contact name is required');
      const saved = await this.people.upsertPersonForImportInTransaction(tx, ctx, subject.id, {
        name,
        title: asString(row.title) ?? undefined,
        email: asString(row.email) ?? undefined,
        phone: asString(row.phone) ?? undefined,
        role: asString(row.role) ?? 'client_contact',
        notes: asString(row.notes) ?? undefined,
      });
      scope.afterCommit.push(() => this.people.afterPersonImport(ctx, saved));
      return { ...row, id: saved.person.id };
    }
    if (section === 'capabilities') {
      const name = asString(row.name);
      if (!name) throw new BadRequestException('Capability name is required');
      const data = {
        name,
        type: asString(row.type) ?? 'product',
        lifecycle: profileCapabilityLifecycle(row.lifecycle),
        description: suppliedText(row, 'description'),
        tags: asStringArray(row.tags),
        keywords: asStringArray(row.keywords),
      };
      const prior = asString(row.id)
        ? await tx.clientCapability.findFirst({
            where: { id: String(row.id), tenantId: ctx.tenantId, clientId: subject.id },
          })
        : null;
      if (row.id && !prior) throw new NotFoundException('Capability not found');
      const saved = prior
        ? await this.capabilities.updateCapabilityInTransaction(tx, ctx, subject.id, prior.id, data)
        : await this.capabilities.createCapabilityInTransaction(
            tx,
            ctx,
            subject.id,
            data,
            provenance,
          );
      scope.afterCommit.push(() => this.capabilities.afterCapabilityCreated(ctx, saved));
      return { ...row, id: saved.id };
    }
    if (section === 'advocacy') {
      const c = await tx.client.findFirst({
        where: { id: subject.id, tenantId: ctx.tenantId },
        select: { intakeData: true },
      });
      await this.clients.updateInTransaction(
        tx,
        ctx,
        subject.id,
        {
          intakeData: { ...asRecord(c?.intakeData), advocacy: row },
          ...('issueCodes' in row ? { issueCodes: asStringArray(row.issueCodes) } : {}),
          ...('submissionTracks' in row
            ? { submissionTracks: asStringArray(row.submissionTracks) }
            : {}),
        },
        false,
      );
      return value;
    }
    if (section === 'notes') {
      const note = asString(row.body) ?? asString(value);
      if (!note) throw new BadRequestException('Note is required');
      // Existing profile notes remain one canonical text field; append only the reviewed value.
      const c = await tx.client.findFirst({
        where: { id: subject.id, tenantId: ctx.tenantId },
        select: { intakeData: true },
      });
      await tx.client.update({
        where: { id: subject.id },
        data: {
          intakeData: {
            ...asRecord(c?.intakeData),
            profileNotes: [asRecord(c?.intakeData).profileNotes, note].filter(Boolean).join('\n\n'),
          },
        },
      });
      return { id: asString(row.id) ?? randomUUID(), body: note };
    }
    throw new BadRequestException('Unsupported profile field');
  }
}
