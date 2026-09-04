/**
 * Compiles a structured query spec into parameterized SQL, validating every
 * table/column/operator reference against `global-dataset-registry.ts`
 * before any SQL text exists.
 *
 * Deliberately NOT a SQL-text validator/parser. There is no dependency in
 * this codebase for safely parsing arbitrary SQL, and the model never
 * supplies SQL text or an identifier that becomes part of the query — every
 * identifier in the emitted SQL comes from this file's own fixed maps or the
 * registry's `column`/`expression` strings. The only caller-influenced values
 * that reach the database are bound parameters ($1, $2, ...), never
 * interpolated text. This keeps the entire safety property testable by a
 * short list of "does it ever emit a name/expression not from the registry"
 * unit tests, instead of "did we think of every SQL injection shape."
 */
import {
  getDataset,
  isDerivedField,
  type FieldDef,
  type FieldType,
  type GlobalDatasetDef,
} from './global-dataset-registry.js';

export class QuerySpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuerySpecError';
  }
}

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'in'
  | 'not_in'
  | 'gte'
  | 'lte'
  | 'gt'
  | 'lt'
  | 'between'
  | 'contains'
  | 'is_null'
  | 'is_not_null';

const FILTER_OPS: ReadonlySet<string> = new Set([
  'eq',
  'ne',
  'in',
  'not_in',
  'gte',
  'lte',
  'gt',
  'lt',
  'between',
  'contains',
  'is_null',
  'is_not_null',
]);

export type AggFn = 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max';

const AGG_FNS: ReadonlySet<string> = new Set(['count', 'count_distinct', 'sum', 'avg', 'min', 'max']);
const NUMERIC_ONLY_AGGS: ReadonlySet<string> = new Set(['sum', 'avg']);

export interface SelectSpec {
  /** Omit only when `agg` is `'count'` (bare COUNT(*)). */
  field?: string;
  agg?: AggFn;
}

export interface FilterSpec {
  field: string;
  op: FilterOp;
  /** Required for every op except is_null / is_not_null. */
  value?: unknown;
}

export interface OrderBySpec {
  /** Must be an alias produced by `select`. */
  field: string;
  direction?: 'asc' | 'desc';
}

export interface QuerySpec {
  dataset: string;
  select: SelectSpec[];
  filters?: FilterSpec[];
  groupBy?: string[];
  orderBy?: OrderBySpec[];
  limit?: number;
  /** ISO date/timestamp. Only honored when the dataset declares `supportsAsOf`. */
  asOfDate?: string;
}

export interface CompiledQuery {
  sql: string;
  params: unknown[];
  /** For audit logging: the dataset key and a redaction-free copy of the spec that produced this SQL. */
  datasetKey: string;
}

function resolveField(dataset: GlobalDatasetDef, name: string): FieldDef {
  const def = dataset.fields[name];
  if (!def) {
    throw new QuerySpecError(
      `Unknown field "${name}" for dataset "${dataset.key}". Call list_global_datasets to see valid fields.`,
    );
  }
  return def;
}

function fieldSql(def: FieldDef): string {
  return isDerivedField(def) ? `(${def.expression})` : def.column;
}

function assertFilterable(name: string, def: FieldDef): void {
  if (def.filterable === false) {
    throw new QuerySpecError(`Field "${name}" cannot be filtered on.`);
  }
}

function assertGroupable(name: string, def: FieldDef): void {
  if (def.groupable === false) {
    throw new QuerySpecError(`Field "${name}" cannot be grouped or aggregated by.`);
  }
}

