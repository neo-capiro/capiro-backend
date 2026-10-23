import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { createHash } from 'node:crypto';

/** New-client conversion awaits the canonical capacity owner; this protocol links a reviewed client. */
export interface ProspectConversionCommand {
  schemaVersion: 1;
  requestId: string;
  prospectId: string;
  expectedUpdatedAt: string;
  mode: 'existing_client';
  clientId: string;
}
export interface ProspectConversionReceipt {
  schemaVersion: 1;
  requestId: string;
  prospectId: string;
  clientId: string;
  payloadDigest: string;
  outcome: 'linked';
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
  const value = input as Partial<ProspectConversionCommand>;
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
          'clientId',
        ].includes(key),
    ) ||
    value.schemaVersion !== 1 ||
    !uuid(prospectId) ||
    value.prospectId !== prospectId ||
    !uuid(value.requestId) ||
    !uuid(value.clientId) ||
    value.mode !== 'existing_client' ||
    typeof value.expectedUpdatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expectedUpdatedAt)) ||
    new Date(value.expectedUpdatedAt).toISOString() !== value.expectedUpdatedAt
  )
    throw new BadRequestException(
      'A current prospect and exact existing client review are required',
    );
  return {
    schemaVersion: 1,
    requestId: value.requestId,
    prospectId,
    expectedUpdatedAt: value.expectedUpdatedAt,
    mode: 'existing_client',
    clientId: value.clientId,
  };
}
export const prospectConversionDigest = (command: ProspectConversionCommand) =>
  createHash('sha256').update(JSON.stringify(command)).digest('hex');
