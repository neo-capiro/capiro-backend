import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'boundedJson', async: false })
class BoundedJsonConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return boundedJsonViolation(value) === null;
  }

  defaultMessage(): string {
    return boundedJsonViolation(undefined) ?? 'setup exceeds the allowed JSON budget';
  }
}

@ValidatorConstraint({ name: 'messageCharacterBudget', async: false })
class MessageCharacterBudgetConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return (
      Array.isArray(value) &&
      value.reduce(
        (total, item) =>
          total +
          (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
            ? (item as { text: string }).text.length
            : 0),
        0,
      ) <= 120_000
    );
  }

  defaultMessage(_args?: ValidationArguments): string {
    return 'messages exceed the 120000-character request budget';
  }
}

export class WorkspaceAssistantMessageDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MinLength(1)
  @MaxLength(32_000)
  text!: string;
}

export class WorkspaceAssistantSectionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  name!: string;

  @IsString()
  @MaxLength(50_000)
  content!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  status?: string;
}

export class WorkspaceAssistantDocumentDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  product?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  client?: string;

  @IsArray()
  @ArrayMaxSize(80)
  @ValidateNested({ each: true })
  @Type(() => WorkspaceAssistantSectionDto)
  sections!: WorkspaceAssistantSectionDto[];
}

export class WorkspaceAssistantContextItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  text?: string;
}

/**
 * In-editor Meri assistant request. Runtime classes are used all the way down,
 * so the global ValidationPipe can reject unknown nested fields instead of
 * trusting erased TypeScript interfaces.
 */
export class WorkspaceAssistantDto {
  @IsArray()
  @ArrayMaxSize(40)
  @Validate(MessageCharacterBudgetConstraint)
  @ValidateNested({ each: true })
  @Type(() => WorkspaceAssistantMessageDto)
  messages!: WorkspaceAssistantMessageDto[];

  @IsObject()
  @ValidateNested()
  @Type(() => WorkspaceAssistantDocumentDto)
  document!: WorkspaceAssistantDocumentDto;

  /** Setup remains extensible, but is bounded by keys, depth, nodes, arrays, and strings. */
  @IsOptional()
  @IsObject()
  @Validate(BoundedJsonConstraint)
  setup?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(80)
  @ValidateNested({ each: true })
  @Type(() => WorkspaceAssistantContextItemDto)
  context?: WorkspaceAssistantContextItemDto[];

  @IsOptional()
  @IsUUID()
  clientId?: string;
}

function boundedJsonViolation(value: unknown): string | null {
  // defaultMessage calls this without a value; return the generic message.
  if (value === undefined) return 'setup exceeds the allowed JSON budget';
  let nodes = 0;
  const visit = (current: unknown, depth: number): string | null => {
    nodes += 1;
    if (nodes > 1_000) return 'setup exceeds 1000 JSON nodes';
    if (depth > 5) return 'setup exceeds nesting depth 5';
    if (typeof current === 'string' && current.length > 20_000) {
      return 'setup contains a string longer than 20000 characters';
    }
    if (Array.isArray(current)) {
      if (current.length > 100) return 'setup contains an array longer than 100 items';
      for (const item of current) {
        const violation = visit(item, depth + 1);
        if (violation) return violation;
      }
      return null;
    }
    if (current && typeof current === 'object') {
      const entries = Object.entries(current as Record<string, unknown>);
      if (entries.length > 80) return 'setup contains an object with more than 80 keys';
      for (const [key, item] of entries) {
        if (key.length > 200) return 'setup contains a key longer than 200 characters';
        const violation = visit(item, depth + 1);
        if (violation) return violation;
      }
    }
    return null;
  };
  return visit(value, 0);
}