function coerceFilterValue(field: string, type: FieldType, op: FilterOp, raw: unknown): unknown {
  const coerceOne = (v: unknown): unknown => {
    switch (type) {
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          throw new QuerySpecError(`Filter on "${field}" expects a number, got ${JSON.stringify(v)}.`);
        }
        return v;
      case 'boolean':
        if (typeof v !== 'boolean') {
          throw new QuerySpecError(`Filter on "${field}" expects a boolean, got ${JSON.stringify(v)}.`);
        }
        return v;
      case 'date':
      case 'timestamp': {
        const d = new Date(v as string);
        if (typeof v !== 'string' || Number.isNaN(d.getTime())) {
          throw new QuerySpecError(`Filter on "${field}" expects an ISO date string, got ${JSON.stringify(v)}.`);
        }
        return d;
      }
      case 'string':
      case 'string[]':
      default:
        if (typeof v !== 'string') {
          throw new QuerySpecError(`Filter on "${field}" expects a string, got ${JSON.stringify(v)}.`);
        }
        return v;
    }
  };

  if (op === 'in' || op === 'not_in') {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) {
      throw new QuerySpecError(`Filter op "${op}" on "${field}" expects a non-empty array (max 200 values).`);
    }
    return raw.map(coerceOne);
  }
  if (op === 'between') {
    if (!Array.isArray(raw) || raw.length !== 2) {
      throw new QuerySpecError(`Filter op "between" on "${field}" expects a [min, max] array.`);
    }
    return raw.map(coerceOne);
  }
  if (op === 'contains') {
    if (type !== 'string') {
      throw new QuerySpecError(`Filter op "contains" only applies to string fields (field "${field}").`);
    }
    return coerceOne(raw);
  }
  return coerceOne(raw);
}

/** Deterministic alias for a select entry — never taken from caller input. */
function selectAlias(spec: SelectSpec): string {
  if (spec.agg) return spec.field ? `${spec.agg}_${spec.field}` : `${spec.agg}_all`;
  return spec.field as string;
}

/**
 * Parses the raw, untyped tool-call `input` object (the JSON schema Meri's
 * tool catalog advertises is advisory only, per this file's existing
 * search_X tools — see `optionalString`/`clampInt` elsewhere in
 * meri-tools.service.ts) into a `QuerySpec`. Throws `QuerySpecError` on any
 * structurally wrong shape; `compileQuerySpec` does the semantic/allowlist
 * validation on the result.
 */
export function parseQuerySpecInput(input: Record<string, unknown>): QuerySpec {
  if (typeof input.dataset !== 'string' || !input.dataset.trim()) {
    throw new QuerySpecError('dataset is required and must be a string.');
  }
  if (!Array.isArray(input.select) || input.select.length === 0) {
    throw new QuerySpecError('select must be a non-empty array.');
  }

  const select: SelectSpec[] = input.select.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new QuerySpecError(`select[${i}] must be an object.`);
    }
    const r = raw as Record<string, unknown>;
    const entry: SelectSpec = {};
    if (r.field !== undefined) {
      if (typeof r.field !== 'string') throw new QuerySpecError(`select[${i}].field must be a string.`);
      entry.field = r.field;
    }
    if (r.agg !== undefined) {
      if (typeof r.agg !== 'string') throw new QuerySpecError(`select[${i}].agg must be a string.`);
      entry.agg = r.agg as AggFn;
    }
    return entry;
  });

  const filters: FilterSpec[] | undefined = Array.isArray(input.filters)
    ? input.filters.map((raw, i) => {
        if (typeof raw !== 'object' || raw === null) {
          throw new QuerySpecError(`filters[${i}] must be an object.`);
        }
        const r = raw as Record<string, unknown>;
        if (typeof r.field !== 'string') throw new QuerySpecError(`filters[${i}].field must be a string.`);
        if (typeof r.op !== 'string') throw new QuerySpecError(`filters[${i}].op must be a string.`);
        return { field: r.field, op: r.op as FilterOp, value: r.value };
      })
    : undefined;

  const groupBy: string[] | undefined = Array.isArray(input.groupBy)
    ? input.groupBy.map((v, i) => {
        if (typeof v !== 'string') throw new QuerySpecError(`groupBy[${i}] must be a string.`);
        return v;
      })
    : undefined;

  const orderBy: OrderBySpec[] | undefined = Array.isArray(input.orderBy)
    ? input.orderBy.map((raw, i) => {
        if (typeof raw !== 'object' || raw === null) {
          throw new QuerySpecError(`orderBy[${i}] must be an object.`);
        }
        const r = raw as Record<string, unknown>;
        if (typeof r.field !== 'string') throw new QuerySpecError(`orderBy[${i}].field must be a string.`);
        const direction = r.direction === 'desc' ? 'desc' : 'asc';
        return { field: r.field, direction: direction as 'asc' | 'desc' };
      })
    : undefined;

  const limit = input.limit !== undefined ? Number(input.limit) : undefined;
  const asOfDate = typeof input.asOfDate === 'string' ? input.asOfDate : undefined;

  return {
    dataset: input.dataset,
    select,
    filters,
    groupBy,
    orderBy,
    limit,
    asOfDate,
  };
}

