# Evidence provenance

Attempts 1–4 are preserved, including failures. Attempt 4 ran both affected suites against the final nine-file source manifest and passed 71/71 cases. It is the successful affected-source result; earlier results are not silently carried to changed production bytes.

The runner/configuration files here are final reference snapshots, not portable entry points. They reference the original task-root runtime and its existing dependency installation. Historical receipts identify the exact configuration used for each attempt. No dependency installation, database setup, socket, live identity or provider call was performed.

`sourceHead` in the runtime receipt is the commit before the four reviewed checkpoints were committed. The worktree contained those checkpoints during attempt 4. The receipt's before/after file hashes, `SOURCE-MANIFEST.json`, and `TESTED-SOURCE.json` bind the actual tested bytes. `sourceEdits: false` means the runner made no source edits; it does not assert a clean worktree.

`TESTED-SOURCE.json` also records Git blob hashes after staging, so publication can be checked against the tested bytes without rerunning unchanged tests. No broad build, semantic typecheck, native HTTP/SQL or startup integration result is implied.
