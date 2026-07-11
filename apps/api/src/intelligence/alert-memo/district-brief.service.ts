import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { recordAiUsageEvent, parseProviderUsage, type TenantContext } from '@capiro/shared';
import { AiCredentialResolverService } from '../../engagement/ai-credential-resolver.service.js';
import { EngagementService } from '../../engagement/engagement.service.js';
import { MemoryStoreService } from '../../memory/memory-store.service.js';
import type { MemoryItemType } from '../../memory/memory.types.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  RepresentationResolverService,
  type FederalMemberSummary,
  type RepresentationResult,
  type StateLegislatorSummary,
} from '../../clients/representation-resolver.service.js';
import { renderMemoDocx, type MemoDocInput } from './alert-memo-docx.js';
import type { AlertMemoAlertInput } from './alert-memo.types.js';
import type { DistrictBriefResult } from './district-brief.types.js';

/**
 * District-impact one-pager (Phase 1 M1.5, PD6). A sibling of `AlertMemoService`
 * grounded in the District Impact Engine instead of just the alert: the fact
 * sheet adds the facility's footprint and its resolved federal + state
 * representation (M1.3's `RepresentationResolverService` — the SAME
 * deterministic join the M5 targeting-brief validator will use, so a claim
 * here means the same thing everywhere). Kept self-contained (not sharing
 * `AlertMemoService`'s private helpers) — this codebase's convention for
 * grounded-generation services is a local copy of the claims/prompt/grounding
 * logic per site rather than a shared abstraction (see alert-memo.service.ts's
 * own "borrowed from the artifact generator" comment).
 */
const BRIEF_TIMEOUT_MS = 60_000;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const SECTION_ORDER = [
  'Facility & footprint',
  'Who represents it',
  'The bill/rule at stake',
  'District impact',
  'The ask',
] as const;

const SYSTEM_PROMPT = `You are a senior government-affairs strategist writing a concise DISTRICT-IMPACT BRIEF for a lobbying firm's account team, connecting a specific legislative or regulatory development to ONE of the client's physical facilities and the elected officials who represent it.
You are given: (1) an ABOUT-THE-CLIENT brief that sets the voice, priorities, and hard "red lines" you must respect; and (2) a closed, numbered FACT SHEET of claims (c1, c2, ...) covering the facility, its representatives (federal and/or state — only those actually resolved are listed), and the bill/rule/hearing at stake.
Hard rules:
- Assert ONLY facts drawn from the fact sheet. Never introduce a number, date, name, committee assignment, vote, or quote that is not in a claim.
- Every paragraph MUST cite the claim ids it draws on (claimIds).
- If no representative is listed for a chamber, say nothing about that chamber — do not guess who holds the seat.
- Use the ABOUT-THE-CLIENT brief to shape tone and "the ask" — but do NOT state it as fact and NEVER contradict a stated red line.
- Keep it tight: ~1 page. "The ask" = 1-3 concrete, facility-specific next steps (e.g. a constituent meeting, a plant tour invitation, a letter citing local jobs/investment).
Return ONLY JSON: {"sections":[{"heading":"Facility & footprint","paragraphs":[{"text":"...","claimIds":["c1"]}]}, ...]} covering, in order: Facility & footprint, Who represents it, The bill/rule at stake, District impact, The ask. No prose outside the JSON.`;

interface Claim {
  id: string;
  text: string;
  url?: string | null;
}

interface GenSection {
  heading: string;
  paragraphs: Array<{ text: string; claimIds: string[] }>;
}

interface BriefFacility {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  employeeCount: number | null;
}

@Injectable()
export class DistrictBriefService {
  private readonly logger = new Logger(DistrictBriefService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly representation: RepresentationResolverService,
    private readonly credentials: AiCredentialResolverService,
    private readonly memory: MemoryStoreService,
    private readonly engagement: EngagementService,
  ) {}

  async generate(
    ctx: TenantContext,
    clientId: string,
    facilityId: string,
    alert: AlertMemoAlertInput,
    replaceAttachmentId?: string,
  ): Promise<DistrictBriefResult> {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clientFacility.findFirst({
        where: { tenantId: ctx.tenantId, id: facilityId, clientId },
        include: { client: { select: { id: true, name: true } } },
      }),
    );
    if (!row) throw new NotFoundException('Facility not found for this client');
    const facility: BriefFacility = {
      id: row.id,
      name: row.name,
      city: row.city,
      state: row.state,
      employeeCount: row.employeeCount,
    };
    const clientName = row.client.name;

