import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseDbDate } from '../strategy/dates.js';
import type { ReferenceForkDto, ReferenceUiKind } from './dto/reference-fork.dto.js';

export interface ReferenceRow {
  id: string;
  kind: string;
  label: string;
  fy: number | null;
  startsOn: Date | null;
  endsOn: Date | null;
  tone: string | null;
  position: number;
}

export interface ReferenceCalendars {
  congress: ReferenceRow[];
  ppbeLanes: ReferenceRow[];
  ppbeCurrentPhases: ReferenceRow[];
  source: Record<string, 'baseline' | 'override'>;
}

const KINDS = ['congress_milestone', 'ppbe_lane_bar', 'ppbe_current_phase'] as const;

/**
 * Merged reference calendars: for each kind, the tenant's fork
 * (sp_reference_override) if it has any rows for that kind, else the global
 * Capiro baseline (sp_reference_entry). Fork-on-edit write path is G4.
 */
@Injectable()
export class ReferenceService {
  constructor(private readonly prisma: PrismaService) {}

  async getCalendars(tenantId: string): Promise<ReferenceCalendars> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      // sp_reference_entry is GLOBAL (no tenantId) — the tenant-scope hook does
      // not touch it, so this returns the full baseline. sp_reference_override
      // HAS tenantId — the hook scopes it to this tenant.
      const [baseline, overrides] = await Promise.all([
        tx.spReferenceEntry.findMany({
          where: { active: true },
          orderBy: { position: 'asc' },
          select: rowSelect,
        }),
        tx.spReferenceOverride.findMany({
          where: { active: true },
          orderBy: { position: 'asc' },
          select: rowSelect,
        }),
      ]);

      const result: ReferenceCalendars = {
        congress: [],
        ppbeLanes: [],
        ppbeCurrentPhases: [],
        source: {},
      };

      for (const kind of KINDS) {
        const tenantRows = overrides.filter((r) => r.kind === kind);
        const rows = tenantRows.length > 0 ? tenantRows : baseline.filter((r) => r.kind === kind);
        const overridden = tenantRows.length > 0;
        if (kind === 'congress_milestone') {
          result.congress = rows;
          result.source.congress = overridden ? 'override' : 'baseline';
        } else if (kind === 'ppbe_lane_bar') {
          result.ppbeLanes = rows;
          result.source.ppbeLanes = overridden ? 'override' : 'baseline';
        } else {
          result.ppbeCurrentPhases = rows;
          result.source.ppbeCurrentPhases = overridden ? 'override' : 'baseline';
        }
      }
      return result;
    });
  }

  /**
   * Fork-on-edit (REF-5): replace the tenant's override rows for one UI kind
   * (congress → congress_milestone, ppbe → ppbe_current_phase) atomically. The
   * renderer already prefers tenant rows for a kind when >=1 exists, so writing
   * these materializes the fork; other kinds and other tenants are untouched.
   */
  async fork(tenantId: string, clerkUserId: string, uiKind: ReferenceUiKind, dto: ReferenceForkDto) {
    const spKind = uiKind === 'congress' ? 'congress_milestone' : 'ppbe_current_phase';
    const isCongress = spKind === 'congress_milestone';

    // Per-kind validation + date parsing up front (fail before any write).
    const parsed = dto.rows.map((r, i) => {
      if (isCongress) {
        if (!r.startsOn || !r.endsOn) {
          throw new BadRequestException(`Milestone "${r.label}" needs a start and end quarter`);
        }
        const startsOn = parseDbDate(r.startsOn, 'startsOn');
        const endsOn = parseDbDate(r.endsOn, 'endsOn');
        if (endsOn <= startsOn) {
          throw new BadRequestException(`Milestone "${r.label}" must end after it starts`);
        }
        return { label: r.label, fy: null, startsOn, endsOn, tone: r.tone ?? 'info', position: i };
      }
      if (r.fy == null) {
        throw new BadRequestException(`PPBE row "${r.label}" needs a fiscal year`);
      }
      return { label: r.label, fy: r.fy, startsOn: null, endsOn: null, tone: r.tone ?? null, position: i };
    });

    await this.prisma.withTenantUser(tenantId, clerkUserId, async (tx) => {
      const before = await tx.spReferenceOverride.findMany({
        where: { kind: spKind },
        orderBy: { position: 'asc' },
        select: rowSelect,
      });
      await tx.spReferenceOverride.deleteMany({ where: { kind: spKind } });
      if (parsed.length) {
        await tx.spReferenceOverride.createMany({
          data: parsed.map((p) => ({
            tenantId,
            kind: spKind,
            label: p.label,
            fy: p.fy,
            startsOn: p.startsOn,
            endsOn: p.endsOn,
            tone: p.tone,
            position: p.position,
            active: true,
            updatedByUserId: clerkUserId,
          })),
        });
      }
      await tx.spActivityLog.create({
        data: {
          tenantId,
          actorUserId: clerkUserId,
          authorKind: 'person',
          // First materialization of this kind = fork; subsequent saves = update.
          action: before.length === 0 ? 'reference.forked' : 'reference.updated',
          entityType: 'reference',
          entityId: spKind,
          // Symmetric YYYY-MM-DD dates on both sides of the audit snapshot.
          before: {
            rows: before.map((b) => ({ ...b, startsOn: r2iso(b.startsOn), endsOn: r2iso(b.endsOn) })),
          },
          after: { rows: parsed.map((p) => ({ ...p, startsOn: r2iso(p.startsOn), endsOn: r2iso(p.endsOn) })) },
        },
      });
    });
    // Fresh read after commit reflects the fork through the merge logic.
    return this.getCalendars(tenantId);
  }
}

/** Serialize a @db.Date back to YYYY-MM-DD for the audit snapshot. */
function r2iso(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

const rowSelect = {
  id: true,
  kind: true,
  label: true,
  fy: true,
  startsOn: true,
  endsOn: true,
  tone: true,
  position: true,
} as const;
