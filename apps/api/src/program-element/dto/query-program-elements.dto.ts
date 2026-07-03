import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class QueryProgramElementsDto {
  @IsOptional()
  @IsString()
  service?: string;

  @IsOptional()
  @IsString()
  budget_activity?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @IsIn(['markup-monitor'])
  mode?: 'markup-monitor';

  // When 'true', restrict the list to PEs that have at least one underlying data
  // signal (FY history row, PE-linked federal award, or a bill referencing the PE).
  // Lets the finder hide sparse/empty PEs so users don't click into blank detail
  // pages. Omitted/any other value = no filter (return all PEs).
  @IsOptional()
  @IsString()
  @IsIn(['true', 'false'])
  has_data?: string;

  // When 'true', restrict the list to PEs the CURRENT user is watching (the
  // finder's "Watchlist" mode). Requires an authenticated user; without one it
  // returns an empty list.
  @IsOptional()
  @IsString()
  @IsIn(['true', 'false'])
  watched?: string;

  // BL-1: money-graph line-type facet (intelligence cache). MILCON_PROJECT /
  // TRANSFER / CLASSIFIED are registry-reserved — accepted here so the facet
  // strip doesn't 400 when those ingests land; they match zero rows today.
  @IsOptional()
  @IsString()
  @IsIn(['RDTE_PE', 'PROCUREMENT_BLIN', 'OM_BLI', 'MILCON_PROJECT', 'TRANSFER', 'CLASSIFIED'])
  line_type?: string;

  // BL-1: capability slug facet ("I sell X" → lines with an accepted match).
  @IsOptional()
  @IsString()
  capability?: string;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  divergence_threshold?: number;

  // Reconciliation queue status filter (Step 29): open | resolved | all.
  @IsOptional()
  @IsString()
  @IsIn(['open', 'resolved', 'dismissed', 'all'])
  status?: string;

  // Step 1.4 — budget-delta filters. Free-form string (no @IsIn enum) so the read path
  // accepts every stored delta type. Recognized values: the budget delta types (see
  // DeltaTypeForScore in deltas/materiality-scorer.ts: pb_vs_prior_pb, mark_vs_request,
  // mark_vs_mark, conference_vs_marks, enacted_vs_request, new_start, termination, zeroed,
  // transfer_candidate, quantity_change, unit_cost_change, outyear_shift,
  // project_level_change) PLUS 'report_language_action' (Step 2.4 — committee-report
  // LANGUAGE provisions). NOTE: 'report_language_action' is recognized here as a valid
  // filter/type string ONLY; provision-change DETECTION is NOT wired into the delta engine
  // yet — that is DEFERRED until real committee_provisions_* data exists (see
  // sync-report-provisions.ts / provision-loader.ts). Do not add it to DeltaTypeForScore
  // or the delta engine until then.
  @IsOptional()
  @IsString()
  deltaType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  fy?: number;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(1)
  minScore?: number;
}