    const repResult = await this.representation.representativesForFacility(row);
    const committeeRoles = await this.resolveCommitteeRoles(
      alert.committee,
      collectBioguideIds(repResult),
    );

    const { claims, sources } = buildDistrictClaims(alert, facility, repResult, committeeRoles);
    const { steering, memoryFilesUsed } = await this.loadSteering(clientId, clientName);

    const cred = await this.credentials.resolveProvider(ctx, 'anthropic');
    if (!cred)
      throw new ServiceUnavailableException('No Anthropic credential available for this tenant');

    let sections: GenSection[] = [];
    let lowConfidence = false;
    let rawUsage: unknown = null;
    try {
      const { text, raw } = await this.callAnthropic(
        cred.apiKey,
        cred.model,
        buildUserPrompt(alert, facility, clientName, steering, claims),
      );
      rawUsage = raw;
      sections = verifyGrounded(parseSections(text), claims);
    } catch (err) {
      this.logger.warn(
        `district-brief generation failed (${(err as Error).message}); using scaffold`,
      );
    }
    if (!sections.length) {
      sections = scaffold(alert, facility, claims);
      lowConfidence = true;
    }

    await recordAiUsageEvent(
      { prisma: this.prisma, logger: this.logger },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      'district_brief',
      {
        provider: 'anthropic',
        model: cred.model,
        usage: parseProviderUsage(rawUsage),
        usedTenantKey: cred.usedTenantKey,
      },
    );

    const title =
      `District brief — ${facility.name} — ${alert.billDisplayNum ?? alert.hearingTitle ?? alert.title}`.slice(
        0,
        200,
      );
    const markdown = toMarkdown(title, sections, sources, clientName, facility);

