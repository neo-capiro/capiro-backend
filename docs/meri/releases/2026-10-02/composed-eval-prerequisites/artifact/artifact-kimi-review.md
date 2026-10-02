Replied in previous turn, but platform confirmation failed. Let me provide the independent source review now.

---

## Independent Source Review: Case46 Artifact Owner TXT Export Implementation

Branch: `codex/meri-case46-artifact-owner-20261002`

**Scope:** Review of final bounded TXT export implementation adding UTF-8 text artifact creation through existing governed `create_word` format `txt`, immutable owned artifact bytes with operation UUID, and authenticated download/UI support.

---

### REVIEW FINDINGS

#### 1. API Layer (`apps/api/src/meri/meri-docgen.helpers.ts`)

**PASS.** The implementation correctly:
- Adds `'txt'` to `DocFormat` union type
- Defines `TextSpec` interface with `title` and `text` fields
- Implements `MAX_TEXT_BYTES = 1024 * 1024` (1MiB limit)
- Implements `validateTextBytes()` with UTF-8 fatal decode, BOM acceptance, control character restriction (tab/CR/LF only), surrogate rejection
- Implements `normalizeTextSpec()` with exact byte preservation via `TextEncoder`/`TextDecoder` roundtrip validation
- Returns `text/plain; charset=utf-8` MIME type

**Verification:** The `text !== textRaw` check after `validateTextBytes()` ensures exact Unicode preservation. BOM (`\ufeff`) is handled via `ignoreBOM: true` in decoder, allowing it in content while still validating UTF-8.

#### 2. API Artifact Integrity (`apps/api/src/meri/meri-artifact-integrity.ts`)

**PASS.** The implementation correctly:
- Excludes `'txt'` from OOXML validation path (OOXML_MAIN_PART and `validateOoxmlArtifactPackage`)
- Adds `txt` case in `validateDocumentArtifactBytes()` calling `validateTextBytes(bytes)`

**Note:** The `Exclude<DocFormat, 'pdf'>` type changes to `Exclude<DocFormat, 'pdf' | 'txt'>` are appropriately applied.

#### 3. API Tools Service (`apps/api/src/meri/meri-tools.service.ts`)

**PASS.** The implementation correctly:

**In `TOOLS_REGISTRY`:**
- Adds `'txt'` to `format` enum with description update
- Adds `text` field description for exact UTF-8 text

**In `execute()` switch:**
- Accepts `'txt'` format, delegates to `createDocument`

**In `createDocument()`:**
- Requires `conversationId` for txt format (ownership validation)
- Uses `normalizeTextSpec(input)` validation
- Creates `generatedBuffer = Buffer.from(spec.text, 'utf8')`
- Sets `kind: 'text_document'`
- Creates immutable `textCreation` receipt with `randomUUID()` operation ID
- Stores `bodyText` as actual text content (not JSON) for txt format
- Returns `operationReceipt` via `readTextArtifactCreation()`

**In `getDocumentArtifact()`:**
- Selects `conversationId` and verifies association
- Requires `textCreation` metadata for txt artifacts (throws `UnprocessableEntityException` if missing)
- Returns `operationReceipt` reconstructed from metadata via `readTextArtifactCreation()`

**In `renderStoredDocument()`:**
- Throws `UnprocessableEntityException` for txt format (prevents regeneration, requires immutable bytes)

#### 4. API Controller (`apps/api/src/meri/meri.controller.ts`)

**PASS.** Adds `X-Capiro-Artifact-Operation-Id` header in download response when `operationReceipt` present, and exposes it in `Access-Control-Expose-Headers`.

#### 5. API Receipt Module (`apps/api/src/meri/meri-text-artifact-receipt.ts`)

**PASS.** New file implementing:
- `TextArtifactCreation` interface with all required fields
- `readTextArtifactCreation()` function that validates receipt against actual database row, rejecting tampered metadata

**Critical validation:** The function checks `version === 1`, `kind === 'meri_text_artifact_creation'`, UUID v4 format for `operationId`, and field-by-field equality with the actual persisted row. This prevents metadata-only attacks on ownership or byte identity.

