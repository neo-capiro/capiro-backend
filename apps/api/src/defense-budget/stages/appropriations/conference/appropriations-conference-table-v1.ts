/** Phase 6 Workstream K — explicit HAC-D/SAC-D/Conference printed column roles. */
import { z } from 'zod';
import {
  congressionalTableV1Schema,
  type CongressionalRowV1,
  type CongressionalTableV1,
  type RowMoneyV1,
} from '../../congressional-table-v1.js';

export const APPROPRIATIONS_CONFERENCE_COLUMN_ROLE_VALUES = [
  'label',
  'request_baseline',
  'hac_d',
  'sac_d',
  'conference',
  'change',
  'quantity',
  'other',
] as const;
export const appropriationsConferenceColumnRoleV1Schema = z.enum(
  APPROPRIATIONS_CONFERENCE_COLUMN_ROLE_VALUES,
);
export type AppropriationsConferenceColumnRoleV1 = z.infer<
  typeof appropriationsConferenceColumnRoleV1Schema
>;

export const appropriationsConferenceTableV1Schema = z
  .object({
    schemaVersion: z.literal('appropriations_conference_table_v1'),
    table: congressionalTableV1Schema,
    columnRoles: z.array(
      z
        .object({
          columnIndex: z.number().int().nonnegative(),
          role: appropriationsConferenceColumnRoleV1Schema,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<number>();
    for (const item of value.columnRoles) {
      if (seen.has(item.columnIndex)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate conference column role' });
      }
      seen.add(item.columnIndex);
      if (!value.table.columns.some((column) => column.columnIndex === item.columnIndex)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'conference role references missing column' });
      }
    }
    if (!value.columnRoles.some((item) => item.role === 'conference')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'conference table requires explicit conference column' });
    }
  });
export type AppropriationsConferenceTableV1 = z.infer<typeof appropriationsConferenceTableV1Schema>;

function roleMap(bundle: AppropriationsConferenceTableV1): Map<number, AppropriationsConferenceColumnRoleV1> {
  return new Map(bundle.columnRoles.map((item) => [item.columnIndex, item.role]));
}

export function conferenceEmissionTableV1(
  bundle: AppropriationsConferenceTableV1,
): CongressionalTableV1 {
  const roles = roleMap(bundle);
  return {
    ...bundle.table,
    columns: bundle.table.columns.map((column) => {
      const role = roles.get(column.columnIndex);
      if (role === 'conference') return { ...column, moneySemantic: 'appropriated_total' as const };
      if (role === 'request_baseline') return { ...column, moneySemantic: 'request_baseline' as const };
      if (role === 'change') return { ...column, moneySemantic: 'change' as const };
      if (role === 'quantity') return { ...column, moneySemantic: undefined, isQuantity: true };
      return { ...column, moneySemantic: undefined };
    }),
  };
}

export interface PrintedConferenceMoneyV1 extends RowMoneyV1 {
  role: 'hac_d' | 'sac_d' | 'conference';
}

export function printedConferenceMoneyForRowV1(
  bundle: AppropriationsConferenceTableV1,
  row: CongressionalRowV1,
): PrintedConferenceMoneyV1[] {
  const roles = roleMap(bundle);
  const output: PrintedConferenceMoneyV1[] = [];
  for (const cell of row.cells) {
    if (cell.value == null) continue;
    const role = roles.get(cell.columnIndex);
    if (role !== 'hac_d' && role !== 'sac_d' && role !== 'conference') continue;
    const column = bundle.table.columns.find((item) => item.columnIndex === cell.columnIndex);
    const unit = column?.declaredUnit ?? bundle.table.declaredUnit;
    if (unit == null) continue;
    output.push({
      role,
      semantic: 'appropriated_total',
      value: cell.value,
      unit,
      ...(column?.fiscalYear != null ? { fiscalYear: column.fiscalYear } : {}),
      columnIndex: cell.columnIndex,
    });
  }
  return output;
}
