import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import type {
  WsAssignableRole,
  WsChecksResponse,
  WsCollaborator,
  WsCollaboratorsResponse,
  WsComment,
  WsConfig,
  WsContextItem,
  WsDocVersion,
  WsDocument,
  WsDraft,
  WsIndustryDatum,
  WsLockStatus,
  WsNotification,
  WsProductDefaults,
  WsTemplate,
} from './types.js';

// Base path: the engine is mounted at /workspace-api/* on the shared ALB.
const BASE = '/workspace-api';
// The MAIN Capiro API (tenant/user tables) is mounted at /api/*. The workspace
// engine doesn't own the user table, so identity resolution goes to /api.
const MAIN = '/api';

// ── Identity (tenant members) ────────────────────────────────────────────────
/**
 * A tenant member as the comment/collaborator UI needs them. `clerkUserId` is
 * the key the engine stores on a comment's `authorId` (the engine trusts the
 * Clerk claim and never synthesizes a Capiro user id), so author resolution is
 * by clerkUserId; `id` is the canonical Capiro user id for everything else.
 */
export interface WsTenantMember {
  id: string;
  clerkUserId: string;
  email: string;
  name: string;
  initials: string;
}

/** First+last initials from a display name (falls back to first two letters). */
export function initials(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Roster of the active tenant's members for author attribution + collaborator
 * pickers. Backed by the MAIN api (GET /api/tenant-members) — NOT the engine —
 * because the user table lives there. Display-only, available to every member.
 */
export function useTenantMembers() {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'tenant-members'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data } = await api.get<Array<Omit<WsTenantMember, 'initials'>>>(
        `${MAIN}/tenant-members`,
      );
      return data.map((m) => ({ ...m, initials: initials(m.name) }));
    },
  });
}

// ── Cascade + catalog ───────────────────────────────────────────────────────
export function useIndustries() {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'industries'],
    queryFn: async () =>
      (await api.get<{ industries: string[] }>(`${BASE}/cascade`)).data.industries,
  });
}

export function useProductsFor(industry: string | null, all = false) {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'products', industry, all],
    enabled: all || !!industry,
    queryFn: async () => {
      const ind = encodeURIComponent(industry ?? 'Defense & Aerospace');
      const { data } = await api.get<{ products: string[] }>(
        `${BASE}/cascade/${ind}/products${all ? '?all=1' : ''}`,
      );
      return data.products;
    },
  });
}

export function usePathwaysFor(industry: string | null, product: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'pathways', industry, product],
    enabled: !!industry && !!product,
    queryFn: async () => {
      const { data } = await api.get<{ pathways: string[] }>(
        `${BASE}/cascade/${encodeURIComponent(industry!)}/products/${encodeURIComponent(product!)}/pathways`,
      );
      return data.pathways;
    },
  });
}

export function useCommitteesFor(industry: string | null, pathways: string[]) {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'committees', industry, pathways],
    enabled: !!industry && pathways.length > 0,
    queryFn: async () => {
      const { data } = await api.get<{ committees: string[] }>(
        `${BASE}/cascade/${encodeURIComponent(industry!)}/committees?pathways=${encodeURIComponent(pathways.join(','))}`,
      );
      return data.committees;
    },
  });
}

/** Platform-data rows for an industry (INDUSTRY_DATA) — Links & data toggles. */
export function useIndustryData(industry: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'industry-data', industry],
    enabled: !!industry,
    queryFn: async () =>
      (
        await api.get<{ data: WsIndustryDatum[] }>(
          `${BASE}/cascade/${encodeURIComponent(industry!)}/data`,
        )
      ).data.data,
  });
}

/** The shared section-name library for OwnSectionBuilder's "add from library". */
export function useSectionLibrary() {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'section-library'],
    queryFn: async () =>
      (await api.get<{ sections: string[] }>(`${BASE}/cascade/section-library`)).data.sections,
  });
}

export function useProductDefaults(product: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'defaults', product],
    enabled: !!product,
    queryFn: async () =>
      (
        await api.get<WsProductDefaults>(
          `${BASE}/products/${encodeURIComponent(product!)}/defaults`,
        )
      ).data,
  });
}

// ── Templates ───────────────────────────────────────────────────────────────
export function useTemplatesFor(product: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'templates', product],
    enabled: !!product,
    queryFn: async () =>
      (
        await api.get<{
          primary: WsTemplate | null;
          secondary: WsTemplate | null;
          all: WsTemplate[];
        }>(`${BASE}/templates?product=${encodeURIComponent(product!)}`)
      ).data,
  });
}

