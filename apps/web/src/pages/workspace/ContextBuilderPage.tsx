import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { App as AntApp, Spin } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import { StepsRail } from './StepsRail.js';
import { Icon, MeriCallout } from './kit.js';
import {
  useDraft,
  useDraftContext,
  useAddContextItem,
  useRemoveContextItem,
  useDrafts,
  useGenerateAll,
} from './api.js';
import { MeriDraftingOverlay } from './LibraryPage.js';
import { decodeHtmlEntities } from '../../lib/html-entities.js';
import { useDebouncedValue } from '../../lib/use-debounced-value.js';
import type { WsConfig, WsContextItem } from './types.js';

/**
 * Build Context — the ContextBuilder half of the locked prototype (asset_13
 * `ContextBuilder` + `NewsSection`), ported to production fidelity. Renders
 * inside the real app shell (.ws-root / .ws-shell) using the prototype's scoped
 * DS classes (workspace-ds.css).
 *
 * Binding corrections from the product owner (OVERRIDE the prototype mocks):
 *  1. NEWS comes from OUR systems, not external feeds:
 *       - member-level press: GET /api/directory/contacts/:id/news (per selected office)
 *       - general feed:       GET /api/explorer/intel-articles (Data Explorer "News Feed")
 *     filtered by the doc's client + selected offices.
 *  2. "office" = member of Congress (our Directory). cfg.offices holds member names.
 *  3. Per-office context is AUTO-DERIVED (read-only v1) from the member's directory
 *     profile (state/district, committees, top issues, bio) + their recent press —
 *     sourced from GET /api/directory/contacts?q=<name> and .../news.
 *  4. Additional-context = free-text ITEMS (a list); each persists as kind:'free-text'.
 *  5. Added sources/news PERSIST as context items (id-ref + snapshot in payload) and
 *     the right "Context plan" reads useDraftContext(draftId).
 */

// ── prototype constants ────────────────────────────────────────────────────────
const ACCENT_BANNER_BORDER = '1px solid var(--accent-glow, rgba(59,91,219,0.2))';

// ── main-api response shapes (subset) ───────────────────────────────────────────
interface DirContact {
  id: string;
  fullName: string;
  memberName: string;
  chamber: string;
  state: string;
  district: string;
  party: string;
  partyName?: string;
  committees?: string[];
  committeeLeadership?: string[];
  topIssues?: Array<{ issue: string; stafferCount: number }>;
  focusAreas?: string[];
  officeLocation?: string;
  bio?: { hometown?: string; occupation?: string; narrative?: string };
}
interface DirContactsResponse {
  contacts: DirContact[];
}
interface MemberNewsItem {
  id: string;
  title: string;
  link: string;
  publishedAt: string | null;
  summary: string;
}
interface MemberNewsPayload {
  contactId: string;
  memberName: string;
  items: MemberNewsItem[];
}
interface IntelArticleRow {
  id: string;
  source: string;
  title: string;
  url: string;
  publishedAt: string;
  summary: string | null;
  topics: string[];
  agencies: string[];
}
interface ExplorerResponse<T> {
  rows: T[];
  total: number;
}

// A news card as rendered by NewsSection — normalized across both sources.
interface NewsCard {
  id: string; // stable id used both as react key and as the persisted ref id
  headline: string;
  url: string;
  source: string;
  date: string;
  origin: 'member-press' | 'intel-feed';
  relevantOffices: string[];
  summary?: string; // carried into the persisted payload so Meri can use it
}

// A pullable source item (one row in a tab list).
interface SourceItem {
  id: string;
  t: string;
  sub?: string;
  // Grounding body persisted into the context-item payload so Meri generation
  // actually uses this source (documents fetch it lazily via extract-text).
  text?: string;
}
interface SourceGroup {
  type: string;
  tab: string;
  icon: string;
  items: SourceItem[];
}

// ── helpers ─────────────────────────────────────────────────────────────────────
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((x) => x[0])
    .filter(Boolean)
    .slice(-2)
    .join('')
    .toUpperCase();
}
function MiniAva({ x, size = 22 }: { x: string; size?: number }) {
  return (
    <span
      className="num"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'linear-gradient(135deg,#4E78D8,#1A3F9F)',
        color: '#fff',
        display: 'inline-grid',
        placeItems: 'center',
        fontSize: size * 0.4,
        fontWeight: 600,
        flex: 'none',
        boxShadow: '0 0 0 1.5px var(--bg-surface)',
      }}
    >
      {x}
    </span>
  );
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Page ──────────────────────────────────────────────────────────────────────
export function ContextBuilderPage() {
  const { draftId } = useParams();
  const { data: draft, isLoading } = useDraft(draftId ?? null);

  if (isLoading || !draft) {
    return (
      <div className="ws-shell">
        <StepsRail active="context" draftId={draftId} />
        <div className="ws-stage" style={{ textAlign: 'center', padding: 60 }}>
          <Spin />
        </div>
      </div>
    );
  }

  return (
    <div className="ws-shell">
      <StepsRail active="context" draftId={draftId} product={draft.product} />
      <div className="ws-stage" style={{ padding: 0 }}>
        <ContextBuilder draftId={draftId!} cfg={draft.config} client={draft.client} />
      </div>
    </div>
  );
}

