import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { nativeCanonicalSha256 } from './native-approvals/native-approval.contract.js';

export const CLIENT_RECORD_SCOPE_KEY = '__meriClientRecordScope';
export const CLIENT_RECORD_MAX_BYTES = 65536;
const uuid = z
  .string()
  .uuid()
  .regex(/^[a-f0-9-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
const baseFields = {
  name: text(300).optional(),
  website: text(500).optional(),
  description: text(4000).optional(),
  sectorTag: text(120).optional(),
  primaryContactName: text(200).optional(),
  primaryContactEmail: text(200).optional(),
  primaryContactPhone: text(60).optional(),
};
export const createClientInput = z
  .object({
    ...baseFields,
    name: text(300),
    ldaClientId: z.number().int().min(1).max(2147483647).optional(),
    skipLdaCheck: z.boolean().optional(),
  })
  .strict();
const strings = z.array(text(120)).max(100);
export const profileFieldNames = [
  'name',
  'website',
  'description',
  'productDescription',
  'primaryContactName',
  'primaryContactEmail',
  'primaryContactPhone',
  'sectorTag',
  'uei',
  'cageCode',
  'issueCodes',
  'naicsCodes',
  'pscCodes',
] as const;
const fieldName = z.enum(profileFieldNames);
const profile = z
  .object({
    ...baseFields,
    clientId: uuid,
    productDescription: text(4000).optional(),
    uei: text(12).optional(),
    cageCode: text(5).optional(),
    issueCodes: strings.optional(),
    naicsCodes: strings.optional(),
    pscCodes: strings.optional(),
    provenance: z
      .record(
        fieldName,
        z.object({ sourceUrl: text(2048), confidence: z.enum(['high', 'medium', 'low']) }).strict(),
      )
      .optional(),
    facilities: z
      .array(
        z
          .object({
            name: text(200),
            addressLine: text(300).optional(),
            city: text(120).optional(),
            state: text(2).optional(),
            zip: text(10).optional(),
            congressionalDistrict: text(4).optional(),
            employeeCount: z.number().int().min(0).max(10000000).optional(),
            notes: text(2000).optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    capabilities: z
      .array(
        z
          .object({
            name: text(200),
            type: text(60).optional(),
            description: text(4000).optional(),
            sector: text(120).optional(),
            notes: text(2000).optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    people: z
      .array(
        z
          .object({
            name: text(200),
            title: text(200).optional(),
            email: text(200).optional(),
            phone: text(60).optional(),
            role: text(120).optional(),
            lastContact: text(40).optional(),
            notes: text(2000).optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();
export const updateClientProfileInput = profile.refine(
  (value) =>
    profileFieldNames.some((key) => value[key] !== undefined) ||
    ['facilities', 'capabilities', 'people'].some(
      (key) => (value[key as 'facilities']?.length ?? 0) > 0,
    ),
  'No profile changes',
);
export const clientRecordRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create_client'), input: createClientInput }).strict(),
  z
    .object({ operation: z.literal('update_client_profile'), input: updateClientProfileInput })
    .strict(),
]);
export type ClientRecordRequest = z.infer<typeof clientRecordRequestSchema>;
export const clientRecordSelectionSchema = z
  .object({ conversationId: uuid, selectedClientId: uuid.nullable() })
  .strict();
export const clientRecordScopeSchema = clientRecordSelectionSchema
  .extend({
    identityRevision: digest,
    membershipRevision: digest,
    contextRevision: digest,
  })
  .strict();
export type ClientRecordScope = z.infer<typeof clientRecordScopeSchema>;
export interface ClientRecordAccess {
  scope: ClientRecordScope;
  mode: 'execute' | 'observe';
  clientIds: readonly string[];
  assertCurrent(): Promise<void>;
}
export const isClientRecordAction = (tool: string) =>
  tool === 'create_client' || tool === 'update_client_profile';
export function clientRecordRequest(tool: string, input: unknown): ClientRecordRequest {
  const parsed = clientRecordRequestSchema.safeParse({ operation: tool, input });
  if (
    !parsed.success ||
    Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > CLIENT_RECORD_MAX_BYTES
  )
    throw new BadRequestException('Invalid client record action');
  return parsed.data;
}
export function readClientRecordScope(preview: unknown) {
  const result = clientRecordScopeSchema.safeParse(
    (preview as Record<string, unknown> | null)?.[CLIENT_RECORD_SCOPE_KEY],
  );
  if (!result.success) throw new ForbiddenException('Client record proposal scope unavailable');
  return result.data;
}
export async function assertClientRecordAccess(
  access: ClientRecordAccess | undefined,
  conversationId: string | null | undefined,
  tool: string,
  input: unknown,
  preview?: unknown,
  terminalObservation = false,
  readOnly = false,
) {
  const scope = clientRecordScopeSchema.safeParse(access?.scope),
    request = clientRecordRequest(tool, input);
  if (
    !access ||
    !scope.success ||
    typeof access.assertCurrent !== 'function' ||
    scope.data.conversationId !== conversationId ||
    (!readOnly && access.mode !== 'execute')
  )
    throw new ForbiddenException('Current client record access required');
  if (
    request.operation === 'update_client_profile' &&
    ((scope.data.selectedClientId !== null &&
      request.input.clientId !== scope.data.selectedClientId) ||
      !access.clientIds.includes(request.input.clientId))
  )
    throw new ForbiddenException('Current client record access required');
  if (preview !== undefined) {
    const stored = readClientRecordScope(preview);
    const compare = (value: ClientRecordScope) =>
      terminalObservation ? { ...value, membershipRevision: null } : value;
    if (nativeCanonicalSha256(compare(stored)) !== nativeCanonicalSha256(compare(scope.data)))
      throw new ForbiddenException('Client record proposal authority changed');
  }
  await access.assertCurrent();
  return scope.data;
}
export function clientRecordFingerprint(
  tool: string,
  input: Record<string, unknown>,
  scope?: ClientRecordScope,
) {
  return isClientRecordAction(tool) ? { ...input, [CLIENT_RECORD_SCOPE_KEY]: scope } : input;
}
export function publicClientRecordPreview(preview: Record<string, unknown>) {
  const { [CLIENT_RECORD_SCOPE_KEY]: _scope, ...rest } = preview;
  return rest;
}

/** Canonical owner receipts, preserving partial row results; no inferred atomic profile update. */
export function clientRecordReceipt(tool: string, raw: unknown, input: unknown) {
  const request = clientRecordRequest(tool, input);
  if (request.operation === 'create_client') {
    const result = z
      .object({
        created: z.literal(true),
        client: z.object({ id: uuid, name: text(300), website: z.string().max(500).nullable() }),
        ldaMatch: z
          .object({
            ldaClientId: z.number().int().positive(),
            name: text(300),
            totalFilings: z.number().int().nonnegative(),
            latestFilingYear: z.number().int().nullable(),
          })
          .nullable(),
      })
      .safeParse(raw);
    if (
      !result.success ||
      result.data.client.name !== request.input.name ||
      (request.input.ldaClientId !== undefined &&
        result.data.ldaMatch?.ldaClientId !== request.input.ldaClientId)
    )
      throw new ServiceUnavailableException('Client creation receipt unavailable');
    return { request, outcome: 'created' as const, ...result.data };
  }
  const list = z.array(z.string().max(4000)).max(150);
  const result = z
    .object({
      tool: z.literal('update_client_profile'),
      updated: z.literal(true),
      clientId: uuid,
      clientName: z.string().max(300),
      fieldsWritten: z.array(fieldName).max(profileFieldNames.length),
      facilitiesCreated: list,
      capabilitiesCreated: list,
      peopleCreated: list,
      peopleUpdated: list,
      skipped: list,
      rowErrors: list,
    })
    .safeParse(raw);
  const expected = profileFieldNames.filter((key) => request.input[key] !== undefined);
  if (
    !result.success ||
    result.data.clientId !== request.input.clientId ||
    nativeCanonicalSha256([...result.data.fieldsWritten].sort()) !==
      nativeCanonicalSha256([...expected].sort())
  )
    throw new ServiceUnavailableException('Client profile receipt unavailable');
  const value = result.data,
    changed =
      value.fieldsWritten.length +
        value.facilitiesCreated.length +
        value.capabilitiesCreated.length +
        value.peopleCreated.length +
        value.peopleUpdated.length >
      0;
  return {
    request,
    outcome: value.rowErrors.length
      ? changed
        ? ('partially_updated' as const)
        : ('not_updated' as const)
      : changed
        ? ('updated' as const)
        : ('unchanged' as const),
    ...value,
  };
}
