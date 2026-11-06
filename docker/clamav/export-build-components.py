#!/usr/bin/python3
"""Build-only evidence export; never declares native or vulnerability qualification.

Usage: export-build-components.py prepare|finish. Missing/inconsistent evidence exits 1.
"""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tomllib

SOURCE = Path("/build/clamav-1.5.4")
BUILD = Path("/build/clamav-build")
OUT = Path("/build/scanner-build-evidence")
ARCHIVE_SHA = "1af1117a228f1b5bc7fa91a0dabc37848a99e7d25188e9be8043332ce721dfd3"
LOCK_SHA = "4d1d83e531d18e793f348db5a4baa6ec8c5d14345a285eb6959fcd4af12e1e28"
CURL_SHA = "8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5"


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write(name, value):
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")


def copy(path, name):
    target = OUT / name
    target.parent.mkdir(parents=True, exist_ok=True)
    assert not target.exists(), target
    shutil.copyfile(path, target)


def command(name, args, cwd=None):
    result = subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    write(name + ".command.json", {"argv": args, "cwd": str(cwd), "exitCode": result.returncode,
                                   "stderr": result.stderr.decode("utf-8", errors="replace")})
    assert result.returncode == 0, (name, result.returncode)
    (OUT / name).write_bytes(result.stdout)
    return result.stdout


def source_inventory():
    assert sha("/build/clamav.tar.gz") == ARCHIVE_SHA
    assert sha("/build/curl.tar.xz") == CURL_SHA
    assert sha(SOURCE / "Cargo.lock") == LOCK_SHA
    lock = tomllib.loads((SOURCE / "Cargo.lock").read_text())
    packages = {(p["name"], p["version"]): p for p in lock["package"]}
    assert len(packages) == len(lock["package"]) == 291
    vendors = []
    for directory in sorted((SOURCE / ".cargo/vendor").iterdir()):
        assert directory.is_dir() and not directory.is_symlink(), directory
        manifest = tomllib.loads((directory / "Cargo.toml").read_text())
        package = manifest["package"]
        locked = packages[(package["name"], package["version"])]
        checks_path = directory / ".cargo-checksum.json"
        checks = json.loads(checks_path.read_text())
        assert checks["package"] == locked.get("checksum"), directory
        actual_files = {p.relative_to(directory).as_posix() for p in directory.rglob("*") if p.is_file()}
        assert actual_files == set(checks["files"]) | {".cargo-checksum.json"}, directory
        for relative, expected in checks["files"].items():
            path = directory / relative
            assert path.resolve().is_relative_to(directory.resolve())
            assert not path.is_symlink() and sha(path) == expected, path
        vendors.append({"directory": directory.relative_to(SOURCE).as_posix(),
                        "name": package["name"], "version": package["version"],
                        "source": locked["source"], "packageChecksum": checks["package"],
                        "files": checks["files"], "checksumFileSha256": sha(checks_path)})
    assert len(vendors) == 290
    # Every source file is bound, including extra embedded C code and build scripts.
    files = {}
    for path in sorted(SOURCE.rglob("*")):
        if path.is_symlink():
            files[path.relative_to(SOURCE).as_posix()] = {"symlink": path.readlink().as_posix()}
        elif path.is_file():
            files[path.relative_to(SOURCE).as_posix()] = {"sha256": sha(path)}
    return {"clamavArchiveSha256": ARCHIVE_SHA, "curlArchiveSha256": CURL_SHA,
            "cargoLockSha256": LOCK_SHA, "vendorPackages": vendors, "sourceFiles": files}


def prepare():
    OUT.mkdir(parents=True, exist_ok=False)
    write("source-inventory.json", source_inventory())
    query = BUILD / ".cmake/api/v1/query/client-capiro-components"
    query.mkdir(parents=True)
    for kind in ("codemodel-v2", "cache-v2", "toolchains-v1"):
        (query / kind).touch(exist_ok=False)
    for relative in ("Cargo.lock", "Cargo.toml", "libclamav_rust/Cargo.toml", ".cargo/config.toml",
                     "libclamunrar/version.hpp", "libclammspack/README", "libclammspack/CMakeLists.txt",
                     "libclamav/7z/7zVersion.h", "libclamav/yara_clam.h", "libclamav/CMakeLists.txt"):
        copy(SOURCE / relative, "source/" + relative)


def match_installed_staticlib(installed, records):
    assert installed.is_file() and records
    digest, size = sha(installed), installed.stat().st_size
    assert all(set(r) == {"path", "sha256", "bytes"} for r in records)
    assert all(re.fullmatch(r"[0-9a-f]{64}", r["sha256"]) and
               type(r["bytes"]) is int and r["bytes"] > 0 for r in records)
    assert any(r["sha256"] == digest and r["bytes"] == size for r in records), "Installed staticlib differs from production terminal bytes"
    return digest, size


