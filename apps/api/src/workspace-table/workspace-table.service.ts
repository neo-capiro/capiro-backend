import { BadRequestException, Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { ProgramElementReadService } from '../program-element/program-element-read.service.js';
import { IntelligenceService } from '../intelligence/intelligence.service.js';
import { ClientCapabilitiesService } from '../clients/client-capabilities.service.js';
import { ClientFacilitiesService } from '../clients/client-facilities.service.js';

export type PlatformTableSource =
  | 'pe-timeline'
  | 'pe-contractors'
  | 'tracked-bills'
  | 'capabilities'
  | 'facilities';

export interface PlatformTable {
  title: string;
  headers: string[];
  rows: string[][];
}

/** Budget figures are stored in MILLIONS (canonical unit) — label columns $M. */
function money(v: unknown): string {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toFixed(1)}M`;
}

function text(v: unknown): string {
  if (v == null) return '';
  return String(v);
}

/**
 * Builds tables from platform data for the editor's Insert → Table → "Pull from
 * platform". Returns a flat { title, headers, rows } the web inserts as a
 * prefilled (editable) table. Read-only; reuses the existing typed services.
 */
@Injectable()
export class WorkspaceTableService {
  constructor(
    private readonly pe: ProgramElementReadService,
    private readonly intel: IntelligenceService,
    private readonly capabilities: ClientCapabilitiesService,
    private readonly facilities: ClientFacilitiesService,
  ) {}

  async build(
    ctx: TenantContext,
    source: PlatformTableSource,
    opts: { peCode?: string; clientId?: string },
  ): Promise<PlatformTable> {
    switch (source) {
      case 'pe-timeline':
        return this.peTimeline(opts.peCode);
      case 'pe-contractors':
        return this.peContractors(opts.peCode);
      case 'tracked-bills':
        return this.trackedBills(ctx, opts.clientId);
      case 'capabilities':
        return this.clientCapabilities(ctx, opts.clientId);
      case 'facilities':
        return this.clientFacilities(ctx, opts.clientId);
      default:
        throw new BadRequestException(`Unknown table source: ${source}`);
    }
  }

  private async peTimeline(peCode?: string): Promise<PlatformTable> {
    if (!peCode) throw new BadRequestException('peCode is required for pe-timeline');
    const { years } = await this.pe.getTimeline(peCode);
    // "NDAA Conf." is the authorization-track conference (the only conference value
    // populated today; it lives in ndaaConference, outside the appropriations ladder).
    const headers = ['FY', 'PB Request', 'HASC', 'SASC', 'HAC-D', 'SAC-D', 'NDAA Conf.', 'Enacted'];
    const rows = years.map((y) => [
      text(y.fy),
      money(y.request),
      money(y.hascMark),
      money(y.sascMark),
      money(y.hacDMark),
      money(y.sacDMark),
      money(y.ndaaConference),
      money(y.enacted),
    ]);
    return { title: `${peCode} — Budget timeline ($M)`, headers, rows };
  }

  private async peContractors(peCode?: string): Promise<PlatformTable> {
    if (!peCode) throw new BadRequestException('peCode is required for pe-contractors');
    const res = await this.pe.getContractors(peCode);
    const data = res.data ?? [];
    const headers = ['Contractor', 'Obligated', 'Awards'];
    const rows = data.map((c) => [text(c.contractorName), money(c.amount), text(c.awards)]);
    return { title: `${peCode} — Contractors ($M)`, headers, rows };
  }

  private async trackedBills(ctx: TenantContext, clientId?: string): Promise<PlatformTable> {
    if (!clientId) throw new BadRequestException('clientId is required for tracked-bills');
    const { bills } = await this.intel.getTrackedBills(clientId, ctx.tenantId);
    const headers = ['Bill', 'Title', 'Sponsor', 'Latest action'];
    const rows = bills.map((b) => [
      text(b.identifier).toUpperCase(),
      text(b.title),
      text(b.sponsorName),
      text(b.latestActionText),
    ]);
    return { title: 'Tracked bills', headers, rows };
  }

  private async clientCapabilities(ctx: TenantContext, clientId?: string): Promise<PlatformTable> {
    if (!clientId) throw new BadRequestException('clientId is required for capabilities');
    const caps = await this.capabilities.listCapabilities(ctx, clientId);
    const headers = ['Capability', 'Type', 'Sector', 'Program element'];
    const rows = caps.map((c) => [text(c.name), text(c.type), text(c.sector), text(c.peNumber)]);
    return { title: 'Capabilities', headers, rows };
  }

  private async clientFacilities(ctx: TenantContext, clientId?: string): Promise<PlatformTable> {
    if (!clientId) throw new BadRequestException('clientId is required for facilities');
    const facs = await this.facilities.listFacilities(ctx, clientId);
    const headers = ['Facility', 'City', 'State', 'District', 'Employees'];
    const rows = facs.map((f) => [
      text(f.name),
      text(f.city),
      text(f.state),
      text(f.congressionalDistrict),
      f.employeeCount == null ? '—' : text(f.employeeCount),
    ]);
    return { title: 'Facilities', headers, rows };
  }
}
