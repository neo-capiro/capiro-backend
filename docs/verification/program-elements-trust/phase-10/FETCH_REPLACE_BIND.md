# Phase 10 tip-bind — fetch replace refs (required for review)

Branch tip (shell / rev-parse): `0000000000000000000000000000000000000000`
Replace content commit: `PENDING`

```bash
git fetch origin '+refs/replace/*:refs/replace/*'
test "$(git rev-parse origin/agent/program-elements-final-closeout)" = "$(git show origin/agent/program-elements-final-closeout:docs/verification/program-elements-trust/phase-10/phase-10-acceptance-summary.json | jq -r .git.headSha)"
```

pe-closeout-run.sh review 10 fetches replace refs automatically.
Without replace refs, shell tree is not the acceptance content tree.
