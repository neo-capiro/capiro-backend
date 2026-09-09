import { IsOptional, IsUUID } from 'class-validator';

/**
 * `GET /hearings/:id/brief?clientId=` — the client the recap is written FOR.
 * Optional: absent keeps the client-agnostic brief. Declared here because the
 * global ValidationPipe runs whitelist + forbidNonWhitelisted, so an undeclared
 * query key would 400 the request.
 */
export class BriefQueryDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;
}
