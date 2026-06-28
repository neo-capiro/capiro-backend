import { IsEmail, IsIn, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

const ROLES = ['editor', 'reviewer', 'commenter', 'viewer'] as const;

/**
 * Payload to send a Workspace collaborator-invite email (E-19). The engine owns
 * the invite row + in-app notification; the web calls this after a successful
 * invite to deliver the email (apps/api owns the SES path). `link` is built by
 * the web from its own origin so no app-base-url config is needed here.
 */
export class SendInviteEmailDto {
  @IsEmail() toEmail!: string;
  @IsOptional() @IsString() @MaxLength(200) toName?: string;
  @IsString() @MaxLength(300) draftTitle!: string;
  @IsIn(ROLES) role!: (typeof ROLES)[number];
  @IsUrl({ require_tld: false }) link!: string;
  @IsOptional() @IsString() @MaxLength(200) inviterName?: string;
}
