# Strategies Context Library import

Implementation and QA note for the draft PR. Deployment and live production verification are not claimed here.

The Context Library now explains its purpose in government-affairs language. Users upload existing client briefings, presentations, firm blueprints, spreadsheets, or meeting notes. Meri identifies relevant information across the existing 14 context categories; a single file can produce several categories. The interface shows readable category names and source excerpts without requiring Markdown, metadata, or individual template files.

The upload dialog uses the shared Strategies modal shell, centered in the viewport through a body portal. The portal retains the existing design-system scope classes. Its body scrolls while the header and actions remain available; mobile uses the existing full-height sheet treatment.

**Workflow and persistence**

1. Choose a client and either one strategy or all strategies for that client. Client-wide context requires the existing administrator permission. This import flow does not offer firm-wide scope.
2. Add up to 10 files, each no larger than 25 MB. Upload uses the existing attachment workflow: originals are stored with the client and submitted to the existing asynchronous client knowledge-base indexing process before context review. Canceling the review does not delete those uploaded originals.
3. The API reads the file with source locations such as pages, slides, and spreadsheet row ranges. `api-strategy` splits the extracted source into bounded analysis requests; the orchestrator uses the existing tenant credential infrastructure to organize it into context categories.
4. Review the extracted content and source excerpts, select the items to keep, and save. No generated Context Library document or fact is persisted before that save. Failed files or sections retain an explicit retry path, and successful work can be saved separately.
5. Saving creates the canonical Markdown and active context facts with `working_draft` authority and `source_of_truth: false`. Import time is distinguished from an unknown source date. Existing context is preserved, potential disagreements are recorded for review, and retries do not overwrite prior review decisions. Written instructions about Meri's missions or permissions do not grant permissions, create schedules, or execute work.

**File coverage and bounded reading**

| Files | Current behavior |
| --- | --- |
| PDF | Extracts selectable text by page. Scanned pages use the existing credential-dependent visual reader when available. |
| Word `.docx`, `.doc` | Uses the existing bounded document extraction path. Unreadable files receive conversion/retry guidance. |
| PowerPoint `.pptx` | Reads slide text in presentation order and linked speaker notes. Images, diagrams, and charts produce a partial-coverage notice. |
| Excel `.xlsx` | Reads worksheet cell values with sheet/row references. Missing saved formula results and visual content are disclosed. |
| CSV, TXT, Markdown, JSON | Uses the existing text extraction path. No special formatting is required. |
| PNG, JPG/JPEG | Uses the existing visual reader; images must be 5 MB or smaller. |
| Older PowerPoint `.ppt` and Excel `.xls` | Originals can be uploaded, but extraction asks the user to save as `.pptx`, `.xlsx`, or PDF and retry. No automatic binary Office conversion is claimed. |

Extraction is limited to 100,000 characters, 200 PDF pages or presentation slides, and 5,000 spreadsheet rows / 50 columns. Visual reading attempts at most four pages within a 45-second overall budget and depends on an available tenant visual-model credential. Partial or unavailable reading is disclosed; an unreadable file does not become a successful import. Presentation/Word/spreadsheet graphics are not fully interpreted by their text extractors. The UI directs users to add a PDF or image when those visuals contain material information.

**Deployment and configuration**

Ship all four services together: `apps/web`, `apps/api`, `apps/api-strategy`, and `apps/meriv2-orchestrator`. The web flow calls `/strategy-api/context/imports/{resolve,analyze,save}`; `api-strategy` reads the tenant-authorized attachment endpoints on the API and calls the orchestrator for analysis and conflict comparison.

Reuse the existing `INTERNAL_SERVICE_SECRET` for signed review payloads, existing `API_INTERNAL_URL` / `API_BASE_URL` and `MERIV2_ORCHESTRATOR_URL` service routing, attachment storage/scanning/indexing configuration, and tenant BYOK infrastructure. The existing strategy-planner, agentic, and context-steward access guards remain in force. `MERIV2_CONTEXT_IMPORT_TIMEOUT_MS` can lower the orchestrator's default 50-second request deadline; it cannot raise that cap. No database migration or new credential store is introduced.

**Verification**

298 tests passed in the materialized task checkout:

| Area | Result | Coverage |
| --- | --- | --- |
| Strategy API | 184 tests / 8 suites | 17 new import workflow tests; existing document, frontmatter, fact/steward, locator, plan-export, module boot and orchestrator-client regressions. |
| API extraction | 33 tests / 3 suites | 13 extraction cases, exact route-manifest regeneration and runtime policy coverage. Real Office/image/PDF-structure fixtures; the committed PDF extraction tests mock the PDF.js worker boundary, with a separate actual PDF parsing smoke check. |
| Orchestrator | 56 tests / 4 suites | Source grounding, 14 categories, strict structured results, incoming/existing conflicts, scoped provider adapters, fallback, timeouts, failures and metering. Provider HTTP responses are mocked. |
| Web | 25 tests / 4 suites | Multi-file upload, review, partial saves, retries, expired/source-changed review recovery, readable citations, existing conflict decisions, portal centering rules, focus and busy-state dismissal. |

The complete materialized Strategy API passes `tsc --noEmit --incremental false`. Its tests ran with `jest --runInBand src/context src/app.module.di-boot.spec.ts src/meri/strategy-orchestrator.client.spec.ts` from `apps/api-strategy`.

API helper and orchestrator service/client checks passed focused strict TypeScript checks with their documented dependency boundaries. Modified page/helper modules passed transpilation checks. API, orchestrator and web tests ran through isolated Jest/Vitest harnesses because the full monorepo and its installed workspace dependencies were not available locally. These results do not claim full builds of those three applications.

Live provider calls, an authenticated end-to-end upload/save against deployed services, and rendered browser geometry remain unverified. Browser geometry could not run because the environment had no Chromium executable; DOM placement, CSS selector matching, centering rules and keyboard behavior are covered by the modal tests. The PR remains a draft for that integration verification.
