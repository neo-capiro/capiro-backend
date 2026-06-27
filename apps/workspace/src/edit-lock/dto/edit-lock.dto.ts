import { IsOptional, IsString } from 'class-validator';

/**
 * Acquire / request / take-over carry the caller's display name: the engine
 * doesn't own the user table, so the client (which has the resolved identity)
 * supplies the name to denormalize onto the lock for the banner. Falls back to
 * the Clerk user id when absent.
 */
export class LockActorDto {
  @IsOptional() @IsString() name?: string;
}
