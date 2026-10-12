# Clarification of generator environment scope

The preserved checkpoint's `sanitizedEnvironmentKeys` describes the author launcher: `env -i` supplies only `PATH` and the isolated `XDG_CACHE_HOME`. Cached official Prisma `GeneratorProcess` adds the controlled `PRISMA_GENERATOR_INVOCATION=true` marker when forking its Node generator child. Therefore the generator child is not claimed to have exactly two keys. This clarification appends to the original safety receipt; it does not alter that receipt, the generated declarations or frozen source.

The direct invocation remains the cached official 5.22.0 generator with `noEngine: true`, empty native binary paths, null env-file paths and isolated outputs/cache. No engine download/copy, native CLI, `.env` loading, live credential lookup, PrismaClient instantiation or database execution occurred. The official marker is generator-process coordination, not a relaxation of those boundaries.

The author review traces activate a saved Workspace reviewer invitation/grant and in-app notification. They do not create Clerk users or tenant memberships. Account-provider status and its attempt/receipt lifecycle are separate original Core owners; inert review of those owners remains independent. The Workspace activation trace must not be called account or provider activation.
