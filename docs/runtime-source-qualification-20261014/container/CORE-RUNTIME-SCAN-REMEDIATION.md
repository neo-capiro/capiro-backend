# Core runtime OS-package remediation

This is a partial remediation, not image admission. The zero HIGH/CRITICAL gate
is unchanged. No new image build or deployment is authorized by this document.

## Immutable candidate and actual inventory

Source: `91399fe1a205e37073cbeed2d7eb66a1fafd7fa2`.
Candidate: `capiro/dev/api@sha256:e55f2ac27a7cbe5368972d67501e3a19169527b73fa7dec458101cb08d9a202e`.
Build: `capiro-build-intel-api:cc9c776a-0486-4461-938f-bebc666720b2`.
Scan: COMPLETE, 2026-10-14 17:46:05 UTC; 5 CRITICAL and 12 HIGH.

Read-only extraction of `var/lib/dpkg/status` from these immutable layers found
88 installed packages in the base and 94 after the runtime APT step:

- Base layer: `sha256:24b2bb3778b7d3a170ad001b2da5179f504bb6f790d1a7f26997492bc5f03042`.
- Runtime APT layer: `sha256:e5c0ee656169cdcaed9110708cb198f76a680211f0f0c7435f4dcfcd17f323cc`.

| Source package | Actual installed binaries | Version | Runtime requirement |
| --- | --- | --- | --- |
| perl | perl-base only | 5.36.0-7+deb12u3 | Essential Debian package; retain and upgrade |
| util-linux | bsdutils, libblkid1, libmount1, libsmartcols1, libuuid1, mount, util-linux, util-linux-extra | 2.38.1-5+deb12u3 (bsdutils: 1:2.38.1-5+deb12u3) | Essential packages plus linked libraries; removal not qualified |
| zlib | zlib1g | 1:1.2.13.dfsg-1 | Required by wget, gpgv, libapt-pkg6.0 and util-linux |

`wget` depends on `libuuid1` and `zlib1g`. The existing `capiro-dev-api:650`
container healthcheck is `wget -qO- http://127.0.0.1:4000/health || exit 1`.
Removing wget or its libraries would break that healthcheck. The entrypoint
uses POSIX shell, Node and tsx; Prisma CLI/native engines, OpenSSL,
ca-certificates, dumb-init, UID/GID 1001 and writable scratch selection remain
unchanged. No unused package removal has sufficient runtime evidence here.

## Focused change

The runtime APT step now explicitly upgrades the already-installed `perl-base`
using Bookworm repositories and checks that its installed version is at least
`5.36.0-7+deb12u4`. Missing security updates fail the build rather than silently
retaining the vulnerable base version. `--only-upgrade` avoids adding full Perl.
No package sources, Node version, lockfile, native-engine generation, permissions,
entrypoints, healthcheck utilities or admission thresholds change.

