# Workspace vNext — Two-Screen Max Draft Flow

## Status

Implemented on `agent/workspace-two-screen-max-flow` for review. This document is the frontend/backend handoff for the simplified creation experience.

## Product workflow

Workspace creation is now intentionally two screens:

1. **Intake** — goal, template, sources, and Capiro context.
2. **Draft** — a complete editable first draft with the existing Meri conversation, comments, collaborators, versions, locks, quality, delivery, and export tools.

The former user-visible sequence `Goal → Type → Blueprint → Design → Brief → Context → Outline → Generate` is no longer the primary creation path. Those artifacts are still created and persisted by the backend for governance, but Meri builds them inside one Max-reasoning operation.

## Intake screen

Route:

```text
/workspace/new
```

### Goal

The user tells Meri:

- what should be written;
- who must act;
- the requested outcome;
- why it matters now.

The user may select a client. The actual client profile record is attached as factual context when the **Client profile** context domain is selected.

### Published submission templates

The intake lists published Capiro and firm blueprints. A published blueprint version is pinned before generation and continues to define:

- structure;
- required and locked sections;
- evidence rules;
- content rules;
- approval policy;
- default theme.

Firm administrators can continue creating and publishing custom templates through Template Studio:

```text
/workspace/studio
```

Draft or retired blueprint versions cannot be pinned by the intake.

### Four source groups

#### 1. Relevant context

User-provided factual or background material. Current intake supports text-readable files and pasted text.

Purpose value:

```text
context
```

#### 2. Client saved documents

Previously saved Workspace drafts associated with the selected client. The current draft section content and packet documents are flattened into a bounded text source.

Purpose value:

```text
client_saved
```

#### 3. Sample documents

Examples used only for:

- structure;
- tone;
- organization;
- rhetorical quality.

Sample documents are explicitly excluded from factual evidence IDs and claim grounding. Prompts prohibit copying distinctive wording.

Purpose value:

```text
sample
```

#### 4. Capiro context

A simple selector for internal context domains, including:

- Client profile
- Strategies and priorities
- Relationships and targets
- Engagement history
- Institutional memory
- Mailbox and correspondence
- Client files and notes
- People and stakeholders
- Defense budget
- Grants and contracts
- Legislation and hearings
- News and intelligence
- District Nexus

The actual selected client profile is attached immediately. Other domains are currently persisted as **retrieval requests** with `factualUseAllowed=false`; their labels and instructions cannot support factual claims until a cross-service resolver supplies the underlying records.

Purpose value:

```text
system
```

## Generation API

```http
POST /workspace-api/drafts/:draftId/agent/generate-from-intake
```

Authenticated with the existing Workspace TenantGuard and object-level `canEdit` authorization.

### Request

```json
{
  "expectedRevision": 1,
  "goal": "Create a two-page FY27 NDAA paper asking HASC staff to protect the Ground Robotics request.",
  "sources": [
    {
      "purpose": "context",
      "label": "FY27 budget notes",
      "text": "...",
      "sourceType": "user-upload"
    },
    {
      "purpose": "client_saved",
      "label": "Prior authorization paper",
      "text": "...",
      "refId": "draft-uuid",
      "sourceType": "workspace-document"
    },
    {
      "purpose": "sample",
      "label": "Strong committee-facing paper",
      "text": "...",
      "sourceType": "sample-document"
    },
    {
      "purpose": "system",
      "label": "Defense budget",
      "text": "Retrieve relevant Program Elements and funding deltas.",
      "refId": "defense-budget",
      "sourceType": "capiro-context-request",
      "metadata": {
        "resolved": false
      }
    }
  ]
}
```

### Source limits

- Maximum 40 sources.
- Maximum 50,000 characters per source.
- Maximum 120,000 source characters sent to a single reasoning packet.
- Each individual source is capped at 18,000 prompt characters.
- Truncation is declared in the structured source packet.

### Max reasoning pipeline

