import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

/**
 * Resolve an open fact conflict. `controllingFactId`, when given, must be one
 * of the conflict's two facts (factAId / factBId) — the OTHER fact is rejected
 * (the review action that settles which source controls). Enforced server-side
 * in StewardService.resolveConflict; the DTO only bounds the shape. The
 * resolution `note` is REQUIRED and must not be blank — it is the review
 * trail's rationale (enforced here AND in the service, not just the web UI).
 */
export class ResolveConflictDto {
  @IsString()
  @Matches(/\S/, { message: 'note must not be empty or whitespace-only' })
  @MaxLength(2000)
  note!: string;

  @IsOptional()
  @IsUUID()
  controllingFactId?: string;
}
