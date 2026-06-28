import { IsIn, IsOptional, IsString } from 'class-validator';
import type { PlatformTableSource } from './workspace-table.service.js';

const SOURCES = [
  'pe-timeline',
  'pe-contractors',
  'tracked-bills',
  'capabilities',
  'facilities',
] as const;

export class PlatformTableQueryDto {
  @IsIn(SOURCES)
  source!: PlatformTableSource;

  /** Program Element code — required for the PE sources. */
  @IsOptional()
  @IsString()
  peCode?: string;

  /** Client UUID — required for the client-scoped sources. */
  @IsOptional()
  @IsString()
  clientId?: string;
}