#### 6. Orchestrator (`apps/meriv2-orchestrator/src/meri/meriv3/meriv3-semantic-compatibility-tools.ts`)

**PASS.** The implementation correctly:
- Maps `text` type to `create_word` tool
- Adds `text` to `CLIENT_AWARE_ARTIFACT_TYPES` set
- Updates schema enum and description
- In `execute()`, sets `format: 'txt'` and `sections: []` for text type
- **Pagination note:** The test at line 217 shows V3 linking via `producedArtifactIds` (not duplicating artifacts), satisfying the "V3 with actual rowcount" binding requirement

#### 7. Web Components (`apps/web/src/components/chat/`)

**PASS.** Implementation correctly:
- Adds `text_document` to `DOC_KINDS` in `MeriCanvas.tsx` with `ext: 'txt'`
- Client-side bytes validation in `meriDocumentBytesMatchFormat()` for txt (UTF-8 fatal decode, control character check, 1MiB limit)
- Download validation requires `X-Capiro-Artifact-Byte-Authority: persisted_at_creation_v1` AND valid operation UUID for txt
- `readMeriSavedDocumentArtifact()` accepts `text_document` kind

#### 8. Web vNext (`apps/web/src/vnext/meri/MeriArtifactCanvas.tsx`)

**PASS.** Adds `text_document` to `DOC_KINDS` with `ext: 'txt'` and `label: 'TEXT DOCUMENT'`.

#### 9. Tests

**Specification Compliance:**
- `meri-docgen.helpers.spec.ts`: Tests for BOM preservation, surrogate rejection, control character handling, exact byte preservation
- `meri-document-artifact.spec.ts`: Tests for creation with proper filename `aster-synthetic-briefing.txt`, SHA256 `c26beebc62f179a568981d811784dc75ad7e2cad79c94165d6f4859dcb278c53`, 28 bytes, operation receipt, download with saved bytes
- `meri-artifact-download.test.ts`: Tests for txt download with required headers
- `meriv3-semantic-compatibility-tools.spec.ts`: Test shows preservation of client/conversation pinning, V3 delegation

**Frozen case46 expectations:**
- Filename `aster-synthetic-briefing.txt` ✓
- Bytes `Synthetic Aster briefing v1\n` ✓
- Tests are in test files only, no preseeded success ✓
- No new route/tool/provider/model config ✓
- No readonly-capture exception ✓
- V3 uses `producedArtifactIds` linking ✓

#### 10. Shared Package (`packages/shared/src/index.ts`)

**PASS.** Updated capability description for `create_word` to document txt format support.

---

### POLICY COMPLIANCE

**AGENTS.md - Authorization and Safety:**
- No production deployment claimed ✓
- No readonly-capture exception created ✓
- No cross-tenant widening ✓
- Immutable artifact bytes with operation receipt satisfies "exact bytes" requirement ✓

**AGENTS.md - Evidence and Reporting:**
- Tests use fake storage/network (not live) ✓
- No live capture authority claimed ✓

**AGENTS.md - Development and Integration:**
- Existing patterns preserved (similar structure to docx/pdf) ✓
- Prisma unchanged (additional field in metadata JSON only) ✓

---

### VERDICT

**PASS**

The implementation correctly adds:
1. **Governed TXT creation** through existing `create_word` tool with format `txt`
2. **Exact UTF-8 preservation** via `TextEncoder`/`TextDecoder` roundtrip validation
3. **Immutable owned artifact bytes** with `persisted_at_creation_v1` byte authority
4. **Operation UUID receipt** in metadata and HTTP headers for authentication
5. **V3 orchestrator compatibility** with proper client/conversation pinning
6. **UI download support** with integrity validation on client side
7. **Security verification** via `readTextArtifactCreation()` against actual database row

The frozen case46 requirements (filename, exact bytes) are test-asserted only, with no preseeded success. The V3 path links via `producedArtifactIds` rather than legacy duplication. No policy violations detected.