import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Request for POST /intel-api/hearings/resolve-stream.
 * At least one of `pageUrl` / `hearingId` should be present; the service returns
 * `unresolvable` when neither yields a lead.
 */
export class ResolveStreamDto {
  /** An event/committee/C-SPAN/YouTube page URL, or a direct media URL, to resolve. */
  @IsOptional() @IsString() @MaxLength(2000) pageUrl?: string;

  /** An internal committee-hearing row id (`cm-{congress}-{eventId}`) or C-SPAN program id. */
  @IsOptional() @IsString() @MaxLength(200) hearingId?: string;
}
