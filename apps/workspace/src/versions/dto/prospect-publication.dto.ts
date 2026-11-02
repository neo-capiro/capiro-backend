import { IsString, IsUUID, Matches, ValidateIf } from 'class-validator';

/** Publication identifies a reviewed saved revision. It carries no new content. */
export class PublishProspectDraftDto {
  @IsUUID() requestId!: string;
  @IsUUID() expectedProspectId!: string;
  @IsUUID() sourceVersionId!: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) sourceSnapshotHash!: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) expectedStateHash!: string;
  @ValidateIf((_object, value) => value !== null)
  @IsUUID()
  expectedPublicationId!: string | null;
}
