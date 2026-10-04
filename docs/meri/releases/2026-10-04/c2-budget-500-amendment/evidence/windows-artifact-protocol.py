"""One bounded operation over native, handle-relative artifact storage.

The caller retains the returned identities. No path-based I/O fallback is allowed.
"""
import base64
import contextlib
import hashlib
import json
import pathlib
import re
import runpy
import sys

native = runpy.run_path(str(pathlib.Path(__file__).with_name("windows-owned-artifacts.py")))
MAX_BYTES = 32 * 1024 * 1024


def digest(value):
    return hashlib.sha256(value).hexdigest()


def components(value, root=False):
    if not isinstance(value, str):
        raise ValueError("INVALID_PATH")
    if root:
        if not re.fullmatch(r"[A-Za-z]:\\[^\x00]+", value):
            raise ValueError("LOCAL_ABSOLUTE_ROOT_REQUIRED")
        drive, value = value[:2].upper(), value[3:]
        parts = value.split("\\")
    else:
        drive, parts = None, value.split("/")
    for part in parts:
        native["validate_name"](part)
    return drive, parts


def execute(request):
    op = request["op"]
    drive, root_parts = components(request["root"], root=True)
    old = request.get("state")
    if op != "init" and (not isinstance(old, dict) or old.get("root") != request["root"]):
        raise ValueError("OWNER_STATE_REQUIRED")
    state = {"root": request["root"], "directories": {}, "files": {}} if op == "init" else json.loads(json.dumps(old))
    with contextlib.ExitStack() as stack:
        def retain(handle):
            return stack.enter_context(handle)

        def bind_directory(key, handle, created=False):
            observed = native["inspect"](handle)["identity"]
            prior = state["directories"].get(key)
            if prior is not None and prior != observed:
                raise ValueError("DIRECTORY_IDENTITY_CHANGED")
            if prior is None and not created and op != "init":
                raise ValueError("UNOWNED_DIRECTORY")
            state["directories"][key] = observed

        parent = retain(native["open_volume"](drive))
        key = drive
        bind_directory(key, parent)
        for index, part in enumerate(root_parts):
            creating = op == "init" and index == len(root_parts) - 1
            parent = retain(native["open_child"](parent, part, True, create=creating))
            key += "/" + part
            bind_directory(key, parent, created=creating)
        root_handle, root_key = parent, key

        def open_file(ref, create=False):
            _, parts = components(ref)
            parent, key = root_handle, root_key
            for part in parts[:-1]:
                key += "/" + part
                creating = create and key not in state["directories"]
                parent = retain(native["open_child"](parent, part, True, create=creating))
                bind_directory(key, parent, created=creating)
            for existing in state["files"]:
                if existing.casefold() == ref.casefold() and existing != ref:
                    raise ValueError("CASE_ALIAS_REFUSED")
            handle = retain(native["open_child"](parent, parts[-1], False, create=create, write=create))
            identity = native["inspect"](handle)["identity"]
            if not create and state["files"].get(ref, {}).get("identity") != identity:
                raise ValueError("FILE_IDENTITY_CHANGED")
            return handle

        def write(ref, encoded):
            data = base64.b64decode(encoded, validate=True)
            if len(data) > MAX_BYTES:
                raise ValueError("ARTIFACT_TOO_LARGE")
            handle = open_file(ref, create=True)
            native["write_bytes"](handle, data)
            actual = native["read_bytes"](handle)
            if actual != data:
                raise ValueError("WRITE_READBACK_MISMATCH")
            descriptor = {"ref": ref, "sha256": digest(actual), "bytes": len(actual)}
            state["files"][ref] = {"identity": native["inspect"](handle)["identity"], **descriptor}
            return descriptor

        if op == "init":
            write(".capture-owned", request["marker"])
            result = write("bundle-owner.json", request["owner"])
            state["ownerSha256"] = result["sha256"]
        else:
            owner = native["read_bytes"](open_file("bundle-owner.json"))
            if digest(owner) != state["ownerSha256"]:
                raise ValueError("CURRENT_OWNER_CHANGED")
            if op == "write":
                result = write(request["ref"], request["bytes"])
            elif op == "read":
                data = native["read_bytes"](open_file(request["ref"]))
                expected = state["files"][request["ref"]]
                if digest(data) != expected["sha256"] or len(data) != expected["bytes"]:
                    raise ValueError("ARTIFACT_BYTES_CHANGED")
                result = {"bytes": base64.b64encode(data).decode("ascii"), "sha256": digest(data)}
            elif op == "list":
                files = []

                def visit(handle, key, prefix):
                    for name in native["list_names"](handle):
                        native["validate_name"](name)
                        ref = prefix + name
                        child_key = key + "/" + name
                        directory = child_key in state["directories"]
                        child = retain(native["open_child"](handle, name, directory))
                        observed = native["inspect"](child)["identity"]
                        if directory:
                            bind_directory(child_key, child)
                            visit(child, child_key, ref + "/")
                        else:
                            if state["files"].get(ref, {}).get("identity") != observed:
                                raise ValueError("UNOWNED_OR_REPLACED_FILE")
                            files.append(ref)

                visit(root_handle, root_key, "")
                if sorted(files) != sorted(state["files"]):
                    raise ValueError("TREE_ENTRY_SET_CHANGED")
                result = sorted(files)
            else:
                raise ValueError("UNKNOWN_OPERATION")
        return {"state": state, "result": result}


if __name__ == "__main__":
    try:
        wire = sys.stdin.buffer.read(48 * 1024 * 1024 + 1)
        if len(wire) > 48 * 1024 * 1024:
            raise ValueError("REQUEST_TOO_LARGE")
        result = execute(json.loads(wire))
        sys.stdout.write(json.dumps({"ok": True, **result}, separators=(",", ":")))
    except Exception as error:
        # Native errors expose codes only; never reflect file contents or requests.
        sys.stdout.write(json.dumps({"ok": False, "error": type(error).__name__, "code": getattr(error, "winerror", None)}))
        sys.exit(1)
