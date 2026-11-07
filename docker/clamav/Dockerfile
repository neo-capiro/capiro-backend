# PREPARED_UNRUN: independent source review and a new exact-digest qualification are required.
# Build and runtime use the same official Ubuntu 26.04 linux/arm64 manifest.
FROM ubuntu@sha256:86eb1bc1059720a19a777ba5a109e9ee3690d5dfe3e319871a6d6beb86fb7f85 AS builder
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
RUN test "$(dpkg --print-architecture)" = arm64 \
    && apt-get -o Acquire::Retries=0 update \
    && apt-get -o Acquire::Retries=0 install -y --no-install-recommends apt=3.2.1ubuntu0.1 \
    && apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
       ca-certificates wget xz-utils build-essential cmake pkg-config python3 python3-pytest check \
       cargo rustc libbz2-dev libjson-c-dev libpcre2-dev libssl-dev libncurses-dev \
       libc6=2.43-2ubuntu2.4 libc6-dev=2.43-2ubuntu2.4 \
       libxml2-dev=2.15.2+dfsg-0.1ubuntu0.3 \
       zlib1g-dev=1:1.3.dfsg+really1.3.1-1ubuntu3.2 zlib1g=1:1.3.dfsg+really1.3.1-1ubuntu3.2
WORKDIR /build
COPY capture-cargo.py export-build-components.py /build/
RUN chmod 0755 /build/capture-cargo.py
# Extract the verified sources with Python's explicit data filter.
RUN wget --https-only -O curl.tar.xz https://curl.se/download/curl-8.23.0.tar.xz \
    && echo '8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5  curl.tar.xz' | sha256sum -c - \
    && python3 -m tarfile --filter=data -e curl.tar.xz \
    && cd curl-8.23.0 \
    && ./configure --prefix=/opt/capiro/curl --libdir=/opt/capiro/curl/lib \
       --with-openssl --with-ca-bundle=/etc/ssl/certs/ca-certificates.crt \
       --enable-shared --disable-static --disable-ldap --disable-ldaps \
       --without-libpsl --without-libidn2 --without-libssh2 --without-gssapi \
    && make -j2 && make install \
    && /opt/capiro/curl/bin/curl --version \
    && ! /opt/capiro/curl/bin/curl --version | grep -E 'Protocols:.*(ldap|ldaps)' \
    && ldd /opt/capiro/curl/lib/libcurl.so | tee /build/curl-linkage.txt \
    && ! grep -Ei 'ldap|sasl|not found' /build/curl-linkage.txt
RUN wget --https-only -O clamav.tar.gz https://github.com/Cisco-Talos/clamav/releases/download/clamav-1.5.4/clamav-1.5.4.tar.gz \
    && echo '1af1117a228f1b5bc7fa91a0dabc37848a99e7d25188e9be8043332ce721dfd3  clamav.tar.gz' | sha256sum -c - \
    && python3 -m tarfile --filter=data -e clamav.tar.gz \
    && python3 /build/export-build-components.py prepare \
    && cmake -S clamav-1.5.4 -B clamav-build \
       -D cargo_EXECUTABLE:FILEPATH=/build/capture-cargo.py \
       -D CMAKE_EXPORT_COMPILE_COMMANDS=ON \
       -D CMAKE_BUILD_TYPE=Release -D CMAKE_INSTALL_PREFIX=/opt/capiro/clamav \
       -D CMAKE_INSTALL_LIBDIR=lib -D APP_CONFIG_DIRECTORY=/etc/clamav \
       -D DATABASE_DIRECTORY=/var/lib/clamav -D CVD_CERTS_DIRECTORY=/opt/capiro/clamav/certs \
       -D CURL_INCLUDE_DIR=/opt/capiro/curl/include \
       -D CURL_LIBRARY:FILEPATH=/opt/capiro/curl/lib/libcurl.so \
       '-D CMAKE_INSTALL_RPATH=/opt/capiro/clamav/lib;/opt/capiro/curl/lib' \
       -D ENABLE_CLAMONACC=OFF -D ENABLE_MILTER=OFF -D ENABLE_EXAMPLES=OFF \
       -D ENABLE_MAN_PAGES=OFF -D ENABLE_STATIC_LIB=OFF -D ENABLE_JSON_SHARED=ON \
       -D ENABLE_TESTS=ON -D BYTECODE_RUNTIME=interpreter \
    && grep -F 'CURL_LIBRARY:FILEPATH=/opt/capiro/curl/lib/libcurl.so' clamav-build/CMakeCache.txt \
    && cmake --build clamav-build --parallel 2 \
    && ctest --test-dir clamav-build --output-on-failure --parallel 1 \
    && cmake --install clamav-build \
    && python3 /build/export-build-components.py finish

