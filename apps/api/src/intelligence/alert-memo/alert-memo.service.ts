import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { AiCredentialResolverService } from '../../engagement/ai-credential-resolver.service.js';
import { EngagementService } from '../../engagement/engagement.service.js';
import { MeriDocgenService } from '../../meri/meri-docgen.service.js';
import { MemoryStoreService } from '../../memory/memory-store.service.js';
import type { MemoryItemType } from '../../memory/memory.types.js';
import type { WordSpec } from '../../meri/meri-docgen.helpers.js';
import type {
  AlertMemoAlertInput,
  AlertMemoResult,
} from './alert-memo.types.js';

/**
 * Generates a client-voiced, source-grounded MEMO from an intel alert and
 * auto-files it in the client's Documents.
 *
 * Grounding (borrowed from the artifact generator): the model may assert ONLY
 * the supplied claims (each with an id); it returns JSON sections whose
 * paragraphs cite claim ids; any paragraph citing an unknown claim is dropped.
 * The client's Memory files (client-soul / compass / people + firm playbook) are
 * injected as STEERING — voice, priorities, red lines — never as citable facts.
 * That split is what makes the memo bespoke without hallucinating.
 */
const MEMO_TIMEOUT_MS = 60_000;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const SECTION_ORDER = [
  'Bottom line',
  'What happened',
  'Why it matters',
  'Recommended actions',
  'Talking points',
] as const;

const SYSTEM_PROMPT = `You are a senior federal government-affairs strategist writing a concise internal MEMO for a lobbying firm's account team about a development affecting a specific client.
You are given: (1) an ABOUT-THE-CLIENT brief that sets the voice, priorities, and hard "red lines" you must respect; and (2) a closed, numbered FACT SHEET of claims (c1, c2, ...).
Hard rules:
- Assert ONLY facts drawn from the fact sheet. Never introduce a number, date, name, bill, or quote that is not in a claim.
- Every paragraph MUST cite the claim ids it draws on (claimIds).
- Use the ABOUT-THE-CLIENT brief to shape tone, emphasis, and the recommended actions — but do NOT state it as fact and NEVER contradict a stated red line.
- Keep it tight: ~1 page. "Recommended actions" = 2-4 concrete, client-specific next steps.
Return ONLY JSON: {"sections":[{"heading":"Bottom line","paragraphs":[{"text":"...","claimIds":["c1"]}]}, ...]} covering, in order: Bottom line, What happened, Why it matters, Recommended actions, Talking points. No prose outside the JSON.`;

interface Claim {
  id: string;
  text: string;
  url?: string | null;
}

interface GenSection {
  heading: string;
  paragraphs: Array<{ text: string; claimIds: string[] }>;
}

@Injectable()
export class AlertMemoService {
  private readonly logger = new Logger(AlertMemoService.name);

  constructor(
    private readonly credentials: AiCredentialResolverService,
    private readonly memory: MemoryStoreService,
    private readonly docgen: MeriDocgenService,
    private readonly engagement: EngagementService,
  ) {}