export function compileQuerySpec(spec: QuerySpec): CompiledQuery {
  const dataset = getDataset(spec.dataset);
  if (!dataset) {
    throw new QuerySpecError(`Unknown dataset "${spec.dataset}". Call list_global_datasets to see valid datasets.`);
  }

  if (!Array.isArray(spec.select) || spec.select.length === 0) {
    throw new QuerySpecError('select must be a non-empty array.');
  }
  if (spec.select.length > 12) {
    throw new QuerySpecError('select supports at most 12 entries.');
  }

  const params: unknown[] = [];
  let paramIndex = 0;
  const nextParam = (value: unknown): string => {
    params.push(value);
    paramIndex += 1;
    return `$${paramIndex}`;
  };

  // --- FROM clause, with the $ASOF_DATE$ substitution bound FIRST so its
  // parameter number matches its left-to-right position in the final SQL. ---
  let fromSql = dataset.table;
  if (fromSql.includes('$ASOF_DATE$')) {
    if (!dataset.supportsAsOf) {
      throw new QuerySpecError(`Dataset "${dataset.key}" does not support asOfDate.`);
    }
    let asOf: Date;
    if (spec.asOfDate !== undefined) {
      asOf = new Date(spec.asOfDate);
      if (Number.isNaN(asOf.getTime())) {
        throw new QuerySpecError(`asOfDate "${spec.asOfDate}" is not a valid date.`);
      }
    } else {
      asOf = new Date();
    }
    const placeholder = nextParam(asOf);
    fromSql = fromSql.split('$ASOF_DATE$').join(placeholder);
  } else if (spec.asOfDate !== undefined) {
    throw new QuerySpecError(`Dataset "${dataset.key}" does not support asOfDate.`);
  }

  // --- select ---
  const seenAliases = new Set<string>();
  const nonAggSelectFields = new Set<string>();
  const selectSqlParts: string[] = [];

  for (const entry of spec.select) {
    if (entry.agg !== undefined && !AGG_FNS.has(entry.agg)) {
      throw new QuerySpecError(`Unknown aggregate "${entry.agg}".`);
    }
    if (entry.agg === undefined) {
      if (!entry.field) throw new QuerySpecError('select entries without agg must set field.');
      const def = resolveField(dataset, entry.field);
      nonAggSelectFields.add(entry.field);
      selectSqlParts.push(`${fieldSql(def)} AS ${entry.field}`);
    } else if (entry.agg === 'count' && !entry.field) {
      selectSqlParts.push(`COUNT(*) AS count_all`);
    } else {
      if (!entry.field) throw new QuerySpecError(`agg "${entry.agg}" requires field.`);
      const def = resolveField(dataset, entry.field);
      assertGroupable(entry.field, def);
      if (NUMERIC_ONLY_AGGS.has(entry.agg) && def.type !== 'number') {
        throw new QuerySpecError(`Aggregate "${entry.agg}" requires a numeric field; "${entry.field}" is ${def.type}.`);
      }
      const alias = selectAlias(entry);
      const sqlFn =
        entry.agg === 'count_distinct'
          ? `COUNT(DISTINCT ${fieldSql(def)})`
          : `${entry.agg.toUpperCase()}(${fieldSql(def)})`;
      selectSqlParts.push(`${sqlFn} AS ${alias}`);
    }
    const alias = selectAlias(entry);
    if (seenAliases.has(alias)) {
      throw new QuerySpecError(`Duplicate select alias "${alias}" — select each field/aggregate at most once.`);
    }
    seenAliases.add(alias);
  }

  const hasAggregate = spec.select.some((e) => e.agg !== undefined);

  // --- groupBy ---
  const groupBySqlParts: string[] = [];
  if (spec.groupBy && spec.groupBy.length > 0) {
    if (spec.groupBy.length > 6) {
      throw new QuerySpecError('groupBy supports at most 6 fields.');
    }
    for (const field of spec.groupBy) {
      if (!nonAggSelectFields.has(field)) {
        throw new QuerySpecError(
          `groupBy field "${field}" must also appear as a non-aggregated select entry.`,
        );
      }
      const def = resolveField(dataset, field);
      assertGroupable(field, def);
      groupBySqlParts.push(fieldSql(def));
    }
  }
  if (hasAggregate && nonAggSelectFields.size > 0) {
    const missing = [...nonAggSelectFields].filter((f) => !(spec.groupBy ?? []).includes(f));
    if (missing.length > 0) {
      throw new QuerySpecError(
        `select mixes aggregates with non-aggregated field(s) ${missing.join(', ')} that are not in groupBy.`,
      );
    }
  }

  // --- filters ---
  const whereSqlParts: string[] = [];
  for (const f of spec.filters ?? []) {
    if (!FILTER_OPS.has(f.op)) {
      throw new QuerySpecError(`Unknown filter op "${f.op}".`);
    }
    const def = resolveField(dataset, f.field);
    assertFilterable(f.field, def);
    const col = fieldSql(def);

    if (f.op === 'is_null') {
      whereSqlParts.push(`${col} IS NULL`);
      continue;
    }
    if (f.op === 'is_not_null') {
      whereSqlParts.push(`${col} IS NOT NULL`);
      continue;
    }

    const value = coerceFilterValue(f.field, def.type, f.op, f.value);

    switch (f.op) {
      case 'eq':
        whereSqlParts.push(`${col} = ${nextParam(value)}`);
        break;
      case 'ne':
        whereSqlParts.push(`${col} <> ${nextParam(value)}`);
        break;
      case 'gt':
        whereSqlParts.push(`${col} > ${nextParam(value)}`);
        break;
      case 'gte':
        whereSqlParts.push(`${col} >= ${nextParam(value)}`);
        break;
      case 'lt':
        whereSqlParts.push(`${col} < ${nextParam(value)}`);
        break;
      case 'lte':
        whereSqlParts.push(`${col} <= ${nextParam(value)}`);
        break;
      case 'contains':
        whereSqlParts.push(`${col} ILIKE ${nextParam(`%${value}%`)}`);
        break;
      case 'in':
        whereSqlParts.push(`${col} = ANY(${nextParam(value)})`);
        break;
      case 'not_in':
        whereSqlParts.push(`${col} <> ALL(${nextParam(value)})`);
        break;
      case 'between': {
        const [lo, hi] = value as [unknown, unknown];
        whereSqlParts.push(`${col} BETWEEN ${nextParam(lo)} AND ${nextParam(hi)}`);
        break;
      }
    }
  }

  // --- orderBy ---
  const orderBySqlParts: string[] = [];
  for (const o of spec.orderBy ?? []) {
    if (!seenAliases.has(o.field)) {
      throw new QuerySpecError(`orderBy field "${o.field}" must be one of the select aliases: ${[...seenAliases].join(', ')}.`);
    }
    const dir = o.direction === 'desc' ? 'DESC' : 'ASC';
    orderBySqlParts.push(`${o.field} ${dir}`);
  }
  if (spec.orderBy && spec.orderBy.length > 3) {
    throw new QuerySpecError('orderBy supports at most 3 fields.');
  }

  // --- limit ---
  const requestedLimit = spec.limit ?? dataset.defaultLimit;
  if (typeof requestedLimit !== 'number' || !Number.isFinite(requestedLimit) || requestedLimit < 1) {
    throw new QuerySpecError('limit must be a positive number.');
  }
  const limit = Math.min(Math.floor(requestedLimit), dataset.maxLimit);

  let sql = `SELECT ${selectSqlParts.join(', ')} FROM ${fromSql}`;
  if (whereSqlParts.length > 0) sql += ` WHERE ${whereSqlParts.join(' AND ')}`;
  if (groupBySqlParts.length > 0) sql += ` GROUP BY ${groupBySqlParts.join(', ')}`;
  if (orderBySqlParts.length > 0) sql += ` ORDER BY ${orderBySqlParts.join(', ')}`;
  sql += ` LIMIT ${limit}`;

  return { sql, params, datasetKey: dataset.key };
}
