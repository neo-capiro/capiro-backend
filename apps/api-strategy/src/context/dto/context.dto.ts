import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Upload a context-pack document (raw markdown incl. YAML frontmatter). All
 * semantic validation (frontmatter grammar, vocabularies, scope consistency)
 * happens server-side in ContextDocumentsService — the DTO only bounds the
 * payload shape.
 */
export class UploadContextDocumentDto {
  @IsString()
  @MaxLength(300000)
  content!: string;

  /**
   * apps/api clients.id. The binding is enforced server-side from the
   * VALIDATED frontmatter client_id (bindIdentity in
   * ContextDocumentsService.upload): omitted here = bound from frontmatter;
   * present AND contradicting frontmatter = field-level 400.
   */
  @IsOptional()
  @IsUUID()
  clientId?: string;

  /**
   * node/strategy id when the frontmatter scope is node|strategy. Same
   * contract as clientId: frontmatter strategy_id/node_id is the source of
   * truth — omitted = bound from frontmatter, contradiction = 400.
   */
  @IsOptional()
  @IsUUID()
  scopeRef?: string;

  /** Optional display title; defaults to the first H1 / the template key. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;
}