/**
 * The FULL tenant-visible template library (all products) for Setup's "Search
 * all templates". Separate from useTemplatesFor (which stays product-scoped for
 * the two Meri recommendation cards). `enabled` lets the picker defer the fetch
 * until the user actually opens search.
 */
export function useAllTemplates(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'templates', 'library'],
    enabled,
    staleTime: 60_000,
    queryFn: async () => (await api.get<WsTemplate[]>(`${BASE}/templates/library`)).data,
  });
}

// ── Drafts ──────────────────────────────────────────────────────────────────
export function useDrafts(params?: { sector?: string; scope?: 'all' | 'mine' | 'shared' }) {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'drafts', params],
    queryFn: async () => {
      const q = new URLSearchParams();
      if (params?.sector) q.set('sector', params.sector);
      if (params?.scope) q.set('scope', params.scope);
      const qs = q.toString();
      return (await api.get<WsDraft[]>(`${BASE}/drafts${qs ? `?${qs}` : ''}`)).data;
    },
  });
}

export function useDraft(id: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'draft', id],
    enabled: !!id,
    queryFn: async () => (await api.get<WsDraft>(`${BASE}/drafts/${id}`)).data,
  });
}

export function useCreateDraft() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      industry?: string;
      product?: string;
      client?: string;
      docTitle?: string;
    }) => (await api.post<WsDraft>(`${BASE}/drafts`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws', 'drafts'] }),
  });
}

export function useUpdateDraft(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    // Serialize autosave PATCHes for a draft (react-query v5 scope): debounced
    // edits to sibling config fields (letterhead, ask, …) run one-at-a-time in
    // order, so an out-of-order server echo can't clobber a freshly-typed value.
    scope: { id: `ws-draft-update-${id}` },
    mutationFn: async (
      body: Partial<{
        docTitle: string;
        industry: string;
        product: string;
        client: string;
        status: 'draft' | 'complete';
        config: Partial<WsConfig>;
        ask: { amount?: string; pb?: string; delta?: string };
      }>,
    ) => (await api.patch<WsDraft>(`${BASE}/drafts/${id}`, body)).data,
    onSuccess: (data) => {
      qc.setQueryData(['ws', 'draft', id], data);
      qc.invalidateQueries({ queryKey: ['ws', 'drafts'] });
      // E-18: keep the pre-submission checks score live as the draft is edited.
      qc.invalidateQueries({ queryKey: ['ws', 'checks', id] });
    },
  });
}

/**
 * "Start with Meri" intake: resolves a free-text prompt to a work product +
 * cascade, creates the draft, and auto-drafts its sections. Returns the drafted
 * WsDraft to open directly in the editor (handoff Q-LIB-3). Slow (LLM) — show a
 * "Meri is drafting…" state on the caller.
 */
export function useMeriIntake() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { prompt: string; client?: string }) =>
      (await api.post<WsDraft>(`${BASE}/meri/intake`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws', 'drafts'] }),
  });
}

export function useDeleteDraft() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`${BASE}/drafts/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws', 'drafts'] }),
  });
}

// ── Documents (packet tabs) ─────────────────────────────────────────────────
export function useAddDocument(draftId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string; ordinal?: number }) =>
      (await api.post<WsDocument>(`${BASE}/drafts/${draftId}/documents`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws', 'draft', draftId] }),
  });
}

export function useUpdateDocument(draftId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      docId,
      body,
    }: {
      docId: string;
      body: Partial<{ name: string; ordinal: number; body: Record<string, unknown> }>;
    }) => (await api.patch<WsDocument>(`${BASE}/drafts/${draftId}/documents/${docId}`, body)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ws', 'draft', draftId] });
      qc.invalidateQueries({ queryKey: ['ws', 'checks', draftId] }); // E-18: live score
    },
  });
}

export function useDeleteDocument(draftId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (docId: string) =>
      (await api.delete(`${BASE}/drafts/${draftId}/documents/${docId}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws', 'draft', draftId] }),
  });
}

// ── Comments ────────────────────────────────────────────────────────────────
export function useComments(documentId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'comments', documentId],
    enabled: !!documentId,
    queryFn: async () =>
      (await api.get<WsComment[]>(`${BASE}/documents/${documentId}/comments`)).data,
  });
}

export function useCreateComment(documentId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      body: string;
      quote?: string;
      anchor?: Record<string, unknown>;
      parentId?: string;
    }) => (await api.post<WsComment>(`${BASE}/documents/${documentId}/comments`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws', 'comments', documentId] }),
  });
}