def rust_components(metadata):
    by_id = {p["id"]: p for p in metadata["packages"]}
    compiled = {}
    root_artifacts = []
    results = sorted((OUT / "cargo-events").glob("*.result.json"))
    assert results
    assert len(results) == len(list((OUT / "cargo-events").glob("*.intent.json")))
    for result_path in results:
        result = json.loads(result_path.read_text())
        assert result["exitCode"] == 0, result_path
        intent = json.loads(result_path.with_name(result_path.name.replace(".result.json", ".intent.json")).read_text())
        assert result["artifactCaptureExitCode"] == 0, result_path
        assert {k: v for k, v in result.items() if k not in {
            "exitCode", "artifactCaptureExitCode", "productionStaticLibraries"}} == intent
        events = []
        for line in result_path.with_name(result_path.name.replace(".result.json", ".jsonl")).read_text().splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue  # Test-program stdout is retained raw; it is not build metadata.
            if isinstance(event, dict):
                events.append(event)
        assert any(e.get("reason") == "build-finished" and e.get("success") is True for e in events)
        if result["mode"] != "build":
            continue  # Test compilation is preserved, never treated as shipped code.
        assert result["cwd"] == str(SOURCE / "libclamav_rust")
        assert "--release" in result["command"] and "aarch64-unknown-linux-gnu" in result["command"]
        invocation_roots = set()
        for event in events:
            if event.get("reason") != "compiler-artifact":
                continue
            package = by_id[event["package_id"]]  # Unknown packages fail closed.
            record = compiled.setdefault(package["id"], {"package": package, "artifacts": []})
            record["artifacts"].append(event)
            if package["name"] == "clamav_rust" and "staticlib" in event["target"]["crate_types"]:
                invocation_roots.update(event["filenames"])
        terminal = result["productionStaticLibraries"]
        assert invocation_roots and len(terminal) == len(invocation_roots)
        assert {r["path"] for r in terminal} == invocation_roots
        root_artifacts.extend(terminal)
    assert root_artifacts and compiled
    installed_rust = Path("/opt/capiro/clamav/lib/libclamav_rust.a")
    digest, size = match_installed_staticlib(installed_rust, root_artifacts)
    return {"compiledPackages": sorted(compiled.values(), key=lambda x: x["package"]["id"]),
            "productionTerminalStaticLibraries": root_artifacts,
            "installedStaticLibrary": str(installed_rust), "installedStaticLibrarySha256": digest,
            "installedStaticLibraryBytes": size,
            "scope": "Actual production Cargo invocation, including host build tools/proc macros; artifact target/profile retained. Not every crate is necessarily runtime reachable."}


