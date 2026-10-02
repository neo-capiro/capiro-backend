# Native candidate images

Both exact-source builds for `15ed650f3bc56b6906cb0dbf7cb30602843f4a7b` succeeded.
The relevant GitHub Actions runs failed at startup with no jobs, so the explicitly
authorized native CodeBuild fallback ran the reviewed recipes.

The orchestrator passed 1,410 tests in 126 suites, with two existing skipped tests,
plus packaged entrypoint health and unauthenticated-route rejection checks. Its
immutable digest is `sha256:486bcf39b84361704e81752ee9b5f33797788d6f3ca27b4d2c1d2dd4464bed6d`.
It is a qualified candidate, not yet a claimed deployment in this record.

The API passed its packaged imports, including setup factory and fixture closure,
and all 449 migration hashes matched source without applying migrations. Its
digest is `sha256:5c32ba799e208af6c568db3f41a2e950dfc2c3e53a734c6b33b7899d2e80a2a7`.
**Hold this API candidate for the budget-operator correction:** the installer CLI
does not bind the governance tenant AsyncLocalStorage required by the explicit
synthetic cohort. The existing installer test harness used `all`, concealing that
composition gap. A narrow CLI correction and explicit-cohort regression are in
progress. Do not change the service cohort to `all` to bypass it.

Original case01 and the full original live plan remain NOT RUN. No rollout,
migration or fixture mutation is claimed here. The attached build receipts are
independent readbacks of actual successful source/build/digest/marker observations.