  async generate(
    ctx: TenantContext,
    clientId: string,
    alert: AlertMemoAlertInput,
    clientName: string,
    replaceAttachmentId?: string,
  ): Promise<AlertMemoResult> {
    const { claims, sources } = buildClaims(alert);
    const { steering, memoryFilesUsed } = await this.loadSteering(clientId, clientName);

    const cred = await this.credentials.resolveProvider(ctx, 'anthropic');
    if (!cred) throw new ServiceUnavailableException('No Anthropic credential available for this tenant');

    let sections: GenSection[] = [];
    let lowConfidence = false;
    try {
      const raw = await this.callAnthropic(cred.apiKey, cred.model, buildUserPrompt(alert, clientName, steering, claims));
      sections = verifyGrounded(parseSections(raw), claims);
    } catch (err) {
      this.logger.warn(`alert-memo generation failed (${(err as Error).message}); using scaffold`);
    }
    if (!sections.length) {
      sections = scaffold(alert, claims);
      lowConfidence = true;
    }

    const title = `Client memo — ${alert.billDisplayNum ?? alert.hearingTitle ?? alert.title}`.slice(0, 200);
    const markdown = toMarkdown(title, sections, claims, sources, clientName);

    // Render docx + auto-file in the client's Documents.
    let document: AlertMemoResult['document'] = null;
    try {
      const buffer = await this.docgen.buildDocx(toWordSpec(title, clientName, alert, sections));
      const fileName = `${title}.docx`.replace(/[\\/:*?"<>|]+/g, '-');
      const saved = await this.engagement.createAttachmentFromBuffer(ctx, {
        clientId,
        fileName,
        contentType: DOCX_MIME,
        buffer,
        source: 'intel_memo',
      });
      document = { attachmentId: saved.id, fileName: saved.fileName };
      // Regenerate: replace the prior Document so the client's Documents don't accrue drafts.
      if (replaceAttachmentId) {
        await this.engagement
          .deleteAttachment(ctx, replaceAttachmentId)
          .catch((e) => this.logger.warn(`replace prior memo doc failed: ${(e as Error).message}`));
      }
    } catch (err) {
      // The memo is still returned for the composer; auto-file can be retried by the client.
      this.logger.error(`alert-memo auto-file to Documents failed: ${(err as Error).message}`);
    }

    return {
      title,
      markdown,
      sections,
      sources,
      document,
      usedTenantKey: cred.usedTenantKey,
      model: cred.model,
      lowConfidence,
      memoryFilesUsed,
    };
  }

  /** Re-file an edited memo (markdown from the composer) as a fresh docx in the client's Documents. */
  async saveEdited(
    ctx: TenantContext,
    clientId: string,
    input: { title: string; markdown: string; clientName: string; actionDate?: string; replaceAttachmentId?: string },
  ): Promise<{ document: { attachmentId: string; fileName: string } | null; title: string }> {
    const subtitle = `Prepared for ${input.clientName}${input.actionDate ? ` · ${input.actionDate}` : ''}`;
    const buffer = await this.docgen.buildDocx(markdownToWordSpec(input.title, subtitle, input.markdown));
    const fileName = `${input.title}.docx`.replace(/[\\/:*?"<>|]+/g, '-');
    const saved = await this.engagement.createAttachmentFromBuffer(ctx, {
      clientId,
      fileName,
      contentType: DOCX_MIME,
      buffer,
      source: 'intel_memo',
    });
    if (input.replaceAttachmentId) {
      await this.engagement.deleteAttachment(ctx, input.replaceAttachmentId).catch(() => undefined);
    }
    return { document: { attachmentId: saved.id, fileName: saved.fileName }, title: input.title };
  }

  /** Pull the client's Memory files (voice/priorities/red-lines) + firm playbook as steering text. */
  private async loadSteering(
    clientId: string,
    clientName: string,
  ): Promise<{ steering: string; memoryFilesUsed: string[] }> {
    const wanted: Array<{ type: MemoryItemType; slug: string; label: string }> = [
      { type: 'client-soul' as MemoryItemType, slug: clientId, label: 'client-soul' },
      { type: 'client-compass' as MemoryItemType, slug: clientId, label: 'client-compass' },
      { type: 'client-people' as MemoryItemType, slug: clientId, label: 'client-people' },
      { type: 'playbook' as MemoryItemType, slug: 'firm', label: 'firm-playbook' },
    ];
    const blocks: string[] = [];
    const used: string[] = [];
    for (const w of wanted) {
      try {
        const item = await this.memory.getByTypeSlug(w.type, w.slug);
        if (!item) continue;
        const body = item.sections
          .map((s) => (s.body ?? '').trim())
          .filter(Boolean)
          .join('\n');
        if (!body.trim()) continue;
        blocks.push(`## ${item.title}\n${body}`);
        used.push(w.label);
      } catch (err) {
        this.logger.debug(`memory read ${w.type}/${w.slug} skipped: ${(err as Error).message}`);
      }
    }
    const steering = blocks.length
      ? blocks.join('\n\n')
      : `(No client knowledge files on record for ${clientName}. Write a professional, neutral government-affairs memo.)`;
    return { steering: steering.slice(0, 8000), memoryFilesUsed: used };
  }

  /** The only network call. Direct Anthropic Messages with the resolved per-tenant key. */
  private async callAnthropic(apiKey: string, model: string, prompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEMO_TIMEOUT_MS);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        throw new ServiceUnavailableException(`Anthropic failed: ${JSON.stringify(json).slice(0, 200)}`);
      }
      const content = Array.isArray(json.content) ? json.content : [];
      return content
        .map((part) => {
          const r = part && typeof part === 'object' ? (part as Record<string, unknown>) : {};
          return r.type === 'text' && typeof r.text === 'string' ? r.text : '';
        })
        .join('\n')
        .trim();
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---- pure helpers ----------------------------------------------------------

function buildClaims(alert: AlertMemoAlertInput): { claims: Claim[]; sources: AlertMemoResult['sources'] } {
  const claims: Claim[] = [];
  const push = (text: string | null | undefined, url?: string | null) => {
    const t = (text ?? '').trim();
    if (!t) return;
    claims.push({ id: `c${claims.length + 1}`, text: t, url: url ?? null });
  };
  push(`Alert: ${alert.title}`, alert.url);
  if (alert.actionText) push(`Official action${alert.actionDate ? ` (${alert.actionDate})` : ''}: ${alert.actionText}`, alert.url);
  if (alert.billDisplayNum || alert.billTitle) push(`Bill: ${[alert.billDisplayNum, alert.billTitle].filter(Boolean).join(' — ')}`, alert.url);
  if (alert.committee) push(`Committee: ${alert.committee}`);
  if (alert.hearingTitle) push(`Hearing: ${alert.hearingTitle}`, alert.url);
  if (alert.whyItMatters) push(`Relevance to client: ${alert.whyItMatters}`);
  if (alert.matchedTags?.length) push(`Matched the client's tracked interests: ${alert.matchedTags.join(', ')}`);
  for (const q of alert.quotes ?? []) {
    const who = q.speaker ? `${q.speaker}: ` : '';
    push(`Hearing statement — ${who}"${q.text}"`, alert.url);
  }
  const sources = claims
    .filter((c) => c.url)
    .map((c) => ({ claimId: c.id, label: c.text.slice(0, 80), url: c.url }));
  return { claims, sources };
}

function buildUserPrompt(
  alert: AlertMemoAlertInput,
  clientName: string,
  steering: string,
  claims: Claim[],
): string {
  return [
    `Write the internal memo for client "${clientName}" about: ${alert.title}`,
    '',
    'ABOUT THE CLIENT (voice/priorities/red lines — steer by this, do not cite as fact):',
    steering,
    '',
    'FACT SHEET (the ONLY material you may assert; cite ids):',
    claims.map((c) => `${c.id}: ${c.text}`).join('\n'),
    '',
    'Return JSON: {"sections":[{"heading":"Bottom line","paragraphs":[{"text":"...","claimIds":["c1"]}]}, ...]}',
  ].join('\n');
}

function parseSections(text: string): GenSection[] {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return [];
  let parsed: { sections?: unknown };
  try {
    parsed = JSON.parse(trimmed) as { sections?: unknown };
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]) as { sections?: unknown };
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed.sections)) return [];
  const out: GenSection[] = [];
  for (const raw of parsed.sections) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.heading !== 'string') continue;
    const paras = Array.isArray(s.paragraphs) ? s.paragraphs : [];
    const paragraphs = paras
      .map((p) => {
        const r = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
        const t = typeof r.text === 'string' ? r.text.trim() : '';
        const ids = Array.isArray(r.claimIds) ? r.claimIds.filter((x): x is string => typeof x === 'string') : [];
        return { text: t, claimIds: ids };
      })
      .filter((p) => p.text);
    out.push({ heading: s.heading.trim(), paragraphs });
  }
  return out;
}

