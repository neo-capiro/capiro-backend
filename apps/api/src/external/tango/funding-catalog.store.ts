import { Prisma, type PrismaClient } from '@prisma/client';
import { TangoStoreService } from './tango-store.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { catalogEmbeddingState, attachmentEmbeddingState } from './funding-embedding-state.js';
import { compact, date, grantFields, hash, noticeFields, noticeKey, numeric, object, samFileUrlAliases, samUrlKey, stable, text, type RecordData } from './funding-catalog.mapper.js';

export class FundingCatalogStore {
  readonly observations: TangoStoreService;
  constructor(readonly prisma: PrismaClient) { this.observations = new TangoStoreService(prisma as PrismaService); }
  async grant(payload: RecordData, commit: boolean): Promise<void> {
    const fields = grantFields(payload), id = String(payload.grant_id);
    const existing = await this.prisma.federalGrant.findUnique({ where: { id } });
    if (!fields.agency && !existing) throw new Error('New grant has no agency');
    if (!commit) return;
    const updated = date(payload.last_updated);
    if (existing?.lastUpdatedAt && updated && updated < existing.lastUpdatedAt) return;
    // Tango's P/F-only feed can lag an explicit official closure. A replay of
    // that older content must not reopen the canonical grant. A genuinely
    // newer provider update may reopen it normally.
    const official = object(object(existing?.raw).grantsGovDocument);
    const lifecycle = object(official.lifecycle);
    const officialObserved = date(lifecycle.observedAt ?? official.observedAt);
    const officialStatus = String(lifecycle.status ?? object(official.payload).ost ?? '').toLowerCase();
    if (['closed','archived'].includes(officialStatus) && existing?.status === officialStatus &&
        ['posted','forecasted'].includes(fields.status ?? '') && officialObserved && (!updated || updated <= officialObserved)) delete fields.status;
    await this.observations.writeSnapshot({ resourceType: 'grant', externalId: id, normalized: payload, sourceUpdatedAt: updated?.toISOString() ?? null, sourceUrl: fields.url });
    // Only an explicit, fresh provider null clears a lifecycle date. Omission
    // and blank enrichment preserve the richer data already held locally.
    const deadlineField = fields.status === 'forecasted' ? 'estimated_application_response_date' : 'response_date';
    if (updated && object(payload.important_dates)[deadlineField] === null) fields.closeDate = null;
    const now = new Date();
    const raw = { ...object(existing?.raw), tango: { payload, observedAt: now.toISOString() } };
    await this.prisma.federalGrant.upsert({ where: { id },
      create: { id, title: fields.title, agency: fields.agency, ...fields, raw, syncedAt: now, detailSyncedAt: now },
      update: { ...fields, raw, syncedAt: now, detailSyncedAt: now, ...catalogEmbeddingState(existing, fields, 'grant', now) },
    });
    await this.observations.proposeLink({ localResourceType: 'federal_grant', localResourceId: id, tangoResourceType: 'grant', tangoExternalId: id, basis: 'exact_identifier', confidenceBand: 'high' });
    for (const rawAttachment of Array.isArray(payload.attachments) ? payload.attachments : []) {
      const attachment = object(rawAttachment), url = text(attachment.url);
      if (!url) throw new Error('Missing grant attachment URL');
      const existingAttachment = await this.prisma.opportunityAttachment.findFirst({ where: { federalGrantId: id, sourceUrl: url } });
      const data = compact({ federalGrantId: id, sourceUrl: url, fileName: text(attachment.name), declaredMimeType: text(attachment.mime_type), postedDate: date(attachment.posted_date),
        providerData: { ...attachment, grant_id: id, extraction_status: 'not_provided', binding: 'provider_resource_id' }, providerObservedAt: now });
      if (existingAttachment) await this.prisma.opportunityAttachment.update({ where: { id: existingAttachment.id }, data: { ...data, ...attachmentEmbeddingState(existingAttachment, data, now) } });
      else await this.prisma.opportunityAttachment.create({ data: data as Prisma.OpportunityAttachmentUncheckedCreateInput });
    }
  }
  async findNotice(id: string) {
    const key = noticeKey(id);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM sam_opportunity WHERE lower(replace(notice_id,'-',''))=${key} LIMIT 2`;
    if (rows.length > 1) throw new Error('Ambiguous existing government notice identity; refusing merge');
    return rows[0] ? this.prisma.samOpportunity.findUnique({ where: { id: rows[0].id } }) : null;
  }
  async notice(payload: RecordData, commit: boolean): Promise<string | null> {
    const key = noticeKey(payload.notice_id), fields = noticeFields(payload);
    const existing = await this.findNotice(key);
    if (!commit) return existing?.id ?? null;
    const updated = date(payload.last_updated);
    const previous = date(object(object(existing?.raw).tango).providerUpdatedAt);
    if (updated && previous && updated < previous) return existing!.id;
    await this.observations.writeSnapshot({ resourceType: 'notice', externalId: key, normalized: payload, sourceUpdatedAt: updated?.toISOString() ?? null, sourceUrl: fields.sourceUrl });
    if (updated && payload.response_deadline === null) fields.responseDeadline = null;
    const now = new Date();
    const raw = { ...object(existing?.raw), tango: { payload, providerUpdatedAt: updated?.toISOString() ?? null, observedAt: now.toISOString() } };
    const saved = existing
      ? await this.prisma.samOpportunity.update({ where: { id: existing.id }, data: { ...fields, raw, lastSyncedAt: now, ...catalogEmbeddingState(existing, fields, 'notice', now) } })
      : await this.prisma.samOpportunity.create({ data: { noticeId: key, title: fields.title, noticeType: fields.noticeType, ...fields, raw, lastSyncedAt: now } });
    await this.observations.proposeLink({ localResourceType: 'sam_opportunity', localResourceId: saved.id, tangoResourceType: 'notice', tangoExternalId: key, basis: 'exact_identifier', confidenceBand: 'high' });
    const history = compact({ tangoOpportunityId: text(object(payload.opportunity).opportunity_id), samOpportunityId: saved.id,
      solicitationNumber: text(payload.solicitation_number), title: text(payload.title), description: text(payload.description),
      descriptionSha256: text(payload.description) ? hash(payload.description) : undefined,
      postedDate: date(payload.posted_date), providerUpdatedAt: updated, responseDeadline: fields.responseDeadline,
      active: fields.active, setAside: fields.setAside, naicsCode: fields.naicsCode, pscCode: fields.pscCode,
      attachmentCount: numeric(payload.attachment_count), sourceUrl: fields.sourceUrl,
      contentHash: hash(stable(payload)), snapshot: payload, lastSyncedAt: now });
    await this.prisma.tangoOpportunityNotice.upsert({ where: { tangoNoticeId: key },
      create: { tangoNoticeId: key, ...history } as Prisma.TangoOpportunityNoticeUncheckedCreateInput, update: history });
    return saved.id;
  }
  async opportunity(payload: RecordData, commit: boolean): Promise<void> {
    const providerId = text(payload.opportunity_id);
    if (!providerId) throw new Error('Missing provider opportunity identity');
    // Opportunity IDs identify notice families, not individual SAM notices.
    // A family's SAM URL can point to a different amendment than its explicit
    // latest notice. Prefer the provider's exact notice ID, corroborated by the
    // nested latest notice when supplied; never infer identity from chronology.
    const nestedLatest = text(object(payload.latest_notice).notice_id);
    const latest = payload.latest_notice_id ? noticeKey(payload.latest_notice_id)
      : nestedLatest ? noticeKey(nestedLatest) : samUrlKey(payload.sam_url);
    if (nestedLatest && noticeKey(nestedLatest) !== latest) throw new Error('Conflicting latest notice IDs');
    const existing = await this.findNotice(latest);
    // Full notice payloads own canonical lifecycle fields. Document discovery
    // may enrich an already-linked row, but never turns family data into a notice.
    if (!commit) return;
    await this.observations.writeSnapshot({ resourceType: 'opportunity', externalId: providerId, normalized: payload,
      sourceUpdatedAt: date(payload.last_notice_date)?.toISOString() ?? null, sourceUrl: String(payload.sam_url) });
    if (!existing) return; // kept in the snapshot; replay after the notice catalog catches up
    const contact = object(payload.primary_contact);
    const enrichment = compact({ pocName: text(contact.full_name), pocEmail: text(contact.email),
      ...(!existing.description ? { description: text(payload.description) } : {}) });
    if (Object.keys(enrichment).length) await this.prisma.samOpportunity.update({ where: { id: existing.id },
      data: { ...enrichment, ...(enrichment.description ? { embeddedAt: null } : {}) } });
    await this.observations.proposeLink({ localResourceType: 'sam_opportunity', localResourceId: existing.id,
      tangoResourceType: 'opportunity', tangoExternalId: providerId, basis: 'exact_identifier', confidenceBand: 'high' });
    for (const raw of Array.isArray(payload.notice_history) ? payload.notice_history : []) {
      const entry = object(raw), id = noticeKey(entry.notice_id);
      const local = await this.findNotice(id);
      const data = compact({ tangoOpportunityId: providerId, samOpportunityId: local?.id,
        title: text(entry.title), solicitationNumber: text(entry.solicitation_number), postedDate: date(entry.posted_date),
        sourceUrl: `https://sam.gov/opp/${id}/view`, lastSyncedAt: new Date() });
      // Metadata-only history must not overwrite a full notice body/snapshot.
      await this.prisma.tangoOpportunityNotice.upsert({ where: { tangoNoticeId: id },
        create: { tangoNoticeId: id, ...data, contentHash: hash(stable(entry)), snapshot: entry }, update: data });
    }
    for (const raw of Array.isArray(payload.attachments) ? payload.attachments : []) {
      const attachment = object(raw), id = text(attachment.attachment_id), url = text(attachment.url);
      if (!id || !url) throw new Error('Unmappable provider attachment; replay page');
      const aliases = samFileUrlAliases(url);
      const previous = await this.prisma.opportunityAttachment.findFirst({ where: { samOpportunityId: existing.id,
        OR: [{ providerAttachmentId: id }, { sourceUrl: { in: aliases }, tangoNoticeId: null }] } });
      // Provider omissions do not delete a previously obtained extraction.
      const previousData = object(previous?.providerData);
      const sourceChanged = !!previous && !aliases.includes(previous.sourceUrl);
      const providerData: RecordData = { ...previousData, ...attachment, opportunity_id: providerId, binding: 'provider_attachment_id' };
      if (sourceChanged && !text(attachment.extracted_text)) {
        delete providerData.extracted_text;
        providerData.extraction_status = attachment.extraction_status ?? 'pending';
      } else if (!text(attachment.extracted_text) && text(previousData.extracted_text)) {
        providerData.extracted_text = previousData.extracted_text;
        providerData.extraction_status = previousData.extraction_status;
      }
      const data = compact({ samOpportunityId: existing.id, providerAttachmentId: id, sourceUrl: url,
        fileName: text(attachment.name), declaredMimeType: text(attachment.mime_type),
        declaredSizeBytes: numeric(attachment.file_size) != null ? BigInt(attachment.file_size) : undefined,
        postedDate: date(attachment.posted_date), providerData, providerObservedAt: new Date(),
        ...(sourceChanged ? { status: 'metadata_only', contentSha256: null, observedSizeBytes: null, observedMimeType: null,
          archiveBucket: null, archiveKey: null, archiveVersionId: null, archivedAt: null,
          lastAttemptAt: null, failureReason: null, failureDetail: null } : {}) });
      if (previous) await this.prisma.opportunityAttachment.update({ where: { id: previous.id },
        data: { ...data, ...attachmentEmbeddingState(previous, data, data.providerObservedAt) } });
      else await this.prisma.opportunityAttachment.create({ data: data as Prisma.OpportunityAttachmentUncheckedCreateInput });
    }
  }
}
