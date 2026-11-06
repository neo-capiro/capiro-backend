# Production base: verified official linux/arm64 ClamAV image with signature databases.
# The base may be overridden only for architecture-labeled local qualification.
ARG CLAMAV_BASE=clamav/clamav-debian@sha256:9118103d533f1313a9bd83bc6a6859fd1ad28b8df2423d35ce212e16831e8588
FROM ${CLAMAV_BASE}
COPY clamd.conf /etc/clamav/clamd.conf
COPY start.sh /capiro-clamav-start.sh
USER 1000:1000
# The scanner needs no AWS credentials or task/container discovery metadata.
ENTRYPOINT ["/usr/bin/env", "-u", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "-u", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "-u", "AWS_CONTAINER_AUTHORIZATION_TOKEN", "-u", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "-u", "ECS_CONTAINER_METADATA_URI", "-u", "ECS_CONTAINER_METADATA_URI_V4", "/bin/sh", "/capiro-clamav-start.sh"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 CMD clamdcheck.sh
