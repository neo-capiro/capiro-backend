/**
 * Authenticated transport bridge for the first Workspace vNext client.
 *
 * The original vNext client was written around raw `fetch` and an optimistic
 * set of response shapes. Replacing every call site in one release would be
 * risky, so this bridge is deliberately narrow:
 *   - only same-origin `/workspace-api/*` requests are intercepted;
 *   - requests go through the canonical `useApi()` Axios instance, gaining
 *     Clerk bearer auth, impersonation headers and shared 401 handling;
 *   - legacy backend rows are normalized once before the existing view code
 *     sees them;
 *   - non-Workspace fetches are untouched.
 *
 * It is installed only while an authenticated vNext Workspace route is mounted.
 */
import type { AxiosInstance } from 'axios';

type JsonObject = Record<string, unknown>;

let currentClient: AxiosInstance | null = null;
let originalFetch: typeof window.fetch | null = null;
let installedFetch: typeof window.fetch | null = null;
let installCount = 0;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function maybeText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

function maybeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function flag(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function bodyToHtml(value: unknown): string {
  if (typeof value === 'string') return value;
  const body = object(value);
  if (typeof body.html === 'string') return body.html;
  return list(body.blocks)
    .map((raw) => {
      const block = object(raw);
      return text(block.content);
    })
    .filter(Boolean)
    .join('\n');
}

function htmlBody(value: string): JsonObject {
  return {
    blocks: [{ id: 'main', type: 'section', content: value }],
  };
}

function normalizeDocument(value: unknown): JsonObject {
  const row = object(value);
  return {
    ...row,
    id: text(row.id),
    title: text(row.name, text(row.title, 'Untitled document')),
    body: bodyToHtml(row.body),
    order: maybeNumber(row.ordinal) ?? maybeNumber(row.order),
  };
}

function normalizeDraft(value: unknown): JsonObject {
  const row = object(value);
  const config = object(row.config);
  const agent = object(config.documentAgent);
  const quality = object(agent.quality);
  return {
    ...row,
    id: text(row.id),
    docTitle: text(row.docTitle, 'Untitled document'),
    documentType: maybeText(row.product),
    sector: maybeText(row.industry),
    clientName: maybeText(row.client),
    phase: maybeText(agent.phase),
    // WsDraft.status is a legacy visual label, not the Agent status.
    status: maybeText(agent.status),
    qualityScore:
      typeof quality.score === 'number' ? quality.score : null,
    config,
    documents: list(row.documents).map(normalizeDocument),
  };
}

function normalizeQuestion(value: unknown): JsonObject {
  const row = object(value);
  return {
    id: text(row.id),
    label: text(row.label, text(row.text)),
    required: flag(row.required),
  };
}

function normalizeMessage(value: unknown): JsonObject {
  const row = object(value);
  const data = object(row.data);
  const proposal = object(data.proposal);
  return {
    ...row,
    role: row.role === 'user' ? 'user' : 'agent',
    questions: list(data.questions).map(normalizeQuestion),
    proposalId:
      maybeText(row.proposalId) ?? maybeText(proposal.proposalId),
    allowedActions: list(data.allowedActions).filter(
      (item): item is string => typeof item === 'string',
    ),
    status:
      data.status === 'applied' ||
      data.status === 'needs_resolution' ||
      data.status === 'sent'
        ? data.status
        : undefined,
  };
}

function normalizeContext(value: unknown): JsonObject {
  const row = object(value);
  const payload = object(row.payload);
  return {
    ...row,
    id: text(row.id),
    label: text(payload.label, 'Untitled source'),
    sourceType: maybeText(payload.sourceType) ?? maybeText(row.kind),
    authority: maybeText(payload.authority),
    freshness: maybeText(payload.freshness),
    verification: maybeText(payload.verification),
    url: maybeText(payload.url),
    included:
      typeof payload.included === 'boolean' ? payload.included : true,
    exclusionReason: maybeText(payload.exclusionReason),
    payload,
  };
}

function normalizeLock(value: unknown): JsonObject {
  const row = object(value);
  return {
    ...row,
    heldBy: flag(row.held)
      ? flag(row.heldByMe)
        ? 'me'
        : maybeText(row.holderId) ?? 'other'
      : null,
    heldByName: flag(row.heldByMe)
      ? 'You'
      : maybeText(row.holderName),
    acquiredAt:
      typeof row.acquiredAt === 'string' ? row.acquiredAt : null,
    staleAfterMs: flag(row.holderInactive) ? 0 : undefined,
  };
}

function normalizeComment(value: unknown): JsonObject {
  const row = object(value);
  const authorId = text(row.authorId);
  return {
    ...row,
    authorName:
      maybeText(row.authorName) ??
      maybeText(row.name) ??
      (authorId.startsWith('guest:') ? 'Guest reviewer' : 'Team member'),
    text: text(row.body, text(row.text)),
    isGuest: authorId.startsWith('guest:'),
    replies: list(row.replies).map(normalizeComment),
  };
}

function normalizeCollaborator(value: unknown): JsonObject {
  const row = object(value);
  const status = text(row.status);
  return {
    ...row,
    userId: text(row.subjectId, text(row.userId)),
    name: text(row.name, text(row.email, 'Pending invite')),
    email: text(row.email),
    status:
      status === 'pending'
        ? 'pending'
        : status === 'declined'
          ? 'declined'
          : 'accepted',
  };
}

function normalizeVersion(value: unknown, index: number): JsonObject {
  const row = object(value);
  return {
    ...row,
    version: maybeNumber(row.version) ?? index + 1,
    createdBy: maybeText(row.authorId),
    config: object(object(row.snapshot).config),
  };
}

function normalizeQuality(value: unknown): JsonObject {
  const row = object(value);
  return {
    ...row,
    score: typeof row.score === 'number' ? row.score : null,
    checks: list(row.checks).map((raw) => {
      const check = object(raw);
      const status = text(check.status);
      return {
        ...check,
        status:
          status === 'critical'
            ? 'error'
            : status === 'notable'
              ? 'warning'
              : status === 'success'
                ? 'success'
                : 'info',
        severity:
          check.severity === 'critical'
            ? 'high'
            : check.severity,
      };
    }),
  };
}

function normalizeBlueprintVersion(value: unknown): JsonObject {
  const row = object(value);
  return {
    ...row,
    versionId: text(row.id, text(row.versionId)),
    updatedAt:
      text(row.publishedAt) ||
      text(row.createdAt) ||
      text(row.updatedAt),
  };
}

function normalizeBlueprint(value: unknown): JsonObject {
  const row = object(value);
  return {
    ...row,
    blueprintId: text(row.id, text(row.blueprintId)),
    scope:
      row.scope === 'capiro' || row.scope === 'capiro_global'
        ? 'capiro_global'
        : 'firm',
    documentType: maybeText(row.product) ?? maybeText(row.documentType),
    versions: list(row.versions).map(normalizeBlueprintVersion),
  };
}

function normalizePublicError(data: unknown, status: number): JsonObject {
  const body = object(data);
  const message = text(body.message, text(body.error));
  return {
    ...body,
    statusCode:
      typeof body.statusCode === 'number' ? body.statusCode : status,
    code:
      maybeText(body.code) ??
      (/^[A-Z][A-Z0-9_]+$/.test(message)
        ? message
        : String(status)),
  };
}

function parseJsonBody(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string' || !init.body) return undefined;
  try {
    return JSON.parse(init.body) as unknown;
  } catch {
    return init.body;
  }
}

function transformRequest(
  pathname: string,
  method: string,
  body: unknown,
): unknown {
  const data = object(body);

  if (method === 'POST' && /^\/workspace-api\/drafts$/.test(pathname)) {
    return {
      ...data,
      docTitle: text(data.docTitle, 'Untitled document'),
      industry: data.industry ?? data.sector ?? null,
      product: data.product ?? data.documentType ?? null,
      client: data.client ?? data.clientName ?? null,
    };
  }

  if (
    method === 'POST' &&
    /^\/workspace-api\/drafts\/[^/]+\/documents$/.test(pathname)
  ) {
    return {
      ...data,
      name: data.name ?? data.title ?? 'Untitled document',
      title: undefined,
    };
  }

  if (
    method === 'PATCH' &&
    /^\/workspace-api\/drafts\/[^/]+\/documents\/[^/]+$/.test(pathname)
  ) {
    return {
      ...data,
      name: data.name ?? data.title,
      title: undefined,
      body:
        typeof data.body === 'string' ? htmlBody(data.body) : data.body,
    };
  }

  if (
    (method === 'POST' || method === 'PATCH') &&
    /^\/workspace-api\/documents\/[^/]+\/comments(?:\/[^/]+)?$/.test(
      pathname,
    )
  ) {
    return {
      ...data,
      body: data.body ?? data.text ?? '',
      text: undefined,
    };
  }

  return body;
}

function normalizeResponse(
  pathname: string,
  method: string,
  value: unknown,
): unknown {
  if (method === 'GET' && pathname === '/workspace-api/drafts') {
    const rows = Array.isArray(value)
      ? value
      : list(object(value).drafts);
    return { drafts: rows.map(normalizeDraft) };
  }

  if (
    method === 'GET' &&
    /^\/workspace-api\/drafts\/[^/]+$/.test(pathname)
  ) {
    return normalizeDraft(value);
  }

  if (
    /^\/workspace-api\/drafts\/[^/]+\/documents$/.test(pathname)
  ) {
    const rows = Array.isArray(value)
      ? value
      : list(object(value).documents);
    if (method === 'GET') {
      return { documents: rows.map(normalizeDocument) };
    }
    return normalizeDocument(value);
  }

  if (
    /^\/workspace-api\/drafts\/[^/]+\/documents\/[^/]+$/.test(pathname)
  ) {
    return method === 'DELETE' ? value : normalizeDocument(value);
  }

  if (
    method === 'GET' &&
    /^\/workspace-api\/drafts\/[^/]+\/agent\/messages$/.test(pathname)
  ) {
    return {
      ...object(value),
      messages: list(object(value).messages).map(normalizeMessage),
    };
  }

  if (
    method === 'GET' &&
    /^\/workspace-api\/drafts\/[^/]+\/agent\/generation$/.test(pathname)
  ) {
    return object(value).run ?? null;
  }

  if (
    method === 'GET' &&
    /^\/workspace-api\/drafts\/[^/]+\/agent\/quality$/.test(pathname)
  ) {
    return normalizeQuality(value);
  }

  if (
    method === 'GET' &&
    /^\/workspace-api\/drafts\/[^/]+\/context$/.test(pathname)
  ) {
    const rows = Array.isArray(value)
      ? value
      : list(object(value).items);
    return { items: rows.map(normalizeContext) };
  }

  if (/^\/workspace-api\/drafts\/[^/]+\/lock(?:\/.*)?$/.test(pathname)) {
    return normalizeLock(value);
  }

  if (
    method === 'GET' &&
    /^\/workspace-api\/documents\/[^/]+\/comments$/.test(pathname)
  ) {
    const rows = Array.isArray(value)
      ? value
      : list(object(value).comments);
    return { comments: rows.map(normalizeComment) };
  }

  if (
    /^\/workspace-api\/documents\/[^/]+\/comments\/[^/]+$/.test(pathname) ||
    (method === 'POST' &&
      /^\/workspace-api\/documents\/[^/]+\/comments$/.test(pathname))
  ) {
    return normalizeComment(value);
  }

  if (
    method === 'GET' &&
    /^\/workspace-api\/drafts\/[^/]+\/collaborators$/.test(pathname)
  ) {
    const rows = Array.isArray(value)
      ? value
      : list(object(value).collaborators);
    return { collaborators: rows.map(normalizeCollaborator) };
  }

  if (
    method === 'GET' &&
    /^\/workspace-api\/drafts\/[^/]+\/versions$/.test(pathname)
  ) {
    const rows = Array.isArray(value)
      ? value
      : list(object(value).versions);
    return {
      versions: rows.map((row, index) =>
        normalizeVersion(row, rows.length - index),
      ),
    };
  }

  if (
    method === 'GET' &&
    pathname === '/workspace-api/template-studio/blueprints'
  ) {
    const rows = Array.isArray(value)
      ? value
      : list(object(value).blueprints);
    return { blueprints: rows.map(normalizeBlueprint) };
  }

  if (
    /^\/workspace-api\/template-studio\/blueprints\/[^/]+$/.test(
      pathname,
    )
  ) {
    return normalizeBlueprint(value);
  }

  if (
    /^\/workspace-api\/template-studio\/blueprints\/[^/]+\/versions\/[^/]+$/.test(
      pathname,
    )
  ) {
    return normalizeBlueprintVersion(value);
  }

  if (
    method === 'POST' &&
    /^\/workspace-api\/drafts\/[^/]+\/agent\/outline\/revise$/.test(
      pathname,
    )
  ) {
    const proposal = object(object(value).proposal);
    return {
      proposalId: text(proposal.proposalId),
      type: 'outline_revision',
    };
  }

  return value;
}

function responseFromJson(
  value: unknown,
  status: number,
  statusText: string,
): Response {
  if (status === 204) {
    return new Response(null, { status, statusText });
  }
  return new Response(JSON.stringify(value ?? null), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    const source =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return new URL(source, window.location.origin);
  } catch {
    return null;
  }
}

export function installWorkspaceTransportBridge(
  client: AxiosInstance,
): () => void {
  currentClient = client;
  installCount += 1;

  if (!installedFetch) {
    originalFetch = window.fetch.bind(window);
    const bridge: typeof window.fetch = async (input, init) => {
      const url = requestUrl(input);
      if (
        !url ||
        url.origin !== window.location.origin ||
        !url.pathname.startsWith('/workspace-api/')
      ) {
        return originalFetch!(input, init);
      }

      const method = (init?.method ?? 'GET').toUpperCase();
      const requestBody = transformRequest(
        url.pathname,
        method,
        parseJsonBody(init),
      );

      try {
        const response = await currentClient!.request({
          method,
          url: `${url.pathname}${url.search}`,
          data: requestBody,
          headers:
            requestBody === undefined
              ? undefined
              : { 'Content-Type': 'application/json' },
        });
        return responseFromJson(
          normalizeResponse(
            url.pathname,
            method,
            response.data,
          ),
          response.status,
          response.statusText,
        );
      } catch (error) {
        const axiosError = error as {
          response?: {
            status?: number;
            statusText?: string;
            data?: unknown;
          };
          message?: string;
        };
        const status = axiosError.response?.status ?? 500;
        return responseFromJson(
          normalizePublicError(
            axiosError.response?.data ?? {
              message: axiosError.message ?? 'Workspace request failed',
            },
            status,
          ),
          status,
          axiosError.response?.statusText ?? 'Workspace request failed',
        );
      }
    };

    installedFetch = bridge;
    window.fetch = bridge;
  }

  return () => {
    installCount = Math.max(0, installCount - 1);
    if (
      installCount === 0 &&
      installedFetch &&
      originalFetch &&
      window.fetch === installedFetch
    ) {
      window.fetch = originalFetch;
      installedFetch = null;
      originalFetch = null;
      currentClient = null;
    }
  };
}
