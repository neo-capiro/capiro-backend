
# Meri v3 Design System Implementation — Gap Analysis
## Date: 2026-08-16
## Branch: agent/meriv3-design-system-impl

## Prototype Feature Inventory → Backend Mapping

### 1. TITLE BAR
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Meri wordmark | Static asset | ✅ EXISTS | `/assets/meri-logo.png` |
| Shell label "Undocked Workspace" | N/A | ✅ EXISTS | In VNextMeriTopBar |
| Scope selector (center) | `GET /api/clients` | ✅ EXISTS | VNextMeriTopBar scope trigger |
| Scope meta (record count) | `GET /api/clients` (returns count) | ⚠️ PARTIAL | Shows client count, not record count per client |
| Search (⌘K) | `GET /api/clio/conversations/search?q=...` | ✅ EXISTS | ThreadRail search + palette |
| New thread button | `POST /api/clio/conversations` | ✅ EXISTS | handleNewSession |
| WHAT MERI CAN DO (Pro Tip) | N/A (static content) | ✅ EXISTS | PRO_TIPS in VNextMeriTopBar |
| Avatar | Clerk user | ✅ EXISTS | IdentityMark in VNextMeriTopBar |
| Window controls (dock/max/close) | localStorage (meri-prefs) | ✅ EXISTS | readWindowChrome/writeWindowChrome |

### 2. SCOPE SELECTOR DROPDOWN
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Search field | Client-side filter | ⚠️ MISSING | No search input in scope dropdown |
| "This thread" row (FIXED AT CREATION) | N/A | ⚠️ MISSING | Thread scope is immutable — prototype shows it |
| Client rows with record counts | `GET /api/clients` | ⚠️ PARTIAL | Shows clients but not per-client record counts |
| "All clients · Portfolio" row | N/A | ✅ EXISTS | Portfolio option in scope menu |
| Footnote card | N/A (static) | ⚠️ MISSING | "Scope is durable conversation context..." |

### 3. COMMAND PALETTE (⌘K)
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Full-surface scrim + dialog | N/A | ⚠️ MISSING | Current: thread rail search only, not full palette |
| Search threads, messages, context, sources, actions | `GET /api/clio/conversations/search` | ⚠️ PARTIAL | Only searches conversations, not context/sources/actions |
| Result kinds (THREAD, MESSAGE, SOURCE, SKILL, CLIENT) | N/A | ⚠️ MISSING | Single result list without kind labels |
| Keyboard navigation | N/A | ⚠️ MISSING | No arrow-key navigation in search results |

### 4. TOAST
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Bottom-centered, auto-dismiss 2600ms | N/A | ✅ EXISTS | useCapiroToast |

### 5. THREAD RAIL (300px)
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| New thread button (primary gradient) | `POST /api/clio/conversations` | ✅ EXISTS | |
| SAVED PROMPTS section | N/A | ⚠️ GAP | Shows "NO SAVED PROMPTS" — no backend endpoint |
| WORKSPACES section | N/A | ⚠️ GAP | Shows "NO WORKSPACES YET" — no backend endpoint |
| RECENT section with search | `GET /api/clio/conversations` + search | ✅ EXISTS | |
| Thread groups (TODAY/EARLIER) | Client-side grouping | ✅ EXISTS | |
| Thread rows with kind icon, title, meta | `GET /api/clio/conversations` | ✅ EXISTS | |
| Search snippet in results | `GET /api/clio/conversations/search` | ⚠️ PARTIAL | Shows snippet but not highlighted |
| Thread row menu (Rename, Move to workspace, Duplicate, Archive) | `PATCH /api/clio/conversations/:id` | ⚠️ PARTIAL | Rename+Archive exist; Move to workspace + Duplicate are GAPS |
| Loading skeletons | N/A | ✅ EXISTS | |
| Empty state | N/A | ✅ EXISTS | |
| No-results state | N/A | ✅ EXISTS | |

