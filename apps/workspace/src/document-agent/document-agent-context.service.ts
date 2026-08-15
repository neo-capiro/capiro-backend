// Document Agent Context Service — handles context recommendation, analysis,
// conflict detection, and coverage scoring. Delegates to the reasoning gateway
// for model-backed analysis, but performs deterministic conflict detection
// locally (no model needed for numeric/date/status conflicts).

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { WorkspaceReasoningGateway } from '../workspace-reasoning/workspace-reasoning.gateway.js';
import { computeContextSnapshotHash, type ContextConflict } from './document-agent-state.js';

/**
 * Context classification helpers — deterministic, no model needed.
 */
export type ContextAuthority = 'primary' | 'firm' | 'client' | 'secondary' | 'unknown';
export type ContextFreshness = 'current' | 'aging' | 'stale' | 'unknown';
export type ContextVerification = 'verified' | 'not_verified' | 'unavailable';

export interface ClassifiedContextItem {
  id: string;
  authority: ContextAuthority;
  freshness: ContextFreshness;
  verification: ContextVerification;
  publishedAt?: string;
  verifiedAt?: string;
}

@Injectable()
export class DocumentAgentContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reasoning: WorkspaceReasoningGateway,
  ) {}

  /**
   * Classify a context item's authority, freshness, and verification.
   * Deterministic — based on the payload fields, not a model call.
   */
  classify(payload: Record<string, unknown>): ClassifiedContextItem {
    const sourceType = (payload.sourceType as string) ?? 'unknown';
    const publishedAt = (payload.publishedAt as string) ?? undefined;
    const verifiedAt = (payload.verifiedAt as string) ?? undefined;
    const verification = ((payload.verification as string) ?? 'unavailable') as ContextVerification;

    // Authority: primary sources are government/official; firm is internal;
    // client is client-provided; secondary is news/analysis; unknown otherwise.
    let authority: ContextAuthority = 'unknown';
    if (sourceType === 'government' || sourceType === 'congressional' || sourceType === 'federal') {
      authority = 'primary';
    } else if (sourceType === 'firm' || sourceType === 'internal') {
      authority = 'firm';
    } else if (sourceType === 'client') {
      authority = 'client';
    } else if (sourceType === 'news' || sourceType === 'analysis' || sourceType === 'secondary') {
      authority = 'secondary';
    }

    // Freshness: current if <90 days old, aging if <365, stale if >365, unknown if no date.
    let freshness: ContextFreshness = 'unknown';
    if (publishedAt) {
      const ageDays = (Date.now() - new Date(publishedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays < 90) freshness = 'current';
      else if (ageDays < 365) freshness = 'aging';
      else freshness = 'stale';
    }

    return {
      id: (payload.id as string) ?? '',
      authority,
      freshness,
      verification,
      publishedAt,
      verifiedAt,
    };
  }

  /**
   * Detect conflicts between context items. Deterministic — checks for
   * numeric, date, and status conflicts based on the payload fields.
   * Semantic conflicts are left to the model (via the reasoning gateway).
   */
  detectConflicts(
    items: Array<{ id: string; payload: Record<string, unknown> }>,
  ): ContextConflict[] {
    const conflicts: ContextConflict[] = [];

    // Numeric conflicts: items with the same label but different numeric values.
    const numericGroups = new Map<string, Array<{ id: string; value: number }>>();
    for (const item of items) {
      const label = (item.payload.label as string) ?? '';
      const numericValue = (item.payload.numericValue as number) ?? undefined;
      if (label && numericValue !== undefined) {
        const key = label.toLowerCase();
        if (!numericGroups.has(key)) numericGroups.set(key, []);
        numericGroups.get(key)!.push({ id: item.id, value: numericValue });
      }
    }
    for (const [label, group] of numericGroups) {
      const values = new Set(group.map((g) => g.value));
      if (values.size > 1) {
        conflicts.push({
          id: `numeric:${label}`,
          itemIds: group.map((g) => g.id),
          type: 'numeric',
          description: `Items disagree on "${label}": ${group.map((g) => g.value).join(', ')}`,
          recommendedResolution: 'Verify the authoritative source and update the conflicting items.',
          resolved: false,
        });
      }
    }

    // Date conflicts: items with the same event but different dates.
    const dateGroups = new Map<string, Array<{ id: string; date: string }>>();
    for (const item of items) {
      const event = (item.payload.event as string) ?? '';
      const date = (item.payload.date as string) ?? undefined;
      if (event && date) {
        const key = event.toLowerCase();
        if (!dateGroups.has(key)) dateGroups.set(key, []);
        dateGroups.get(key)!.push({ id: item.id, date });
      }
    }
    for (const [event, group] of dateGroups) {
      const dates = new Set(group.map((g) => g.date));
      if (dates.size > 1) {
        conflicts.push({
          id: `date:${event}`,
          itemIds: group.map((g) => g.id),
          type: 'date',
          description: `Items disagree on the date for "${event}": ${group.map((g) => g.date).join(', ')}`,
          recommendedResolution: 'Confirm the correct date from the primary source.',
          resolved: false,
        });
      }
    }

    // Status conflicts: items with the same subject but different statuses.
    const statusGroups = new Map<string, Array<{ id: string; status: string }>>();
    for (const item of items) {
      const subject = (item.payload.subject as string) ?? '';
      const status = (item.payload.status as string) ?? undefined;
      if (subject && status) {
        const key = subject.toLowerCase();
        if (!statusGroups.has(key)) statusGroups.set(key, []);
        statusGroups.get(key)!.push({ id: item.id, status });
      }
    }
    for (const [subject, group] of statusGroups) {
      const statuses = new Set(group.map((g) => g.status));
      if (statuses.size > 1) {
        conflicts.push({
          id: `status:${subject}`,
          itemIds: group.map((g) => g.id),
          type: 'status',
          description: `Items disagree on the status of "${subject}": ${group.map((g) => g.status).join(', ')}`,
          recommendedResolution: 'Determine the current authoritative status.',
          resolved: false,
        });
      }
    }

    return conflicts;
  }

  /**
   * Compute the context snapshot hash for staleness detection.
   */
  computeSnapshotHash(items: Array<{ id: string; label: string; text?: string }>): string {
    return computeContextSnapshotHash(items);
  }
}
