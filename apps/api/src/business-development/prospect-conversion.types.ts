import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { createHash } from 'node:crypto';

interface ConversionIdentity {
  schemaVersion: 1;
  requestId: string;
  prospectId: string;
  expectedUpdatedAt: string;
}
export type ProspectConversionCommand = ConversionIdentity &
  (
    | { mode: 'existing_client'; clientId: string }
    | {
        mode: 'new_client';
        clientName: string;
        clientWebsite: string | null;
        clientDescription: string | null;
      }
  );
export interface ProspectConversionReceipt {
  schemaVersion: 1;
  requestId: string;
  prospectId: string;
  clientId: string;
  payloadDigest: string;
  outcome: 'linked' | 'created';
  expectedUpdatedAt: string;
  prospectUpdatedAt: string;
  committedAt: string;
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && isUUID(value) && value === value.toLowerCase();
export function parseProspectConversion(
  prospectId: string,
  input: unknown,
): ProspectConversionCommand {
  const value = input as Record<string, unknown>;
  const fields =
    value?.mode === 'new_client'
      ? ['clientName', 'clientWebsite', 'clientDescription']
      : ['clientId'];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'schemaVersion',
          'requestId',
          'prospectId',
          'expectedUpdatedAt',
          'mode',
          ...fields,
        ].includes(key),
    ) ||
    value.schemaVersion !== 1 ||
    !uuid(prospectId) ||
    value.prospectId !== prospectId ||
    !uuid(value.requestId) ||
    !['existing_client', 'new_client'].includes(String(value.mode)) ||
    typeof value.expectedUpdatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expectedUpdatedAt)) ||
    new Date(value.expectedUpdatedAt).toISOString() !== value.expectedUpdatedAt
  )
    throw new BadRequestException('A current prospect and exact conversion review are required');
  const identity = {
    schemaVersion: 1 as const,
    requestId: value.requestId,
    prospectId,
    expectedUpdatedAt: value.expectedUpdatedAt as string,
  };
  if (value.mode === 'existing_client') {
    if (!uuid(value.clientId))
      throw new BadRequestException('An exact existing client is required');
    return { ...identity, mode: 'existing_client', clientId: value.clientId };
  }
  const text = (field: unknown, max: number, nullable: boolean): field is string | null =>
    (nullable && field === null) ||
    (typeof field === 'string' &&
      field.length > 0 &&
      field.length <= max &&
      field === field.trim());
  if (
    !text(value.clientName, 200, false) ||
    !text(value.clientWebsite, 2048, true) ||
    !text(value.clientDescription, 600, true)
  )
    throw new BadRequestException('Review the new client name, website and description');
  if (value.clientWebsite !== null) {
    try {
      const url = new URL(value.clientWebsite as string);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error();
    } catch {
      throw new BadRequestException('Use an HTTP or HTTPS client website');
    }
  }
  return {
    ...identity,
    mode: 'new_client',
    clientName: value.clientName as string,
    clientWebsite: value.clientWebsite as string | null,
    clientDescription: value.clientDescription as string | null,
  };
}
export const prospectConversionDigest = (command: ProspectConversionCommand) =>
  createHash('sha256').update(JSON.stringify(command)).digest('hex');
