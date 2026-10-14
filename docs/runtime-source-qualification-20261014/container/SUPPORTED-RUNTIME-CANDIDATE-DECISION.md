# Supported Core runtime candidate decision

Decision as of 2026-10-14: retain the supported Perl update, but do not submit a
paid build of the current Dockerfile expecting admission. **No complete supported
official Node22 glibc candidate is demonstrated under the existing ECR basic
scan gate.** This is a package/support constraint, not a local-Docker constraint;
the shipping owner can perform Linux/ARM64 qualification when a viable package
closure is prepared.

Application source remains `91399fe1a205e37073cbeed2d7eb66a1fafd7fa2`; this
workstream changes only Docker/runtime packaging and supporting evidence.

## Direct repository check

The official Debian ARM64 `Packages.xz` indexes were read over HTTPS. These reads
establish availability, not installation or signature verification; qualification
must use APT's authenticated Release/InRelease path.

| Official suite | Relevant package availability | Consequence |
| --- | --- | --- |
| bookworm-security | perl-base 5.36.0-7+deb12u4 | Existing targeted update has an actual ARM64 package; SHA256 03d979b849a1a0a8955eee28b988dbc25a407fd3a0581df5c94e6ae7bcc01ddf |
| bookworm-security | util-linux/libuuid1 2.38.1-5+deb12u1 | Older than installed main-suite deb12u3; not a remedy for remaining util-linux findings |
| bookworm-backports | No perl-base, util-linux, libuuid1 or zlib1g entries | No supported backports shortcut for these packages |
| trixie-security | util-linux/libuuid1 2.41.5-0+deb13u1 | Does not fix CVE-2026-78408/78409/78410/76642 according to Debian |
| trixie-backports | No perl-base, util-linux, libuuid1 or zlib1g entries | No supported backports shortcut |

Indexes:

- https://deb.debian.org/debian-security/dists/bookworm-security/main/binary-arm64/Packages.xz
- https://deb.debian.org/debian/dists/bookworm-backports/main/binary-arm64/Packages.xz
- https://deb.debian.org/debian-security/dists/trixie-security/main/binary-arm64/Packages.xz
- https://deb.debian.org/debian/dists/trixie-backports/main/binary-arm64/Packages.xz