def package_owner(path, label):
    raw = command("toolchain/" + label + "-owner.txt", ["dpkg-query", "-S", str(path)]).decode().splitlines()
    assert len(raw) == 1 and ": " in raw[0], (path, raw)
    owner, owned_path = raw[0].split(": ", 1)
    assert owned_path == str(path) and re.fullmatch(r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?", owner), raw
    return owner


def toolchain_file(path, label):
    assert path.is_absolute() and path.is_file(), path
    resolved = path.resolve(strict=True)
    return {"path": str(path), "resolvedPath": str(resolved),
            "symlinkTarget": str(path.readlink()) if path.is_symlink() else None,
            "sha256": sha(resolved), "bytes": resolved.stat().st_size,
            "owner": package_owner(resolved, label)}


def package_identity(owner, label):
    fields = "${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\t${db:Status-Status}\n"
    raw = command("toolchain/" + label + "-package.txt", ["dpkg-query", "-W", "-f=" + fields, owner]).decode().splitlines()
    assert len(raw) == 1, (owner, raw)
    values = raw[0].split("\t")
    assert len(values) == 6 and all(values) and values[5] == "installed", (owner, raw)
    binary, version, architecture, source, source_version, _ = values
    assert binary.split(":")[0] == owner.split(":")[0]
    assert architecture == "arm64" or architecture == "all", (owner, architecture)
    if ":" in owner:
        assert owner.split(":", 1)[1] == architecture
    return {"binaryPackage": binary, "version": version, "architecture": architecture,
            "sourcePackage": source, "sourceVersion": source_version}


def toolchain_inventory():
    sysroot_raw = command("toolchain/sysroot.txt", ["/usr/bin/rustc", "--print", "sysroot"]).decode().strip()
    target_raw = command("toolchain/target-libdir.txt", ["/usr/bin/rustc", "--print", "target-libdir",
                          "--target", "aarch64-unknown-linux-gnu"]).decode().strip()
    sysroot, target = Path(sysroot_raw), Path(target_raw)
    assert sysroot.is_absolute() and sysroot.is_dir() and target.is_absolute() and target.is_dir()
    assert target.resolve().is_relative_to(sysroot.resolve())
    executables = [toolchain_file(Path(name), "executable-" + str(i)) for i, name in
                   enumerate(("/usr/bin/rustc", "/usr/bin/cargo"))]
    paths = sorted(p for p in target.rglob("*") if p.name.endswith((".rlib", ".a", ".so")) or ".so." in p.name)
    assert paths and any(p.name.startswith("libstd-") and p.suffix == ".rlib" for p in paths)
    libraries = [toolchain_file(p, "library-" + str(i)) for i, p in enumerate(paths)]
    owners = sorted({record["owner"] for record in executables + libraries})
    packages = {owner: package_identity(owner, str(i)) for i, owner in enumerate(owners)}
    write("rust-toolchain-inventory.json", {
        "kind": "scanner-rust-toolchain-evidence-v1", "target": "aarch64-unknown-linux-gnu",
        "sysroot": sysroot_raw, "targetLibdir": target_raw, "executables": executables,
        "targetLibraries": libraries, "packages": packages,
        "scope": "Complete installed target-directory library envelope, not proof every library survives final linkage; pair with production staticlib and CMake/native closure",
        "status": "BUILD_TOOLCHAIN_ATTRIBUTION_NOT_SECURITY_QUALIFICATION", "securityQualified": False})


def finish():
    before = json.loads((OUT / "source-inventory.json").read_text())
    after = source_inventory()
    # Retain additions from upstream generation/tests; every preexisting source byte remains exact.
    assert all(after["sourceFiles"].get(k) == v for k, v in before["sourceFiles"].items())
    assert after["vendorPackages"] == before["vendorPackages"]
    write("generated-source-files.json", {k: v for k, v in after["sourceFiles"].items() if k not in before["sourceFiles"]})
    raw = command("cargo-metadata.json", ["/usr/bin/cargo", "metadata", "--locked", "--offline",
                  "--format-version", "1", "--filter-platform", "aarch64-unknown-linux-gnu"], SOURCE)
    metadata = json.loads(raw)
    rust = rust_components(metadata)
    write("rust-compiled-components.json", rust)
    for name, args in {"rustc-version.txt": ["/usr/bin/rustc", "-vV"],
                       "cargo-version.txt": ["/usr/bin/cargo", "--version"],
                       "curl-version.txt": ["/opt/capiro/curl/bin/curl", "--version"],
                       "curl-configure.txt": ["/opt/capiro/curl/bin/curl-config", "--configure"],
                       "curl-features.txt": ["/opt/capiro/curl/bin/curl-config", "--features"],
                       "curl-protocols.txt": ["/opt/capiro/curl/bin/curl-config", "--protocols"]}.items():
        command(name, args)
    assert b"host: aarch64-unknown-linux-gnu" in (OUT / "rustc-version.txt").read_bytes()
    toolchain_inventory()
    cache = (BUILD / "CMakeCache.txt").read_text()
    required = {"ENABLE_UNRAR": "ON", "ENABLE_EXTERNAL_MSPACK": "OFF", "ENABLE_SHARED_LIB": "ON",
                "ENABLE_STATIC_LIB": "OFF", "ENABLE_TESTS": "ON", "ENABLE_JSON_SHARED": "ON",
                "ENABLE_CLAMONACC": "OFF", "ENABLE_MILTER": "OFF", "MAINTAINER_MODE": "OFF",
                "BYTECODE_RUNTIME": "interpreter"}
    for key, value in required.items():
        assert re.search(r"^" + key + r":[^=]+=" + value + r"$", cache, re.M), (key, value)
    reply = BUILD / ".cmake/api/v1/reply"
    indexes = list(reply.glob("index-*.json"))
    assert len(indexes) == 1
    index = json.loads(indexes[0].read_text())
    assert {"codemodel", "cache", "toolchains"} <= {x["kind"] for x in index["objects"]}
    targets = [json.loads(p.read_text()) for p in reply.glob("target-*.json")]
    names = {t["name"] for t in targets}
    assert {"clamav", "clammspack", "clamunrar", "regex", "lzma_sdk", "yara", "bytecode_runtime"} <= names
    link = (BUILD / "libclamav/CMakeFiles/clamav.dir/link.txt").read_text()
    assert "libclamav_rust.a" in link and "libclammspack" in link
    for path in sorted(reply.glob("*.json")):
        copy(path, "cmake/reply/" + path.name)
    for relative in ("CMakeCache.txt", "compile_commands.json", "install_manifest.txt"):
        copy(BUILD / relative, "cmake/" + relative)
    for path in sorted(BUILD.rglob("link.txt")):
        copy(path, "cmake/" + path.relative_to(BUILD).as_posix())
    for path in sorted(BUILD.rglob("*.h")):
        copy(path, "cmake/generated-headers/" + path.relative_to(BUILD).as_posix())
    for relative in ("config.log", "lib/curl_config.h"):
        copy(Path("/build/curl-8.23.0") / relative, "curl/" + relative)
    installed = {}
    for root in (Path("/opt/capiro/clamav"), Path("/opt/capiro/curl")):
        for path in sorted(root.rglob("*")):
            if path.is_symlink():
                installed[str(path)] = {"symlink": path.readlink().as_posix()}
            elif path.is_file():
                installed[str(path)] = {"sha256": sha(path), "bytes": path.stat().st_size}
    assert any("libclammspack.so" in p for p in installed)
    assert any("libclamunrar.so" in p for p in installed)
    write("installed-custom-files.json", installed)
    assert (SOURCE / "libclammspack/README").read_text().splitlines()[0].strip() == "libmspack 0.11alpha"
    unrar = (SOURCE / "libclamunrar/version.hpp").read_text()
    assert re.search(r"RARVER_MAJOR\s+6\b", unrar) and re.search(r"RARVER_MINOR\s+24\b", unrar)
    write("component-inventory.json", {"kind": "scanner-build-component-evidence-v1",
          "status": "BUILD_EXPORT_ONLY_NOT_SECURITY_QUALIFICATION", "clamavVersion": "1.5.4",
          "curlVersion": "8.23.0", "clamavArchiveSha256": ARCHIVE_SHA, "curlArchiveSha256": CURL_SHA,
          "cargoLockSha256": LOCK_SHA, "lockedPackages": 291, "vendoredPackages": 290,
          "productionCargoPackageCount": len(rust["compiledPackages"]),
          "bundledComponents": [{"name": "libclammspack", "sourceVersion": "0.11alpha", "sharedAbiVersion": "0.8.0",
                                 "sourceBasis": "source/libclammspack/README", "owner": "ClamAV patched bundle"},
                                {"name": "libclamunrar", "sourceVersion": "6.24", "sourceBasis": "source/libclamunrar/version.hpp",
                                 "owner": "ClamAV patched bundle"},
                                {"name": "lzma_sdk", "upstreamHeaderVersion": "9.20",
                                 "sourceBasis": "source/libclamav/7z/7zVersion.h", "owner": "ClamAV patched bundle"},
                                {"name": "yara", "derivedFromVersion": "2.1.0",
                                 "sourceBasis": "source/libclamav/yara_clam.h", "owner": "ClamAV fork; not stock YARA 2.1.0"},
                                {"name": "regex", "sourceVersion": "ClamAV 1.5.4 bundled source",
                                 "sourceBasis": "source-inventory.json", "owner": "ClamAV patched bundle"}],
          "allCMakeTargets": sorted(names), "requiredBuildFeatures": required,
          "fullImageSbomAndAdvisoryCoverageRequired": True, "imageDigestBoundExternally": True,
          "securityQualified": False,
          "unresolvedSecurityCoverage": [
              "Final-image OS package SBOM and all-severity vulnerability report",
              "Every actual production Cargo package matched to advisory coverage; host/build-only classification retained",
              "Embedded Rust toolchain standard/runtime libraries outside Cargo.lock, including compiler-builtins: match retained rust-toolchain-inventory.json package/source/file identities to advisories and native static/dynamic closure; inventory and rustc -vV alone are not a security pass",
              "All bundled C targets, including ClamAV-patched libmspack/UnRAR/LZMA/YARA/regex, matched to upstream advisory review",
              "Final-image dynamic closure and installed-file hashes matched to this export and exact manifest/config digest"
          ]})
    # Index every raw artifact. The outer native collector must bind this index to the image digest.
    entries = [f"{sha(p)}  {p.relative_to(OUT).as_posix()}\n" for p in sorted(OUT.rglob("*")) if p.is_file()]
    (OUT / "SHA256SUMS").write_text("".join(entries))


if __name__ == "__main__":
    assert len(sys.argv) == 2 and sys.argv[1] in {"prepare", "finish"}, __doc__
    {"prepare": prepare, "finish": finish}[sys.argv[1]]()
