#!/bin/bash
set -euo pipefail
test "$(dpkg --print-architecture)" = arm64
test "$(getent passwd clamav | cut -d: -f3-4)" = 1000:1000
dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' | sort
for package in libcurl4t64 libcurl3t64-gnutls libsasl2-2 libsasl2-modules libsasl2-modules-db libldap2; do
  if dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null | grep -qx installed; then
    echo "Unexpected runtime dependency: $package" >&2
    exit 1
  fi
done
test "$(dpkg-query -W -f='${Version}' libc6)" = 2.43-2ubuntu2.4
test "$(dpkg-query -W -f='${Version}' libxml2-16)" = 2.15.2+dfsg-0.1ubuntu0.3
test "$(dpkg-query -W -f='${Version}' zlib1g)" = 1:1.3.dfsg+really1.3.1-1ubuntu3.2
test "$(dpkg-query -W -f='${Version}' apt)" = 3.2.1ubuntu0.1
clamd --version | grep -E '^ClamAV 1\.5\.4([/ ]|$)'
freshclam --version | grep -E '^ClamAV 1\.5\.4([/ ]|$)'
curl --version | grep -E '^curl 8\.23\.0 '
! curl --version | grep -E 'Protocols:.*(ldap|ldaps)'
for binary in /opt/capiro/clamav/bin/freshclam /opt/capiro/clamav/sbin/clamd /opt/capiro/curl/lib/libcurl.so; do
  linkage="$(ldd "$binary")"
  printf '%s\n%s\n' "$binary" "$linkage"
  ! grep -Ei 'ldap|sasl|not found' <<< "$linkage"
  if grep -q libcurl <<< "$linkage"; then
    grep -F 'libcurl.so.4 => /opt/capiro/curl/lib/libcurl.so.4' <<< "$linkage"
  fi
done
test -s /var/lib/clamav/main.cvd || test -s /var/lib/clamav/main.cld
test -s /var/lib/clamav/daily.cvd -o -s /var/lib/clamav/daily.cld
test -s /var/lib/clamav/bytecode.cvd -o -s /var/lib/clamav/bytecode.cld