// ── ContextBuilder (asset_13) ───────────────────────────────────────────────────
function ContextBuilder({
  draftId,
  cfg,
  client,
}: {
  draftId: string;
  cfg: WsConfig;
  client: string | null;
}) {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const api = useApi();
  const [tab, setTab] = useState(0);
  const [freeText, setFreeText] = useState('');
  const [addingId, setAddingId] = useState<string | null>(null);
  const generateAll = useGenerateAll(draftId);
  const [drafting, setDrafting] = useState(false);

  // Open editor: if the document hasn't been drafted yet, have Meri draft the
  // WHOLE document now (grounded in the setup + the context just built), then
  // open the editor populated. If it's already drafted (e.g. returning here),
  // just open — never clobber existing content. (Per-section + Regenerate All
  // handle re-drafting from inside the editor.)
  const openEditor = async () => {
    const content = (cfg.sectionContent as Record<string, string> | undefined) ?? {};
    const sections = (cfg.sections as string[] | undefined) ?? [];
    const alreadyDrafted = sections.some((s) => (content[s] ?? '').replace(/<[^>]*>/g, '').trim());
    if (sections.length && !alreadyDrafted) {
      setDrafting(true);
      try {
        await generateAll.mutateAsync();
      } catch {
        message.error(
          'Meri could not draft the document — you can draft sections individually in the editor.',
        );
      } finally {
        setDrafting(false);
      }
    }
    navigate(`/workspace/draft/${draftId}`);
  };

  const offices = (cfg.offices as string[] | undefined) ?? [];
  const showOffices = !!cfg.officeAssociated && offices.length > 0;
  // Per-office groups render only when the doc is personalized (correction #3).
  const showPersonalizedGroups = !!cfg.personalize && showOffices;

  // Persisted context plan + mutations.
  const { data: items } = useDraftContext(draftId);
  const addItem = useAddContextItem(draftId);
  const removeItem = useRemoveContextItem(draftId);
  const planItems = (items ?? []) as WsContextItem[];
  const addedRefIds = useMemo(
    () =>
      new Set(
        planItems
          .map((it) => (it.payload as { refId?: string }).refId)
          .filter((x): x is string => !!x),
      ),
    [planItems],
  );

  // Source tabs (real where wired, engine fallback otherwise).
  const sourceGroups = useSourceGroups(client);
  // Resolved client id for the Bills tab's search-any-bill bar (deduped fetch).
  const clientId = useClientId(client);

  // News from OUR systems (correction #1).
  const newsCards = useNewsCards(client, offices);

  const addSource = async (g: SourceGroup, it: SourceItem) => {
    // In-flight guard: the doc path awaits extract-text, during which the row
    // stays clickable — without this a double-click adds a duplicate item.
    if (addedRefIds.has(it.id) || addingId === it.id) return;
    setAddingId(it.id);
    try {
      let text = it.text ?? '';
      // Documents: pull the ACTUAL file content so Meri understands what's in it.
      if (g.type === 'docs-notes' && it.id.startsWith('doc-')) {
        const attachmentId = it.id.slice('doc-'.length);
        try {
          const { data } = await api.post<{ text?: string }>(
            `/api/engagement/attachments/${attachmentId}/extract-text`,
          );
          // Clamp so a large document can't blow the autosave / generation budget.
          text = [it.t, (data.text ?? '').slice(0, 8000)].filter(Boolean).join('\n');
        } catch {
          text = it.t; // unsupported / scanned (no text layer) → reference by name
          message.warning('Could not read that document — added as a reference.');
        }
      }
      await addItem.mutateAsync({
        kind: 'source',
        payload: { sourceType: g.type, refId: it.id, label: it.t, sub: it.sub, text },
      });
      message.success('Added to context plan');
    } catch {
      message.error('Could not add to context plan.');
    } finally {
      setAddingId(null);
    }
  };
  const addFreeText = () => {
    const text = freeText.trim();
    if (!text) return;
    addItem.mutate(
      { kind: 'free-text', payload: { text } },
      {
        onSuccess: () => {
          setFreeText('');
          message.success('Added to context plan');
        },
      },
    );
  };
  const addNews = (a: NewsCard) => {
    if (addedRefIds.has(a.id)) return;
    addItem.mutate(
      {
        kind: 'news',
        // Q-CTX-1: persist an id-reference + a snapshot so the plan survives feed
        // churn. `text` (headline + summary) is what Meri generation reads.
        payload: {
          refId: a.id,
          headline: a.headline,
          url: a.url,
          source: a.source,
          date: a.date,
          origin: a.origin,
          text: [a.headline, a.summary].filter(Boolean).join(' — '),
        },
      },
      { onSuccess: () => message.success('Added to context plan') },
    );
  };

  const activeGroup = sourceGroups[tab] ?? sourceGroups[0];

  return (
    <div
      style={{ display: 'grid', gridTemplateColumns: '1fr 320px', height: '100%', minHeight: 540 }}
    >
      {/* ── LEFT: pull facts ─────────────────────────────────────────────────── */}
      <div
        style={{ overflow: 'auto', padding: '24px 30px', borderRight: '1px solid var(--border-1)' }}
      >
        <h1
          style={{
            fontFamily: 'var(--font-serif)',
            fontWeight: 500,
            fontSize: 24,
            letterSpacing: '-0.01em',
            margin: '0 0 4px',
          }}
        >
          Build the context Meri uses
        </h1>
        <p style={{ fontSize: 13, color: 'var(--ink-2)', margin: '0 0 16px', maxWidth: 560 }}>
          Pull facts from across the platform.
          {showOffices ? (
            <>
              {' '}
              Associate each to <b>all offices</b> or a <b>specific office</b>.
            </>
          ) : null}{' '}
          Meri grounds every section in what you add.
        </p>

        {/* Additional plain-text context for Meri — adds a free-text ITEM on submit. */}
        <div
          style={{
            marginBottom: 16,
            padding: '13px 14px',
            background: 'var(--accent-soft)',
            border: ACCENT_BANNER_BORDER,
            borderRadius: 9,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <Icon name="Sparkles" size={13} style={{ color: 'var(--accent)' }} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent-ink)' }}>
              Additional context for Meri
            </span>
            <span style={{ fontSize: 11, color: 'var(--accent-ink)', opacity: 0.65 }}>
              (optional)
            </span>
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: 'var(--accent-ink)',
              marginBottom: 8,
              lineHeight: 1.45,
              opacity: 0.8,
            }}
          >
            Anything not in the platform — talking points, constraints, messaging guidance. Meri
            incorporates this when drafting.
          </div>
          <textarea
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            placeholder="e.g. Avoid naming competitors directly. Lead with workforce impact before cost. Reference the bipartisan coalition letter from last session."
            rows={3}
            className="field"
            style={{
              width: '100%',
              padding: '9px 12px',
              fontSize: 12.5,
              fontFamily: 'var(--font-sans)',
              background: 'rgba(255,255,255,0.7)',
              resize: 'vertical',
              lineHeight: 1.5,
              boxSizing: 'border-box',
              border: '1px solid var(--accent-glow, rgba(59,91,219,0.25))',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button
              className="btn sm btn-accent"
              onClick={addFreeText}
              disabled={!freeText.trim() || addItem.isPending}
            >
              <Icon name="Plus" size={12} />
              Add note to context plan
            </button>
          </div>
        </div>

        {/* 6 source tabs */}
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 14 }}>
          {sourceGroups.map((s, i) => (
            <button
              key={s.type}
              onClick={() => setTab(i)}
              className="btn sm"
              style={{
                borderColor: tab === i ? 'var(--accent)' : 'var(--border-1)',
                color: tab === i ? 'var(--accent)' : 'var(--ink-2)',
                background: tab === i ? 'var(--accent-soft)' : 'var(--bg-surface)',
              }}
            >
              <Icon name={s.icon} size={13} />
              {s.tab}
            </button>
          ))}
        </div>

        {/* Bills: search-any-bill bar (mirrors client profile → Tracker). */}
        {activeGroup?.type === 'bills' && (
          <BillContextSearch
            clientId={clientId}
            addedRefIds={addedRefIds}
            addingId={addingId}
            onAdd={(it) => addSource(activeGroup, it)}
          />
        )}

        {/* active tab items */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {activeGroup && activeGroup.items.length > 0 ? (
            activeGroup.items.map((it) => (
              <SourceRow
                key={it.id}
                icon={activeGroup.icon}
                title={it.t}
                sub={it.sub}
                added={addedRefIds.has(it.id)}
                adding={addingId === it.id}
                onAdd={() => addSource(activeGroup, it)}
              />
            ))
          ) : (
            <div
              style={{
                fontSize: 12.5,
                color: 'var(--ink-3)',
                padding: '14px 2px',
                fontStyle: 'italic',
              }}
            >
              {activeGroup?.type === 'bills'
                ? 'No bills on the Tracker board yet — search above to add any bill, or track bills from the client profile → Tracker.'
                : `Nothing to pull from ${activeGroup?.tab ?? 'this source'} yet${
                    client ? ` for ${client}` : ''
                  }.`}
            </div>
          )}
        </div>

        {/* Relevant news (correction #1 — OUR systems) */}
        <NewsSection articles={newsCards} addedIds={addedRefIds} onAdd={addNews} />
      </div>

      {/* ── RIGHT: context plan ──────────────────────────────────────────────── */}
      <div
        style={{
          background: 'var(--bg-surface)',
          padding: 16,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 700 }}>Context plan</span>
          <span className="pill info">Meri uses this</span>
        </div>

        {/* Shared / document group: persisted source + free-text items. */}
        <PlanGroup
          icon="Globe"
          label={showOffices ? 'Shared · every office' : 'Document context'}
          items={planItems.filter((it) => it.kind === 'source' || it.kind === 'free-text')}
          onRemove={(id) => removeItem.mutate(id)}
        />

        {/* Added news group. */}
        {planItems.some((it) => it.kind === 'news') && (
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-1)' }}>
            <PlanGroup
              icon="Newspaper"
              label="News"
              items={planItems.filter((it) => it.kind === 'news')}
              onRemove={(id) => removeItem.mutate(id)}
            />
          </div>
        )}

        {/* Per-office auto-derived groups (correction #3) — only when personalized. */}
        {showPersonalizedGroups && offices.map((who) => <OfficePlanGroup key={who} who={who} />)}

        <div style={{ display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 12 }}>
          <button
            className="btn"
            style={{ flex: 'none' }}
            onClick={() => navigate(`/workspace/setup/${draftId}`)}
            title="Back to Setup"
          >
            <Icon name="ArrowLeft" size={14} />
          </button>
          <button
            className="btn btn-accent"
            style={{ flex: 1, justifyContent: 'center' }}
            onClick={openEditor}
            disabled={drafting}
          >
            {drafting ? 'Meri is drafting…' : 'Open editor'}
            <Icon name="ArrowRight" size={14} />
          </button>
        </div>
      </div>
      {drafting && (
        <MeriDraftingOverlay
          title="Meri is drafting your document…"
          detail="Drafting each section from your setup and the context you built. This can take a moment."
        />
      )}
    </div>
  );
}

