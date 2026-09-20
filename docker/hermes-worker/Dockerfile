# Meri Hermes worker image — Phase 0 compatibility harness.
#
# Layering:
#   1. BASE: upstream NousResearch/hermes-agent built from the PINNED source
#      tarball (tag v2026.9.14, commit 7a963716b81be13ba513d4f127633b7da493aff2,
#      package version 0.21.3, MIT license). Built by ./build-base.sh, which
#      verifies the tarball sha256 before invoking the upstream Dockerfile.
#      Never `FROM nousresearch/hermes-agent:latest`.
#   2. THIS LAYER: Meri-owned plugins (memory provider + broker tools), the
#      config/SOUL templates and an entrypoint that renders them into
#      HERMES_HOME (/opt/data) at start. No secrets are baked in; provider
#      keys, the API server key and the scope-bound worker token arrive as
#      environment variables.
#
# The upstream ENTRYPOINT (/init → s6-overlay → main-wrapper.sh) is preserved:
# it drops privileges to the `hermes` user and activates the venv, then runs
# our CMD as a bare executable.
ARG HERMES_BASE_IMAGE=meri-hermes-worker:v2026.9.14
FROM ${HERMES_BASE_IMAGE}

LABEL org.opencontainers.image.title="meri-hermes-worker" \
      org.opencontainers.image.description="Hermes Agent worker for Meri (Phase 0 harness)" \
      org.opencontainers.image.source="https://github.com/NousResearch/hermes-agent" \
      org.opencontainers.image.licenses="MIT" \
      ai.capiro.hermes.upstream_tag="v2026.9.14" \
      ai.capiro.hermes.upstream_commit="7a963716b81be13ba513d4f127633b7da493aff2" \
      ai.capiro.hermes.upstream_version="0.21.3" \
      ai.capiro.hermes.tarball_sha256="47df72ebd3f9c96d806a94541163f7fe7d7ce5b84f85c1d3787e6dfeea1d7834"

USER root
COPY --chmod=0755 entrypoint.sh /opt/meri/entrypoint.sh
COPY --chmod=0644 config.template.yaml /opt/meri/config.template.yaml
COPY --chmod=0644 SOUL.template.md /opt/meri/SOUL.template.md
COPY plugins/ /opt/meri/plugins/
RUN chmod -R a+rX /opt/meri

ENV HERMES_HOME=/opt/data \
    API_SERVER_ENABLED=true \
    API_SERVER_HOST=0.0.0.0 \
    API_SERVER_PORT=8642

EXPOSE 8642
CMD ["/opt/meri/entrypoint.sh"]