/** Drop any paragraph that cites a claim id not in the fact sheet (grounding gate). */
function verifyGrounded(sections: GenSection[], claims: Claim[]): GenSection[] {
  const valid = new Set(claims.map((c) => c.id));
  const out: GenSection[] = [];
  for (const s of sections) {
    const kept = s.paragraphs.filter((p) => p.claimIds.every((id) => valid.has(id)));
    if (kept.length) out.push({ heading: s.heading, paragraphs: kept });
  }
  return out;
}

/** Deterministic fallback when generation fails or is fully ungrounded. */
function scaffold(alert: AlertMemoAlertInput, claims: Claim[]): GenSection[] {
  const allIds = claims.map((c) => c.id);
  return [
    { heading: 'Bottom line', paragraphs: [{ text: alert.title, claimIds: claims[0] ? [claims[0].id] : [] }] },
    {
      heading: 'What happened',
      paragraphs: [{ text: alert.actionText || alert.title, claimIds: allIds.slice(0, 3) }],
    },
    {
      heading: 'Why it matters',
      paragraphs: alert.whyItMatters ? [{ text: alert.whyItMatters, claimIds: allIds }] : [],
    },
  ].filter((s) => s.paragraphs.length);
}

function toMarkdown(
  title: string,
  sections: GenSection[],
  claims: Claim[],
  sources: AlertMemoResult['sources'],
  clientName: string,
): string {
  const lines: string[] = [`# ${title}`, `*Prepared for ${clientName}*`, ''];
  for (const s of sections) {
    lines.push(`## ${s.heading}`, '');
    for (const p of s.paragraphs) lines.push(p.text, '');
  }
  if (sources.length) {
    lines.push('## Sources', '');
    for (const src of sources) lines.push(`- ${src.label}${src.url ? ` — ${src.url}` : ''}`);
  }
  return lines.join('\n').trimEnd() + '\n';
}

