ARG NODE_VERSION=20.16.0
ARG AWS_CLI_VERSION=2.17.49

FROM public.ecr.aws/aws-cli/aws-cli:${AWS_CLI_VERSION} AS awscli

FROM public.ecr.aws/docker/library/node:${NODE_VERSION}-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV AWS_PAGER=""
WORKDIR /app

# Runtime uses task-role credentials through AWS CLI v2. It contains no GPU libraries,
# NVIDIA driver, model weight, database client, or public HTTP server.
COPY --from=awscli /usr/local/aws-cli /usr/local/aws-cli
RUN ln -s /usr/local/aws-cli/v2/current/bin/aws /usr/local/bin/aws \
 && groupadd --gid 1001 orchestrator \
 && useradd --uid 1001 --gid 1001 --create-home orchestrator

COPY --chown=1001:1001 apps/defense-parser-orchestrator/src ./src
COPY --chown=1001:1001 apps/defense-parser-orchestrator/README.md ./README.md

USER 1001:1001

# The task is command-driven. No listener, port, or health endpoint exists.
ENTRYPOINT ["node", "/app/src/cli.mjs"]
CMD ["help"]
