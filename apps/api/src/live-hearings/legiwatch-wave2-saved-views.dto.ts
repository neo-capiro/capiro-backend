/**
 * LegiWatch V2 Wave 2 (W2-2) — Saved Views request DTOs.
 *
 * `config` is the one field in this module that risks becoming "arbitrary
 * unchecked JSON". `BoundedViewConfigConstraint` closes that off three ways:
 *
 *  1. top-level keys are an ALLOWLIST (`ALLOWED_CONFIG_KEYS`) — an unknown key
 *     is rejected outright, not silently dropped or stored;
 *  2. every value is walked recursively with the same node/depth/string/
 *     array/key-count bounds `workspace-assistant.dto.ts`'s
 *     `BoundedJsonConstraint` already established, so a saved view cannot
 *     grow into a document store;
 *  3. `__proto__`, `constructor`, `prototype`, `tenantId`, `ownerId` and
 *     `ownerUserId` are rejected as keys at ANY depth. The DTO's own
 *     `tenantId`/`ownerUserId` are never declared as top-level fields at all
 *     (the global ValidationPipe's `forbidNonWhitelisted` 400s a request that
 *     tries), so this closes the same door one level down, inside `config`.
 */
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

export const LEGIWATCH_SAVED_VIEW_SURFACES = [
  'hearings_schedule',
  'hearings_archive',
  'committees',
  'committee_intelligence',
  'feed',
  'bills',
] as const;
export type LegiWatchSavedViewSurface = (typeof LEGIWATCH_SAVED_VIEW_SURFACES)[number];

export const LEGIWATCH_SAVED_VIEW_SCOPES = ['personal', 'tenant'] as const;
export type LegiWatchSavedViewScope = (typeof LEGIWATCH_SAVED_VIEW_SCOPES)[number];

/** The supported subset of state a saved view may carry. */
const ALLOWED_CONFIG_KEYS = new Set([
  'subtab',
  'filters',
  'search',
  'sort',
  'dateRange',
  'layout',
  'visibleColumns',
]);

/** Rejected at ANY depth — prototype-pollution vectors and identity fields. */
const RESERVED_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'tenantId',
  'ownerId',
  'ownerUserId',
]);

const MAX_NODES = 500;
const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_LENGTH = 100;
const MAX_OBJECT_KEYS = 40;
const MAX_KEY_LENGTH = 100;

/**
 * Returns a violation message, or null when `value` is a valid saved-view
 * config. Modeled directly on `boundedJsonViolation` in
 * workspace-assistant.dto.ts, extended with the top-level key allowlist and
 * the reserved-key rejection neither that function nor
 * `apps/workspace/.../draft.dto.ts`'s bare `@IsObject()` field currently do.
 */
export function boundedViewConfigViolation(value: unknown): string | null {
  if (value === undefined || value === null) return null; // optional field
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'config must be a JSON object';
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      return `config has an unsupported top-level key "${key}"`;
    }
  }

  let nodes = 0;
  const visit = (current: unknown, depth: number): string | null => {
    nodes += 1;
    if (nodes > MAX_NODES) return `config exceeds ${MAX_NODES} JSON nodes`;
    if (depth > MAX_DEPTH) return `config exceeds nesting depth ${MAX_DEPTH}`;
    if (typeof current === 'string' && current.length > MAX_STRING_LENGTH) {
      return `config contains a string longer than ${MAX_STRING_LENGTH} characters`;
    }
    if (Array.isArray(current)) {
      if (current.length > MAX_ARRAY_LENGTH) {
        return `config contains an array longer than ${MAX_ARRAY_LENGTH} items`;
      }
      for (const item of current) {
        const violation = visit(item, depth + 1);
        if (violation) return violation;
      }
      return null;
    }
    if (current && typeof current === 'object') {
      const entries = Object.entries(current as Record<string, unknown>);
      if (entries.length > MAX_OBJECT_KEYS) {
        return `config contains an object with more than ${MAX_OBJECT_KEYS} keys`;
      }
      for (const [key, item] of entries) {
        if (RESERVED_KEYS.has(key)) {
          return `config uses a reserved key "${key}"`;
        }
        if (key.length > MAX_KEY_LENGTH) {
          return `config contains a key longer than ${MAX_KEY_LENGTH} characters`;
        }
        const violation = visit(item, depth + 1);
        if (violation) return violation;
      }
    }
    return null;
  };

  return visit(value, 0);
}

@ValidatorConstraint({ name: 'boundedViewConfig', async: false })
class BoundedViewConfigConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return boundedViewConfigViolation(value) === null;
  }
  defaultMessage(): string {
    return boundedViewConfigViolation(undefined) ?? 'config exceeds the allowed JSON budget';
  }
}

export class SaveViewDto {
  @IsIn(LEGIWATCH_SAVED_VIEW_SURFACES)
  surface!: LegiWatchSavedViewSurface;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsIn(LEGIWATCH_SAVED_VIEW_SCOPES)
  scope?: LegiWatchSavedViewScope;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  /**
   * The shape version of `config` this request was written against. Omitted
   * requests default to the current version; an EXPLICIT version the server
   * does not understand is refused rather than guessed at (see
   * `CURRENT_CONFIG_VERSION` in the service).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  configVersion?: number;

  @IsOptional()
  @IsObject()
  @Validate(BoundedViewConfigConstraint)
  config?: Record<string, unknown>;
}

export class UpdateViewDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsIn(LEGIWATCH_SAVED_VIEW_SCOPES)
  scope?: LegiWatchSavedViewScope;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  configVersion?: number;

  @IsOptional()
  @IsObject()
  @Validate(BoundedViewConfigConstraint)
  config?: Record<string, unknown>;
}

export class SetDefaultViewDto {
  @IsBoolean()
  isDefault!: boolean;
}

export class DuplicateViewDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;
}

export class ListViewsQueryDto {
  @IsOptional()
  @IsIn(LEGIWATCH_SAVED_VIEW_SURFACES)
  surface?: LegiWatchSavedViewSurface;

  @IsOptional()
  @IsIn(['personal', 'tenant', 'all'])
  scope?: 'personal' | 'tenant' | 'all';
}
