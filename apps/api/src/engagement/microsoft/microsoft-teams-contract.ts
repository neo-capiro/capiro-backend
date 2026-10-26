import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const TEAMS_READ_OPERATIONS = ['list_teams_channels', 'get_teams_channel_messages'] as const;
export type TeamsReadOperation = (typeof TEAMS_READ_OPERATIONS)[number];
const selectors = {
  connectionId: z.uuid(),
  teamId: z.uuid(),
  clientId: z.uuid().optional(),
  continuation: z.string().min(1).max(16384).optional(),
};
export const teamsChannelsInput = z.object(selectors).strict();
export const teamsMessagesInput = z
  .object({
    ...selectors,
    channelId: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[^/\\?#\s\u0000-\u001f]+$/),
  })
  .strict();
export type TeamsReadInput = z.infer<typeof teamsChannelsInput> & { channelId?: string };
export const TEAMS_READ_INPUT_SCHEMAS = {
  list_teams_channels: z.toJSONSchema(teamsChannelsInput),
  get_teams_channel_messages: z.toJSONSchema(teamsMessagesInput),
};

export const TEAMS_PERMISSIONS = {
  list_teams_channels: [
    'Channel.ReadBasic.All',
    'ChannelSettings.Read.All',
    'ChannelSettings.ReadWrite.All',
    'Directory.Read.All',
    'Directory.ReadWrite.All',
    'Group.Read.All',
    'Group.ReadWrite.All',
  ],
  get_teams_channel_messages: ['ChannelMessage.Read.All', 'Group.Read.All', 'Group.ReadWrite.All'],
} as const;

export type TeamsUnavailableReason =
  | 'client_scope_unavailable'
  | 'disconnected'
  | 'permission_required'
  | 'reconnect_required'
  | 'configuration_required'
  | 'source_changed'
  | 'provider_unavailable'
  | 'invalid_provider_response';
export class TeamsReadUnavailable extends Error {
  constructor(readonly reason: TeamsUnavailableReason) {
    super(reason);
  }
}

export function parseTeamsInput(operation: TeamsReadOperation, raw: unknown): TeamsReadInput {
  const schema =
    operation === 'list_teams_channels'
      ? teamsChannelsInput
      : operation === 'get_teams_channel_messages'
        ? teamsMessagesInput
        : null;
  const parsed = schema?.safeParse(raw);
  if (!parsed?.success) throw new BadRequestException('Invalid Teams read selectors');
  return parsed.data;
}

export function teamsResource(operation: TeamsReadOperation, input: TeamsReadInput): string {
  return (
    `/teams/${input.teamId}/channels` +
    (operation === 'get_teams_channel_messages'
      ? `/${encodeURIComponent(input.channelId!)}/messages`
      : '')
  );
}

/** A continuation is data, never authority or an arbitrary fetch URL. */
export function teamsPageUrl(
  operation: TeamsReadOperation,
  input: TeamsReadInput,
  next = input.continuation,
): string {
  const path = '/v1.0' + teamsResource(operation, input);
  if (!next)
    return (
      'https://graph.microsoft.com' +
      path +
      (operation === 'get_teams_channel_messages'
        ? '?$top=50'
        : '?$select=id,displayName,description,membershipType')
    );
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    throw new BadRequestException('Invalid Teams continuation');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    throw new BadRequestException('Invalid Teams continuation');
  }
  if (
    url.origin !== 'https://graph.microsoft.com' ||
    url.username ||
    url.password ||
    url.hash ||
    decoded !== decodeURIComponent(path) ||
    !url.searchParams.has('$skiptoken') ||
    [...url.searchParams.keys()].some((key) => !['$skiptoken', '$top', '$select'].includes(key)) ||
    [...new Set(url.searchParams.keys())].some(
      (key) => url.searchParams.getAll(key).length !== 1,
    ) ||
    (url.searchParams.has('$top') &&
      (operation !== 'get_teams_channel_messages' || url.searchParams.get('$top') !== '50')) ||
    (url.searchParams.has('$select') &&
      (operation !== 'list_teams_channels' ||
        url.searchParams.get('$select') !== 'id,displayName,description,membershipType'))
  )
    throw new BadRequestException('Teams continuation must name the same resource');
  return url.href;
}

const nullableText = z
  .string()
  .nullable()
  .optional()
  .transform((v) => v ?? null);
const instant = z.iso
  .datetime({ offset: true })
  .nullable()
  .optional()
  .transform((v) => v ?? null);
const channel = z.object({
  id: z.string().min(1),
  displayName: z.string(),
  description: nullableText,
  membershipType: z.enum(['standard', 'private', 'shared']),
});
const message = z.object({
  id: z.string().min(1),
  replyToId: z.null().optional(),
  subject: nullableText,
  createdDateTime: instant,
  lastModifiedDateTime: instant,
  deletedDateTime: instant,
  etag: nullableText,
  body: z.object({ contentType: z.enum(['text', 'html']), content: z.string() }).nullable(),
  from: z
    .object({
      user: z.object({ id: nullableText, displayName: nullableText }).nullable().optional(),
      application: z.object({ id: nullableText, displayName: nullableText }).nullable().optional(),
    })
    .nullable()
    .optional(),
});
const page = z.object({
  value: z.array(z.unknown()),
  '@odata.nextLink': z.string().min(1).max(16384).optional(),
});

export function projectTeamsPage(
  operation: TeamsReadOperation,
  input: TeamsReadInput,
  raw: unknown,
) {
  const parsed = page.safeParse(raw);
  if (!parsed.success) throw new TeamsReadUnavailable('invalid_provider_response');
  let nextContinuation: string | null = null;
  if (parsed.data['@odata.nextLink']) {
    try {
      nextContinuation = teamsPageUrl(operation, input, parsed.data['@odata.nextLink']);
    } catch {
      throw new TeamsReadUnavailable('invalid_provider_response');
    }
  }
  const items: Array<{
    id: string;
    data: z.infer<typeof channel> | z.infer<typeof message>;
    source: { resource: string; revision: string | null; contentSha256: string };
  }> = [];
  for (const rawItem of parsed.data.value) {
    const item = (operation === 'list_teams_channels' ? channel : message).safeParse(rawItem);
    if (!item.success || items.some((existing) => existing.id === item.data.id)) continue;
    const data = item.data;
    items.push({
      id: data.id,
      data,
      source: {
        resource: teamsResource(operation, input) + '/' + encodeURIComponent(data.id),
        revision: 'etag' in data ? data.etag : null,
        contentSha256: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
      },
    });
  }
  const omittedItems = parsed.data.value.length - items.length;
  return {
    kind: 'page' as const,
    operation,
    connectionId: input.connectionId,
    teamId: input.teamId,
    channelId: input.channelId ?? null,
    observedAt: new Date().toISOString(),
    coverage:
      operation === 'list_teams_channels' ? ('channels' as const) : ('root_messages_only' as const),
    attachmentsIncluded: false as const,
    repliesIncluded: false as const,
    items,
    nextContinuation,
    incomplete: omittedItems > 0,
    omittedItems,
  };
}
export type TeamsReadResult =
  | ReturnType<typeof projectTeamsPage>
  | {
      kind: 'unavailable';
      operation: TeamsReadOperation;
      reason: TeamsUnavailableReason;
      requiredPermission: string;
    };
