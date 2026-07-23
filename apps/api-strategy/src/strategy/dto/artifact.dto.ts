import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** SpArtifactType enum value set (schema-mirrored). */
export const ARTIFACT_TYPES = ['workspace_draft', 'outreach_record'] as const;
export type ArtifactTypeValue = (typeof ARTIFACT_TYPES)[number];

/**
 * Node -> Capiro artifact back-link (RTE-3). `artifactRef` is a foreign id
 * (ws_draft.id / outreach_records.id) owned by another service, so it is
 * validated as an opaque non-empty string (NOT @IsUUID — schema-faithful to the
 * plain String column, and future-proof to non-uuid id formats).
 */
export class CreateArtifactDto {
  @IsIn(ARTIFACT_TYPES)
  artifactType!: ArtifactTypeValue;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  artifactRef!: string;
}