# Only official signature database files cross this boundary; no donor binaries or libraries.
FROM clamav/clamav-debian@sha256:9118103d533f1313a9bd83bc6a6859fd1ad28b8df2423d35ce212e16831e8588 AS signatures

FROM ubuntu@sha256:86eb1bc1059720a19a777ba5a109e9ee3690d5dfe3e319871a6d6beb86fb7f85
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
RUN test "$(dpkg --print-architecture)" = arm64 \
    && apt-get -o Acquire::Retries=0 update \
    && apt-get -o Acquire::Retries=0 install -y --no-install-recommends apt=3.2.1ubuntu0.1 \
    && apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends \
       ca-certificates tini libbz2-1.0 libjson-c5 libpcre2-8-0 libssl3t64 \
       libxml2-16=2.15.2+dfsg-0.1ubuntu0.3 zlib1g=1:1.3.dfsg+really1.3.1-1ubuntu3.2 \
       libc6=2.43-2ubuntu2.4 libstdc++6 libncursesw6 libtinfo6 \
    && if getent passwd 1000 >/dev/null; then \
         test "$(getent passwd 1000 | cut -d: -f1)" = ubuntu; usermod -l clamav -d /var/lib/clamav -s /usr/sbin/nologin ubuntu; \
       else useradd -u 1000 -M -d /var/lib/clamav -s /usr/sbin/nologin clamav; fi \
    && if getent group 1000 >/dev/null; then \
         old_group="$(getent group 1000 | cut -d: -f1)"; \
         if test "$old_group" != clamav; then test "$old_group" = ubuntu; groupmod -n clamav ubuntu; fi; \
       else groupadd -g 1000 clamav; fi \
    && usermod -g 1000 clamav \
    && install -d -o 1000 -g 1000 /var/lib/clamav /var/log/clamav /etc/clamav \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/scanner-build-evidence /usr/share/capiro-scanner/build-evidence
COPY --from=builder /opt/capiro/curl /opt/capiro/curl
COPY --from=builder /opt/capiro/clamav /opt/capiro/clamav
COPY --from=signatures --chown=1000:1000 /var/lib/clamav/ /var/lib/clamav/
COPY clamd.conf freshclam.conf /etc/clamav/
COPY start.sh /capiro-clamav-start.sh
COPY clamdcheck.sh /usr/local/bin/clamdcheck.sh
COPY verify-runtime.sh /usr/local/bin/verify-scanner-runtime.sh
COPY source-components.json /usr/share/capiro-scanner/source-components.json
ENV PATH="/opt/capiro/clamav/bin:/opt/capiro/clamav/sbin:/opt/capiro/curl/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
RUN printf '%s\n' /opt/capiro/clamav/lib /opt/capiro/curl/lib > /etc/ld.so.conf.d/capiro-scanner.conf \
    && ldconfig \
    && chmod 0755 /capiro-clamav-start.sh /usr/local/bin/clamdcheck.sh /usr/local/bin/verify-scanner-runtime.sh \
    && /usr/local/bin/verify-scanner-runtime.sh
USER 1000:1000
ENTRYPOINT ["/usr/bin/env", "-u", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "-u", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "-u", "AWS_CONTAINER_AUTHORIZATION_TOKEN", "-u", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "-u", "ECS_CONTAINER_METADATA_URI", "-u", "ECS_CONTAINER_METADATA_URI_V4", "/usr/bin/tini", "-g", "--", "/bin/bash", "/capiro-clamav-start.sh"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 CMD clamdcheck.sh
