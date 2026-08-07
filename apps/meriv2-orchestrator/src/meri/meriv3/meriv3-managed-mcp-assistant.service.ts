import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MeriContext } from '@capiro/meriv2-core';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ApiActionProposalRepo } from '../api-action-proposal.repo.js';
import { MeriRegistryService } from '../meri-registry.service.js';
import { toolLabel, type ChatArtifact, type ChatStep } from '../chat/chat-prompt.js';
import { OpenAiResponsesClient } from './openai-responses.client.js';
import { ApiManagedMcpRepo } from './api-managed-mcp.repo.js';
import { MeriV3AssistantService } from './meriv3-assistant.service.js';
import type {
  MeriV3ChatInput,
  MeriV3ChatResult,
  MeriV3ChatStreamEvent,
} from './meriv3.types.js';

interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface InvokeArgs {
  ctx: MeriContext;
  name: string;
  input: Record<string, unknown>;
  conversationId?: string;
  steps: ChatStep[];
  pendingApprovals: NonNullable<MeriV3ChatResult['pendingApprovals']>;
  artifacts: ChatArtifact[];
  emit: (event: MeriV3ChatStreamEvent) => void;
  prePersistRefusal: (name: string, input: Record<string, unknown>) => string | null;
  noteComplianceOutcome: (outcome: 'PASS' | 'WARN' | 'BLOCK') => void;
  scopeViolation?: string;
}

interface AssistantInternals {
  fetchToolSchemas: () => Promise<ToolSchema[]>;
  invokeTool: (args: InvokeArgs) => Promise<unknown>;
  augmentToolInput: (
    dto: MeriV3ChatInput,
    input: Record<string, unknown>,
    schema: ToolSchema | undefined,
  ) => { input: Record<string, unknown>; scopeViolation?: string };
}

const MANAGED_PREFIXES = ['mcp__meriv3_hubspot__', 'mcp__meriv3_airtable__'] as const;

function isManagedTool(name: string): boolean {
  return MANAGED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function managedLabel(name: string): string {
  const parts = name.split('__');
  const server = (parts[1] ?? '').toLowerCase();
  const app =
    server === 'meriv3_hubspot'
      ? 'HubSpot'
      : server === 'meriv3_airtable'
        ? 'Airtable'
        : 'Connected app';
  const tool = parts.slice(2).join(' ').replace(/_/g, ' ');
  const toolTitle = tool.replace(/\b\w/g, (char) => char.toUpperCase());
  return `${app}: ${toolTitle}`.trim();
}

/**
 * MeriV3-only extension of the proven chat loop. The base assistant remains
 * unchanged for rollback and for every other Meri surface. At runtime this
 * subclass adds the authenticated user's connected managed-app READ schemas and
 * delegates only those dedicated namespaced calls back to apps/api.
 *
 * The base class currently keeps these seams private. They are ordinary
 * prototype methods at runtime, so this adapter decorates them on this V3-only
 * instance instead of widening the base service's public API or duplicating its
 * ~900-line assurance/action loop. Tests pin these three decorated boundaries.
 */
@Injectable()
export class MeriV3ManagedMcpAssistantService extends MeriV3AssistantService {
  constructor(
    registryService: MeriRegistryService,
    openai: OpenAiResponsesClient,
    actionProposals: ApiActionProposalRepo,
    prisma: PrismaService,
    config: ConfigService,
    managedMcp: ApiManagedMcpRepo,
  ) {
    super(registryService, openai, actionProposals, prisma, config);

    const internals = this as unknown as AssistantInternals;
    const nativeFetch = internals.fetchToolSchemas.bind(this);
    const nativeInvoke = internals.invokeTool.bind(this);
    const nativeAugment = internals.augmentToolInput.bind(this);

    internals.fetchToolSchemas = async (): Promise<ToolSchema[]> => {
      const [native, managed] = await Promise.all([nativeFetch(), managedMcp.schemas()]);
      const seen = new Set(native.map((schema) => schema.name));
      const extra = managed
        .filter((schema) => isManagedTool(schema.name) && !seen.has(schema.name))
        .map(({ name, description, input_schema, appName }) => ({
          name,
          input_schema,
          description: [
            `[Connected app: ${appName}; optional external evidence source.]`,
            'Use this tool only when its data is materially relevant to the user request; never call it merely because the app is connected.',
            'In a client-scoped conversation, use external records only when they clearly concern the active client; ignore unrelated records and ask for clarification when identity is ambiguous.',
            description,
          ].join(' '),
        }));
      return [...native, ...extra];
    };

    internals.augmentToolInput = (
      dto: MeriV3ChatInput,
      input: Record<string, unknown>,
      schema: ToolSchema | undefined,
    ) => {
      // An MCP provider's `clientId` is its own parameter namespace, not a
      // Capiro client UUID. Never rewrite managed vendor arguments with the
      // conversation client. Other/future MCP namespaces remain owned by the
      // base runtime rather than being captured by this feature.
      if (schema && isManagedTool(schema.name)) return { input: { ...input } };
      return nativeAugment(dto, input, schema);
    };

    internals.invokeTool = async (args: InvokeArgs): Promise<unknown> => {
      if (!isManagedTool(args.name)) return nativeInvoke(args);
      const label = managedLabel(args.name) || toolLabel(args.name);
      // Keep managed server ids invisible in the work log: use the human label
      // as the event tool identity so the raw `mcp__meriv3_hubspot__` namespace
      // never reaches the browser/SSE stream.
      args.emit({ type: 'tool_call', tool: label, label });
      try {
        const result = await managedMcp.executeRead(args.name, args.input);
        args.steps.push({ tool: args.name, label, status: 'done' });
        args.emit({ type: 'tool_done', tool: label, label, status: 'done' });
        return result;
      } catch (error) {
        const detail =
          error instanceof Error ? error.message.slice(0, 180) : 'Connected app failed';
        args.steps.push({ tool: args.name, label, status: 'error', detail });
        args.emit({ type: 'tool_done', tool: label, label, status: 'error', detail });
        return { error: detail, connectedApp: true };
      }
    };
  }
}
