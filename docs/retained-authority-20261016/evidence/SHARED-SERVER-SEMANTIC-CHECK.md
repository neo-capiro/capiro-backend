# Narrow shared server semantic check

PASS: zero TypeScript diagnostics in 1,561 ms. Production sources were read only
and all four SHA-256 hashes were unchanged before and after the check. The HTTP
hash matches the transport owner's final released source.

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
The successful process reported 226,764,552 bytes heap used and 380,563,456
bytes RSS; the 256 MiB bound applies to V8 old space, not total process RSS.

## Exact source hashes

| Source under `backend-retained-authority` | SHA-256 |
| --- | --- |
| `packages/shared/src/core-retained-principal.ts` | `334eb08cd9518bc871e8d943f841ba103c7a84ecfca9ab81593eaebb560197d9` |
| `packages/shared/src/core-retained-authority-probe.ts` | `62037476acf41009263015c877a34c78c8c2996a83ebf0a3c0476d33a1777a62` |
| `packages/shared/src/core-retained-read-request.ts` | `ce8e1ecfecaed02a3f9c10794e4cc370817b5c2c69e85f9eb4d0ea3b635275a7` |
| `packages/shared/src/core-retained-authority-http.ts` | `c1e08fcd473dd63be8710c6c0b4fb27cf015fa317df24ad1c1adc339df7f6e48` |

## Supporting artifacts

- `check-shared-server.cjs`: checker, SHA-256 `5a9dce5c22cd581a1e9473d61947bf72fc38c74dd59d440113f0098bfdd35ed2`.
- `shared-server-semantic.receipt.json`: full options, diagnostics, dependency
  inventory and stable source hashes, SHA-256 `60c14fbf3e6b5debc805ce3faf7e5951214f495ddd61eab211b3ca9557e775cf`.
- `shared-server-semantic-256.stdout.txt` and `.stderr.txt`: successful command output.

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