### 6. CONVERSATION HEADER
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Rail toggle (when collapsed) | localStorage | ✅ EXISTS | |
| Thread icon | Client-side (kindFor) | ✅ EXISTS | |
| Title + sub | `GET /api/clio/conversations/:id` | ✅ EXISTS | |
| Mode pill (NEW/STANDARD/RESEARCHING/CLARIFYING/APPROVAL) | Derived from controller state | ✅ EXISTS | |
| Reasoning depth picker | `GET/PATCH /api/clio/v3/conversations/:id/reasoning-mode` | ✅ EXISTS | VNextMeriReasoningControl |
| Bookmark | N/A | ⚠️ GAP | Disabled, "not available yet" |
| Overflow menu | N/A | ⚠️ GAP | Disabled, "not available yet" |

### 7. CONVERSATION SETTINGS POPOVER
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Thread name input | `PATCH /api/clio/conversations/:id` | ✅ EXISTS | |
| Workspace/client select | `PATCH /api/clio/conversations/:id` | ⚠️ GAP | No workspace concept in backend |
| Warning card | N/A (static) | ⚠️ MISSING | |
| Archive button | `POST /api/clio/conversations/:id/archive` | ✅ EXISTS | |
| Cancel/Save buttons | N/A | ✅ EXISTS | |

### 8. ANSWER ANATOMY
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Day divider | Client-side (dayDividerLabel) | ✅ EXISTS | |
| User turn (right-aligned bubble) | N/A | ✅ EXISTS | |
| Attachment chips (9 states) | `POST /api/clio/attachments` | ⚠️ PARTIAL | Shows uploading/ready/truncated/error, but not all 9 states |
| User message editor (edit & resend) | `POST /api/clio/conversations/:id/stream` | ✅ EXISTS | handleEditResend |
| Assistant turn frame (meta row + card) | N/A | ✅ EXISTS | |
| Skill tag (SKILL · CLIENT CHANGES, etc.) | From orchestrator response | ⚠️ PARTIAL | Shows research offers but not skill tags |

### 9. ANSWER BLOCK TYPES
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Paragraph | Markdown rendering | ✅ EXISTS | ReactMarkdown |
| Heading | Markdown rendering | ✅ EXISTS | |
| Bulleted list | Markdown rendering | ✅ EXISTS | |
| Ordered list | Markdown rendering | ✅ EXISTS | |
| Task list | Markdown rendering | ⚠️ PARTIAL | GFM supports it, but not styled as checkboxes |
| Table | Markdown rendering | ✅ EXISTS | |
| Blockquote | Markdown rendering | ✅ EXISTS | |
| Code block | Markdown rendering | ✅ EXISTS | |
| Figure grid (KV) | N/A | ⚠️ GAP | No KV block renderer |
| Callout | N/A | ⚠️ GAP | No callout renderer |

### 10. INLINE SPANS
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Bold | Markdown | ✅ EXISTS | |
| Code | Markdown | ✅ EXISTS | |
| Link | Markdown | ✅ EXISTS | |
| Inline citation | Custom injection | ✅ EXISTS | injectCitations |

### 11. STREAMING CURSOR
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Pulsing block cursor | SSE stream | ✅ EXISTS | StreamingDots |
| "COMPOSING ANSWER…" label | N/A | ⚠️ MISSING | No label, just dots |

### 12. MeriAnalysisCard
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Chart view (stacked bar) | `GET /api/clio/artifacts/:id/image` | ✅ EXISTS | AnalysisChartCard |
| DATA view (table) | Same artifact | ⚠️ PARTIAL | Chart card exists but no DATA tab |
| IMAGE view | Same artifact | ⚠️ PARTIAL | |
| CSV export | N/A | ⚠️ GAP | No CSV export |
| PNG export | N/A | ⚠️ GAP | No PNG export |
| Expand to artifact canvas | N/A | ⚠️ GAP | No expand action |
| Insight strip | From artifact metadata | ⚠️ GAP | No insight display |
| Series legend with toggle | N/A | ⚠️ GAP | No series toggling |
| Provenance strip (DERIVED marker) | From artifact metadata | ⚠️ GAP | No provenance display |

### 13. MeriArtifactBlock (in-answer summary)
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Artifact icon + eyebrow + meta | N/A | ⚠️ GAP | No artifact block in answers |
| Title + bullet sections | N/A | ⚠️ GAP | |
| OPEN IN CANVAS button | N/A | ⚠️ GAP | No artifact canvas |

