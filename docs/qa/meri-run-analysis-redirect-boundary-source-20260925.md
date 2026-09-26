# Active `run_analysis` redirect boundary

Date: 2026-09-25. The active `MeriToolsService.runAnalysis` POST to the configured sandbox `/run` now sets `redirect: 'error'`. This blocks fetch from automatically following a sandbox 30x with the configured bearer, including same-origin redirects that would otherwise retain it. Existing successful JSON processing, failure/audit reporting, request abort, and timeout logic are unchanged.

An authored focused regression uses a loopback HTTP server that first returns a 307 to `/redirect-target` and then serves a normal `/run` result. It asserts the redirect case leaves exactly one request (no target hit and thus no bearer disclosure), remains a failed tool result, and the subsequent normal result still succeeds. The spec is not executed under the RAM/testing hold; this note claims source containment and authored coverage, not a verified test pass or deployed behavior. The separate dark sandbox-readiness observer is not changed here.
