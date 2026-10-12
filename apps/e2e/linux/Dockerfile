# Pinned Linux capture image (CleanUp1 §8.5, round-11)
#
# The visual capture and the CI visual step MUST run on the SAME verified image
# digest so PNGs and the renderer/font identity are comparable. This Dockerfile
# pins that digest and adds NOTHING: the image already contains the Chromium
# build Playwright 1.63.0 launches (chrome-headless-shell-1243, 153.0.8010.12)
# and the fontconfig stack (48 verified font files). The external
# @playwright/test package is mounted read-only at /external at run time — it is
# never installed into this image or into any monorepo manifest.
#
# Build (optional; the runner uses the digest directly):
#   docker build -t cleanup1-visual-capture:local apps/e2e/linux
#
FROM mcr.microsoft.com/playwright@sha256:bc6ab0d6d44ff4826e4cb8c1e6d801e185bfc42bb0753f8e2a30efc70db054c7

# Determinism contract shared with lib/projects.mjs.
ENV TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    XDG_CACHE_HOME=/tmp/cache

# The runner mounts: /arch (read-only source archive), /deps (task-owned named
# volume for Linux-native dependencies), /external (read-only Playwright package),
# and /out (artifact output). The whole host is never mounted.
WORKDIR /work
