# Capiro defense-api dark-service image.
# Build context: repository root.
ARG NODE_VERSION=20.16.0

FROM public.ecr.aws/docker/library/node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /workspace

FROM base AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./

# pnpm install --frozen-lockfile validates the lockfile against every project
# pnpm-workspace.yaml's globs (apps/*, packages/*, infra/*) can discover, not
# just the ones --filter will actually build below. Copying only
# defense-api's own dependency package.jsons left the rest of the workspace
# glob resolving to nothing on disk, which silently produced an incomplete
# install graph -- packages/auth's own "typescript" devDependency never got
# linked, so its build step failed with tsc missing entirely. Every workspace
# member's package.json has to be present for the lockfile to validate
# correctly, even though only defense-api and its real dependencies get built.
COPY apps/api-strategy/package.json apps/api-strategy/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/clio-sandbox/package.json apps/clio-sandbox/package.json
COPY apps/defense-api/package.json apps/defense-api/package.json
COPY apps/intel-api/package.json apps/intel-api/package.json
COPY apps/meriv2-orchestrator/package.json apps/meriv2-orchestrator/package.json
COPY apps/onboard-api/package.json apps/onboard-api/package.json
COPY apps/onboard-web/package.json apps/onboard-web/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/workspace/package.json apps/workspace/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/defense-client/package.json packages/defense-client/package.json
COPY packages/defense-contracts/package.json packages/defense-contracts/package.json
COPY packages/defense-domain/package.json packages/defense-domain/package.json
COPY packages/meriv2-core/package.json packages/meriv2-core/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/strategy-verifier/package.json packages/strategy-verifier/package.json
COPY infra/cdk/package.json infra/cdk/package.json

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter=@capiro/defense-api...

COPY packages/auth packages/auth
COPY packages/defense-contracts packages/defense-contracts
COPY packages/defense-domain packages/defense-domain
COPY packages/defense-client packages/defense-client
COPY apps/defense-api apps/defense-api

RUN pnpm --filter @capiro/auth build \
 && pnpm --filter @capiro/defense-contracts build \
 && pnpm --filter @capiro/defense-domain build \
 && pnpm --filter @capiro/defense-client build \
 && pnpm --filter @capiro/defense-api prisma:generate \
 && pnpm --filter @capiro/defense-api build

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter=@capiro/defense-api...

FROM public.ecr.aws/docker/library/node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps
RUN groupadd --system --gid 1001 capiro \
 && useradd --system --uid 1001 --gid capiro --shell /usr/sbin/nologin capiro \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates dumb-init openssl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=capiro:capiro --from=build /workspace/node_modules /app/node_modules
COPY --chown=capiro:capiro --from=build /workspace/apps/defense-api/dist /app/apps/defense-api/dist
COPY --chown=capiro:capiro --from=build /workspace/apps/defense-api/generated /app/apps/defense-api/generated
COPY --chown=capiro:capiro --from=build /workspace/apps/defense-api/node_modules /app/apps/defense-api/node_modules
COPY --chown=capiro:capiro --from=build /workspace/apps/defense-api/package.json /app/apps/defense-api/package.json
COPY --chown=capiro:capiro --from=build /workspace/apps/defense-api/prisma /app/apps/defense-api/prisma
COPY --chown=capiro:capiro --from=build /workspace/apps/defense-api/scripts /app/apps/defense-api/scripts

COPY --chown=capiro:capiro --from=build /workspace/packages/auth/dist /app/packages/auth/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/auth/node_modules /app/packages/auth/node_modules
COPY --chown=capiro:capiro --from=build /workspace/packages/auth/package.json /app/packages/auth/package.json
COPY --chown=capiro:capiro --from=build /workspace/packages/defense-contracts/dist /app/packages/defense-contracts/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/defense-contracts/package.json /app/packages/defense-contracts/package.json
COPY --chown=capiro:capiro --from=build /workspace/packages/defense-domain/dist /app/packages/defense-domain/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/defense-domain/package.json /app/packages/defense-domain/package.json
COPY --chown=capiro:capiro --from=build /workspace/packages/defense-client/dist /app/packages/defense-client/dist
COPY --chown=capiro:capiro --from=build /workspace/packages/defense-client/package.json /app/packages/defense-client/package.json

USER capiro
WORKDIR /app/apps/defense-api
EXPOSE 4400
ENTRYPOINT ["/usr/bin/dumb-init", "--", "bash", "scripts/entrypoint.sh"]
CMD ["serve"]
