# Case46 artifact UI substep

`collectCase46ArtifactUi` operates on one already generated, admitted canonical `create_word` proposal in an owned synthetic Pat/Aster conversation. It sends no synthesis prompt and creates no proposal. A future native governed-write capture owner supplies its authenticated page and bounded native `readApi` function, and owns sign-in/session revocation, qualified source/build evidence, fixture setup, provider limits and final capture authority.

The substep verifies the current ordinary actor, client, API source and loaded vNext Web source; checks exactly one fresh proposal; clicks the existing Approve/Confirm controls once; then observes the real Playwright download event and authenticated HTTP bytes. It compares the frozen `aster-synthetic-briefing.txt` name, 28 exact UTF-8 bytes and checksum. It reopens the same conversation after reload and checks that the operation, artifact and current owner receipt remain identical. Screenshots are cropped to the synthetic proposal and artifact context rail. The native artifact-storage claim and intent files are exclusive; ambiguous outcomes stop without resending.

The existing download endpoint now supplies `currentAction` in its creation-receipt header. This is derived from the current succeeded canonical proposal and an actual count of owned artifact rows carrying that proposal ID. `attemptCount` remains separate: two attempts may create one artifact, and one reported attempt does not hide two rows. Multiple rows remain downloadable but fail the case46 deterministic check. These are current authenticated readback facts, not new write grants or signed capture authority.

This module returns `UI_SUBSTEP_ONLY`; the byte inspector returns `DETERMINISTIC_DOWNLOAD_CHECK_ONLY`. Both retain `liveAcceptance: NOT_RUN`. Injected objects, fake-browser tests and a saved screenshot cannot establish LIVE acceptance. The original frozen prompt, known briefing source, one generated effect, synthesis trace, distinct governed-write provider accounting/admission and native authenticated composition still must be connected before the original case46 can execute and pass. Do not add case46 to a read-only capture union or relax `serverReadonlyCapture` to admit the artifact write. The proposal-list product GET performs lifecycle reconciliation and is not a database read-only guarantee.

Run bounded verification with existing dependencies:

```powershell
# From apps/api: current artifact/proposal/readback compatibility.
pnpm exec jest --runInBand --forceExit src/meri/meri-document-artifact.spec.ts
pnpm exec tsc --noEmit --rootDir .

# From repository root: pure predicates, plus actual native saved-file handling
# with a fake browser/network. Set these to an owned scratch parent and installed
# Python runtime; this does not authorize browser/auth/cloud execution.
$env:MERI_WINDOWS_ARTIFACT_TEST_ROOT = '<owned local scratch parent>'
$env:MERI_WINDOWS_ARTIFACT_PYTHON = '<installed Python executable>'
node --test evals/meri/live-v1/tests/case46-artifact-ui.test.mjs
```

The UI test entry imports the four pure evidence tests and adds three native-storage/fake-browser tests, for seven total. Windows storage tests are skipped when the explicit local runtime/scratch configuration is absent. Qualification must report actual executed counts and skips.
