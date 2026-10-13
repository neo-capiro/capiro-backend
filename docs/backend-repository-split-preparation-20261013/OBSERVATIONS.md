# Preparation observations and limits

All external actions in this packet are read-only GitHub metadata/docs requests. All repository writes are local preparation docs/evidence. No source config/workflow, remote, repo setting, access grant, credential, cloud/database resource or main ref was changed.

The first worktree read attempted selected files before initializing the no-checkout sparse index; `rg` returned missing paths and the finite Python reader returned FileNotFoundError. Running `git read-tree -mu HEAD` in this owned sparse worktree initialized only the selected source files; the same reads then succeeded. No other worktree was affected.

The first open-PR metadata command used `gh api --slurp`, which this installed CLI rejects as an unknown flag. It failed before any request. The passing replacement uses supported `--paginate` plus Python JSON streaming to combine only selected metadata. No approval was bypassed and no mutation occurred.

A preliminary broad Git name listing was truncated by tool output. The authoritative inventory uses bounded Git tree metadata and finite source paths; no completeness assertion relies on that truncated text. Package, workflow, coupling and donor evidence have explicit source heads and mode/blob/tree bindings.

The destination 404 is preserved, not hidden by a guessed creation. The owner listing corroborates no visible destination but does not prove absence beyond current credential visibility. No creation permission, GitHub integration/settings inventory or new default-branch behavior is qualified.

The current receiving branch is not final all-donor or preview authority. Queued root source integration, published Meri runtime contract and isolated preview IDs remain external dependencies. Native qualification retains its documented unresolved initial cleanup comparison; repo preparation cannot strengthen that acceptance. No new synthetic/native/build/image/provider execution occurred here.

The first read-only verifier failed its full tree count because `git ls-tree` was run from the packet subdirectory without `--full-tree`. Its original helper bytes/SHA and observed assertion are preserved. The corrected reader explicitly selects the full repository tree; no source/workflow/resource was altered.

The next verifier exposed a prose/expected-count error: the exact pinned original ledger/PR2400 list contains 15 entries, not 16, and 14 are receiving ancestors, not 15. The machine inventory already had the correct entries. The failed helper/receipt are retained; prose and verifier constants were corrected. No candidate was added, removed, lost or adopted.
