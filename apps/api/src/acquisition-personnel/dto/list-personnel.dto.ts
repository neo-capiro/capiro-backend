import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

// The global ValidationPipe runs whitelist + forbidNonWhitelisted, so every query
// field needs a class-validator decorator or the request is rejected with 400.
export class ListPersonnelDto {
  @IsOptional()
  @IsString()
  service?: string;

  @IsOptional()
  @IsString()
  organization?: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  pe_code?: string;

  @IsOptional()
  @IsString()
  q?: string;

  // Filter to PE-aligned ('aligned' = has pePrimary or peSecondary) or 'unaligned'.
  // Omitted = all. Used by the DoW directory PE filter pill.
  @IsOptional()
  @IsIn(['aligned', 'unaligned'])
  pe_aligned?: 'aligned' | 'unaligned';

  // Result ordering. 'pe_first' (default for DoW) surfaces PE-aligned people first,
  // then by confidence; 'confidence' keeps the legacy confidence-desc ordering.
  @IsOptional()
  @IsIn(['pe_first', 'confidence'])
  sort?: 'pe_first' | 'confidence';

  // Admin escape hatch. By default the list HIDES soft-superseded people (old
  // DoW-directory rows the updated directory dropped); pass 'true' to include them.
  @IsOptional()
  @IsString()
  include_superseded?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

// One PersonRole row, flattened for the program-team panel (plan §8: people hang off
// OFFICES and ROLES, never directly off a PE). `whyShown` is the human chain
// (role -> office -> program -> PE); it NEVER says "owns PE". See person-role-why-shown.ts.
export interface PersonRoleSummaryDto {
  id: string;
  roleTitle: string;
  roleType: string;
  officeName: string | null;
  programName: string | null;
  /** The stored person_role.contact_use value. */
  contactUse: string;
  /** CONTACT_USE_LABELS[contactUse] (falls back to the raw value if unknown). */
  contactUseLabel: string;
  reviewStatus: string;
  observedAt: string;
  staleAt: string | null;
  whyShown: string;
}

export interface PersonnelListItemDto {
  id: string;
  fullName: string;
  service: string | null;
  organization: string | null;
  title: string | null;
  role: string | null;
  pePrimary: string | null;
  peSecondary: string[];
  emailDomain: string | null;
  // Full email — populated ONLY for capiro_admin callers (PII gate); null otherwise.
  email: string | null;
  publicProfileUrl: string | null;
  headshotUrl: string | null;
  confidence: number;
  status: string;
  firstSeenAt: string;
  lastSeenAt: string;
  sourceCount: number;
  // Additive (plan §8). Empty array when the person has no PersonRole rows yet.
  roles?: PersonRoleSummaryDto[];
  /**
   * Phase I / closeout Phase 6: server-derived CRM link gate for this PE page.
   * Present on PE personnel responses; omitted on generic directory lists.
   */
  crmLinkBlocked?: boolean;
  /** Accessible reason when crmLinkBlocked is true (no PII). */
  crmLinkBlockedReason?: string | null;
}

export interface PersonnelListResponseDto {
  data: PersonnelListItemDto[];
  total: number;
  page: number;
  limit: number;
}