export function useUpdateComment(documentId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      commentId,
      body,
    }: {
      commentId: string;
      body: Partial<{ body: string; resolved: boolean }>;
    }) =>
      (await api.patch<WsComment>(`${BASE}/documents/${documentId}/comments/${commentId}`, body))
        .data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws', 'comments', documentId] }),
  });
}

/**
 * Ask Meri to draft a concrete edit that resolves a comment. Returns a
 * before/after the CommentsRail renders in a SuggestionCard (Approve applies +
 * resolves; Reject dismisses). Tenant-scoped engine endpoint.
 */
export interface CommentSuggestionResult {
  before: string;
  after: string;
  model: string;
}

export function useSuggestCommentEdit(documentId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: async (commentId: string) =>
      (
        await api.post<CommentSuggestionResult>(
          `${BASE}/documents/${documentId}/comments/${commentId}/suggest`,
          {},
        )
      ).data,
  });
}

// ── Collaborators (Collaborate screen) ───────────────────────────────────────
/**
 * People with access to a work product (the draft). Returns the synthetic Owner
 * first, then active + pending collaborators. Tenant-scoped engine endpoint;
 * any role with access may read it.
 */
export function useCollaborators(draftId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'collaborators', draftId],
    enabled: !!draftId,
    queryFn: async () =>
      (await api.get<WsCollaboratorsResponse>(`${BASE}/drafts/${draftId}/collaborators`)).data
        .collaborators,
  });
}

/**
 * Invite a collaborator. Internal teammates are resolved on the client (via
 * useTenantMembers / GET /api/tenant-members) and passed as `subjectId` → they
 * join `active`; an external client SME is passed as a raw `email` → `pending`.
 */
export function useInviteCollaborator(draftId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      subjectId?: string;
      email?: string;
      name?: string;
      role: WsAssignableRole;
      inviterName?: string;
    }) => (await api.post<WsCollaborator>(`${BASE}/drafts/${draftId}/collaborators`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws', 'collaborators', draftId] }),
  });
}

/**
 * Invitee accepts/declines a pending invite (E-19) from the notification bell.
 * Generic over draftId (the bell isn't draft-scoped): accept grants access
 * (status active) + notifies the inviter; decline removes the invite. Refreshes
 * the access list + the bell.
 */
export function useRespondToInvite() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      draftId: string;
      collaboratorId: string;
      action: 'accept' | 'decline';
    }) =>
      (
        await api.post(
          `${BASE}/drafts/${vars.draftId}/collaborators/${vars.collaboratorId}/${vars.action}`,
          {},
        )
      ).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ws', 'collaborators'] });
      qc.invalidateQueries({ queryKey: ['ws', 'notifications'] });
    },
  });
}

/**
 * Send the collaborator-invite EMAIL (E-19) via the MAIN api (which owns SES).
 * Best-effort — the in-app notification is the source of truth, so a failed
 * send never blocks the invite.
 */
export function useSendCollabInviteEmail() {
  const api = useApi();
  return useMutation({
    mutationFn: async (body: {
      toEmail: string;
      toName?: string;
      draftTitle: string;
      role: WsAssignableRole;
      link: string;
      inviterName?: string;
    }) => (await api.post(`${MAIN}/workspace/collaborator-invite-email`, body)).data,
  });
}

// ── Notifications (in-app bell, E-19) ─────────────────────────────────────────
export interface WsNotificationsResponse {
  items: WsNotification[];
  unread: number;
}

/** Poll the current user's notifications for the global bell. */
export function useNotifications(pollMs = 30_000) {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'notifications'],
    refetchInterval: pollMs,
    refetchIntervalInBackground: false,
    // Don't retry — the bell polls for every signed-in user; a user without a
    // tenant claim 403s and the bell just renders empty (no retry = less noise).
    retry: false,
    queryFn: async () => (await api.get<WsNotificationsResponse>(`${BASE}/notifications`)).data,
  });
}

export function useMarkNotificationRead() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.post(`${BASE}/notifications/${id}/read`, {})).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws', 'notifications'] }),
  });
}

export function useMarkAllNotificationsRead() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post(`${BASE}/notifications/read-all`, {})).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws', 'notifications'] }),
  });
}

