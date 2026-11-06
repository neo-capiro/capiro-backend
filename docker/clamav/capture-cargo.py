#!/usr/bin/python3
"""Retain the upstream Cargo command and its real exit; capture build evidence."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


def production_artifacts(log):
    """Snapshot production outputs before returning control to CMake/CTest."""
    paths = set()
    for line in Path(log).read_text().splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (isinstance(event, dict) and event.get("reason") == "compiler-artifact"
                and event.get("target", {}).get("name") == "clamav_rust"
                and "staticlib" in event["target"]["crate_types"]):
            paths.update(event["filenames"])
    assert paths, "No production clamav_rust staticlib artifact"
    artifacts = []
    for name in sorted(paths):
        path = Path(name)
        assert path.is_file() and not path.is_symlink() and path.suffix == ".a", name
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        artifacts.append({"path": name, "sha256": digest, "bytes": path.stat().st_size})
    return artifacts


def main():
    args = sys.argv[1:]
    if not args or args[0] not in {"build", "test"}:
        os.execv("/usr/bin/cargo", ["/usr/bin/cargo", *args])
    # Upstream already uses offline build. Also prevent test/lock resolution drift.
    assert "--" not in args and not any(x.startswith("--message-format") for x in args)
    controls = [flag for flag in ("--locked", "--offline") if flag not in args]
    command = ["/usr/bin/cargo", *args, *controls, "--message-format=json-render-diagnostics"]
    out = Path("/build/scanner-build-evidence/cargo-events")
    out.mkdir(parents=True, exist_ok=True)
    stem = out / (args[0] + "-" + uuid.uuid4().hex)
    invocation = {"command": command, "cwd": os.getcwd(), "mode": args[0],
                  "environment": {k: os.environ[k] for k in (
                      "RUSTFLAGS", "CARGO_CMD", "CARGO_TARGET_DIR", "OPENSSL_DIR",
                      "OPENSSL_INCLUDE_DIR", "OPENSSL_LIB_DIR", "OPENSSL_LIBS"
                  ) if k in os.environ}}
    with stem.with_suffix(".intent.json").open("x") as stream:
        json.dump(invocation, stream, indent=2)
    with stem.with_suffix(".jsonl").open("xb") as evidence:
        with subprocess.Popen(command, stdout=subprocess.PIPE) as child:
            for line in child.stdout:
                evidence.write(line)
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()
            code = child.wait()
    result = {**invocation, "exitCode": code, "artifactCaptureExitCode": None,
              "productionStaticLibraries": []}
    if code == 0:
        try:
            if args[0] == "build":
                result["productionStaticLibraries"] = production_artifacts(stem.with_suffix(".jsonl"))
            result["artifactCaptureExitCode"] = 0
        except Exception as error:
            result["artifactCaptureExitCode"] = 1
            result["artifactCaptureError"] = str(error)
    with stem.with_suffix(".result.json").open("x") as stream:
        json.dump(result, stream, indent=2)
    if code == 0 and result["artifactCaptureExitCode"] != 0:
        return 1
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    raise SystemExit(main())
