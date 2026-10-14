# Docker entrypoint and listening probe correction

The frozen PR2 runtime contract's `apps/api/dist/src/preview-readonly/preview-main.js` is the wrong path for the image build. Docker runs the API build through nest-cli.json and tsconfig.build.json, which sets rootDir to src. Actual compilation of the exact PR2 preview entrypoint and its resolved canonical dependencies using those production compiler options emitted 38 files without diagnostics, including:

`/app/apps/api/dist/preview-readonly/preview-main.js`

There is no extra `src` directory in the emitted path. The emitted entrypoint SHA256 is `74f3711e578160d7d5c062df75df02d50430ad0bf547dc50e1654c15ee7699e1`. This bounded emit proves the path and dependency compilation; it does not qualify a whole API/image build or runtime ABI. Source remains PR2 `111f269d749cae0249c2141779bd6d7deb93f45c`, tree `719c8292fc0c9cf4e8242b8d58efb2d004ad0a1f`.

Use the exact task/container override in [preview-container-invocation.json](evidence/preview-container-invocation.json):

```json
{
  "entryPoint": ["/usr/bin/dumb-init", "--", "node"],
  "command": ["/app/apps/api/dist/preview-readonly/preview-main.js"],
  "workingDirectory": "/app/apps/api"
}
```

This overrides both the image's entrypoint and command. Docker's ordinary entrypoint invokes entrypoint.sh, whose fallback delegates to the legacy dispatcher; its `serve` verb starts dist/main.js and other unknown verbs are refused. Changing command alone leaves that dispatcher active. The reviewed override directly executes only the separate preview bootstrap and does not compose a writer DATABASE_URL, dispatch serve, run migrations, start AppModule or add workers. No task definition/image/container deployment was applied here. Do not use the PR2 extra-src path or leave command=serve.

All explicit preview inputs and permission gates still apply: opt-in=true, separate reviewed PREVIEW_READONLY_DATABASE_URL, pinned existing internal tenant/org, and the production Clerk issuer/key pair. The bootstrap initializes the bounded module, performs an empty role-verified read-only transaction and only then listens. Startup refusal prevents a listener, but a listening probe cannot establish continuing database availability or the complete native fixture acceptance.

The proposed ALB check is safe with method GET, path `/api/__preview_liveness`, success matcher exactly `403`. The source route policy denies this path before auth/controller dispatch and emits no-store. An actual synthetic HTTP test against the emitted bounded PreviewReadOnlyModule/policy returned 403 with zero request Clerk/provider/database calls, and remained 403 after the synthetic database port was set unavailable. A separate unauthenticated `/api/me` request stayed401. The test uses fake DB/Clerk ports and qualifies the denied-path behavior only; it is not native database or credential acceptance.

This health matcher measures a listening HTTP process that responds through the expected deny policy. It cannot prove the release identity, active Clerk authority, current PostgreSQL connection/permissions, tenant RLS, client/identity reads, or provider health. Those require separate image provenance and native/runtime acceptance. No new health handler or wider allowlist is introduced, and the initial business allowlist remains exactly the three reviewed GET handlers.

Both failed preparations are retained: the first scoped emit omitted the exact existing engagement-runtime.types.ts dependency; the first synthetic probe resolved API-only reflect-metadata from repository root. Restoring the frozen dependency and selecting the exact API module path corrected the launchers. No product source, compiler option, assertion or policy was relaxed.
