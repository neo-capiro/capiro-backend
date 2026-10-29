# Clio analysis sandbox runner (assistant-parity F4).
#
# Pinned, minimal image: Node runner + Python with exactly the allowed
# analysis libraries. Runs non-root with a read-only root filesystem (set
# readonlyRootFilesystem + a tmpfs mount for /tmp in the task definition).
# The task role must have ZERO permissions and the security group ZERO
# egress (see docs/adr/0001-clio-analysis-sandbox-isolation.md).

# Maintained base: the official Debian-bookworm Node image, pinned to the exact
# published image index (verified 2026-10-29; NODE_VERSION=22.23.3, built
# 2026-10-21). Same Debian suite as the previous floating node:20-slim, so the
# pinned scientific Python wheels keep the same cp311 ABI and no distro/musl
# jump is involved.
#   index sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9
#   arm64 sha256:6be82d4da7e0320cfc2bc5c000d534bf8c0a7eae567dce465b47c77fdd483987
FROM node:22.23.3-bookworm-slim@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9

# Keep every analytical dependency pinned. These libraries execute only over
# datasets already retrieved through governed Capiro/MCP tools; the sandbox has
# no network route, credentials, package installer, or provider access at run
# time. matplotlib remains the canonical export renderer, while scipy /
# statsmodels / seaborn / networkx unlock statistical, time-series and graph
# analysis without asking the language model to approximate the math.
# Supported security refresh for the base packages the exact-digest scan flagged
# on the previous image. Every listed package has a fixed version in an enabled
# bookworm repository, read 2026-10-29 from security-tracker.debian.org and the
# bookworm / bookworm-security binary-arm64 package indexes:
#   perl-base, perl, libperl5.36   5.36.0-7+deb12u4     (bookworm-security)
#   libgnutls30                    3.7.9-2+deb12u7      (bookworm + security)
#   libc6, libc-bin                2.36-9+deb12u14      (bookworm)
#   dpkg                           1.21.23              (bookworm)
#   libpcre2-8-0                   10.42-1+deb12u2      (bookworm-security)
#   libcap2, libcap2-bin           1:2.66-4+deb12u3+b1  (bookworm)
# util-linux (6 HIGH) and zlib (1 HIGH) have no fixed bookworm version today and
# are deliberately NOT listed: they remain a measured, explicit residual rather
# than being hidden, and perl CVE-2026-82560 is likewise still open upstream.
RUN apt-get update \
  && apt-get install -y --only-upgrade --no-install-recommends \
    perl-base perl libperl5.36 \
    libgnutls30 \
    libc6 libc-bin \
    dpkg \
    libpcre2-8-0 \
    libcap2 libcap2-bin \
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