function toWordSpec(
  title: string,
  clientName: string,
  alert: AlertMemoAlertInput,
  sections: GenSection[],
): WordSpec {
  return {
    title,
    subtitle: `Prepared for ${clientName}${alert.actionDate ? ` · ${alert.actionDate}` : ''}`,
    sections: sections.map((s) => ({
      heading: s.heading,
      paragraphs: s.paragraphs.map((p) => p.text),
      bullets: [],
      tables: [],
      imageArtifactIds: [],
      images: [],
    })),
  };
}

/** Split edited memo markdown into a WordSpec (## headings → sections; drops the top # title + prepared-for line). */
function markdownToWordSpec(title: string, subtitle: string, markdown: string): WordSpec {
  const sections: WordSpec['sections'] = [];
  let cur: { heading: string; paras: string[] } | null = null;
  const flush = () => {
    if (cur && (cur.heading || cur.paras.length)) {
      sections.push({
        heading: cur.heading,
        paragraphs: cur.paras.filter(Boolean),
        bullets: [],
        tables: [],
        imageArtifactIds: [],
        images: [],
      });
    }
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^#\s+/.test(line)) continue; // top title
    if (/^\*Prepared for/.test(line)) continue; // subtitle line
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      flush();
      cur = { heading: (h[1] ?? '').trim(), paras: [] };
      continue;
    }
    if (!cur) cur = { heading: '', paras: [] };
    if (line.trim()) cur.paras.push(line.replace(/^[-*]\s+/, '• ').trim());
  }
  flush();
  if (!sections.length) {
    sections.push({ heading: '', paragraphs: [markdown.trim()], bullets: [], tables: [], imageArtifactIds: [], images: [] });
  }
  return { title, subtitle, sections };
}
