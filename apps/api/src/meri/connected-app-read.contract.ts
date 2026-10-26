import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { getCatalogEntry } from './meri-mcp.catalog.js';
import { managedAppDefinition, isManagedReadOnlyTool } from './meri-managed-mcp.helpers.js';

export const CONNECTED_APP_READ_OPERATIONS = [
  'list_connected_app_reads',
  'read_connected_app',
] as const;
export type ConnectedAppReadOperation = (typeof CONNECTED_APP_READ_OPERATIONS)[number];
export interface ConnectedAppReadSelection {
  connectionId: string;
  provider: string;
  tool: string;
  schemaHash: string;
  inputSchema: Record<string, unknown>;
}
export interface ConnectedAppReadRequest {
  clientId: string | null;
  connectionId?: string;
  provider?: string;
  tool?: string;
  schemaHash?: string;
  arguments?: Record<string, unknown>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = () => new BadRequestException('Invalid connected-app read');
const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: true });
addFormats(ajv);
const ajv2020 = new Ajv2020({ strict: false, allErrors: false, validateFormats: true });
addFormats(ajv2020);
const schemaValidator = (schema: Record<string, unknown>) =>
  schema.$schema === 'https://json-schema.org/draft/2020-12/schema' ? ajv2020 : ajv;

/** Inert JSON only. No credential/endpoint override or remote schema resolution. */
export function connectedReadJson(value: unknown, maxBytes = 32_768, schema = false): unknown {
  let count = 0;
  const visit = (v: unknown, depth: number): unknown => {
    if (++count > 10_000 || depth > 24) throw fail();
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      return v;
    if (typeof v === 'string') {
      if (!schema && /(?:https?|file|data):\/\//i.test(v)) throw fail();
      return v;
    }
    if (Array.isArray(v)) return v.map((item) => visit(item, depth + 1));
    if (!v || typeof v !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(v)))
      throw fail();
    const out: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (!('value' in descriptor) || ['__proto__', 'constructor', 'prototype'].includes(key))
        throw fail();
      if (
        schema &&
        key === '$ref' &&
        (typeof descriptor.value !== 'string' || !descriptor.value.startsWith('#'))
      )
        throw fail();
      if (
        !schema &&
        /^(?:endpoint|base_?url|server_?url|auth(?:orization)?|headers?|access_?token|api_?key|credentials?)$/i.test(
          key,
        )
      )
        throw fail();
      out[key] = visit(descriptor.value, depth + 1);
    }
    return out;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw fail();
  return result;
}

export function parseConnectedAppRead(operation: string, raw: unknown): ConnectedAppReadRequest {
  if (!CONNECTED_APP_READ_OPERATIONS.includes(operation as ConnectedAppReadOperation)) throw fail();
  const value = connectedReadJson(raw) as Record<string, unknown>;
  if (!value || Array.isArray(value) || typeof value !== 'object') throw fail();
  const keys =
    operation === 'list_connected_app_reads'
      ? ['clientId']
      : ['clientId', 'connectionId', 'provider', 'tool', 'schemaHash', 'arguments'];
  if (Object.keys(value).sort().join() !== [...keys].sort().join()) throw fail();
  if (value.clientId !== null && (typeof value.clientId !== 'string' || !UUID.test(value.clientId)))
    throw fail();
  if (
    operation === 'read_connected_app' &&
    (typeof value.connectionId !== 'string' ||
      !UUID.test(value.connectionId) ||
      typeof value.provider !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(value.provider) ||
      typeof value.tool !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value.tool) ||
      typeof value.schemaHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.schemaHash) ||
      !value.arguments ||
      typeof value.arguments !== 'object' ||
      Array.isArray(value.arguments))
  )
    throw fail();
  return value as unknown as ConnectedAppReadRequest;
}

/** Existing catalog/managed definitions own approval; connection rows cannot add tools. */
export function approvedConnectedRead(catalogId: string | null, tool: string): string | null {
  const managed = managedAppDefinition(catalogId);
  if (managed)
    return ['hubspot', 'airtable', 'google-drive'].includes(managed.id) &&
      isManagedReadOnlyTool(managed.id, tool)
      ? managed.id
      : null;
  const catalog = catalogId ? getCatalogEntry(catalogId) : undefined;
  return catalog?.verified &&
    catalog.transport === 'http' &&
    catalog.endpoint &&
    !catalog.requiresEndpointInput &&
    catalog.suggestedTools.some((item) => item.name === tool && item.readOnly === true)
    ? catalog.id
    : null;
}

export function connectedInputSchema(raw: unknown): {
  inputSchema: Record<string, unknown>;
  schemaHash: string;
} {
  const inputSchema = connectedReadJson(raw, 16_384, true) as Record<string, unknown>;
  if (!inputSchema || inputSchema.type !== 'object') throw fail();
  // Compilation does not fetch $refs. A provider's unsupported schema is unavailable, not widened.
  try {
    schemaValidator(inputSchema).compile(inputSchema);
  } catch {
    throw fail();
  }
  return {
    inputSchema,
    schemaHash: createHash('sha256').update(JSON.stringify(inputSchema)).digest('hex'),
  };
}

export function assertConnectedArguments(
  selection: ConnectedAppReadSelection,
  input: Record<string, unknown>,
) {
  if (!schemaValidator(selection.inputSchema).compile(selection.inputSchema)(input)) throw fail();
}
