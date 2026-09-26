# Sandbox readiness receipt v1

`POST /readiness` requires the exact same `Authorization: Bearer <CLIO_SANDBOX_TOKEN>` header as `/run`. The request body must be empty. `/healthz` remains process liveness and is not a readiness signal. The route does not accept Python, datasets, a tool name, or query parameters.

An authenticated observation returns only:

```json
{
  "protocolVersion": 1,
  "ready": true,
  "observedAt": "2026-09-25T00:00:00.000Z",
  "observation": "fresh"
}
```

`observation` is one of `fresh` (this request initiated the probe), `coalesced` (it joined that in-flight probe), `cached` (the same completed observation within 30 seconds), or `refused` (the in-flight probe already had 16 waiting callers). A ready receipt uses HTTP 200; a completed failure or refusal uses HTTP 503 with `ready: false`. Authentication, invalid body, oversized body, and body timeout return HTTP 401, 400, 413, and 408 respectively without a readiness receipt. Consumers must treat any missing, malformed, expired, future, non-200, or `ready: false` result as unready.

The probe uses the `/run` bearer gate, concurrency slots, queue, Python executable, resource-limited harness, and image. It runs fixed code that explicitly imports matplotlib/pyplot/cycler, NumPy, pandas, SciPy/stats, statsmodels, seaborn, and networkx, then checks a version marker in structured results. Admission waits at most 2 seconds, Python gets a 20-second wall timeout, and the HTTP observation has a 25-second deadline. A deadline failure observed by a connected caller is cached as unready. If the last caller disconnects before completion, that probe is abandoned: it is cancelled and removed from coalescing, and its eventual result is never cached. The next caller starts a fresh probe through normal admission. An abandoned or stalled runner retains its concurrency slot until it actually exits, so a fresh probe can still face queue refusal or timeout. Rejected request bodies are not buffered, and an incomplete empty body times out after 2 seconds.

This is a process-local observation of Python startup and imports at `observedAt`. It is not tenant authorization, `run_analysis` tool eligibility, a capacity reservation, or a guarantee that later arbitrary analysis code, datasets, or chart rendering will succeed. It does not change provider tools, JEV routing, `/run`, or `/healthz`. The image and deployed auth/queue/import behavior still require validation after the host RAM hold.
