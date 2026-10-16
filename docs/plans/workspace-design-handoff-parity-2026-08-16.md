> **Scope status — backend cleanup successor.** Historical frontend handoff. The old `apps/web` implementation and workspace commands below were retired from this backend repository in PR30. Current frontend implementation and parity belong to `capiro-frontend`. Retain the backend endpoint observations and open gaps as historical evidence; source retirement does not requalify them.
> Source retirement: [PR30](https://github.com/neo-capiro/capiro-backend/pull/30), exact `7b6bda7ca75ea86afb36c76f013f550fdd79e42f`.

# Workspace vNext — design-handoff parity (2026-08-16)

Branch: `ui/workspace-design-handoff-parity`
Source of truth: `Downloads/workspace/design_handoff_workspace/` (README.md + `Capiro Workspace - Untitled UI.dc.html`)

## Goal

Reskin the five workspace vNext surfaces to pixel-exact parity with the design
handoff prototype, wiring every control to a real backend endpoint where one
exists and rendering an honest gap where one does not.

## Surfaces

| Route | File | Prototype section |
|---|---|---|
| library | `library/WorkspaceLibraryVNext.tsx` | §5 |
| create | `creation/WorkspaceQuickDraftCreation.tsx` + `WorkspaceCreationStabilized.tsx` | §6 |
| editor | `editor/WorkspaceEditorStabilized.tsx` | §7 |
| studio | `studio/WorkspaceStudioVNext.tsx` (list, themes, compare) | §8 |
| studioEditor | `studio/WorkspaceStudioVNext.tsx` (blueprint editor) | §9 |
| themeEditor | new `studio/` theme editor route | §10 |
| public | `share/WorkspaceShareView.tsx` | §11 |
| overlays | shared `components/WorkspaceOverlay.tsx` (22 configs) | §12 |

## Hard rules

1. Navy accent `#294E68`, metal-gradient primary buttons, warm semantic palette,
   three type families (Inter UI / IBM Plex Mono mono-label / Spectral paper).
   Spectral must be added to the font stack — it is not currently loaded.
2. Mono is semantic (machine-owned text) — never for body copy / headings / buttons.
3. Honest gaps: features with no backend endpoint render a designed disabled or
   read-only state with the GAPS.md citation, never silently omitted, never fake data.
4. Governed shell (AppShellUui left nav + top bar) is NOT modified — the prototype's
   rail/header divergences (§1, §3) are cross-product decisions owned by the shell.
5. Named exports, `.js` import suffixes, `useQuery` with `['ws-vnext', …]` keys,
   the workspace `api` client (fetch over `/workspace-api`), pre-built `.ws-vnext-*`
   CSS classes where they exist.
6. No chain-of-thought rendering; proposals never auto-apply; expectedRevision read
   from a ref immediately before every mutation.

## Backend endpoints verified present (apps/workspace/src)

- drafts CRUD + list (scope/sector) — GAPS §5: list does NOT project phase/status/quality
- agent: state, brief (synthesize/approve/reopen), context (recommend/analyze/approve,
  item patch), outline (generate/put/revise/approve), proposals (list/accept/reject),
  messages, generate (max), retry, cancel (state-only, GAPS §27), quality
- delivery: preflight, approval-requests (+decide), share-links (+revoke), guest-comments
- documents (packet), comments, collaborators, versions, edit-lock
- template-studio: blueprints CRUD, versions, publish, retire, test, compare
- public share GET + guest comment POST

## Known gaps the UI must surface honestly

- §4 conflict resolution — no semantic route (DTO exists, no controller)
- §5 library list projection — phase/status/quality render "—" (no N+1)
- §6 global search over documents — no `q` param
- §7 anonymize apply — detect only
- §10/§24 proposal payload — no diff data from server
- §11 blueprint pinned count — not in list route
- §13 guest-comments internal panel — endpoint exists, no panel yet (build it read-only)
- §15 theme CRUD — none (theme editor read-only, Save/Publish disabled)
- §16 brand asset upload — none (firm-mark drop target disabled)
- §22 generation stage instrumentation — stages[] always empty from server
- §26 mode pipelines identical — mode chip is a plain label