### 14. DEEP RESEARCH
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Clarifying questions (MeriResearchClarify) | `POST /api/clio/research` + `POST /api/clio/research/:id/clarify` | ✅ EXISTS | ResearchClarifyInline |
| Research progress (MeriResearchProgress) | SSE `/api/clio/research/:id/plan/stream` | ⚠️ PARTIAL | Shows plan steps but not styled as prototype |
| Step list with 5 states (done/running/queued/failed/skipped) | SSE stream | ⚠️ PARTIAL | Shows trust steps but not with state icons |
| Live source chips | SSE stream | ⚠️ GAP | No live source chips during research |
| Progress bar with percentage | SSE stream | ⚠️ GAP | No progress percentage |
| Stop research | `POST /api/clio/conversations/:id/stream` (abort) | ✅ EXISTS | handleStop |
| Composer during research (placeholder + stop button) | N/A | ✅ EXISTS | |

### 15. GOVERNED ACTIONS (MeriActionProposal)
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Approval card with 10 lifecycle states | `GET /api/clio/action-proposals?conversationId=...` | ⚠️ PARTIAL | Shows pending approvals but not 10 states |
| Approve/Dismiss actions | `POST /api/clio/action-proposals/:id/approve` + `/dismiss` | ✅ EXISTS | |
| Risk flags (external/internal/reversible/irreversible) | From proposal metadata | ⚠️ GAP | No risk flag display |
| Message preview | From proposal metadata | ⚠️ GAP | No message preview |
| Governance detail (expandable) | From proposal metadata | ⚠️ GAP | No expandable governance detail |
| Confirmation modal (MeriActionConfirmation) | N/A | ⚠️ GAP | No confirmation modal |
| Bulk approval (MeriBulkApproval) | `POST /api/clio/action-proposals/:id/approve` (multiple) | ⚠️ PARTIAL | handleApproveAll exists but no bulk modal |

### 16. GROUNDING WARNING (MeriGroundingWarning)
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Warning banner with 4 kinds | From grounding caveat | ✅ EXISTS | Shows groundingCaveat findings |

### 17. TRUST ROW + EVIDENCE TRAY
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Source chips (first 3 + overflow) | From citations | ✅ EXISTS | VNextMeriSourceChip |
| Coverage chip (full/partial/conflict/missing) | From verification | ⚠️ PARTIAL | Shows verification label but not coverage chip |
| Verification chip (6 states) | From verification | ⚠️ PARTIAL | Shows GROUNDED/PARTIAL SUPPORT/REVIEW FLAGGED |
| Evidence toggle (EVIDENCE/HIDE EVIDENCE) | N/A | ⚠️ GAP | No evidence tray |
| 4 sub-tabs (Sources, Verification, Work Performed, Context Used) | N/A | ⚠️ GAP | No sub-tabbed evidence tray |

### 18. MESSAGE ACTIONS + FEEDBACK
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| COPY | N/A | ✅ EXISTS | |
| REGENERATE | `POST /api/clio/conversations/:id/stream` | ✅ EXISTS | handleRegenerate |
| Thumbs up/down | `POST /api/clio/messages/:id/feedback` | ✅ EXISTS | MessageFeedback |
| Feedback form (10 reasons + note) | Same endpoint | ⚠️ PARTIAL | Shows thumbs up/down but not 10-reason form |
| Follow-up chips | From suggestions | ✅ EXISTS | message.suggestions |
| Deep-research offer | `POST /api/clio/research` | ✅ EXISTS | researchOffers |

### 19. COMPOSER
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Add button (+) with popover | N/A | ✅ EXISTS | |
| 6 add items (Upload, Note, HubSpot, SharePoint, Airtable, Import) | `POST /api/clio/attachments` + integrations | ⚠️ PARTIAL | Upload+Note work; Connect items navigate to integrations |
| Task mode picker (STANDARD/RESEARCH/WRITE) | N/A | ⚠️ GAP | No task mode picker |
| Scope pill | From controller | ✅ EXISTS | |
| Context pill | From controller | ✅ EXISTS | |
| Send button | `POST /api/clio/conversations/:id/stream` | ✅ EXISTS | |
| Stop button (during research) | Abort stream | ✅ EXISTS | |
| Disclaimer footer | N/A (static) | ✅ EXISTS | |

