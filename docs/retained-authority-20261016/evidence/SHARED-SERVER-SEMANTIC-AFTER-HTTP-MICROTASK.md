# Narrow shared server semantic check

Successor PASS: zero TypeScript diagnostics in 1,579 ms. Production sources were read only
and all four SHA-256 hashes were unchanged before and after the check. The HTTP
hash matches the transport owner's released microtask cancellation fix. This
single root-authorized repeat checks the changed dependency: the transport now
checks activity inside its deferred callback before starting fetch/reader I/O.

The check used Node v24.19.0, actual installed TypeScript 5.9.3 and
`@types/node` 20.19.39. It loaded exactly four implementation files and 159
declaration files from the installed TypeScript standard library, Node,
`undici-types` and `buffer`. No apps, shared barrel, Jest types, project
references, repository tsconfig include globs, emit or network were used.

Compiler options: `noEmit: true`, `strict: true`, `skipLibCheck: false`,
ES2022 target, CommonJS, Node10 module resolution, ES2022 + DOM libraries,
`types: ['node']`, and the existing API runtime `@types` directory. The checker
rejects app/barrel resolution and more than ten shared implementation files.

The initial 128 MiB old-space run exhausted V8's heap after about 1.5 seconds;
its stderr is retained in `shared-server-semantic.stderr.txt`. The successful
run used the allocated 256 MiB old-space limit. Both launches were bounded by
an owning PowerShell process that killed only its child after 45 seconds.
The successor process reported 229,819,928 bytes heap used and 377,200,640
bytes RSS; the 256 MiB bound applies to V8 old space, not total process RSS.
The first successful check remains preserved separately: it completed in
1,561 ms and checked the prior HTTP `c1e08fcd...` bytes. Its original receipt,
report and 256 MiB stdout/stderr have `before-http-microtask` copies; the initial
128 MiB OOM log remains unchanged. The other three implementation hashes did
not change between the first pass and this successor.

## Exact source hashes

| Source under `backend-retained-authority` | SHA-256 |
| --- | --- |
| `packages/shared/src/core-retained-principal.ts` | `334eb08cd9518bc871e8d943f841ba103c7a84ecfca9ab81593eaebb560197d9` |
| `packages/shared/src/core-retained-authority-probe.ts` | `62037476acf41009263015c877a34c78c8c2996a83ebf0a3c0476d33a1777a62` |
| `packages/shared/src/core-retained-read-request.ts` | `ce8e1ecfecaed02a3f9c10794e4cc370817b5c2c69e85f9eb4d0ea3b635275a7` |
| `packages/shared/src/core-retained-authority-http.ts` | `588f5cf878c08762b0c2ecc1b0b742d21eeb49bc30b653c6d35510315131a848` |

## Supporting artifacts

- `check-shared-server.cjs`: checker, SHA-256 `5a9dce5c22cd581a1e9473d61947bf72fc38c74dd59d440113f0098bfdd35ed2`.
- `shared-server-semantic-after-http-microtask.receipt.json`: full successor
  options, diagnostics, dependency inventory and stable source hashes, SHA-256
  `0cefd476467f3921150d0f740ae2da4ca17541ebb291826ceada64427730b592`.
- `shared-server-semantic-256-after-http-microtask.stdout.txt` and `.stderr.txt`:
  successor command output.
- `shared-server-semantic-before-http-microtask.receipt.json`: preserved first
  successful receipt, SHA-256 `60c14fbf3e6b5debc805ce3faf7e5951214f495ddd61eab211b3ca9557e775cf`.
- `SHARED-SERVER-SEMANTIC-CHECK-before-http-microtask.md` and
  `shared-server-semantic-256-before-http-microtask.stdout.txt` / `.stderr.txt`:
  preserved first-pass report/output. `shared-server-semantic.receipt.json`
  is now an identical copy of the successor receipt, since the original
  checker writes that fixed filename; use the explicit before/after names.

Compiler invocation from the task root:

```powershell
& 'C:\Program Files\nodejs\node.exe' --max-old-space-size=256 'retained-authority-runtime/check-shared-server.cjs'
```

This proves the exact four changed server modules type-check with the stated
installed compiler/declarations and strict options. It does not qualify a
whole shared package/app build, browser surface, production dependency layout,
cryptographic/JCS interoperability, HTTP/runtime behavior, deployment, native
session/resource policy or any test suite. No tests or production edits were
performed in this allocation.