// ── PlanGroup — a labeled list of persisted context items in the right panel ─────
function PlanGroup({
  icon,
  label,
  items,
  onRemove,
}: {
  icon: string;
  label: string;
  items: WsContextItem[];
  onRemove: (id: string) => void;
}) {
  const labelOf = (it: WsContextItem): string => {
    if (it.kind === 'free-text') return String((it.payload as { text?: string }).text ?? 'Note');
    if (it.kind === 'news') return String((it.payload as { headline?: string }).headline ?? 'News');
    return String((it.payload as { label?: string }).label ?? it.kind);
  };
  const iconOf = (it: WsContextItem): string =>
    it.kind === 'free-text' ? 'StickyNote' : it.kind === 'news' ? 'Newspaper' : icon;
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          fontWeight: 600,
          color: 'var(--ink-2)',
          marginBottom: 6,
        }}
      >
        <Icon name={icon} size={12} />
        {label}
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 11, color: 'var(--ink-3)', fontStyle: 'italic', padding: '2px 0' }}>
          Nothing added yet.
        </div>
      ) : (
        items.map((it) => (
          <div
            key={it.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 9px',
              background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-1)',
              borderRadius: 6,
              marginBottom: 5,
            }}
          >
            <Icon name={iconOf(it)} size={13} style={{ color: 'var(--accent)', flex: 'none' }} />
            <span
              style={{
                fontSize: 11.5,
                flex: 1,
                minWidth: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {labelOf(it)}
            </span>
            <button
              onClick={() => onRemove(it.id)}
              title="Remove"
              style={{
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                display: 'grid',
                placeItems: 'center',
                padding: 0,
              }}
            >
              <Icon name="X" size={12} style={{ color: 'var(--ink-3)' }} />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

// ── OfficePlanGroup — per-office auto-derived facts + a Meri note (read-only v1) ─
function OfficePlanGroup({ who }: { who: string }) {
  const api = useApi();
  // Resolve the member name → directory contact (correction #2/#3).
  const { data: contactData } = useQuery({
    queryKey: ['ws-ctx-office', who],
    queryFn: async () =>
      (
        await api.get<DirContactsResponse>('/api/directory/contacts', {
          params: { q: who, pageSize: 1, sort: 'name-asc' },
        })
      ).data,
  });
  const contact =
    (contactData?.contacts ?? []).find((c) => c.fullName === who) ??
    contactData?.contacts?.[0] ??
    null;

  // Recent press for this member (DB-backed; no live fetch on read).
  const { data: newsData } = useQuery({
    queryKey: ['ws-ctx-office-news', contact?.id],
    enabled: !!contact?.id,
    queryFn: async () =>
      (await api.get<MemberNewsPayload>(`/api/directory/contacts/${contact!.id}/news`)).data,
  });

  // Auto-derived facts from the member's directory profile + recent press.
  const facts: string[] = [];
  if (contact) {
    const loc = [contact.state, contact.district ? `Dist ${contact.district}` : '', contact.chamber]
      .filter(Boolean)
      .join(' · ');
    if (loc) facts.push(loc);
    const lead = (contact.committeeLeadership ?? []).slice(0, 1);
    const comm = (contact.committees ?? []).slice(0, lead.length ? 1 : 2);
    [...lead, ...comm].forEach((c) => facts.push(c));
    const issues = (contact.topIssues ?? []).slice(0, 2).map((t) => t.issue);
    if (issues.length) facts.push(`Top issues: ${issues.join(', ')}`);
    if (contact.bio?.hometown) facts.push(`Hometown: ${contact.bio.hometown}`);
  }
  const pressCount = newsData?.items?.length ?? 0;
  if (pressCount)
    facts.push(`${pressCount} recent press item${pressCount === 1 ? '' : 's'} on file`);

  const note = contact
    ? `Auto-derived from ${contact.memberName || who}'s directory profile${pressCount ? ' and recent coverage' : ''}. Meri tailors office-specific sections to these facts.`
    : `No directory match for ${who} yet — add facts as free-text or via the source tabs.`;

  return (
    <div style={{ marginBottom: 11, paddingTop: 11, borderTop: '1px solid var(--border-1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
        <MiniAva x={initialsOf(who)} size={22} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>{who}</span>
        {contact && (
          <span style={{ fontSize: 10.5, color: 'var(--ink-3)' }} className="num">
            {[contact.state, contact.district ? `Dist ${contact.district}` : '']
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </div>
      {facts.map((a, j) => (
        <div
          key={j}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 9px',
            background: 'var(--bg-surface-2)',
            border: '1px solid var(--border-1)',
            borderRadius: 6,
            marginBottom: 5,
          }}
        >
          <span className="dot info" />
          <span style={{ fontSize: 11.5 }}>{a}</span>
        </div>
      ))}
      <MeriCallout style={{ padding: '6px 9px', borderRadius: 6 }}>{note}</MeriCallout>
    </div>
  );
}

// ── NewsSection (asset_13) — articles from OUR systems ──────────────────────────
function NewsSection({
  articles,
  addedIds,
  onAdd,
}: {
  articles: NewsCard[];
  addedIds: Set<string>;
  onAdd: (a: NewsCard) => void;
}) {
  if (!articles || articles.length === 0) return null;
  return (
    <div style={{ marginTop: 20, paddingTop: 20, borderTop: '1px solid var(--border-1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Icon name="Newspaper" size={14} style={{ color: 'var(--ink-2)' }} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink-1)' }}>
          Relevant news
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 18,
            height: 18,
            padding: '0 5px',
            borderRadius: 9,
            background: 'var(--bg-surface-2)',
            border: '1px solid var(--border-1)',
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--ink-2)',
          }}
        >
          {articles.length}
        </span>
        <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
          Meri can reference this coverage when drafting.
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {articles.map((a) => {
          const added = addedIds.has(a.id);
          return (
            <div
              key={a.id}
              style={{
                padding: '12px 13px',
                border: '1px solid',
                borderColor: added ? 'var(--accent)' : 'var(--border-1)',
                borderRadius: 8,
                background: added ? 'var(--accent-soft)' : 'var(--bg-surface)',
                transition: 'border-color 0.15s, background 0.15s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    flex: 1,
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--ink-1)',
                    textDecoration: 'none',
                    lineHeight: 1.4,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                  onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                >
                  {a.headline}
                </a>
                <Icon
                  name="ExternalLink"
                  size={12}
                  style={{ color: 'var(--ink-3)', flexShrink: 0, marginTop: 3 }}
                />
              </div>
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 8 }}>
                {[a.source, a.date].filter(Boolean).join(' · ')}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, flex: 1 }}>
                  <span
                    className="pill"
                    style={{
                      background: 'var(--bg-surface-2)',
                      border: '1px solid var(--border-1)',
                      color: 'var(--ink-2)',
                      textTransform: 'none',
                      letterSpacing: 0,
                      fontWeight: 500,
                    }}
                  >
                    {a.origin === 'member-press' ? 'Member press' : 'Intel feed'}
                  </span>
                  {a.relevantOffices.map((o) => (
                    <span
                      key={o}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '2px 7px',
                        borderRadius: 10,
                        background: 'var(--bg-surface-2)',
                        border: '1px solid var(--border-1)',
                        fontSize: 10,
                        color: 'var(--ink-2)',
                        fontWeight: 500,
                      }}
                    >
                      {o}
                    </span>
                  ))}
                </div>
                <button
                  onClick={() => !added && onAdd(a)}
                  className="btn sm"
                  style={{
                    borderColor: added ? 'var(--accent)' : 'var(--border-1)',
                    background: added ? 'var(--accent-soft)' : 'transparent',
                    color: added ? 'var(--accent-ink)' : 'var(--ink-2)',
                    flexShrink: 0,
                  }}
                >
                  <Icon name={added ? 'Check' : 'Plus'} size={12} />
                  {added ? 'Added' : 'Add to context plan'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── data hooks ──────────────────────────────────────────────────────────────────

/**
 * The 6 source tabs, wired to the SELECTED client's real data (client is
 * required in Setup). Each item carries a `text` grounding body persisted into
 * the context-item payload so Meri generation actually uses it.
 *   - Client profile → overview + capabilities + facilities + people
 *   - Intel          → the client's budget identifiers (PE numbers + issue codes)
 *   - Prior docs     → this client's completed workspace drafts
 *   - Bills          → the client's Tracker board (.../tracker/board) + a search-any-bill
 *                      bar (.../tracker/bill-search) — same source as client profile → Tracker
 *   - Meeting preps  → /api/engagement/outreach/context-library (this client's preps)
 *   - Docs & notes   → /api/engagement/attachments?clientId (content pulled on add)
 */
/**
 * One source row — title + optional subtitle + an "Add to context plan" button.
 * Shared by the source-tab list and the bill-search results so they stay visually
 * identical and share the added/adding states.
 */
function SourceRow({
  icon,
  title,
  sub,
  added,
  adding,
  onAdd,
}: {
  icon: string;
  title: string;
  sub?: string;
  added: boolean;
  adding: boolean;
  onAdd: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        padding: '10px 12px',
        border: '1px solid',
        borderColor: added ? 'var(--accent)' : 'var(--border-1)',
        borderRadius: 8,
        background: added ? 'var(--accent-soft)' : 'var(--bg-surface)',
      }}
    >
      <Icon name={icon} size={15} style={{ color: 'var(--accent)', flex: 'none' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{title}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{sub}</div>}
      </div>
      <button
        className="btn sm"
        disabled={added || adding}
        onClick={onAdd}
        style={{
          borderColor: added ? 'var(--accent)' : 'var(--border-1)',
          background: added ? 'var(--accent-soft)' : 'transparent',
          color: added ? 'var(--accent-ink)' : 'var(--ink-2)',
          flexShrink: 0,
          ...(adding ? { opacity: 0.6, cursor: 'wait' } : {}),
        }}
      >
        <Icon name={added ? 'Check' : 'Plus'} size={12} />
        {added ? 'Added' : adding ? 'Adding…' : 'Add to context plan'}
      </button>
    </div>
  );
}

/**
 * Search-any-bill bar for the Bills tab — mirrors the client-profile Tracker's
 * search (same GET .../tracker/bill-search endpoint). Lets the user pull ANY
 * bill into the context plan, not just the ones already on the Tracker board.
 */
function BillContextSearch({
  clientId,
  addedRefIds,
  addingId,
  onAdd,
}: {
  clientId: string | null;
  addedRefIds: Set<string>;
  addingId: string | null;
  onAdd: (it: SourceItem) => void;
}) {
  const api = useApi();
  const [q, setQ] = useState('');
  const debouncedQ = useDebouncedValue(q.trim(), 250);
  const active = !!clientId && debouncedQ.length >= 2;

  const { data: results, isFetching } = useQuery({
    queryKey: ['ws-ctx-bill-search', clientId, debouncedQ],
    enabled: active,
    staleTime: 30_000,
    queryFn: async () =>
      (
        await api.get<{ billId: string; displayNum: string; title: string | null }[]>(
          `/api/intelligence/clients/${clientId}/tracker/bill-search`,
          { params: { q: debouncedQ } },
        )
      ).data,
  });

  const items: SourceItem[] = (results ?? []).map((r) => ({
    id: `bill-${r.billId}`,
    t: r.displayNum,
    sub: r.title ?? undefined,
    text: [r.displayNum, r.title].filter(Boolean).join(' — '),
  }));

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ position: 'relative' }}>
        <Icon
          name="Search"
          size={14}
          style={{
            position: 'absolute',
            left: 11,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--ink-3)',
            pointerEvents: 'none',
          }}
        />
        <input
          className="field"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={!clientId}
          placeholder="Search any bill to add — e.g. “H.R. 4455”, “transmission”, “data center”…"
          style={{
            width: '100%',
            padding: '9px 12px 9px 32px',
            fontSize: 12.5,
            boxSizing: 'border-box',
            border: '1px solid var(--border-1)',
            borderRadius: 8,
            background: 'var(--bg-surface)',
            opacity: clientId ? 1 : 0.6,
          }}
        />
      </div>
      {active && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {isFetching && !items.length ? (
            <div style={{ fontSize: 12, color: 'var(--ink-3)', padding: '6px 2px' }}>
              Searching…
            </div>
          ) : items.length ? (
            items.map((it) => (
              <SourceRow
                key={it.id}
                icon="Scale"
                title={it.t}
                sub={it.sub}
                added={addedRefIds.has(it.id)}
                adding={addingId === it.id}
                onAdd={() => onAdd(it)}
              />
            ))
          ) : (
            <div
              style={{
                fontSize: 12,
                color: 'var(--ink-3)',
                padding: '6px 2px',
                fontStyle: 'italic',
              }}
            >
              No bills match “{debouncedQ}”.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Resolve a client NAME → id (every client-scoped endpoint keys on the id).
 * Shared by useSourceGroups and the bill-search bar; the clients-list query is
 * deduped by react-query (identical queryKey) so calling it twice costs one fetch.
 */
function useClientId(client: string | null): string | null {
  const api = useApi();
  const { data: clients } = useQuery({
    queryKey: ['ws-clients-list'],
    enabled: !!client,
    queryFn: async () => (await api.get<{ id: string; name: string }[]>('/api/clients')).data,
  });
  return useMemo(
    () => (clients ?? []).find((c) => c.name === client)?.id ?? null,
    [clients, client],
  );
}

function useSourceGroups(client: string | null): SourceGroup[] {
  const api = useApi();
  const clientId = useClientId(client);

  const { data: overview } = useQuery({
    queryKey: ['ws-ctx-client', clientId],
    enabled: !!clientId,
    queryFn: async () =>
      (
        await api.get<{
          id: string;
          name: string;
          description: string | null;
          productDescription: string | null;
          sectorTag: string | null;
          website: string | null;
          issueCodes?: string[];
        }>(`/api/clients/${clientId}`)
      ).data,
  });

  const { data: capabilities } = useQuery({
    queryKey: ['ws-ctx-caps', clientId],
    enabled: !!clientId,
    queryFn: async () =>
      (
        await api.get<
          {
            id: string;
            name: string;
            type: string | null;
            sector: string | null;
            description: string | null;
            justification: string | null;
            peNumber: string | null;
            peNumbers?: string[];
            appropriationAccount: string | null;
            serviceBranch: string | null;
          }[]
        >(`/api/clients/${clientId}/capabilities`)
      ).data,
  });

  const { data: facilities } = useQuery({
    queryKey: ['ws-ctx-facilities', clientId],
    enabled: !!clientId,
    queryFn: async () =>
      (
        await api.get<
          {
            id: string;
            name: string;
            city: string | null;
            state: string | null;
            congressionalDistrict: string | null;
            employeeCount: number | null;
          }[]
        >(`/api/clients/${clientId}/facilities`)
      ).data,
  });

  const { data: people } = useQuery({
    queryKey: ['ws-ctx-client-people', clientId],
    enabled: !!clientId,
    queryFn: async () =>
      (
        await api.get<
          {
            id: string;
            fullName: string | null;
            email: string | null;
            title: string | null;
            role: string | null;
          }[]
        >(`/api/clients/${clientId}/people`)
      ).data,
  });

  // Bills = the client's TRACKER BOARD (the bills tracked under client profile →
  // Tracker). Same trackedBill source, flattened out of the kanban columns so the
  // Context Builder mirrors exactly what's on the board. A search bar below
  // (BillContextSearch) lets the user pull in ANY bill, tracked or not.
  const { data: board } = useQuery({
    queryKey: ['ws-ctx-tracker-board', clientId],
    enabled: !!clientId,
    queryFn: async () =>
      (
        await api.get<{
          columns: {
            bills: { billId: string; displayNum: string; title: string | null }[];
          }[];
        }>(`/api/intelligence/clients/${clientId}/tracker/board`)
      ).data,
  });

  const { data: contextLib } = useQuery({
    queryKey: ['ws-ctx-library'],
    enabled: !!clientId,
    queryFn: async () =>
      (
        await api.get<{
          preps: {
            id: string;
            clientId: string | null;
            title: string | null;
            body: string | null;
            date: string | null;
          }[];
        }>('/api/engagement/outreach/context-library')
      ).data,
  });

  const { data: attachments } = useQuery({
    queryKey: ['ws-ctx-attachments', clientId],
    enabled: !!clientId,
    queryFn: async () =>
      (
        await api.get<
          { id: string; fileName: string; contentType: string | null; createdAt: string }[]
        >('/api/engagement/attachments', { params: { clientId } })
      ).data,
  });

  // Prior docs → this client's completed workspace drafts.
  const { data: drafts } = useDrafts();

  return useMemo(() => {
    // Client profile: overview + capabilities + facilities + people.
    const clientItems: SourceItem[] = [];
    if (overview) {
      clientItems.push({
        id: `overview-${overview.id}`,
        t: `${overview.name} — overview`,
        sub: [overview.sectorTag, overview.website].filter(Boolean).join(' · ') || undefined,
        text: [
          `${overview.name}${overview.sectorTag ? ` (${overview.sectorTag})` : ''}`,
          overview.description,
          overview.productDescription,
        ]
          .filter(Boolean)
          .join('\n'),
      });
    }
    for (const c of capabilities ?? []) {
      clientItems.push({
        id: `cap-${c.id}`,
        t: c.name,
        sub: [c.type, c.sector].filter(Boolean).join(' · ') || undefined,
        text: [
          `Capability: ${c.name}`,
          c.description,
          c.justification,
          c.peNumber ? `PE ${c.peNumber}` : null,
          [c.serviceBranch, c.appropriationAccount].filter(Boolean).join(' · ') || null,
        ]
          .filter(Boolean)
          .join('\n'),
      });
    }
    for (const f of facilities ?? []) {
      const loc = [f.city, f.state].filter(Boolean).join(', ');
      const dist =
        f.state && f.congressionalDistrict ? `${f.state}-${f.congressionalDistrict}` : '';
      clientItems.push({
        id: `fac-${f.id}`,
        t: f.name,
        sub: [loc, dist].filter(Boolean).join(' · ') || undefined,
        text: [
          `Facility: ${f.name}`,
          loc,
          dist ? `District ${dist}` : null,
          f.employeeCount ? `${f.employeeCount} employees` : null,
        ]
          .filter(Boolean)
          .join(' — '),
      });
    }
    for (const p of people ?? []) {
      const name = p.fullName?.trim() || p.email?.trim() || 'Unnamed contact';
      clientItems.push({
        id: `person-${p.id}`,
        t: name,
        sub: [p.role || p.title, client].filter(Boolean).join(' · ') || undefined,
        text: `Client contact: ${name}${p.role || p.title ? ` — ${p.role || p.title}` : ''}`,
      });
    }

    // Intel: budget identifiers (capability PE numbers + LDA issue codes).
    const intelItems: SourceItem[] = [];
    const peSeen = new Set<string>();
    for (const c of capabilities ?? []) {
      for (const pe of [c.peNumber, ...(c.peNumbers ?? [])].filter((x): x is string => !!x)) {
        if (peSeen.has(pe)) continue;
        peSeen.add(pe);
        intelItems.push({
          id: `intel-pe-${pe}`,
          t: `PE ${pe}`,
          sub: c.name,
          text: `Program element ${pe} (${c.name}${c.serviceBranch ? `, ${c.serviceBranch}` : ''})`,
        });
      }
    }
    for (const code of overview?.issueCodes ?? []) {
      intelItems.push({
        id: `intel-issue-${code}`,
        t: `Issue ${code}`,
        sub: 'LDA issue code',
        text: `Lobbying issue area: ${code}`,
      });
    }

    // Bills: the client's tracked bills, straight off the Tracker board.
    const billItems: SourceItem[] = (board?.columns ?? [])
      .flatMap((c) => c.bills)
      .map((b) => ({
        id: `bill-${b.billId}`,
        t: b.displayNum,
        sub: b.title ?? undefined,
        text: [b.displayNum, b.title].filter(Boolean).join(' — '),
      }));

    // Meeting preps for this client.
    const prepItems: SourceItem[] = (contextLib?.preps ?? [])
      .filter((p) => !clientId || p.clientId === clientId)
      .slice(0, 10)
      .map((p) => ({
        id: `prep-${p.id}`,
        t: p.title || 'Meeting prep',
        sub: p.date ? fmtDate(p.date) : 'Meeting prep',
        text: [p.title, p.body].filter(Boolean).join('\n'),
      }));

    // Documents (content pulled lazily on add via extract-text).
    const docItems: SourceItem[] = (attachments ?? []).map((a) => ({
      id: `doc-${a.id}`,
      t: a.fileName,
      sub: [a.contentType, fmtDate(a.createdAt)].filter(Boolean).join(' · ') || undefined,
    }));

    // Prior docs: this client's completed workspace drafts.
    const priorItems: SourceItem[] = (drafts ?? [])
      .filter((d) => !!client && d.client === client && d.status === 'complete')
      .slice(0, 12)
      .map((d) => ({
        id: `wsdraft-${d.id}`,
        t: d.docTitle,
        sub: d.product ?? undefined,
        text: `Prior document: ${d.docTitle}${d.product ? ` (${d.product})` : ''}`,
      }));

    return [
      { type: 'client-profile', tab: 'Client profile', icon: 'Building2', items: clientItems },
      { type: 'intel', tab: 'Intel', icon: 'Radar', items: intelItems },
      { type: 'prior-docs', tab: 'Prior docs', icon: 'FileText', items: priorItems },
      { type: 'bills', tab: 'Bills', icon: 'Scale', items: billItems },
      { type: 'meeting-preps', tab: 'Meeting preps', icon: 'Users', items: prepItems },
      { type: 'docs-notes', tab: 'Docs & notes', icon: 'Paperclip', items: docItems },
    ];
  }, [
    overview,
    capabilities,
    facilities,
    people,
    board,
    contextLib,
    attachments,
    drafts,
    client,
    clientId,
  ]);
}

/**
 * Relevant news from OUR systems (correction #1):
 *  - member press per selected office: GET /api/directory/contacts/:id/news
 *  - general intel feed:               GET /api/explorer/intel-articles (client query)
 * Deduped by url; member-press first.
 */
function useNewsCards(client: string | null, offices: string[]): NewsCard[] {
  const api = useApi();

  // Resolve each office name → directory contact id (then fetch its press).
  const officeContacts = useQuery({
    queryKey: ['ws-news-office-contacts', offices],
    enabled: offices.length > 0,
    queryFn: async () => {
      const results = await Promise.all(
        offices.map(async (who) => {
          const { data } = await api.get<DirContactsResponse>('/api/directory/contacts', {
            params: { q: who, pageSize: 1, sort: 'name-asc' },
          });
          const contact = data.contacts.find((c) => c.fullName === who) ?? data.contacts[0] ?? null;
          return contact ? { who, id: contact.id } : null;
        }),
      );
      return results.filter((x): x is { who: string; id: string } => !!x);
    },
  });
  const resolved = officeContacts.data ?? [];

  const memberNews = useQuery({
    queryKey: ['ws-news-member', resolved.map((r) => r.id)],
    enabled: resolved.length > 0,
    queryFn: async () => {
      const all = await Promise.all(
        resolved.map(async (r) => {
          const { data } = await api.get<MemberNewsPayload>(`/api/directory/contacts/${r.id}/news`);
          return (data.items ?? []).slice(0, 4).map(
            (it): NewsCard => ({
              id: `mp-${it.id}`,
              // Decode HTML entities: feed titles store &#8217;/&amp;/&#39; raw,
              // which JSX renders literally (the reported apostrophe bug).
              headline: decodeHtmlEntities(it.title),
              url: it.link,
              source: data.memberName || r.who,
              date: fmtDate(it.publishedAt),
              origin: 'member-press',
              relevantOffices: [r.who],
              summary: decodeHtmlEntities(it.summary),
            }),
          );
        }),
      );
      return all.flat();
    },
  });

  // General intel feed, biased toward the client (q=client name).
  const intel = useQuery({
    queryKey: ['ws-news-intel', client],
    queryFn: async () =>
      (
        await api.get<ExplorerResponse<IntelArticleRow>>('/api/explorer/intel-articles', {
          params: { q: client || undefined, page: 1, pageSize: 8 },
        })
      ).data,
  });

  return useMemo(() => {
    const fromMembers = memberNews.data ?? [];
    const fromIntel: NewsCard[] = (intel.data?.rows ?? []).map((a) => ({
      id: `ia-${a.id}`,
      headline: decodeHtmlEntities(a.title),
      url: a.url,
      source: a.source,
      date: fmtDate(a.publishedAt),
      origin: 'intel-feed',
      relevantOffices: [],
      summary: decodeHtmlEntities(a.summary),
    }));
    // Dedupe by url; member press takes precedence.
    const seen = new Set<string>();
    const out: NewsCard[] = [];
    for (const card of [...fromMembers, ...fromIntel]) {
      const key = card.url || card.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(card);
    }
    return out.slice(0, 12);
  }, [memberNews.data, intel.data]);
}
