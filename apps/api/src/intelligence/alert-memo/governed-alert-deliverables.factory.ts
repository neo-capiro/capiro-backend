import type { TenantContext } from '@capiro/shared';
import { ContextCompilerService } from '../../context/context-compiler.service.js';
import { rethrowRequiredContextPersistence } from '../../context/context-required-persistence.js';
import { AlertMemoService } from './alert-memo.service.js';
import { DistrictBriefService } from './district-brief.service.js';

export const RAW_ALERT_MEMO_SERVICE = Symbol('RAW_ALERT_MEMO_SERVICE');
export const RAW_DISTRICT_BRIEF_SERVICE = Symbol('RAW_DISTRICT_BRIEF_SERVICE');

const LABEL_BY_TYPE: Record<string, string> = {
  'client-soul': 'client-soul',
  'client-compass': 'client-compass',
  'client-people': 'client-people',
  playbook: 'firm-playbook',
};

interface AlertMemoInternals {
  loadSteering: (
    ctx: TenantContext,
    clientId: string,
    clientName: string,
  ) => Promise<{
    steering: string;
    memoryFilesUsed: string[];
    contextExcluded: Array<{ title: string; reason: string }>;
  }>;
}

interface DistrictBriefInternals {
  loadSteering: (
    ctx: TenantContext,
    clientId: string,
    clientName: string,
  ) => Promise<{ steering: string; memoryFilesUsed: string[] }>;
}

/**
 * Replace only the memo's private steering loader. Required provenance failures
 * escape before the model call and Documents auto-file; ordinary context outages
 * retain the established neutral fallback.
 */
export function createGovernedAlertMemoService(
  service: AlertMemoService,
  contextCompiler: ContextCompilerService,
): AlertMemoService {
  const internal = service as unknown as AlertMemoInternals;
  internal.loadSteering = async (ctx, clientId, clientName) => {
    const blocks: string[] = [];
    const memoryFilesUsed: string[] = [];
    const contextExcluded: Array<{ title: string; reason: string }> = [];
    try {
      const packet = await contextCompiler.compile({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        clientId,
        surface: 'memo',
        layers: ['client-steering', 'client-people', 'firm-playbook'],
        render: 'all',
        charBudget: 8000,
        ref: { clientId },
      });
      for (const type of ['client-soul', 'client-compass', 'client-people', 'playbook']) {
        const item = packet.rendered.find((candidate) => candidate.type === type);
        if (!item) continue;
        blocks.push(`## ${item.title ?? type}\n${item.body}`);
        memoryFilesUsed.push(LABEL_BY_TYPE[type] ?? type);
      }
      for (const exclusion of packet.exclusions ?? []) {
        contextExcluded.push({
          title: exclusion.type
            ? LABEL_BY_TYPE[exclusion.type] ?? exclusion.slug ?? exclusion.type
            : 'Restricted item',
          reason: exclusion.reason,
        });
      }
    } catch (error) {
      rethrowRequiredContextPersistence(error);
    }

    const steering = blocks.length
      ? blocks.join('\n\n')
      : `(No client knowledge files on record for ${clientName}. Write a professional, neutral government-affairs memo.)`;
    return { steering: steering.slice(0, 8000), memoryFilesUsed, contextExcluded };
  };
  return service;
}

/** District-brief twin of createGovernedAlertMemoService. */
export function createGovernedDistrictBriefService(
  service: DistrictBriefService,
  contextCompiler: ContextCompilerService,
): DistrictBriefService {
  const internal = service as unknown as DistrictBriefInternals;
  internal.loadSteering = async (ctx, clientId, clientName) => {
    const blocks: string[] = [];
    const memoryFilesUsed: string[] = [];
    try {
      const packet = await contextCompiler.compile({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        clientId,
        surface: 'district-brief',
        layers: ['client-steering', 'client-people', 'firm-playbook'],
        render: 'all',
        charBudget: 8000,
        ref: { clientId },
      });
      for (const type of ['client-soul', 'client-compass', 'client-people', 'playbook']) {
        const item = packet.rendered.find((candidate) => candidate.type === type);
        if (!item) continue;
        blocks.push(`## ${item.title ?? type}\n${item.body}`);
        memoryFilesUsed.push(LABEL_BY_TYPE[type] ?? type);
      }
    } catch (error) {
      rethrowRequiredContextPersistence(error);
    }

    const steering = blocks.length
      ? blocks.join('\n\n')
      : `(No client knowledge files on record for ${clientName}. Write a professional, neutral government-affairs brief.)`;
    return { steering: steering.slice(0, 8000), memoryFilesUsed };
  };
  return service;
}
