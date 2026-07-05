import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import type { FkRelation } from './memory-graph.helpers.js';

/**
 * Loads authoritative DB foreign-key relations for the current tenant and
 * shapes them into FkRelation[] for the knowledge-graph builder (origin='fk').
 *
 * These are the STRUCTURAL backbone of the graph (Phase A): clients linked to
 * the bills/issues/people/meetings they actually own in Postgres. All queries
 * run under withTenant -> RLS, so a caller only ever sees their tenant's rows.
 *
 * Node id convention (matches memory-graph.helpers + wikilink slugs):
 *   client:<clientId>  bill:<billId>  issue:<code>  person:<personId>
 *   meeting:<meetingId>  office:<slug>
 */
@Injectable()
export class MemoryFkLoader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContextStore,
  ) {}

  async loadForCurrentTenant(): Promise<FkRelation[]> {
    const ctx = this.tenantCtx.require();
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const out: FkRelation[] = [];

      // client -> bill (tracked_bill), enriched with bill title/status/policy area
      const bills = await tx.$queryRaw<
        Array<{ client_id: string; client_name: string; bill_id: string; title: string | null; latest_action: string | null; policy_area: string | null }>
      >`
        SELECT tb.client_id, c.name AS client_name, tb.bill_id,
               cb.title, cb.latest_action_text AS latest_action, cb.policy_area
        FROM tracked_bill tb
        JOIN clients c ON c.id = tb.client_id
        LEFT JOIN congress_bill cb ON cb.id = tb.bill_id
        WHERE tb.tenant_id = ${ctx.tenantId}::uuid
      `;
      for (const b of bills) {
        const attrs: Record<string, string> = {};
        if (b.policy_area) attrs.policyArea = b.policy_area;
        if (b.latest_action) attrs.latestAction = b.latest_action.slice(0, 160);
        out.push({
          srcType: 'client', srcSlug: b.client_id, srcLabel: b.client_name,
          dstType: 'bill', dstSlug: b.bill_id, dstLabel: b.title || b.bill_id, dstAttrs: attrs,
          relation: 'tracks',
        });
      }

      // client -> issue (issue_codes array on clients)
      const issues = await tx.$queryRaw<
        Array<{ id: string; name: string; code: string }>
      >`
        SELECT c.id, c.name, unnest(c.issue_codes) AS code
        FROM clients c
        WHERE c.tenant_id = ${ctx.tenantId}::uuid
          AND array_length(c.issue_codes, 1) > 0
      `;
      for (const i of issues) {
        out.push({
          srcType: 'client', srcSlug: i.id, srcLabel: i.name,
          dstType: 'issue', dstSlug: i.code, dstLabel: i.code,
          relation: 'works-on',
        });
      }

      // client -> person (client_people), enriched with title/role
      const people = await tx.$queryRaw<
        Array<{ client_id: string; client_name: string; person_id: string; person_name: string; title: string | null; role: string | null }>
      >`
        SELECT cp.client_id, c.name AS client_name, cp.id AS person_id, cp.name AS person_name,
               cp.title, cp.role
        FROM client_people cp
        JOIN clients c ON c.id = cp.client_id
        WHERE cp.tenant_id = ${ctx.tenantId}::uuid
      `;
      for (const p of people) {
        const attrs: Record<string, string> = {};
        if (p.title) attrs.title = p.title;
        if (p.role) attrs.role = p.role;
        out.push({
          srcType: 'client', srcSlug: p.client_id, srcLabel: p.client_name,
          dstType: 'person', dstSlug: p.person_id, dstLabel: p.person_name, dstAttrs: attrs,
          relation: 'contact',
        });
      }

      // client -> meeting (meetings with a client_id). Debrief bodies are
      // encrypted and intentionally NOT read here — we only link the meeting.
      const meetings = await tx.$queryRaw<
        Array<{ client_id: string; client_name: string; meeting_id: string; subject: string }>
      >`
        SELECT m.client_id, c.name AS client_name, m.id AS meeting_id, m.subject
        FROM meetings m
        JOIN clients c ON c.id = m.client_id
        WHERE m.tenant_id = ${ctx.tenantId}::uuid
          AND m.client_id IS NOT NULL
          AND m.is_internal = false
      `;
      for (const mt of meetings) {
        out.push({
          srcType: 'client', srcSlug: mt.client_id, srcLabel: mt.client_name,
          dstType: 'meeting', dstSlug: mt.meeting_id, dstLabel: mt.subject || 'Meeting',
          relation: 'met-on',
        });
      }

      // meeting -> attendee person (by contactId when present)
      const attendees = await tx.$queryRaw<
        Array<{ meeting_id: string; subject: string; contact_id: string; name: string | null }>
      >`
        SELECT ma.meeting_id, m.subject, ma.contact_id, ma.name
        FROM meeting_attendees ma
        JOIN meetings m ON m.id = ma.meeting_id
        WHERE ma.tenant_id = ${ctx.tenantId}::uuid
          AND ma.contact_id IS NOT NULL
      `;
      for (const a of attendees) {
        out.push({
          srcType: 'meeting', srcSlug: a.meeting_id, srcLabel: a.subject || 'Meeting',
          dstType: 'person', dstSlug: a.contact_id, dstLabel: a.name ?? a.contact_id,
          relation: 'attended-by',
        });
      }

      // client -> office (the congressional/report-target offices this client
      // engages in outreach). Tenant-scoped (engagement_report_target_offices has
      // tenant_id + client_id) and bounded by the client's own target list.
      //
      // NOTE: we intentionally do NOT source office nodes from the global DoD
      // program_office / derive-office-program-links reference data. That data has
      // no tenant scope, so loading it here would flood every tenant's graph with
      // the entire org chart; wiring those offices to a specific client requires
      // the acquisition-personnel role chain (client -> PE relevance -> program ->
      // office), which lives in the intelligence subsystem, not this FK backbone.
      // Node id: office:<officeKey>, matching the advertised convention.
      const offices = await tx.$queryRaw<
        Array<{ client_id: string; client_name: string; office_key: string; member_principal: string | null; committee: string | null; building: string | null }>
      >`
        SELECT DISTINCT ON (rto.client_id, rto.office_key)
               rto.client_id, c.name AS client_name, rto.office_key,
               rto.member_principal, rto.committee, rto.building
        FROM engagement_report_target_offices rto
        JOIN clients c ON c.id = rto.client_id
        WHERE rto.tenant_id = ${ctx.tenantId}::uuid
          AND rto.client_id IS NOT NULL
        ORDER BY rto.client_id, rto.office_key, rto.updated_at DESC
      `;
      for (const o of offices) {
        const attrs: Record<string, string> = {};
        if (o.committee) attrs.committee = o.committee;
        if (o.building) attrs.building = o.building;
        out.push({
          srcType: 'client', srcSlug: o.client_id, srcLabel: o.client_name,
          dstType: 'office', dstSlug: o.office_key,
          dstLabel: o.member_principal || o.office_key, dstAttrs: attrs,
          relation: 'targets',
        });
      }

      return out;
    });
  }
}