### 20. HOME SURFACE
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Greeting with Meri mark + session dot | N/A | ✅ EXISTS | |
| Scope line (TENANT · SCOPE · N OF M CLIENTS) | `GET /api/clients` | ✅ EXISTS | |
| Composer centered | N/A | ✅ EXISTS | |
| Prompt library (paginated, 4 per page) | N/A (static) | ✅ EXISTS | PROMPT_LIBRARY |
| START WORK section (SKILLS/PROMPTS tabs) | N/A | ⚠️ GAP | No skills/prompts tabs |
| Skill cards with NEEDS A CLIENT badge | N/A | ⚠️ GAP | No skill cards |
| Footnote about editable intent | N/A (static) | ⚠️ MISSING | |

### 21. SIDE PANEL (right rail)
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Panel header with tabs (Context, Memory, Artifact) | N/A | ⚠️ PARTIAL | Only Context tab exists |
| Collapsed strip (66px) with badges | localStorage | ✅ EXISTS | |
| ACTIVE CONTEXT section (3 items + Manage context) | From attachments | ⚠️ PARTIAL | Shows attachments, not full context items |
| CONNECTED SOURCES section (4 rows + Manage integrations) | Managed apps API | ✅ EXISTS | |
| QUICK ACTIONS section (3 actions + View all) | N/A (static) | ✅ EXISTS | |
| Footer strip | N/A (static) | ✅ EXISTS | |
| Memory mode | `GET /api/clio/memory/recent` | ⚠️ GAP | No memory panel in right rail |
| Artifact canvas mode | N/A | ⚠️ GAP | No artifact canvas |
| Source detail mode | N/A | ⚠️ GAP | No source detail panel |
| Manage context mode | N/A | ⚠️ GAP | No manage context panel |

### 22. SOURCE DETAIL SHEET
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Nav row (prev/next + counter + IN ACTIVE CONTEXT chip) | N/A | ⚠️ GAP | |
| Provider + title | From citation | ⚠️ PARTIAL | Shows citation title in inline panel |
| Chips (locator, fit, OPEN SOURCE) | From citation | ⚠️ GAP | No locator/fit chips |
| Why it matters | From server | ⚠️ GAP | No "why it matters" section |
| Evidence in this conversation | From server | ⚠️ GAP | No evidence cards |
| Provenance (SOURCE, LAST VERIFIED, SCOPE, CITATION, VERSION) | From server | ⚠️ GAP | No provenance section |
| Include in active context toggle | N/A | ⚠️ GAP | No context toggle |

### 23. MANAGE CONTEXT SHEET
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Search across clients, strategies, bills, meetings, files | N/A | ⚠️ GAP | No server-side context search |
| INCLUDED IN THIS THREAD · N | From attachments | ⚠️ PARTIAL | Shows attachments, not full context |
| SUGGESTED CONTEXT | N/A | ⚠️ GAP | No suggested context |
| CONTEXT BEHAVIOR toggles | N/A | ⚠️ GAP | No context behavior toggles |
| Apply context button | N/A | ⚠️ GAP | No apply context action |

### 24. INTEGRATIONS MODAL
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| Header (CONNECTED SOURCES, title, sub-line) | N/A | ✅ EXISTS | |
| Tabs (CONNECTED · N / AVAILABLE · N) | Managed apps API | ⚠️ PARTIAL | Shows all apps, no tab separation |
| SECURE OAUTH SIGN-IN label | N/A | ✅ EXISTS | |
| Rows with lettered tiles, names, descriptions, states | Managed apps API | ✅ EXISTS | |
| 5 connection states (CONNECTED, AVAILABLE, CONNECTING, ERROR, REAUTH NEEDED) | Managed apps API | ⚠️ PARTIAL | Shows connected/reconnect/available/not-configured |
| Footer note + Done button | N/A | ✅ EXISTS | |

### 25. STATES GALLERY (Screen Q)
| Feature | Backend Endpoint | Status | Notes |
|---------|-----------------|--------|-------|
| MeriActionLifecycle (10 states) | N/A | ⚠️ GAP | No lifecycle states gallery |
| MeriAttachmentChip (9 states) | N/A | ⚠️ GAP | No attachment states gallery |
| Empty/error/permission states (12 states) | N/A | ⚠️ GAP | No states gallery |
| Answer states (streaming, ungrounded, partial) | N/A | ⚠️ PARTIAL | Streaming+ungrounded exist, partial missing |

## SUMMARY OF GAPS (features with no backend endpoint)

