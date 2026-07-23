import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

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