The operation calls the existing structured `WorkspaceReasoningGateway` methods in this order:

1. `synthesizeBrief`
2. `analyzeContext`
3. `generateOutline`
4. `planDocument` — Max
5. `draftDocument` for each section — Max
6. `runEditorialPass` — Max
7. atomic `WsDraft.config` save

The saved draft includes:

```text
config.sections
config.sectionContent
config.quickDraftIntake
config.documentAgent.brief
config.documentAgent.contextPlan
config.documentAgent.outline
config.documentAgent.generation.lastRun
```

On success the agent state moves directly to:

```json
{
  "phase": "draft",
  "generation": {
    "mode": "max"
  }
}
```

The browser then opens:

```text
/workspace/:draftId
```

## Evidence boundaries

Only `context` and `client_saved` sources may support factual claims.

`sample` sources are style-only.

Unresolved `system` context requests are planning instructions, not evidence.

Generated outline evidence IDs are filtered against the factual-source allowlist before persistence.

If context analysis finds conflicts:

- the complete draft may still be generated with qualified/omitted claims;
- conflicts remain `resolved=false`;
- context is not marked approved;
- the generation run becomes `complete_with_warnings`;
- delivery remains subject to the existing conflict and quality gates.

## Concurrency and recovery

The request requires the latest `expectedRevision`.

The final draft save also compares the original `WsDraft.updatedAt`, preventing a long Max run from overwriting edits made while generation was in progress.

On stale state:

```text
409 DOCUMENT_AGENT_REVISION_CONFLICT
```

Draft creation occurs only when the user selects **Generate first draft**.

If agent initialization fails, the frontend attempts to delete the orphan draft.

If generation fails after initialization, the initialized draft is retained and the UI offers **Open saved draft** for recovery.

A transcript-write failure after the document save is non-fatal; it cannot relabel a successfully persisted draft as failed.

## Existing editor retained

The draft screen continues to use the stabilized Workspace editor and existing collaboration services:

- persistent Meri conversation;
- editable generated section content;
- packet tabs;
- selected-text revisions through proposals;
- comments and replies;
- collaborators and roles;
- edit locks;
- versions and restore;
- quality checks;
- delivery preflight;
- frozen client shares;
- DOCX/PDF export.

## Honest remaining gaps

### Binary parsing on the intake

The current intake reads:

```text
.txt
.md
.markdown
.csv
.json
.html
.htm
.xml
```

It does not claim direct PDF or DOCX parsing. Those files are rejected with an explanation to paste the text or use a saved Workspace document. A follow-up should connect the intake to Capiro’s durable upload/parser pipeline, rather than placing base64 files in the generation request.

### Cross-service Capiro context resolution

The client profile is resolved and attached. The remaining context-domain selections are persisted as retrieval requests because Workspace does not yet have a single context-packet endpoint that resolves all of:

- strategies;
- relationships;
- engagement history;
- institutional memory;
- mailbox;
- files;
- people;
- defense budget;
- funding;
- legislation;
- news;
- District Nexus.

A follow-up should add a tenant- and client-scoped context resolver that returns source-backed records with provenance and access-policy enforcement. Until then, unresolved context requests cannot support factual claims.

### Synchronous generation

The operation is request-scoped. The intake does not display fabricated percentages or time estimates and asks the user to keep the page open. A durable job/worker with reconnectable progress remains a future infrastructure improvement.

## Required validation before merge

```bash
pnpm --filter @capiro/shared build
pnpm --filter @capiro/meriv2-core build
pnpm --filter @capiro/auth build

pnpm --filter @capiro/workspace prisma:generate
pnpm --filter @capiro/workspace typecheck
pnpm --filter @capiro/workspace test -- --runInBand
pnpm --filter @capiro/workspace build

pnpm --filter @capiro/web typecheck
pnpm --filter @capiro/web test
pnpm --filter @capiro/web build

git diff --check
```

No merge or deployment is authorized by this implementation branch alone.
