# Preserved harness limitations and corrections

The original broad-root Web-refusal run exited1 before tests. Its raw stdout, stderr and command are `web-refused-initial.stdout`, `web-refused-initial.stderr` and `web-refused-initial.command.json`. Jest attempted to read `apps/web/package.json` during its package crawl. No owner result JSON was created. A dedicated API/shared-root runner avoids that unrelated crawl while explicitly scheduling all three complete specs; its60 case names, statuses and passing-assertion counts match the original run. No file was removed or renamed to simulate Web absence.

Two preparation mistakes also occurred; neither changed application source or expectations. These are transcriptions of executor output (not newly fabricated application failure logs):

1. An early comparison tried to load the absent `web-refused-results.json` from the failed collection run and raised `FileNotFoundError`. That comparison made no receipt. The original collection failure remains; the comparison was rerun only after actual suite output existed.
2. The first dedicated-run preparation asserted the wrong command-array index for `--config` and raised `AssertionError` before launching Node. The corrected preparation finds the actual `--config` operand at index4. No configured verifier/provider/native command was run.

Original baseline and converted owner runs each exited1 because of the same inherited Memory editor assertion. They are preserved as quality failures; no expectations were disabled or rewritten. Structural/refusal controls and exact case/status comparison exited0.