[Debian DLA-4821-1](https://security-tracker.debian.org/tracker/DLA-4821-1)
and Debian's individual CVE records list that Bookworm backport for the Perl
findings except CVE-2026-82560. Source-package CVE classification is not proof
that every affected module is present in perl-base; no finding is declared
cleared before a new qualified image scan.

## Residual blockers

1. Rebuild and rescan still required; this branch has no candidate image or
   scan result. Original 17 blocking findings remain authoritative.
2. Perl CVE-2026-82560 (Pod::Text) has no fixed Bookworm package listed. Keep it
   blocked pending a supported backport or reviewed binary/module applicability.
3. util-linux CVE-2026-53615, CVE-2026-76642, CVE-2026-78408,
   CVE-2026-78409 and CVE-2026-78410 have no Bookworm fixed version listed.
   Existing binary inventory must guide any supported backport or runtime change.
   A Trixie switch alone does not clear all five.
4. zlib CVE-2026-85091 remains blocked. The published description names
   1.3.1.2–1.3.2, but Debian still marks Bookworm 1.2.13 vulnerable. In
   [upstream issue 1310](https://github.com/madler/zlib/issues/1310), Debian's
   reporter notes on October 4 that the PoC also triggers before the introduction
   of non-blocking support. [Debian bug 1146895](https://bugs.debian.org/1146895)
   records older-version reproduction and unresolved affected-range judgment.
   [Upstream fix df84af2](https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148)
   addresses stale input state in gz_write. Absence of gz_vacate in an older
   release does not establish non-applicability. Do not suppress this finding,
   delete package metadata, mix unstable packages into Bookworm, or waive the gate.
5. Local Docker Linux engine is unavailable on this host. ARM64 image build,
   package-resolution execution and Node/Prisma/native-engine probes have not
   been rerun. They remain required before admission; no paid AWS build was run.

The supported minimal next step is this targeted Perl update. A complete
zero-finding remedy still needs qualified supported fixes for remaining packages
or a separately reviewed runtime packaging change preserving native behavior.

## Package-level applicability evidence

Package-owned file lists were read from the same base layer, not inferred from
scanner source labels. `perl-base.list` includes `Socket.pm` and `Socket.so`,
but no Pod/Text.pm, Archive/Tar.pm, Storable, HTTP/Tiny.pm, IO/Compress or
IO/Uncompress paths. The interpreter's regex and pack/unpack implementation is
present. Thus Socket and interpreter findings have direct installed-component
evidence; other Perl findings need a whole-image module search and vendor review
before any applicability disposition. This document grants no exception.

`util-linux.list` includes `/usr/bin/nsenter`; `libblkid1:arm64.list` includes
`libblkid.so.1.1.0`; the package inventory also includes `mount`. These are the
components implicated by the five util-linux findings. `libuuid1` alone is not
evidence of vulnerable mount/nsenter code, but removing other binaries cannot
clear a source-package finding while libuuid1 retains the same source/version.
`zlib1g:arm64.list` includes `/lib/aarch64-linux-gnu/libz.so.1.2.13`.

## Route to a candidate with a credible admission path

Do not spend a paid build on the Perl-only patch expecting admission. Choose and
locally qualify one of the following complete runtime routes first:

| Route | Current evidence | Admission prerequisites |
| --- | --- | --- |
| Bookworm vendor backports | Perl update exists; remaining util-linux/zlib fixes are not listed | Supported patched Debian packages for all remaining findings, authenticated package evidence, native execution and rescan; currently blocked on vendor packages |
| Trixie or Ubuntu refresh | Trixie still lists four util-linux issues vulnerable; Ubuntu CVE-2026-78408 still needs evaluation | Not a proven complete fix; do not choose merely because distribution is newer |
| Fresh Wolfi glibc runtime assembled from maintained packages | ARM64 index and source recipes provide newer util-linux libraries and zlib with upstream fix; existing ECR basic-scan support is unproven | Verify supported scanning path first; then candidate implementation, signature-verified package closure, pinned image/package versions, ARM64 local native/runtime tests, complete scan before admission |
| Alpine musl | Vendor zlib backport exists | Changes libc and requires different Prisma native engines; conflicts with preserving current glibc engine behavior and is not selected |

The most concrete package-level alternative is a fresh **glibc** runtime, retaining the Debian
build stage and copying the exact Node 22.23.3 artifact plus generated Prisma
engines/workspace into a separately assembled Wolfi runtime. Do not copy Debian
OS libraries or package metadata into Wolfi. This avoids installing Debian's
Essential utility set without forcibly removing Essential packages from a Debian
root filesystem. Keep GNU wget and the exact ECS healthcheck command, POSIX sh,
dumb-init, CA trust, OpenSSL 3 SONAME libraries, UID/GID1001, writable scratch
selection and existing entrypoint paths.

Read-only inspection of the public
[Wolfi ARM64 index](https://packages.wolfi.dev/os/aarch64/APKINDEX.tar.gz)
on 2026-10-14 found these concrete candidate package versions:

- `libuuid=2.42.4-r0`; the
  [util-linux recipe](https://github.com/wolfi-dev/os/blob/main/util-linux.yaml)
  builds upstream 2.42.4 and splits libraries/utilities. Retain only the actual
  resolved library/utility closure, never delete metadata to hide findings.
- `zlib=1.3.2.1_rc20260921-r0`; the
  [zlib recipe](https://github.com/wolfi-dev/os/blob/main/zlib.yaml)
  pins upstream commit `767c4c947852e143f582c85f14cf573411df1b35` after the fix.
  GitHub's compare endpoint reports that commit 23 commits ahead of the fix,
  zero behind, with the fix as merge base. Package signature/provenance and
  installed-binary verification are still required before declaring remediation.
- `wget=1.25.0-r20` depends on libssl.so.4/libcrypto.so.4 rather than libuuid;
  use the maintained package closure while separately retaining libssl.so.3 and
  libcrypto.so.3 for existing Prisma engines. Do not silently substitute an
  incompatible OpenSSL major for Prisma.
- `dumb-init=1.2.5-r12`, `busybox=1.38.0-r3`,
  `ca-certificates-bundle=20260909-r2`; OpenSSL3 libraries
  `libssl3/libcrypto3=3.6.5-r2` and glibc-2.44 packages are indexed.
  Those OpenSSL3 packages also depend on OpenSSL4 packages; qualify the complete
  resolved closure, not just the presence of .so.3 files.
- Indexed `nodejs-22` reaches 22.23.2, not the required 22.23.3. Preserve the
  exact official Node artifact from the original build stage instead of silently
  downgrading or switching Node packages.

The [AWS ECR basic scanning support list](https://docs.aws.amazon.com/AmazonECR/latest/userguide/image-scanning-troubleshooting.html)
lists Amazon Linux, Debian, Ubuntu, CentOS, Oracle Linux, Alpine and RHEL, but not
Wolfi. Verify actual supported scanning before selecting Wolfi; an unsupported
scan cannot be counted as zero findings. Any change to scanner/gate equivalence
requires separate reviewed authorization and is not implemented by this PR.

Index retrieval is availability evidence, not signature verification or an
installed candidate SBOM. Before a paid build: authenticate/pin the ARM64 base
and APK package closure; verify every ELF dependency for Node, Prisma and other
native addons; run Node version/architecture, Prisma CLI5.22.0 and engine load
probes, syntax-only source-map check, non-root/read-only/tempdir checks, wget
loopback healthcheck and TLS checks against local fixtures, with no database or
external service access. Scan the locally built image and require zero
HIGH/CRITICAL before proposing paid qualification. A full scan can reveal new
findings even when these original CVEs are addressed.

**Decision/blocker:** no complete candidate is presently qualified. Preserving the existing runtime image family requires
waiting for supported backports. Moving to the glibc Wolfi assembly is a material
runtime-base change requiring ARM64 execution and scanner support verification
under the existing gate, or a separately reviewed supported scanning decision.
The current host has no Linux container engine or WSL distribution, so that
route cannot be qualified here. No paid build should start until an isolated
ARM64 local execution environment and candidate package closure are validated.

## Local verification and independent review

- `git diff --check`: passed.
- Existing migration-discovery tests were attempted without database access.
  Windows cannot create several Linux-specific filename/symlink fixtures; these
  failures are outside the unchanged migration-discovery implementation.
- Dockerfile RUN syntax and entrypoint syntax were checked with Git Bash.
- Independent review found no blocking code issue. It confirmed the Essential
  package/dependency constraints and corrected bsdutils' version epoch above.
- Container build, APT execution, native probes and rescan remain unverified.
