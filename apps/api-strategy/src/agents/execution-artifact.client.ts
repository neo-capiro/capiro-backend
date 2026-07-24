import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Stage G Execution-Agent artifact hop (server-to-server). STAGES artifacts —
 * a Workspace WsDraft or an engagement OutreachRecord — by replaying the EXACT
 * two-call request sequence the web performs today (apps/web StrategyEditorPage
 * `onRoute`): the api-strategy runtime cannot own the workspace/engagement
 * schemas, so it hops to apps/api under the CALLER's bearer (the same idiom as
 * StrategyAttachmentResolver / StrategyAiCredentialResolver — API_INTERNAL_URL +
 * a forwarded Bearer + the shared INTERNAL_SERVICE_SECRET marker) with an 8s
 * AbortController bound.
 *
 * SAFETY BOUNDARY (plan §G, non-negotiable): this client CREATES / STAGES only.
 * There is NO send/dispatch/deliver code path here — the only two URLs it will
 * ever touch are `POST /workspace-api/drafts` (+ its PATCH) and
 * `POST /api/engagement/outreach`. External send stays hard-disabled until
 * Stage H (see send-approval.ts). A caller bearer is REQUIRED — a bearerless
 * (pure scheduler/system) execution must never reach here; it throws so G-core
 * parks the run rather than performing a bearerless external hop.
 *
 * Fail-soft means fail-LOUD-but-TYPED: every failure (missing bearer, timeout,
 * non-2xx upstream, unparseable body) surfaces as an ExecutionArtifactError the
 * calling service converts into a run failure / finding — NEVER a silent
 * success. Nothing here is logged with document/message contents.
 */

const ARTIFACT_TIMEOUT_MS = 8_000;
const OUTREACH_TITLE_MAX = 240;
const DEFAULT_WORKSPACE_SECTION = 'Background';

export type ExecutionArtifactErrorKind =
  | 'missing_bearer'
  | 'timeout'
  | 'upstream'
  | 'malformed';

/** Typed staging failure — the service maps this to a run failure / finding. */
export class ExecutionArtifactError extends Error {
  constructor(
    readonly kind: ExecutionArtifactErrorKind,
    message: string,
    /** HTTP status when the failure came from a non-2xx upstream response. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ExecutionArtifactError';
  }
}

export interface CreateWorkspaceDraftInput {
  docTitle: string;
  /** Workspace expects the client NAME string (G-core resolves it from clients). */
  clientName: string;
  product: string;
  /**
   * Ordered heading -> sanitized HTML map seeded into the draft's config.
   * Stage-G grounded generation: multiple sections (deterministic fallback:
   * a single 'Background' entry — same shape either way).
   */
  sections: Record<string, string>;
}

export interface CreateOutreachRecordInput {
  title: string;
  subject: string;
  /** Outreach expects the client ID (unlike workspace, which takes the name). */
  clientId: string;
  /** Stage-G grounded generation: the full campaign message body (plain text,
   *  already flattened + sanitized). Omitted/null on the deterministic path. */
  body?: string | null;
  /** The resolved node target (see NodeTargetRef), OutreachRecipientDto-shaped.
   *  Omitted when the node has no targetRef — the record then carries no
   *  recipients, same as before this field existed. */
  recipients?: Record<string, unknown>[];
  /** Which wizard step a reopened draft should resume on (1-based; see
   *  ExecutionService.buildOutreachResumeMetadata). Omitted preserves the
   *  DTO's own default (clamps to 1 — the prior "always opens blank" behavior). */
  lastStep?: number;
  metadata?: Record<string, unknown>;
}

/** The staged artifact's opaque id (WsDraft.id / OutreachRecord.id). */
export interface ArtifactRef {
  ref: string;
}

@Injectable()
export class ExecutionArtifactClient {
  private readonly logger = new Logger(ExecutionArtifactClient.name);
  private readonly apiBaseUrl: string;
  private readonly sharedSecret?: string;

  constructor(config: ConfigService) {
    this.apiBaseUrl = (
      config.get<string>('API_INTERNAL_URL') ??
      config.get<string>('API_BASE_URL') ??
      'https://app.capiro.ai'
    ).replace(/\/+$/, '');
    this.sharedSecret = config.get<string>('INTERNAL_SERVICE_SECRET');
  }

