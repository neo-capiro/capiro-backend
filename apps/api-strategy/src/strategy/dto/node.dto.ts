import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** SpNodeKind / SpNodeSubject / SpNodeStatus enum value sets (schema-mirrored). */
export const NODE_KINDS = ['action', 'decision', 'gate', 'milestone', 'risk'] as const;
export const NODE_SUBJECTS = [
  'deliverable',
  'submission',
  'member',
  'committee',
  'ask',
  'agency',
  'outcome',
  'optics',
] as const;
export const NODE_STATUSES = [
  'draft',
  'in_progress',
  'internal_review',
  'active',
  'suggested',
] as const;

export type NodeKindValue = (typeof NODE_KINDS)[number];
export type NodeSubjectValue = (typeof NODE_SUBJECTS)[number];
export type NodeStatusValue = (typeof NODE_STATUSES)[number];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Manual node create (SHL-7 Add step + future callers). meriAuthored is NOT
 * client-settable — manual adds are person-authored (the Meri draft path sets
 * it server-side in G5).
 */
export class CreateNodeDto {
  @IsIn(NODE_KINDS)
  kind!: NodeKindValue;

  @IsIn(NODE_SUBJECTS)
  subject!: NodeSubjectValue;

  @IsString()
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  note?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  ownerUserId?: string | null;

  @IsOptional()
  @IsIn(NODE_STATUSES)
  status?: NodeStatusValue;

  @IsString()
  @Matches(DATE_RE, { message: 'startsOn must be YYYY-MM-DD' })
  startsOn!: string;

  @IsOptional()
  @Matches(DATE_RE, { message: 'endsOn must be YYYY-MM-DD' })
  endsOn?: string | null;

  @IsOptional()
  @IsBoolean()
  openEnded?: boolean;
}

/**
 * Partial node update (NOD-5 quick actions, NOD-7 field editors, TLN-12 drag).
 * Every field optional; a field present-and-null clears a nullable column,
 * absent leaves it untouched (the service applies only provided keys).
 * `changeNote` is the human-facing version/flash label for this edit.
 */
export class UpdateNodeDto {
  @IsOptional()
  @IsIn(NODE_KINDS)
  kind?: NodeKindValue;

  @IsOptional()
  @IsIn(NODE_SUBJECTS)
  subject?: NodeSubjectValue;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  note?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  ownerUserId?: string | null;

  @IsOptional()
  @IsIn(NODE_STATUSES)
  status?: NodeStatusValue;

  @IsOptional()
  @Matches(DATE_RE, { message: 'startsOn must be YYYY-MM-DD' })
  startsOn?: string;

  @IsOptional()
  @Matches(DATE_RE, { message: 'endsOn must be YYYY-MM-DD' })
  endsOn?: string | null;

  @IsOptional()
  @IsBoolean()
  openEnded?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  changeNote?: string;
}
