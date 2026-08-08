# Clio analysis sandbox runner (assistant-parity F4).
#
# Pinned, minimal image: Node runner + Python with exactly the allowed
# analysis libraries. Runs non-root with a read-only root filesystem (set
# readonlyRootFilesystem + a tmpfs mount for /tmp in the task definition).
# The task role must have ZERO permissions and the security group ZERO
# egress (see docs/adr/0001-clio-analysis-sandbox-isolation.md).

FROM node:20-slim

# Keep every analytical dependency pinned. These libraries execute only over
# datasets already retrieved through governed Capiro/MCP tools; the sandbox has
# no network route, credentials, package installer, or provider access at run
# time. matplotlib remains the canonical export renderer, while scipy /
# statsmodels / seaborn / networkx unlock statistical, time-series and graph
# analysis without asking the language model to approximate the math.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && pip3 install --no-cache-dir --break-system-packages \
    pandas==2.2.3 \
    numpy==2.1.3 \
    matplotlib==3.9.2 \
    scipy==1.14.1 \
    statsmodels==0.14.4 \
    seaborn==0.13.2 \
    networkx==3.4.2 \
  && apt-get purge -y python3-pip \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src

# Install devDependencies (typescript + @types/node) so tsc can resolve the
# 'node' type lib declared in tsconfig, build, copy the python harness, then
# strip node_modules so the runtime image carries no build deps (the runner
# only needs the compiled dist/ + the node runtime + python).
RUN npm install --no-audit --no-fund \
  && ./node_modules/.bin/tsc -p tsconfig.json \
  && cp src/harness.py dist/harness.py \
  && rm -rf node_modules

ENV NODE_ENV=production
USER node
EXPOSE 4100
CMD ["node", "dist/server.js"]

# rebuild trigger: ECR repo capiro/dev/clio-sandbox provisioned

# retrigger: capiro-gha-api ECR policy now allows clio-sandbox push