The [Debian util-linux tracker](https://security-tracker.debian.org/tracker/source-package/util-linux)
lists the required fixes in forky/sid 2.42.4-1, not Bookworm/Trixie stable security
or backports. The [zlib tracker](https://security-tracker.debian.org/tracker/source-package/zlib)
still lists CVE-2026-85091 vulnerable in **all** Bookworm/Trixie/forky/sid suites.
Mixing sid/testing libraries into a stable runtime is not a supported stable
backport and is not selected. A self-built patched Debian package is a different
support/provenance commitment, and does not establish that ECR's vendor-data
mapping will mark it fixed.

Red Hat's maintained [UBI9 Node22-minimal source](https://github.com/sclorg/s2i-nodejs-container/blob/master/22-minimal/Dockerfile.rhel9)
was also checked as a vendor glibc alternative. Its public ARM64 UBI9 baseos
repository currently offers util-linux/libblkid/libmount/libuuid
`2.37.4-25.el9` and zlib `1.2.11-40.el9`. Public `other.xml.gz` changelog metadata
for those packages contains no reference to the six blocking util-linux/zlib
CVEs. Absence of a changelog entry is **not** proof of vulnerability or fix.
The Red Hat CVE JSON endpoint returned HTTP403, and the public VEX URL returned
HTTP404 for CVE-2026-85091. Thus a supported vendor fix/non-applicability claim
for this route is unverified; older upstream versions cannot be assumed safe.
No UBI candidate is selected without exact vendor package/advisory and supported
scan evidence. This does not establish that every vendor runtime is impossible.

## Official Node22 comparison

[Official Node tags](https://hub.docker.com/_/node) and
[Node Docker architecture/variant metadata](https://github.com/nodejs/docker-node/blob/main/versions.json)
offer Node22.23.3 Bookworm, Bookworm-slim, Trixie, Trixie-slim, Alpine3.23 and
Alpine3.24 on ARM64. The glibc variants are Bookworm/Trixie. Switching slim to
full adds packages without changing their distribution's unresolved fix status.

The official Alpine3.24 ARM64 index
https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/APKINDEX.tar.gz contains:

- zlib 1.3.2-r1, the vendor backport for the reported zlib issue;
- wget 1.25.0-r3, depending on musl, OpenSSL3, libidn2, libpcre2 and zlib,
  with no libuuid dependency;
- OpenSSL 3.5.9-r0;
- util-linux/libuuid 2.42.3-r1, which alone does **not** demonstrate the nsenter
  CVE-2026-78408 fix (upstream 2.42.4).

Alpine's [3.24-stable zlib APKBUILD](https://github.com/alpinelinux/aports/blob/3.24-stable/main/zlib/APKBUILD)
explicitly lists CVE-2026-85091 fixed in 1.3.2-r1 and includes the
[upstream df84af2 patch](https://github.com/alpinelinux/aports/blob/3.24-stable/main/zlib/CVE-2026-85091.patch).

Alpine's minimal Node runtime need not install util-linux if the complete
application/native closure does not require it. This would be absence by fresh
supported runtime assembly, not deletion of Debian Essential packages or metadata.
GNU wget would be retained; the ECS healthcheck command stays unchanged.
The Node team explicitly documents Alpine as **musl**, not glibc.

## Exact unavoidable tradeoff

1. **Keep current glibc/OpenSSL3 Prisma native requirements and current ECR basic
   gate:** neither official Node22 Debian runtime offers the remaining supported
   fixes today. Need vendor-supported backports, or separately approved ownership
   of maintained backports and reviewed scanner treatment. Waiting is not replaced
   by a rebuild, source-label removal or a finding suppression.
2. **Keep official Node22 and existing ECR-scannable distribution:** the concrete
   supported alternative is Alpine3.24 with patched zlib/GNU wget, but it requires
   replacing/regenerating the Prisma5.22.0 engines and all native addons for musl
   ARM64 OpenSSL3. Existing `linux-arm64-openssl-3.0.x` glibc engines must not be
   copied into that runtime. This changes the expressly preserved glibc requirement
   and therefore is not implemented without revised scope.
3. **Keep glibc but adopt Wolfi:** maintained patched packages exist, but Wolfi is
   absent from the [ECR basic supported distribution list](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning-troubleshooting.html).
   It requires a separately reviewed supported scanning path. Not selected under
   the current gate.

The selected in-scope change remains the fail-closed supported Perl update.
There is no evidenced additional Dockerfile edit that can currently claim a complete
supported fix while preserving all three constraints. No alternate runtime is
adopted, and no paid build is proposed.

## Shipping-owner qualification once the tradeoff is resolved

- Freeze application source/lockfile and exact candidate Dockerfile; record base
  ARM64 digest, package repository versions/signatures and resolved complete SBOM.
- Before a full app build, inspect the candidate base's installed package inventory
  and available authenticated security updates. Stop if known required packages
  still have unresolved HIGH/CRITICAL findings or scanning is unsupported.
- Preserve Node22 major (prefer current exact22.23.3), PrismaCLI5.22.0, OpenSSL3,
  UID/GID1001, dumb-init, original dispatcher/scratch controls and GNU wget.
- Run isolated ARM64 probes with no credentials or database/network service access:
  Node version/arch, generated Prisma client and native engine load/CLI version,
  syntax-only source-map override, all native addon ELF dependencies, non-root and
  read-only filesystem/tempdir checks, local loopback wget healthcheck, local TLS
  fixture and signal propagation through dumb-init.
- Require an actual supported scan status COMPLETE and zero HIGH/CRITICAL for the
  exact new digest. Unsupported/failed/missing scans cannot count as zero. Keep all
  original findings blocked until new evidence meets the unchanged gate.
- Only the sole shipping owner may request any later paid qualification build;
  this workstream performs no starts, uploads, deployment or database actions.
