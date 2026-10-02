PASS

Reviewed:

**TLS v2 diagnostic delta:**
- Adds official AWS RDS us-east-1 CA bundle (SHA256: b1711d12ba...)
- Injects `rdsTlsOptions()` function that:
  - Verifies CA bundle SHA256
  - Parses connectionString URL, validates PostgreSQL protocol and hostname format
  - Removes `sslmode=require` (per node-postgres docs, sslmode in URL replaces explicit ssl object)
  - Explicitly sets `ca`, `rejectUnauthorized:true`, `servername`, and custom `checkServerIdentity` using Node's TLS checkServerIdentity
  - Returns spread into Client constructor

- Post-connect assertions verify `stream.encrypted` and `stream.authorized` before BEGIN READ ONLY
- Result receipt adds `transport: {tlsVerified:true, caBundleSha256:...}`

**Wrapper composition (case01-reconcile-oneoff-v2.py):**
- Pins BASE_SHA, SCRIPT_SHA, INPUT_SHA, FAILED_SHA, TLS_FAILED_SHA
- `rdsTlsOptions()` SHA matches inline constant
- `fixed_files()` validates all pinned files including TLS_FAILED_SHA (previous diagnostic)
- Validates previous failure scope: stage='CONNECT', code='UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
- `task_request()` injects `SCRIPT.read_text()` as entryPoint (no external path dependencies)
- `owner_receipts()` validates TLS receipt structure: `transport.tlsVerified` and `caBundleSha256`
- `qualify()` reuses base4df lifecycle (frozen)

**Security review:**
- CA bundle is official AWS RDS regional bundle fetched over verified HTTPS, pinned by SHA256
- Three self-signed regional roots included (starfield, RSA 2048 CA, RSA 4096 CA)
- Production uses only pinned official CA; local test CA only in test file
- Hostname validation: pattern `^[a-z0-9.-]+\.us-east-1\.rds\.amazonaws\.com$`
- URL search params restricted to allowlist: schema, sslmode, connection_limit
- SQL unchanged (identical to v1)

**Artifact hashes verified:**
- case01-reconcile-readonly-v2.mjs: 45d5b87eb247...
- case01-reconcile-oneoff-v2.py: 85325b8680f7...

Blocking issues: none.