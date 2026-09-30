# Finite source and public web qualification

Candidate base: `759a0a2bb4f542d0dcc828f58438bfeaa6802439`. This repair is still separate from the consolidated foundation until the integration qualification is recorded.

Finite-source results require the canonical owner and current status before accepting complete or empty coverage. Bill text, Monday, web, and attachment completeness checks retain pagination/extraction boundaries; an empty fully read bill text is empty. Finite-source failure reasons use controlled codes instead of raw owner errors or stop reasons. Existing memory/mail behavior is preserved.

Public web reads validate every DNS answer and redirect, pin the connection through an undici Agent while preserving the URL hostname for TLS, cap streamed HTML/PDF bytes, and retain one deadline through DNS, connection, redirects, body, and extraction. PDF parsing runs in a separate process with bounded input/output and heap, and request cleanup terminates and joins it. A rejected worker-thread trial caused a native Windows Node crash during termination; that design is not retained. The process implementation passed actual PDF extraction and actual deadline termination tests.

PASS: 105 tests across five suites, shared build, API types, and scoped formatting (exit 0). Independent Hermes/Kimi review covers the transport and finite-source classifier. The first transport review's IPv6-range claims were disproved by actual Node BlockList assertions and the passing forbidden-address cases; the corrected review adjudicates those claims explicitly. Static review is separate from lead execution evidence.

Evidence under `C:/dev/cap-meri-foundation-evidence`: `source-direct-gates.json`, `source-direct-tests.log`, `web-ipv6-review-proof.log`, `review-source-final-web-report.md`, and `review-source-final-classifier-report.md`.

Side effects: mocked public-network responses and local PDF child processes only. No private-address probes, shared tenant writes, routing changes, migrations, main integration, or deployment. Combined foundation integration and full File01 acceptance remain pending.