  /**
   * Stage a Workspace WsDraft — mirrors the web's two-call sequence:
   *  1) POST /workspace-api/drafts {docTitle, client: clientName, product}
   *  2) PATCH /workspace-api/drafts/:id {config:{sections: [...], sectionContent: {...}}}
   * The PATCH now writes the FULL ordered heading list (`config.sections`) plus
   * every heading's HTML (`config.sectionContent`) — a multi-section grounded
   * draft needs every heading rendered, not just the created draft's first
   * default section. The deterministic fallback still ships as a single
   * `{'Background': html}` entry, so a caller passing one section behaves
   * exactly as the prior single-section PATCH did. Returns the draft id as {ref}.
   */
  async createWorkspaceDraft(
    bearer: string | undefined,
    input: CreateWorkspaceDraftInput,
  ): Promise<ArtifactRef> {
    if (!bearer) {
      throw new ExecutionArtifactError(
        'missing_bearer',
        'Workspace draft staging requires an interactive caller bearer',
      );
    }
    const headers = this.headers(bearer);

    const createRes = await this.doFetch(
      `${this.apiBaseUrl}/workspace-api/drafts`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          docTitle: input.docTitle,
          client: input.clientName,
          product: input.product,
        }),
      },
      'workspace draft create',
    );
    const created = await this.parseJson<{ id?: unknown }>(createRes, 'workspace draft create');
    const id = typeof created.id === 'string' && created.id ? created.id : '';
    if (!id) {
      throw new ExecutionArtifactError('malformed', 'workspace draft create returned no id');
    }

    const headingList = Object.keys(input.sections);
    const sections = headingList.length ? headingList : [DEFAULT_WORKSPACE_SECTION];
    const sectionContent = headingList.length ? input.sections : { [DEFAULT_WORKSPACE_SECTION]: '' };

    await this.doFetch(
      `${this.apiBaseUrl}/workspace-api/drafts/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ config: { sections, sectionContent } }),
      },
      'workspace draft section patch',
    );

    return { ref: id };
  }

  /**
   * Stage an engagement OutreachRecord (campaign) — POST /api/engagement/outreach
   * {type:'campaign', title (clamped to 240), subject, clientId, metadata}.
   * Creation only; nothing is sent. Returns the record id as {ref}.
   */
  async createOutreachRecord(
    bearer: string | undefined,
    input: CreateOutreachRecordInput,
  ): Promise<ArtifactRef> {
    if (!bearer) {
      throw new ExecutionArtifactError(
        'missing_bearer',
        'Outreach record staging requires an interactive caller bearer',
      );
    }
    const headers = this.headers(bearer);

    const res = await this.doFetch(
      `${this.apiBaseUrl}/api/engagement/outreach`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          type: 'campaign',
          // Outreach title is capped at 240 server-side (node titles allow more).
          title: input.title.slice(0, OUTREACH_TITLE_MAX),
          subject: input.subject,
          clientId: input.clientId,
          ...(input.body ? { body: input.body } : {}),
          ...(input.recipients?.length ? { recipients: input.recipients } : {}),
          ...(input.lastStep ? { lastStep: input.lastStep } : {}),
          metadata: input.metadata ?? {},
        }),
      },
      'outreach record create',
    );
    const rec = await this.parseJson<{ id?: unknown }>(res, 'outreach record create');
    const id = typeof rec.id === 'string' && rec.id ? rec.id : '';
    if (!id) {
      throw new ExecutionArtifactError('malformed', 'outreach record create returned no id');
    }
    return { ref: id };
  }

  private headers(bearer: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: bearer.startsWith('Bearer ') ? bearer : `Bearer ${bearer}`,
    };
    // Server-to-server marker (InternalServiceGuard); the user bearer still
    // carries the authorising identity. Only attached when configured.
    if (this.sharedSecret) headers['x-internal-service-secret'] = this.sharedSecret;
    return headers;
  }

  private async doFetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
    label: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ARTIFACT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      this.logger.warn(`${label} ${aborted ? 'timed out' : 'failed'}`);
      throw new ExecutionArtifactError(
        aborted ? 'timeout' : 'upstream',
        `${label} ${aborted ? 'timed out' : 'failed'}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      this.logger.warn(`${label} non-2xx: HTTP ${res.status}`);
      throw new ExecutionArtifactError('upstream', `${label} failed: HTTP ${res.status}`, res.status);
    }
    return res;
  }

  private async parseJson<T>(res: Response, label: string): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch {
      throw new ExecutionArtifactError('malformed', `${label} returned an unparseable body`);
    }
  }
}
