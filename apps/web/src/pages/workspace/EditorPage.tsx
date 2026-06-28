/**
 * Workspace Editor — Phase 5 core, built to the locked prototype (asset_14 +
 * asset_07 + asset_12). Replaces the v0 editor.
 *
 * Layout (matches the prototype): a full-height shell with the EditorToolbar and
 * the RichTextToolbar pinned at top, then a scrolling 4-column grid:
 *   StepsRail (208) · document canvas (1fr) · InsertRail (74) · MeriPanel (300).
 *
 * Autosave (Q-ED-7 + binding decision): the FULL document model is debounced
 * (~1.2s). `cfg` (sections, sectionContent, sectionMeta, ask, anonymize, …) is
 * persisted via useUpdateDraft; each packet tab's edited body is persisted via
 * useUpdateDocument. "Save draft" flushes immediately. The toolbar shows
 * Saving…/Saved.
 *
 * Rich text: section + packet bodies use a CONTROLLED contentEditable
 * (editor/rich-text.tsx) that stores sanitized HTML and syncs external values
 * only while unfocused. The RichTextToolbar drives the active editor only — no
 * global execCommand.
 *
 * Phase 6b (WIRED): pre-submission Checks popover (live rule-based score),
 * Version-history popover (snapshot on Save draft + restore), and the two-sided
 * concurrent-edit lock (auto-acquire + heartbeat + view-only banner + request /
 * take-over, polled). View-only disables the canvas editors but keeps commenting.
 *
 * Still deferred (layout present): Insert→Templates picker, Insert→Table-type
 * picker, Meri chat editing. These toast / no-op.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { App as AntApp, Spin } from 'antd';
import { StepsRail } from './StepsRail.js';
import {
  useAddDocument,
  useCollaborators,
  useComments,
  useCreateComment,
  useCreateVersion,
  useDeleteDocument,
  useDraft,
  useDraftChecks,
  useGenerateSection,
  useTenantMembers,
  useUpdateDocument,
  useUpdateDraft,
  initials,
} from './api.js';
import { useMe } from '../../lib/me.js';
import type { WsAsk, WsBlock, WsConfig, WsDocument, WsSectionMeta, WsTemplate } from './types.js';
import { EditorToolbar, type SaveStatus } from './editor/EditorToolbar.js';
import { RichTextToolbar } from './editor/RichTextToolbar.js';
import { DraftOutline } from './editor/DraftOutline.js';
import { OfficeRow } from './editor/OfficeRow.js';
import { DocTabs, type DocTab } from './editor/DocTabs.js';
import { PaperBody } from './editor/PaperBody.js';
import { PacketDocCanvas, type PacketBody } from './editor/PacketDocCanvas.js';
import { Letterhead } from './editor/canvas-blocks.js';
import { InsertRail } from './editor/InsertRail.js';
import { MeriPanel } from './editor/MeriPanel.js';
import { AnonymizeReview, type AnonymizeMap } from './editor/AnonymizeReview.js';
import { ChecksPopover } from './editor/ChecksPopover.js';
import { VersionPopover } from './editor/VersionPopover.js';
import { LockBanner } from './editor/LockBanner.js';
import { useEditLock } from './editor/useEditLock.js';
import type { WsCheckResult } from './types.js';
import { budgetFrom } from './editor/BudgetBlock.js';
import { sectionViews } from './editor/section-model.js';
import { anonymizeMap, type StoredRedaction } from './editor/anonymize.js';
import {
  applyEditToSectionHtml,
  getSelectionAnchor,
  highlightSelection,
  type CommentAnchor,
} from './editor/anchors.js';
import type { ComposingComment } from './editor/CommentsRail.js';

const AUTOSAVE_MS = 1200;
// E-16: at most one autosave version checkpoint per this interval of active editing.
const VERSION_CHECKPOINT_MS = 5 * 60_000;
const MAIN_TAB = 'main';

export function EditorPage() {
  const { draftId } = useParams();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { data: draft, isLoading } = useDraft(draftId ?? null);

  const updateDraft = useUpdateDraft(draftId ?? '');
  const updateDocument = useUpdateDocument(draftId ?? '');
  const addDocument = useAddDocument(draftId ?? '');
  const deleteDocument = useDeleteDocument(draftId ?? '');
  const generate = useGenerateSection(draftId ?? '');

  // E-17: real collaborator avatars (owner + active collaborators), resolving
  // clerk ids to initials via the tenant roster. No seed avatars.
  const { data: collaborators } = useCollaborators(draftId ?? null);
  const { data: tenantMembers } = useTenantMembers();
  const collaboratorInitials = useMemo(() => {
    const byClerk = new Map((tenantMembers ?? []).map((m) => [m.clerkUserId, m]));
    return (collaborators ?? [])
      .filter((c) => c.status === 'active')
      .map((c) => {
        const m = c.subjectId ? byClerk.get(c.subjectId) : undefined;
        return initials(m?.name || c.name || c.email || '?');
      });
  }, [collaborators, tenantMembers]);
  const createVersion = useCreateVersion(draftId ?? '');
  const { data: me } = useMe();

  // ── Local working copies (the autosave debounce flushes these to the API) ──
  const [cfg, setCfg] = useState<WsConfig | null>(null);
  const [docTitle, setDocTitle] = useState('');
  // Per-document body working copies for non-main packet docs, keyed by doc id.
  const [packetBodies, setPacketBodies] = useState<Record<string, PacketBody>>({});
  // Inserted media blocks on the MAIN doc (photo/table/logo). Persisted in cfg.
  const [mainBlocks, setMainBlocks] = useState<WsBlock[]>([]);

  const [activeTab, setActiveTab] = useState<string>(MAIN_TAB);
  const [activeOffice, setActiveOffice] = useState<string | null>(null);
  // E-9: id of the block just inserted — scrolled into view + flashed.
  const [justInserted, setJustInserted] = useState<string | null>(null);
  useEffect(() => {
    if (!justInserted) return;
    // Runs after the new block has rendered, so getElementById resolves.
    document
      .getElementById(`ws-block-${justInserted}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setJustInserted(null), 1300);
    return () => clearTimeout(t);
  }, [justInserted]);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [draftingSection, setDraftingSection] = useState<string | null>(null);

  // ── Phase 6: rail tab, comment composing, selection FAB, anonymize modal ────
  const [railTab, setRailTab] = useState<'meri' | 'comments'>('meri');
  const [composing, setComposing] = useState<ComposingComment | null>(null);
  // Floating "Comment" button anchored at a live canvas selection.
  const [selectionFab, setSelectionFab] = useState<{ top: number; left: number } | null>(null);
  const [showAnonymizeReview, setShowAnonymizeReview] = useState(false);
  // Phase 6b: which toolbar popover is open (mutually exclusive).
  const [popover, setPopover] = useState<'checks' | 'history' | null>(null);

  // The engine document the active canvas maps to (comment scope). The MAIN
  // canvas is the primary WsDocument (lowest ordinal); packet tabs are their own
  // doc id. Derived before the load guard so the comments hook order is stable.
  const activeDocumentId = useMemo(() => {
    if (!draft) return null;
    if (activeTab === MAIN_TAB) {
      const primary = [...draft.documents].sort((a, b) => a.ordinal - b.ordinal)[0];
      return primary?.id ?? null;
    }
    return activeTab;
  }, [draft, activeTab]);

  const { data: commentsData } = useComments(activeDocumentId);
  const createComment = useCreateComment(activeDocumentId ?? '');
  const comments = commentsData ?? [];
  const openCommentsCount = comments.filter((c) => !c.resolved).length;

  const selfClerkId = me?.user.clerkUserId ?? null;
  const selfName =
    `${me?.user.firstName ?? ''} ${me?.user.lastName ?? ''}`.trim() || me?.user.email || 'You';

  // ── Phase 6b: live pre-submission checks (toolbar score + popover) ──────────
  const { data: checks, isLoading: checksLoading } = useDraftChecks(draftId ?? null);

  // ── Phase 6b: concurrent-edit lock (auto-acquire, heartbeat, release) ───────
  const editLock = useEditLock(draftId ?? null, selfName);
  const viewOnly = !!editLock.lock.holderId && !editLock.canEdit;

  const hydrated = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Dirty trackers so the debounce only writes what changed.
  const cfgDirty = useRef(false);
  const dirtyDocs = useRef<Set<string>>(new Set());

  // Hydrate the local working copies from the draft once it loads (Q-DOC-2:
  // open on the draft's OWN data, including Meri-intake auto-drafted content).
  useEffect(() => {
    if (!draft || hydrated.current) return;
    hydrated.current = true;
    setCfg(draft.config);
    setDocTitle(draft.docTitle);
    setMainBlocks(((draft.config.mainBlocks as WsBlock[] | undefined) ?? []).slice());
    const bodies: Record<string, PacketBody> = {};
    for (const d of draft.documents) {
      bodies[d.id] = normalizeBody(d);
    }
    setPacketBodies(bodies);
    setActiveOffice(draft.config.offices?.[0] ?? null);
  }, [draft]);

  // ── Autosave: debounce the full document model (cfg + packet bodies) ────────
  // `flush` closes over the latest cfg/bodies; the debounce timer dispatches
  // through `flushRef` so a fired timer always runs the freshest flush (not a
  // stale closure captured when the timer was set).
  const flushRef = useRef<(manual: boolean) => void>(() => {});
  const lastCheckpoint = useRef(0); // E-16: last autosave version checkpoint time
  const scheduleSave = useCallback(() => {
    if (!draftId) return;
    setSaveStatus('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => flushRef.current(false), AUTOSAVE_MS);
  }, [draftId]);

  const flush = useCallback(
    (manual: boolean) => {
      if (!draftId) return;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const tasks: Promise<unknown>[] = [];
      // cfg + title.
      if (cfgDirty.current && cfg) {
        cfgDirty.current = false;
        tasks.push(
          updateDraft.mutateAsync({
            docTitle,
            config: { ...cfg, mainBlocks } as Partial<WsConfig>,
          }),
        );
      }
      // each dirty packet body.
      for (const docId of dirtyDocs.current) {
        const body = packetBodies[docId];
        if (!body) continue;
        tasks.push(
          updateDocument.mutateAsync({
            docId,
            body: { body: { blocks: body.blocks, title: body.title } },
          }),
        );
      }
      dirtyDocs.current.clear();

      const hadChanges = tasks.length > 0;
      Promise.allSettled(tasks).then(() => {
        setSaveStatus('saved');
        if (manual) message.success('Saved to Documents');
        // E-16: snapshot a throttled version checkpoint on autosave so version
        // history is populated without a manual "Save draft" button (E-20).
        if (hadChanges && draftId) {
          const now = Date.now();
          if (now - lastCheckpoint.current > VERSION_CHECKPOINT_MS) {
            lastCheckpoint.current = now;
            createVersion.mutate({ label: 'Autosave' });
          }
        }
      });
    },
    [
      draftId,
      cfg,
      docTitle,
      mainBlocks,
      packetBodies,
      updateDraft,
      updateDocument,
      createVersion,
      message,
    ],
  );
  flushRef.current = flush;

  // Flush any pending save on unmount.
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  // ── cfg mutation helper ─────────────────────────────────────────────────────
  const patchCfg = useCallback(
    (partial: Partial<WsConfig>) => {
      setCfg((prev) => (prev ? { ...prev, ...partial } : prev));
      cfgDirty.current = true;
      scheduleSave();
    },
    [scheduleSave],
  );

  // Cover-letter: ensure a packet doc exists when cfg.coverLetter flips on.
  useEffect(() => {
    if (!cfg || !draft) return;
    if (!cfg.coverLetter) return;
    const exists =
      draft.documents.some((d) => /cover letter/i.test(d.name)) ||
      Object.values(packetBodies).some((b) => /cover letter/i.test(b.title ?? ''));
    if (!exists && draftId) {
      addDocument.mutate({ name: 'Cover letter' });
    }
    // Only react to the flag flipping (documents refetch hydrates the rest).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg?.coverLetter]);

  // When the draft's documents list changes (add/remove), reconcile working
  // bodies for any newly-arrived docs without clobbering in-flight edits.
  useEffect(() => {
    if (!draft) return;
    setPacketBodies((prev) => {
      const next = { ...prev };
      for (const d of draft.documents) {
        if (!next[d.id]) next[d.id] = normalizeBody(d);
      }
      // Drop bodies for documents that no longer exist.
      for (const id of Object.keys(next)) {
        if (!draft.documents.some((d) => d.id === id)) delete next[id];
      }
      return next;
    });
  }, [draft]);

  // Selection → floating "Comment" button. After the mouse-up settles, if there
  // is a non-empty selection inside a section body, show the FAB at the selection.
  useEffect(() => {
    const onMouseUp = () => {
      // Defer so the browser finishes updating window.getSelection().
      window.setTimeout(() => {
        const anchor = getSelectionAnchor();
        if (!anchor) {
          setSelectionFab(null);
          return;
        }
        setSelectionFab({
          top: anchor.rect.top - 8,
          left: anchor.rect.left + anchor.rect.width / 2,
        });
      }, 0);
    };
    document.addEventListener('mouseup', onMouseUp);
    return () => document.removeEventListener('mouseup', onMouseUp);
  }, []);

  if (isLoading || !draft || !cfg) {
    return (
      <div className="ws-shell">
        <StepsRail active="draft" draftId={draftId} />
        <div className="ws-stage" style={{ textAlign: 'center', padding: 60 }}>
          <Spin />
        </div>
      </div>
    );
  }

  // ── Derived view-models ─────────────────────────────────────────────────────
  const views = sectionViews(cfg);
  const storedRedactions = (cfg.anonymizeMap as { redactions?: StoredRedaction[] } | undefined)
    ?.redactions;
  const anonMap = anonymizeMap(draft.client, draft.product, storedRedactions);
  const ask: WsAsk =
    (cfg.ask as WsAsk | undefined) ??
    (draft.ask && draft.ask !== 'n/a' ? (draft.ask as WsAsk) : {});
  const budget = budgetFrom(cfg);
  const offices = (cfg.offices as string[] | undefined) ?? [];
  const linkedData = (cfg.linkedData as string[] | undefined) ?? [];

  // Office row predicate (Q-ED-1): personalize is the single canonical gate.
  const showOfficeRow = !!cfg.personalize && offices.length > 0;

  // Letterhead firm fallbacks (live tenant firm wiring is later; use config).
  // NEVER fall back to the client — the letterhead is the FIRM's identity, and it
  // only renders at all when cfg.letterhead.custom is set (see Letterhead).
  const firmName = cfg.letterhead?.firmName || 'Your firm';
  const firmAddr = cfg.letterhead?.firmAddr || 'Add a firm address in Setup → Letterhead';

  // Packet tabs: the synthetic MAIN tab (label = the selected work product) maps
  // to the primary WsDocument (lowest ordinal, see activeDocumentId). The other
  // documents are packet add-ons (cover letter, appendix, …) and get their own
  // tabs. EXCLUDE the primary here — MAIN already represents it — otherwise a
  // single-document draft renders two tabs for the same doc (the primary's stale
  // stored name showed up as a spurious second tab, e.g. "White paper").
  const sortedDocs = [...draft.documents].sort((a, b) => a.ordinal - b.ordinal);
  const primaryDocId = sortedDocs[0]?.id;
  const tabs: DocTab[] = [
    { id: MAIN_TAB, label: cfg.product || draft.docTitle || 'Document', main: true },
    ...sortedDocs.filter((d) => d.id !== primaryDocId).map((d) => ({ id: d.id, label: d.name })),
  ];
  const isMainDoc = activeTab === MAIN_TAB;

  // Budget-identifier meta line under the title.
  const metaParts = [
    draft.client,
    budget.account,
    budget.pe ? `PE ${budget.pe}` : null,
    budget.upl,
  ].filter(Boolean);
  const metaLine = metaParts.length ? metaParts.join(' · ') : (draft.product ?? '');

  const toast = (msg: string) => message.info(msg);

  // ── Section handlers ────────────────────────────────────────────────────────
  const setSectionMeta = (name: string, meta: Partial<WsSectionMeta>) => {
    const all = (cfg.sectionMeta as Record<string, WsSectionMeta> | undefined) ?? {};
    patchCfg({ sectionMeta: { ...all, [name]: { ...(all[name] ?? {}), ...meta } } });
  };
  const setSectionBody = (name: string, html: string) => {
    const content = (cfg.sectionContent as Record<string, string> | undefined) ?? {};
    patchCfg({ sectionContent: { ...content, [name]: html } });
  };
  const renameSection = (i: number, name: string) => {
    const v = name.trim();
    if (!v || v === cfg.sections[i]) return;
    const next = [...cfg.sections];
    const old = next[i];
    if (!old) return;
    next[i] = v;
    // Carry content + meta across the rename.
    const content = { ...((cfg.sectionContent as Record<string, string> | undefined) ?? {}) };
    const meta = { ...((cfg.sectionMeta as Record<string, WsSectionMeta> | undefined) ?? {}) };
    if (old in content) {
      content[v] = content[old] ?? '';
      delete content[old];
    }
    if (old in meta) {
      meta[v] = meta[old] ?? {};
      delete meta[old];
    }
    patchCfg({ sections: next, sectionContent: content, sectionMeta: meta });
  };
  const removeSection = (name: string) =>
    patchCfg({ sections: cfg.sections.filter((x) => x !== name) });
  const reorderSections = (from: number, to: number) => {
    const arr = [...cfg.sections];
    const [moved] = arr.splice(from, 1);
    if (moved === undefined) return;
    arr.splice(to, 0, moved);
    patchCfg({ sections: arr });
  };
  const addSection = (name?: string, meta?: Partial<WsSectionMeta>) => {
    if (!isMainDoc) {
      addBlockTo('section');
      return;
    }
    const base = (name && name.trim()) || 'New section';
    let n = base;
    let i = 2;
    while (cfg.sections.includes(n)) n = `${base} ${i++}`;
    const patch: Partial<WsConfig> = { sections: [...cfg.sections, n] };
    if (meta) {
      const all = (cfg.sectionMeta as Record<string, WsSectionMeta> | undefined) ?? {};
      patch.sectionMeta = { ...all, [n]: meta };
    }
    patchCfg(patch);
    toast('Section added');
  };

  // Draft-with-Meri: generate → write content + set status review (Meri output
  // stays attributable via the accent body + review pill).
  const generateSection = (name: string) => {
    setDraftingSection(name);
    generate.mutate(name, {
      onSuccess: (r) => {
        setSectionBody(name, r.content);
        setSectionMeta(name, { status: 'review' });
        message.success(
          `Drafted with ${r.model}${r.usedTenantKey ? ' (your key)' : ''}${r.anonymized ? ' · anonymized' : ''}`,
        );
      },
      onError: (e: unknown) => {
        const msg =
          (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          'Generation failed';
        message.error(msg);
      },
      onSettled: () => setDraftingSection(null),
    });
  };
  const regenerateSection = (name: string) => generateSection(name);
  const markReviewed = (name: string) => {
    setSectionMeta(name, { status: 'done' });
    toast(`Marked "${name}" reviewed`);
  };
  const setAsk = (key: keyof WsAsk, value: string) => patchCfg({ ask: { ...ask, [key]: value } });

  // ── Insert handlers (route to the active doc) ───────────────────────────────
  // Map an insert "kind" to a persisted WsBlock. Table variants
  // (table-platform / table-custom from the TableTypePicker) collapse to a
  // `table` block carrying a `variant` so the type union stays closed; `image`
  // maps to a `photo` block. `section` becomes a packet section block (the MAIN
  // doc handles sections via cfg.sections, not the block model). Returns null
  // for non-block kinds like `template`.
  const blockFor = (id: string, kind: string, extra?: Partial<WsBlock>): WsBlock | null => {
    if (kind === 'section') return { id, type: 'section', title: 'New section', content: '' };
    if (kind === 'image' || kind === 'photo') return { id, type: 'photo', ...extra };
    if (kind === 'logo') return { id, type: 'logo', ...extra };
    if (kind === 'table') return { id, type: 'table', ...extra };
    if (kind === 'table-platform') return { id, type: 'table', variant: 'platform' };
    if (kind === 'table-custom')
      return { id, type: 'table', variant: 'custom', rows: 3, cols: 2, cells: [], ...extra };
    return null;
  };
  // extra carries an uploaded image src (photo/logo) or table dims (E-5/6/8).
  const addBlockTo = (kind: string, extra?: Partial<WsBlock>) => {
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    // MAIN doc: sections live in cfg.sections (not the block model).
    if (kind === 'section' && isMainDoc) {
      addSection();
      return;
    }
    const block = blockFor(id, kind, extra);
    if (!block) return; // non-block kind (e.g. template) — handled elsewhere.
    if (isMainDoc) {
      setMainBlocks((b) => [...b, block]);
      cfgDirty.current = true;
      scheduleSave();
    } else {
      setPacketBodies((prev) => {
        const body = prev[activeTab] ?? { blocks: [] };
        return { ...prev, [activeTab]: { ...body, blocks: [...body.blocks, block] } };
      });
      dirtyDocs.current.add(activeTab);
      scheduleSave();
    }
    setJustInserted(id); // E-9: scroll into view + flash so the user sees it
    toast('Inserted');
  };
  const removeMainBlock = (id: string) => {
    setMainBlocks((b) => b.filter((x) => x.id !== id));
    cfgDirty.current = true;
    scheduleSave();
  };
  const changeMainBlock = (id: string, patch: Partial<WsBlock>) => {
    setMainBlocks((b) => b.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    cfgDirty.current = true;
    scheduleSave();
  };

  // ── Packet doc handlers ─────────────────────────────────────────────────────
  const onPacketChange = (docId: string, body: PacketBody) => {
    setPacketBodies((prev) => ({ ...prev, [docId]: body }));
    dirtyDocs.current.add(docId);
    scheduleSave();
  };
  const addDoc = (label: string) => {
    addDocument.mutate(
      { name: label },
      {
        onSuccess: (doc) => {
          setPacketBodies((prev) => ({ ...prev, [doc.id]: normalizeBody(doc) }));
          setActiveTab(doc.id);
        },
      },
    );
  };
  const renameDoc = (docId: string, label: string) =>
    updateDocument.mutate({ docId, body: { name: label } });
  const removeDoc = (docId: string) => {
    deleteDocument.mutate(docId);
    if (activeTab === docId) setActiveTab(MAIN_TAB);
  };

  // ── Toolbar handlers ────────────────────────────────────────────────────────
  // Anonymize: ON → off clears the flag; OFF → open the review modal (applying
  // it sets the flag + persists the redaction map).
  const onAnonymize = () => {
    if (cfg.anonymize) patchCfg({ anonymize: false });
    else setShowAnonymizeReview(true);
  };
  const onApplyAnonymize = (map: AnonymizeMap) => {
    patchCfg({ anonymize: true, anonymizeMap: map });
    setShowAnonymizeReview(false);
    message.success(
      `Anonymized ${map.redactions.length} name${map.redactions.length === 1 ? '' : 's'}`,
    );
  };
  const onChecks = () => setPopover((p) => (p === 'checks' ? null : 'checks'));
  const onHistory = () => setPopover((p) => (p === 'history' ? null : 'history'));
  // "Fix" in the checks popover: a jump-to stub (closes the popover + toasts).
  // E-18: "Fix" performs a concrete action per check instead of a toast stub —
  // open the anonymize review, or jump to + focus the first empty section.
  const onFixCheck = (c: WsCheckResult) => {
    setPopover(null);
    if (c.id === 'anonymize-map' || c.id === 'anonymize') {
      setShowAnonymizeReview(true);
      return;
    }
    const content = (cfg.sectionContent as Record<string, string> | undefined) ?? {};
    // Mirror the engine's sections-filled check: strip HTML before testing so a
    // whitespace-only "<p></p>" section counts as empty (checks.service.ts).
    const empty = cfg.sections.find((s) => !(content[s] || '').replace(/<[^>]*>/g, '').trim());
    if (empty) {
      const esc = typeof CSS !== 'undefined' ? CSS.escape(empty) : empty;
      // Anchor is on the SectionBlock outer wrapper (renders for empty sections too).
      const el = document.querySelector(`[data-ws-section-block="${esc}"]`) as HTMLElement | null;
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.focus?.();
      toast(`Fix: draft the "${empty}" section`);
      return;
    }
    toast(`Review: ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  };
  const onShare = () => navigate(`/workspace/collab/${draftId}`);
  const onPreview = () => {
    flush(false);
    navigate(`/workspace/preview/${draftId}`);
  };

  const onEditContext = () => navigate(`/workspace/context/${draftId}`);
  const onAskMeri = (text: string) =>
    toast(`Meri: "${text}" — chat editing arrives in a later phase`); // TODO(phase 6b)

  // ── Comment handlers (highlight-to-comment) ─────────────────────────────────
  // Clicking the selection FAB: snapshot the selection's anchor, wrap it in a
  // transient .ws-hl highlight, open a composing comment, and switch the rail to
  // Comments (prototype parity).
  const onStartComment = () => {
    const anchor = getSelectionAnchor();
    setSelectionFab(null);
    if (!anchor) return;
    highlightSelection();
    setComposing({
      section: anchor.section,
      quote: anchor.quote,
      start: anchor.start,
      end: anchor.end,
    });
    setRailTab('comments');
  };
  const onComposeCancel = () => setComposing(null);
  const onComposeSave = (text: string) => {
    const v = text.trim();
    if (!v || !composing || !activeDocumentId) {
      setComposing(null);
      return;
    }
    const anchor: CommentAnchor = {
      section: composing.section,
      quote: composing.quote,
      start: composing.start,
      end: composing.end,
    };
    createComment.mutate(
      { body: v, quote: composing.quote, anchor: anchor as unknown as Record<string, unknown> },
      {
        onSuccess: () => setComposing(null),
        onError: () => message.error('Could not save comment'),
      },
    );
  };
  // Approve a Meri-drafted edit from a comment: splice the rewrite into the
  // anchored section's body. The MAIN canvas keys section bodies by name in
  // cfg.sectionContent; a packet doc keys them by the section BLOCK whose title
  // matches the anchor. Routes to the doc the comment belongs to.
  const onApplyEdit = (anchor: CommentAnchor, after: string) => {
    if (isMainDoc) {
      const content = (cfg.sectionContent as Record<string, string> | undefined) ?? {};
      const current = content[anchor.section] ?? '';
      setSectionBody(anchor.section, applyEditToSectionHtml(current, anchor, after));
      message.success('Applied Meri’s edit');
      return;
    }
    // Packet doc: find the section block by title and splice its content.
    const body = packetBodies[activeTab];
    const target = body?.blocks.find(
      (b) => b.type === 'section' && (b.title ?? '') === anchor.section,
    );
    if (!body || !target) {
      message.info('Could not locate the section to edit');
      return;
    }
    const nextBlocks = body.blocks.map((b) =>
      b.id === target.id
        ? { ...b, content: applyEditToSectionHtml(b.content ?? '', anchor, after) }
        : b,
    );
    onPacketChange(activeTab, { ...body, blocks: nextBlocks });
    message.success('Applied Meri’s edit');
  };

  // ── Template apply (Insert → Templates: replace vs merge) ────────────────────
  const onApplyTemplate = (tpl: WsTemplate, mode: 'replace' | 'merge') => {
    if (mode === 'replace') {
      // Replace structure; clear written content + meta (prototype warns first).
      patchCfg({
        sections: tpl.sections.slice(),
        sectionContent: {},
        sectionMeta: {},
        selectedTemplate: tpl.id,
      });
      message.success(`Applied template “${tpl.name}”`);
    } else {
      // Merge: append sections not already present, preserving existing order +
      // content. Existing sectionContent/meta are untouched.
      const existing = new Set(cfg.sections);
      const added = tpl.sections.filter((s) => !existing.has(s));
      patchCfg({
        sections: [...cfg.sections, ...added],
        selectedTemplate: tpl.id,
      });
      message.success(
        added.length
          ? `Merged ${added.length} section${added.length === 1 ? '' : 's'} from “${tpl.name}”`
          : `“${tpl.name}” added no new sections`,
      );
    }
  };

  return (
    <div className="ws-editor-shell">
      <EditorToolbar
        title={docTitle || draft.docTitle}
        saveStatus={saveStatus}
        anonymize={!!cfg.anonymize}
        letterhead={cfg.letterhead}
        checksScore={checks?.score ?? null}
        checksOpen={popover === 'checks'}
        historyOpen={popover === 'history'}
        viewOnly={viewOnly}
        collaborators={collaboratorInitials}
        onAnonymize={onAnonymize}
        onChecks={onChecks}
        onHistory={onHistory}
        onShare={onShare}
        onPreview={onPreview}
      />

      {/* Concurrent-edit lock banner (Q-ED-2): view-only / request / take-over,
          plus the active-editor receive-request UI. */}
      <LockBanner
        lock={editLock.lock}
        requestPending={editLock.requestPending}
        requestBusy={editLock.requestBusy}
        takeOverBusy={editLock.takeOverBusy}
        releasing={editLock.releasing}
        onRequest={editLock.request}
        onTakeOver={editLock.takeOver}
        onSaveAndRelease={() => editLock.saveAndRelease(() => flush(true))}
        onKeepEditing={editLock.keepEditing}
      />

      <RichTextToolbar />

      <div className="ws-editor-scroll">
        <div className="ws-editor-cols">
          <StepsRail active="draft" draftId={draftId} product={cfg.product}>
            <DraftOutline views={views} onAddSection={addSection} />
          </StepsRail>

          {/* Document canvas */}
          <div className="ws-editor-canvas">
            {showOfficeRow && (
              <OfficeRow
                offices={offices}
                active={activeOffice}
                onChange={setActiveOffice}
                onAddOffice={(name) => {
                  if (!offices.includes(name)) patchCfg({ offices: [...offices, name] });
                  setActiveOffice(name);
                }}
              />
            )}
            <DocTabs
              tabs={tabs}
              activeId={activeTab}
              onSelect={setActiveTab}
              onAdd={addDoc}
              onRename={renameDoc}
              onRemove={removeDoc}
            />
            {isMainDoc ? (
              <div
                className="card"
                style={{
                  position: 'relative',
                  maxWidth: 624,
                  width: '100%',
                  margin: '0 auto',
                  padding: 0,
                  overflow: 'hidden',
                  borderTopLeftRadius: 0,
                }}
              >
                <Letterhead
                  letterhead={cfg.letterhead}
                  firmName={firmName}
                  firmAddr={firmAddr}
                  onToast={toast}
                />
                <div style={{ padding: '20px 30px 26px' }}>
                  <PaperBody
                    docTitle={docTitle || draft.docTitle}
                    sections={views}
                    blocks={mainBlocks}
                    ask={ask}
                    budget={budget}
                    anonymizeOn={!!cfg.anonymize}
                    anonMap={anonMap}
                    metaLine={metaLine}
                    draftingSection={draftingSection}
                    readOnly={viewOnly}
                    onTitle={(t) => {
                      setDocTitle(t);
                      cfgDirty.current = true;
                      scheduleSave();
                    }}
                    onReorder={reorderSections}
                    onRenameSection={renameSection}
                    onRemoveSection={removeSection}
                    onChangeBody={setSectionBody}
                    onAsk={setAsk}
                    onGenerate={generateSection}
                    onRegenerate={regenerateSection}
                    onMarkReviewed={markReviewed}
                    onRemoveBlock={removeMainBlock}
                    onChangeBlock={changeMainBlock}
                    justInsertedId={justInserted}
                    onToast={toast}
                  />
                </div>
              </div>
            ) : (
              <PacketDocCanvas
                label={tabs.find((t) => t.id === activeTab)?.label ?? 'Document'}
                body={packetBodies[activeTab] ?? { blocks: [] }}
                firmName={firmName}
                firmAddr={firmAddr}
                letterhead={cfg.letterhead}
                readOnly={viewOnly}
                onChange={(body) => onPacketChange(activeTab, body)}
                onAskMeri={() =>
                  toast(`Asking Meri to draft "${tabs.find((t) => t.id === activeTab)?.label}"`)
                }
                onToast={toast}
              />
            )}
          </div>

          <InsertRail
            product={cfg.product}
            onAddSection={addSection}
            onInsert={addBlockTo}
            onApplyTemplate={onApplyTemplate}
          />

          <MeriPanel
            isMainDoc={isMainDoc}
            contextItems={linkedData}
            openComments={openCommentsCount}
            activeTab={railTab}
            onTabChange={setRailTab}
            documentId={activeDocumentId}
            comments={comments}
            composing={composing}
            selfClerkId={selfClerkId}
            selfName={selfName}
            onComposeSave={onComposeSave}
            onComposeCancel={onComposeCancel}
            onApplyEdit={onApplyEdit}
            onAsk={onAskMeri}
            onQuickAction={(a) => toast(`Meri: ${a} — arrives in a later phase`)}
            onEditContext={onEditContext}
          />
        </div>
      </div>

      {/* Floating "Comment" button at a live canvas selection. */}
      {selectionFab && (
        <button
          className="ws-comment-fab"
          style={{ top: selectionFab.top, left: selectionFab.left }}
          // Use mousedown so the click fires before the selection is cleared.
          onMouseDown={(e) => {
            e.preventDefault();
            onStartComment();
          }}
        >
          <CommentFabIcon />
          Comment
        </button>
      )}

      {/* Anonymize review modal (opens from the toolbar Anonymize button when off). */}
      {showAnonymizeReview && draftId && (
        <AnonymizeReview
          draftId={draftId}
          onClose={() => setShowAnonymizeReview(false)}
          onApply={onApplyAnonymize}
        />
      )}

      {/* Pre-submission checks popover (toolbar "Checks N/M"). */}
      {popover === 'checks' && (
        <ChecksPopover
          data={checks}
          loading={checksLoading}
          onClose={() => setPopover(null)}
          onFix={onFixCheck}
        />
      )}

      {/* Version-history popover (toolbar "Version history"). */}
      {popover === 'history' && draftId && (
        <VersionPopover
          draftId={draftId}
          selfClerkId={selfClerkId}
          selfName={selfName}
          onClose={() => setPopover(null)}
          onRestored={() => {
            // The restore overwrites the draft server-side; re-hydrate locally.
            hydrated.current = false;
            setPopover(null);
          }}
        />
      )}
    </div>
  );
}

function CommentFabIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** Normalize a WsDocument's stored body into the editor's PacketBody shape. */
function normalizeBody(d: WsDocument): PacketBody {
  const body = (d.body ?? {}) as { blocks?: WsBlock[]; title?: string };
  return { title: body.title ?? d.name, blocks: (body.blocks ?? []).slice() };
}
