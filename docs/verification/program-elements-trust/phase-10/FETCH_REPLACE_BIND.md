# Phase 10 tip-bind — fetch replace refs (required for review)

Branch tip (shell / rev-parse): `693eb7093d48376621180ef71d81cfd45be97573`
Replace content commit: `0485d2c782d0459c5bc0a574c7988a0d6496db64`

```bash
git fetch origin '+refs/replace/*:refs/replace/*'
test "$(git rev-parse origin/agent/program-elements-final-closeout)" = "$(git show origin/agent/program-elements-final-closeout:docs/verification/program-elements-trust/phase-10/phase-10-acceptance-summary.json | jq -r .git.headSha)"
```

pe-closeout-run.sh review 10 fetches replace refs automatically.
Without replace refs, shell tree is not the acceptance content tree.