### BLOCKING GAPS (core prototype features with no backend)
1. **Saved prompts library** — No endpoint to save/retrieve user prompts
2. **Workspaces** — No workspace concept in backend (client workspaces, shared workspaces)
3. **Command palette (full)** — Only conversation search exists; no context/sources/actions search
4. **Task mode picker** — No STANDARD/RESEARCH/WRITE mode in backend
5. **Artifact canvas** — No artifact model or canvas endpoint
6. **Memory panel in right rail** — Memory exists but not in right rail panel
7. **Source detail sheet** — No source detail endpoint with provenance
8. **Manage context sheet** — No context management endpoint
9. **Evidence tray with 4 sub-tabs** — No evidence tray endpoint
10. **Analysis card sub-tabs (CHART/DATA/IMAGE)** — No sub-tab structure in artifact endpoint
11. **CSV/PNG export** — No export endpoints
12. **Skill cards + skills library** — No skill endpoints
13. **Attachment chip states (all 9)** — Backend returns fewer states
14. **Action lifecycle states (10)** — Backend returns fewer states
15. **Bulk approval modal** — No bulk approval endpoint
16. **Confirmation modal for actions** — No confirmation endpoint
17. **Context behavior toggles** — No context behavior endpoint
18. **Suggested context** — No suggested context endpoint
19. **Server-side context search** — No context search endpoint
20. **Reasoning depth saved-state line** — No saved-state timestamp endpoint

### NON-BLOCKING GAPS (UI-only, can be built with mock data)
21. **Scope selector search field** — Client-side filter only
22. **Scope footnote card** — Static content
23. **Command palette kind labels** — UI enhancement
24. **Streaming cursor label** — "COMPOSING ANSWER…" text
25. **Figure grid (KV) block** — New block type
26. **Callout block** — New block type
27. **Task list checkboxes** — Styled checkboxes
28. **Skill tag on assistant turns** — From orchestrator metadata
29. **Live source chips during research** — From SSE stream
30. **Progress bar with percentage** — From SSE stream
31. **Risk flags on action proposals** — From proposal metadata
32. **Message preview in action proposals** — From proposal metadata
33. **Governance detail expandable** — From proposal metadata
34. **Coverage chip** — From verification metadata
35. **Verification chip (6 states)** — From verification metadata
36. **Feedback form (10 reasons)** — Enhanced feedback form
37. **START WORK section with tabs** — UI enhancement
38. **Thread row menu items (Move to workspace, Duplicate)** — Backend endpoints needed
39. **Bookmark button** — No bookmark endpoint
40. **Thread overflow menu** — No overflow endpoint

## EXISTING BACKEND ENDPOINTS (confirmed)
- `GET /api/clients` — List clients
- `GET /api/clio/conversations` — List conversations
- `POST /api/clio/conversations` — Create conversation
- `GET /api/clio/conversations/:id` — Get conversation
- `PATCH /api/clio/conversations/:id` — Update conversation (rename)
- `POST /api/clio/conversations/:id/archive` — Archive conversation
- `GET /api/clio/conversations/search?q=...` — Search conversations
- `POST /api/clio/conversations/:id/stream` — Send message (SSE stream)
- `POST /api/clio/attachments` — Upload attachment
- `POST /api/clio/messages/:id/feedback` — Submit feedback
- `GET /api/clio/action-proposals?conversationId=...` — List action proposals
- `POST /api/clio/action-proposals/:id/approve` — Approve proposal
- `POST /api/clio/action-proposals/:id/dismiss` — Dismiss proposal
- `GET /api/clio/memory/recent?limit=5` — Recent memories
- `PATCH /api/clio/memory/:id` — Update memory
- `DELETE /api/clio/memory/:id` — Forget memory
- `POST /api/clio/research` — Start research
- `POST /api/clio/research/:id/clarify` — Submit clarify answers
- `GET /api/clio/research/:id/export/:kind` — Export research
- `GET /api/clio/alerts` — List alerts
- `POST /api/clio/alerts/:id/dismiss` — Dismiss alert
- `GET /api/clio/v3/conversations/:id/reasoning-mode` — Get reasoning mode
- `PATCH /api/clio/v3/conversations/:id/reasoning-mode` — Set reasoning mode
- Managed apps API (connect/disconnect/list)