    let document: DistrictBriefResult['document'] = null;
    try {
      const buffer = await renderMemoDocx(
        toMemoDocInput(clientName, facility, alert, sections, sources),
      );
      const fileName = `${title}.docx`.replace(/[\\/:*?"<>|]+/g, '-');
      const saved = await this.engagement.createAttachmentFromBuffer(ctx, {
        clientId,
        fileName,
        contentType: DOCX_MIME,
        buffer,
        source: 'district_brief',
      });
      document = { attachmentId: saved.id, fileName: saved.fileName };
      if (replaceAttachmentId) {
        await this.engagement
          .deleteAttachment(ctx, replaceAttachmentId)
          .catch((e) =>
            this.logger.warn(`replace prior district brief doc failed: ${(e as Error).message}`),
          );
      }
    } catch (err) {
      this.logger.error(`district-brief auto-file to Documents failed: ${(err as Error).message}`);
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
      facility: {
        id: facility.id,
        name: facility.name,
        city: facility.city,
        state: facility.state,
      },
    };
  }

  /**
   * Best-effort federal committee role (Chair/Ranking Member/...) for the
   * alert's named committee. Only asserted when the free-text committee name
   * matches EXACTLY one current `CongressCommittee` — ambiguous or no match
   * yields no claim at all (never guess, PD2's own standard).
   */
  private async resolveCommitteeRoles(
    committeeName: string | null | undefined,
    bioguideIds: string[],
  ): Promise<Map<string, string>> {
    const roles = new Map<string, string>();
    const needle = (committeeName ?? '').trim().toLowerCase();
    if (!needle || !bioguideIds.length) return roles;
    const committees = await this.prisma.congressCommittee.findMany({
      where: { isCurrent: true },
      select: { systemCode: true, name: true },
    });
    const matches = committees.filter((c) => {
      const n = c.name.toLowerCase();
      return n.includes(needle) || needle.includes(n);
    });
    if (matches.length !== 1) return roles;
    const memberships = await this.prisma.congressCommitteeMembership.findMany({
      where: { systemCode: matches[0]!.systemCode, bioguideId: { in: bioguideIds } },
      select: { bioguideId: true, title: true },
    });
    for (const m of memberships) {
      if (m.title) roles.set(m.bioguideId, m.title);
    }
    return roles;
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
      : `(No client knowledge files on record for ${clientName}. Write a professional, neutral government-affairs brief.)`;
    return { steering: steering.slice(0, 8000), memoryFilesUsed: used };
  }

  /** The only network call. Direct Anthropic Messages with the resolved per-tenant key. */
  private async callAnthropic(
    apiKey: string,
    model: string,
    prompt: string,
  ): Promise<{ text: string; raw: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BRIEF_TIMEOUT_MS);
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
        throw new ServiceUnavailableException(
          `Anthropic failed: ${JSON.stringify(json).slice(0, 200)}`,
        );
      }
      const content = Array.isArray(json.content) ? json.content : [];
      const text = content
        .map((part) => {
          const r = part && typeof part === 'object' ? (part as Record<string, unknown>) : {};
          return r.type === 'text' && typeof r.text === 'string' ? r.text : '';
        })
        .join('\n')
        .trim();
      return { text, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---- pure helpers ----------------------------------------------------------

function collectBioguideIds(rep: RepresentationResult): string[] {
  if (rep.unresolved) return [];
  const ids: string[] = [];
  if (rep.federal.house) ids.push(rep.federal.house.bioguideId);
  for (const s of rep.federal.senate) ids.push(s.bioguideId);
  return ids;
}

function formatFederalDistrict(m: FederalMemberSummary): string {
  return m.district == null
    ? `${m.state ?? ''}-at-large`.replace(/^-/, '')
    : `${m.state}-${String(m.district).padStart(2, '0')}`;
}

function buildDistrictClaims(
  alert: AlertMemoAlertInput,
  facility: BriefFacility,
  rep: RepresentationResult,
  committeeRoles: Map<string, string>,
): { claims: Claim[]; sources: DistrictBriefResult['sources'] } {
  const claims: Claim[] = [];
  const push = (text: string | null | undefined, url?: string | null) => {
    const t = (text ?? '').trim();
    if (!t) return;
    claims.push({ id: `c${claims.length + 1}`, text: t, url: url ?? null });
  };

  const location = [facility.city, facility.state].filter(Boolean).join(', ');
  push(`Facility: ${facility.name}${location ? ` in ${location}` : ''}`);
  if (facility.employeeCount != null) {
    push(`This facility employs approximately ${facility.employeeCount} people.`);
  }

  if (!rep.unresolved) {
    const h = rep.federal.house;
    if (h) {
      const role = committeeRoles.get(h.bioguideId);
      push(
        `U.S. Representative for this facility's district (${formatFederalDistrict(h)}): ${h.fullName}${h.party ? ` (${h.party})` : ''}${role ? `, ${role} on ${alert.committee}` : ''}.`,
      );
    }
    for (const s of rep.federal.senate) {
      const role = committeeRoles.get(s.bioguideId);
      push(
        `U.S. Senator for ${facility.state}: ${s.fullName}${s.party ? ` (${s.party})` : ''}${role ? `, ${role} on ${alert.committee}` : ''}.`,
      );
    }
    const describeState = (label: string, l: StateLegislatorSummary | null) => {
      if (!l) return;
      push(`${label} for this facility's district: ${l.name}${l.party ? ` (${l.party})` : ''}.`);
    };
    describeState('State Representative (lower chamber)', rep.state.lower);
    describeState('State Senator (upper chamber)', rep.state.upper);
  }

  push(`Alert: ${alert.title}`, alert.url);
  if (alert.actionText)
    push(
      `Official action${alert.actionDate ? ` (${alert.actionDate})` : ''}: ${alert.actionText}`,
      alert.url,
    );
  if (alert.billDisplayNum || alert.billTitle)
    push(`Bill: ${[alert.billDisplayNum, alert.billTitle].filter(Boolean).join(' — ')}`, alert.url);
  if (alert.committee) push(`Committee: ${alert.committee}`);
  if (alert.hearingTitle) push(`Hearing: ${alert.hearingTitle}`, alert.url);
  if (alert.whyItMatters) push(`Relevance to client: ${alert.whyItMatters}`);
  if (alert.matchedTags?.length)
    push(`Matched the client's tracked interests: ${alert.matchedTags.join(', ')}`);
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
  facility: BriefFacility,
  clientName: string,
  steering: string,
  claims: Claim[],
): string {
  return [
    `Write the district-impact brief for client "${clientName}" about facility "${facility.name}" regarding: ${alert.title}`,
    '',
    'ABOUT THE CLIENT (voice/priorities/red lines — steer by this, do not cite as fact):',
    steering,
    '',
    'FACT SHEET (the ONLY material you may assert; cite ids):',
    claims.map((c) => `${c.id}: ${c.text}`).join('\n'),
    '',
    'Return JSON: {"sections":[{"heading":"Facility & footprint","paragraphs":[{"text":"...","claimIds":["c1"]}]}, ...]}',
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
        const ids = Array.isArray(r.claimIds)
          ? r.claimIds.filter((x): x is string => typeof x === 'string')
          : [];
        return { text: t, claimIds: ids };
      })
      .filter((p) => p.text);
    out.push({ heading: s.heading.trim(), paragraphs });
  }
  return out;
}

