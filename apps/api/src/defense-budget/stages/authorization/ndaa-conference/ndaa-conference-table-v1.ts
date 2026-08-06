/** Phase 6 Workstream G — explicit House/Senate/Conference column roles. */
import { z } from 'zod';
import {
  congressionalTableV1Schema,
  type CongressionalRowV1,
  type CongressionalTableV1,
} from '../../congressional-table-v1.js';
import type { MoneyUnitV1 } from '../../../contracts/extraction-artifact-v1.js';

export const NDAA_CONFERENCE_TABLE_SCHEMA_VERSION = 'ndaa_conference_table_v1' as const;
export const NDAA_CONFERENCE_COLUMN_ROLE_VALUES = [
  'label',
  'request_baseline',
  'hasc',
  'sasc',
  'ndaa_conference',
  'change',
  'quantity',
  'other',
] as const;
export const ndaaConferenceColumnRoleSchema = z.enum(NDAA_CONFERENCE_COLUMN_ROLE_VALUES);
export type NdaaConferenceColumnRole = z.infer<typeof ndaaConferenceColumnRoleSchema>;

export const ndaaConferenceColumnRoleV1Schema = z
  .object({
    columnIndex: z.number().int().nonnegative(),
    role: ndaaConferenceColumnRoleSchema,
  })
  .strict();

export const ndaaConferenceTableV1Schema = z
  .object({
    schemaVersion: z.literal(NDAA_CONFERENCE_TABLE_SCHEMA_VERSION),
    table: congressionalTableV1Schema,
    columnRoles: z.array(ndaaConferenceColumnRoleV1Schema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const indices = value.columnRoles.map((item) => item.columnIndex);
    if (new Set(indices).size !== indices.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'columnRoles must be unique' });
    }
    const tableIndices = new Set(value.table.columns.map((column) => column.columnIndex));
    if (indices.some((index) => !tableIndices.has(index))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'columnRoles must reference table columns',
      });
    }
    const roles = new Map(value.columnRoles.map((item) => [item.columnIndex, item.role]));
    for (const column of value.table.columns) {
      const role = roles.get(column.columnIndex);
      if (role === 'quantity' && (!column.isQuantity || column.moneySemantic != null)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'quantity role requires quantity-only column' });
      }
      const expectedSemantic =
        role === 'request_baseline'
          ? 'request_baseline'
          : role === 'change'
            ? 'change'
            : role === 'hasc' || role === 'sasc' || role === 'ndaa_conference'
              ? 'authorized_total'
              : undefined;
      if (expectedSemantic != null && column.moneySemantic !== expectedSemantic) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${role} role requires moneySemantic=${expectedSemantic}`,
        });
      }
    }
    const roleValues = new Set(value.columnRoles.map((item) => item.role));
    if (
      !roleValues.has('ndaa_conference') &&
      !(roleValues.has('request_baseline') && roleValues.has('change'))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'conference table requires an explicit conference total or request+change columns',
      });
    }
  });
export type NdaaConferenceTableV1 = z.infer<typeof ndaaConferenceTableV1Schema>;

export interface PrintedConferenceMoneyV1 {
  role: Extract<NdaaConferenceColumnRole, 'request_baseline' | 'hasc' | 'sasc' | 'ndaa_conference' | 'change'>;
  value: string;
  unit: MoneyUnitV1;
  fiscalYear?: number;
  columnIndex: number;
  rawText: string;
}

export function ndaaConferenceRoleMapV1(
  bundle: NdaaConferenceTableV1,
): ReadonlyMap<number, NdaaConferenceColumnRole> {
  return new Map(bundle.columnRoles.map((item) => [item.columnIndex, item.role]));
}

/**
 * Build a shared Workstream-C table safe for generic stage emission. House and
 * Senate money columns are intentionally removed so the generic absolute-total
 * selector can only see the conference position (or explicit request+change).
 */
export function ndaaConferenceEmissionTableV1(bundleInput: NdaaConferenceTableV1): CongressionalTableV1 {
  const bundle = ndaaConferenceTableV1Schema.parse(bundleInput);
  const roles = ndaaConferenceRoleMapV1(bundle);
  const allowed = new Set<NdaaConferenceColumnRole>([
    'label',
    'request_baseline',
    'ndaa_conference',
    'change',
    'quantity',
  ]);
  const columns = bundle.table.columns
    .filter((column) => allowed.has(roles.get(column.columnIndex) ?? 'other'))
    .map((column) => {
      const role = roles.get(column.columnIndex);
      return role === 'ndaa_conference' ? { ...column, moneySemantic: 'authorized_total' as const } : column;
    });
  const indices = new Set(columns.map((column) => column.columnIndex));
  return {
    ...bundle.table,
    columns,
    rows: bundle.table.rows.map((row) => ({
      ...row,
      cells: row.cells.filter((cell) => indices.has(cell.columnIndex)),
    })),
  };
}

export function printedConferenceMoneyForRowV1(
  bundleInput: NdaaConferenceTableV1,
  row: CongressionalRowV1,
): PrintedConferenceMoneyV1[] {
  const bundle = ndaaConferenceTableV1Schema.parse(bundleInput);
  const roles = ndaaConferenceRoleMapV1(bundle);
  const byColumn = new Map(bundle.table.columns.map((column) => [column.columnIndex, column]));
  const out: PrintedConferenceMoneyV1[] = [];
  for (const cell of row.cells) {
    if (cell.value == null) continue;
    const role = roles.get(cell.columnIndex);
    if (
      role == null ||
      !['request_baseline', 'hasc', 'sasc', 'ndaa_conference', 'change'].includes(role)
    ) {
      continue;
    }
    const column = byColumn.get(cell.columnIndex);
    const unit = column?.declaredUnit ?? bundle.table.declaredUnit;
    if (unit == null) continue;
    out.push({
      role: role as PrintedConferenceMoneyV1['role'],
      value: cell.value,
      unit,
      ...(column?.fiscalYear != null ? { fiscalYear: column.fiscalYear } : {}),
      columnIndex: cell.columnIndex,
      rawText: cell.rawText,
    });
  }
  return out;
}