/** Change a collaborator's role (owner-only on the server). */
export function useUpdateCollaboratorRole(draftId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, role }: { id: string; role: WsAssignableRole }) =>
      (await api.patch<WsCollaborator>(`${BASE}/drafts/${draftId}/collaborators/${id}`, { role }))
        .data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws', 'collaborators', draftId] }),
  });
}

/** Remove a collaborator (owner-only on the server; the Owner can't be removed). */
export function useRemoveCollaborator(draftId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.delete(`${BASE}/drafts/${draftId}/collaborators/${id}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws', 'collaborators', draftId] }),
  });
}

// ── Generation (Meri) ───────────────────────────────────────────────────────
export interface GenerateSectionResult {
  section: string;
  content: string;
  model: string;
  usedTenantKey: boolean;
  anonymized: boolean;
  legend?: Record<string, string>;
}

export function useGenerateSection(draftId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: async (section: string) =>
      (
        await api.post<GenerateSectionResult>(`${BASE}/drafts/${draftId}/generate-section`, {
          section,
        })
      ).data,
  });
}

/**
 * Draft the WHOLE document (every section) with Meri. Used after the Context
 * Builder ("Open editor") and by the editor's "Regenerate All". Returns the
 * refreshed draft; callers re-hydrate from it. Invalidates the draft + checks.
 */
export function useGenerateAll(draftId: string | null) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (await api.post<WsDraft>(`${BASE}/drafts/${draftId}/generate-all`, {})).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ws', 'draft', draftId] });
      qc.invalidateQueries({ queryKey: ['ws', 'checks', draftId] });
    },
  });
}

// ── Anonymize (review modal) ──────────────────────────────────────────────────
/**
 * A name span Meri detected as a candidate for anonymization. `kind` drives the
 * default generic replacement ("the client" / "the program"). `occurrences` is
 * the count across the draft (drives the All-occurrences vs This-mention scope).
 */
export interface AnonymizeDetection {
  from: string;
  kind: 'client' | 'office' | 'program';
  suggested: string;
  occurrences: number;
  /** 'high' = structured client/product/office (pre-checked); 'low' = mined. */
  confidence?: 'high' | 'low';
}

export function useAnonymizeDetect(draftId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: async () =>
      (
        await api.post<{ detections: AnonymizeDetection[] }>(
          `${BASE}/drafts/${draftId}/anonymize/detect`,
          {},
        )
      ).data.detections,
  });
}

/** Download the draft as a .docx (engine renders via the docx lib). */
export function useExportDocx(draftId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: async (filenameHint?: string) => {
      const res = await api.get<Blob>(`${BASE}/drafts/${draftId}/export/docx`, {
        responseType: 'blob',
      });
      const blob = new Blob([res.data], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(filenameHint || 'document').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
  });
}

/**
 * Download a SERVER-RENDERED .pdf of the draft (deterministic — no browser
 * print). Mirrors useExportDocx; the engine builds the PDF with pdfkit.
 */
export function useExportPdf(draftId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: async (filenameHint?: string) => {
      const res = await api.get<Blob>(`${BASE}/drafts/${draftId}/export/pdf`, {
        responseType: 'blob',
      });
      const blob = new Blob([res.data], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(filenameHint || 'document').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
  });
}

// ── Context Builder ─────────────────────────────────────────────────────────
// (The engine's mock /context/sources + /context/news endpoints are no longer
// consumed — the Context Builder now sources real client data from the MAIN api
// directly and persists only the chosen items as ws_context_item below.)

export function useDraftContext(draftId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'ctx-items', draftId],
    enabled: !!draftId,
    queryFn: async () => (await api.get<WsContextItem[]>(`${BASE}/drafts/${draftId}/context`)).data,
  });
}

export function useAddContextItem(draftId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      kind: 'source' | 'news' | 'free-text';
      payload: Record<string, unknown>;
    }) => (await api.post<WsContextItem>(`${BASE}/drafts/${draftId}/context`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws', 'ctx-items', draftId] }),
  });
}

export function useRemoveContextItem(draftId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (itemId: string) =>
      (await api.delete(`${BASE}/drafts/${draftId}/context/${itemId}`)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws', 'ctx-items', draftId] }),
  });
}

// ── In-editor Meri assistant (document-scoped) ───────────────────────────────
// A bounded, READ-ONLY tool loop on the MAIN api (where the Meri tools + AI keys
// live). The editor posts the live document + setup + Context Builder plan and a
// conversation; Meri returns a reply plus proposed edits the editor previews and
// applies. See apps/api/src/workspace-assistant.
export interface WsAssistantEdit {
  op: 'replace_section' | 'insert_section' | 'remove_section';
  section?: string;
  afterSection?: string;
  name?: string;
  content?: string;
  note?: string;
}
export interface WsAssistantConfidence {
  level: 'high' | 'medium' | 'low' | 'unknown';
  label: string;
}
export interface WsAssistantStructuralWarning {
  code: 'rdte_procurement_mismatch' | 'capability_mission_mismatch' | 'primary_vehicle_overclaim';
  peCode: string;
  message: string;
}
export interface WsAssistantStep {
  tool: string;
  label: string;
  detail?: string;
  status: 'done' | 'error';
}
export interface WsAssistantResult {
  reply: string;
  edits: WsAssistantEdit[];
  /** Grounding confidence on the proposed edits (parity with full Meri). */
  confidence?: WsAssistantConfidence;
  /** Deterministic PE structural warnings to surface before applying edits. */
  structuralWarnings?: WsAssistantStructuralWarning[];
  /** Thought-process steps (data lookups Meri ran) for the working view. */
  steps?: WsAssistantStep[];
}
export interface WsAssistantRequest {
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  document: {
    title: string;
    product?: string;
    client?: string;
    sections: Array<{ name: string; content: string; status?: string }>;
  };
  setup?: Record<string, unknown>;
  context?: Array<{ label?: string; text?: string }>;
  clientId?: string;
}
export function useWorkspaceAssistant() {
  const api = useApi();
  return useMutation({
    mutationFn: async (body: WsAssistantRequest) =>
      (await api.post<WsAssistantResult>(`${MAIN}/workspace/assistant`, body)).data,
  });
}

// ── Pre-submission checks (Phase 6b) ─────────────────────────────────────────
/**
 * Rule-based pre-submission checks for a draft. Re-fetched when the popover
 * opens (`enabled`) and kept fresh as the draft is edited (the toolbar score is
 * read from `score`). Tenant-scoped engine endpoint.
 */
export function useDraftChecks(draftId: string | null, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'checks', draftId],
    enabled: !!draftId && enabled,
    staleTime: 10_000,
    queryFn: async () => (await api.get<WsChecksResponse>(`${BASE}/drafts/${draftId}/checks`)).data,
  });
}

// ── Version history (Phase 6b) ───────────────────────────────────────────────
export function useVersions(draftId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'versions', draftId],
    enabled: !!draftId,
    queryFn: async () => (await api.get<WsDocVersion[]>(`${BASE}/drafts/${draftId}/versions`)).data,
  });
}

export function useCreateVersion(draftId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body?: { label?: string; authorKind?: 'meri' | 'person' }) =>
      (await api.post<WsDocVersion>(`${BASE}/drafts/${draftId}/versions`, body ?? {})).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ws', 'versions', draftId] }),
  });
}

export function useRestoreVersion(draftId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (versionId: string) =>
      (await api.post<WsDraft>(`${BASE}/drafts/${draftId}/versions/${versionId}/restore`, {})).data,
    onSuccess: (data) => {
      qc.setQueryData(['ws', 'draft', draftId], data);
      qc.invalidateQueries({ queryKey: ['ws', 'versions', draftId] });
    },
  });
}

// ── Concurrent-edit lock (Phase 6b, Q-ED-2) ──────────────────────────────────
/** Poll lock status (~every 15s). Disabled until the editor mounts a draft. */
export function useLockStatus(draftId: string | null, pollMs = 15_000) {
  const api = useApi();
  return useQuery({
    queryKey: ['ws', 'lock', draftId],
    enabled: !!draftId,
    refetchInterval: draftId ? pollMs : false,
    refetchIntervalInBackground: false,
    queryFn: async () => (await api.get<WsLockStatus>(`${BASE}/drafts/${draftId}/lock`)).data,
  });
}

function useLockAction(draftId: string, verb: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body?: { name?: string }) =>
      (await api.post<WsLockStatus>(`${BASE}/drafts/${draftId}/lock/${verb}`, body ?? {})).data,
    onSuccess: (data) => qc.setQueryData(['ws', 'lock', draftId], data),
  });
}

export const useAcquireLock = (draftId: string) => useLockAction(draftId, 'acquire');
export const useHeartbeatLock = (draftId: string) => useLockAction(draftId, 'heartbeat');
export const useReleaseLock = (draftId: string) => useLockAction(draftId, 'release');
export const useRequestLock = (draftId: string) => useLockAction(draftId, 'request');
export const useTakeOverLock = (draftId: string) => useLockAction(draftId, 'take-over');