/**
 * Drop any paragraph that is not fully grounded (grounding gate). W3.3: a
 * paragraph must cite at least one claim AND every cited id must be a real
 * fact-sheet claim. The old `claimIds.every(...)` was VACUOUSLY TRUE for a
 * zero-citation paragraph (`[].every` === true), so ungrounded model prose —
 * asserting facts with no citation at all — sailed through into a
 * client-facing brief. Requiring `length > 0` closes that hole; a generation
 * that ends up fully uncited drops to zero sections and the caller downgrades
 * to the deterministic scaffold with lowConfidence=true.
 */
function verifyGrounded(sections: GenSection[], claims: Claim[]): GenSection[] {
  const valid = new Set(claims.map((c) => c.id));
  const out: GenSection[] = [];
  for (const s of sections) {
    const kept = s.paragraphs.filter(
      (p) => p.claimIds.length > 0 && p.claimIds.every((id) => valid.has(id)),
    );
    if (kept.length) out.push({ heading: s.heading, paragraphs: kept });
  }
  return out;
}

/** Deterministic fallback when generation fails or is fully ungrounded. */
function scaffold(
  alert: AlertMemoAlertInput,
  facility: BriefFacility,
  claims: Claim[],
): GenSection[] {
  const allIds = claims.map((c) => c.id);
  return [
    {
      heading: 'Facility & footprint',
      paragraphs: [{ text: facility.name, claimIds: claims[0] ? [claims[0].id] : [] }],
    },
    {
      heading: 'The bill/rule at stake',
      paragraphs: [{ text: alert.actionText || alert.title, claimIds: allIds.slice(0, 3) }],
    },
    {
      heading: 'District impact',
      paragraphs: alert.whyItMatters ? [{ text: alert.whyItMatters, claimIds: allIds }] : [],
    },
  ].filter((s) => s.paragraphs.length);
}

function toMarkdown(
  title: string,
  sections: GenSection[],
  sources: DistrictBriefResult['sources'],
  clientName: string,
  facility: BriefFacility,
): string {
  const lines: string[] = [`# ${title}`, `*Prepared for ${clientName} — ${facility.name}*`, ''];
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

function toMemoDocInput(
  clientName: string,
  facility: BriefFacility,
  alert: AlertMemoAlertInput,
  sections: GenSection[],
  sources: DistrictBriefResult['sources'],
): MemoDocInput {
  const reLine = `${facility.name}${alert.billDisplayNum ? ` — ${alert.billDisplayNum}` : alert.hearingTitle ? ` — ${alert.hearingTitle}` : ''}`;
  return {
    clientName,
    dateStr: formatBriefDate(alert.actionDate),
    reLine,
    sections: sections.map((s) => ({
      heading: s.heading,
      paragraphs: s.paragraphs.map((p) => p.text),
    })),
    sources: sources.map((s) => ({ label: s.label, url: s.url })),
  };
}

/** Long-form brief date; parses YYYY-MM-DD as a local date to avoid tz drift. */
function formatBriefDate(actionDate?: string | null): string {
  let d: Date;
  if (actionDate && /^\d{4}-\d{2}-\d{2}/.test(actionDate)) {
    const parts = actionDate.slice(0, 10).split('-').map(Number);
    d = new Date(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1);
  } else if (actionDate) {
    d = new Date(actionDate);
  } else {
    d = new Date();
  }
  if (Number.isNaN(d.getTime())) d = new Date();
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
