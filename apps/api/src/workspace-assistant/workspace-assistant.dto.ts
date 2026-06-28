import { ArrayMaxSize, IsArray, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * In-editor Meri assistant request (document-scoped). The web editor sends the
 * live document, the setup config, and the Context Builder plan so Meri always
 * operates on exactly what's being edited. Nested shapes are passed through as
 * leaves (the global ValidationPipe runs whitelist+forbidNonWhitelisted, so we
 * only declare top-level fields and validate shapes defensively in the service).
 */
export class WorkspaceAssistantDto {
  /** Full conversation so far; the last entry is the new user turn. */
  @IsArray()
  @ArrayMaxSize(40)
  messages!: Array<{ role: 'user' | 'assistant'; text: string }>;

  /** The live document: { title, product, client, sections: [{ name, content, status }] }. */
  @IsObject()
  document!: Record<string, unknown>;

  /** Setup config subset: { tone, toneContext, pages, ask, audience, offices, … }. */
  @IsOptional()
  @IsObject()
  setup?: Record<string, unknown>;

  /** Context Builder plan items the user added: { label, text }. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(80)
  context?: Array<{ label?: string; text?: string }>;

  /** Resolved client UUID (so the read-only data tools can scope to this client). */
  @IsOptional()
  @IsString()
  clientId?: string;
}
