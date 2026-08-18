import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';

export interface DefenseTenantContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: string;
}

/**
 * Display-only Decimal -> number coercion for JSON responses. Never used on
 * a governed money WRITE path (proposeManualOverrideV1/manual-override-v1
 * require exact decimal strings and are untouched by this helper).
 */
export function num(value: Prisma.Decimal | number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'object' && 'toNumber' in value ? value.toNumber() : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function requirePeCode(raw: string): string {
  const peCode = (raw ?? '').trim().toUpperCase();
  if (!peCode) throw new BadRequestException('peCode is required');
  if (peCode.length > 16) throw new BadRequestException('peCode is too long');
  return peCode;
}

export function normalizePage(raw?: number): number {
  const n = Number(raw ?? 1);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

export function normalizeLimit(raw?: number, max = 100): number {
  const n = Number(raw ?? 25);
  if (!Number.isFinite(n) || n < 1) return 25;
  return Math.min(Math.floor(n), max);
}

export function assertFound<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new NotFoundException(message);
  return value;
}
