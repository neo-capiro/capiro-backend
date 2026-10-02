Reviewing the Windows native artifact storage implementation for security and correctness issues.

## Analysis

### windows-owned-artifacts.py

**1. Rejected share semantics**: `FILE_SHARE_READ` (1) is passed, but `open_volume` uses `CreateFileW` with share value `1` - only allowing concurrent read. For directories opened via `NtCreateFile`, `ShareAccess=1` is passed - again read-only. **APPROVED** - denies concurrent write/delete.

**2. Reparse point handling**: `inspect` uses `GetFileInformationByHandleEx` with `FileAttributeTagInfo` (9), checks `0x400` (`FILE_ATTRIBUTE_REPARSE_POINT`) and `tag != 0`. **APPROVED** - rejects reparse points.

**3. Hardlink check**: `inspect` checks `info.links != 1` for non-directories. **APPROVED** - rejects hardlinks.

**4. Single-component RootDirectory**: `Attributes.RootDirectory` is set to parent handle, `ObjectName` contains only the single final component. **APPROVED** - path resolution is handle-relative only.

**5. Delete-on-close tracking**: No explicit `FILE_DELETE_ON_CLOSE` passed. Handle is kept open until `__exit__`. **APPROVED** - keeps handle count preventing deletion.

**6. FILE_CREATE semantics**: `open_child` uses `Disposition=2` (`FILE_CREATE`) when `create=True`, `1` (`FILE_OPEN`) otherwise. **APPROVED** - no overwrite semantics.

**7. Open options flags**: Uses `0x20 | (1 if directory else 0x40)` - `FILE_SYNCHRONIZE_IO_ALERT | (FILE_DIRECTORY_FILE | FILE_NON_DIRECTORY_FILE)`. **APPROVED** - object kind enforcement.

**8. Identity composition**: Volume serial + FileIndexHigh + FileIndexLow + CreationTimeHigh + CreationTimeLow. **APPROVED** - correctly captures identity.

**9. Current owner/ID integrity**: `state["directories"]` tracks observed identity; `bind_directory` verifies against stored state. **APPROVED** - identity validation.

**10. Race conditions in read**: `read_bytes` snapshots `inspect(handle)` before/after read, verifies size and identity unchanged. **APPROVED** - detects concurrent modification.

**11. Write exclusivity**: `write_bytes` requires `size == 0` on entry, rejects writes to existing files. **APPROVED** - prevents append/overwrite.

**12. Junction attack parent swap**: `parent` handle is held (via ExitStack) during entire write operation. Any junction swap would affect a different path. **APPROVED** - handle-relative I/O prevents redirection.

**13. Abrupt helper**: `write_bytes` calls `FlushFileBuffers`. Partial file without manifest indicates failed run. **APPROVED** - poisoned state on interruption.

**14. Path validation**: `validate_name` rejects path separators, reserved names, trailing dots/spaces, length > 510 bytes UTF-16. **APPROVED** - component-level validation.

### windows-artifact-protocol.py

**15. Share boundary**: Uses `runpy.run_path()` to load native module, correctly scopes imports. **APPROVED** - isolated helper.

**16. No symlink/Junction traversal**: Relies entirely on handle-relative `open_child`. **APPROVED** - no path-based traversal fallback.

**17. Base64 handling**: Uses `validate=True`. **APPROVED** - strict base64 decoding.

**18. State fork safety**: Uses `json.loads(json.dumps(old))` for deep copy. **APPROVED** - prevents caller mutation.

**19. Owner binding on init**: `bind_directory` enforces identity on root even when not creating. **APPROVED** - root ownership established.

**20. Case alias detection**: `open_file` checks for casefold collision. **APPROVED** - prevents case-variant attacks.

**21. Directory identity binding**: `bind_directory` validates identity matches prior observation. **APPROVED** - detects directory replacement.

**22. Write verification**: `write` performs readback and compares. **APPROVED** - write integrity verified.

**23. Manifest atomicity**: `capture-manifest.json` written last; `finalize` is only completion signal. **APPROVED** - atomic completion.

### windows-artifact-storage.mjs

**24. Poisoning semantics**: Sets `failed = true` on any exception, rejects subsequent operations. **APPROVED** - fail-closed after errors.

**25. WeakSet branding**: Uses `instances` WeakSet for capability verification. **APPROVED** - object identity verification.

**26. Root canonicalization**: Uses `resolve(root)` but stored separately from state. **APPROVED** - path canonicalization.

**27. Hash verification**: Node-side verifies `sha256` and `bytes` match after native operations. **APPROVED** - double-verification.

**28. Response validation**: Checks `response.ok !== true` and `response.state?.root !== ownedRoot`. **APPROVED** - response integrity.

**29. spawnSync shell**: `shell: false`. **APPROVED** - no shell injection.

**30. Wire length**: Limits input to 48MiB, rejects oversized. **APPROVED** - bounded input.

### Native Race Tests (windows-native-races.py)

Thoroughly tests:
- Pinned root/ancestor rename blocking
- Junction swap blocking during creation
- Open handle blocking external rewrite/delete
- Preexisting write/delete handle preventing native open
- Second creator exclusion (no overwrite)
- Owner held during read blocks replacement
- Abrupt helper exit with uncommitted file

**APPROVED** - comprehensive race testing.

### Integration Tests (windows-artifact-storage.test.mjs)

Tests duplicate writes, same-byte replacement, parent replacement, owner change, hardlink alias, junction parent, external symlink, unsafe refs, case aliases, oversize rejection, unexpected entries.

**APPROVED** - edge case coverage.

## Narrow Limitations Documented

1. Native capability is **in-process only** - no durable cross-process reopening of capability
2. CLI/application acceptance **remains gated** - no default portable LIVE_ARTIFACT_PATH_UNSAFE
3. **Windows NTFS fixed local volume only** - network/removable drives rejected
4. Native I/O option **only** - verify-capture capture/auth/source flows blocked unchanged
5. Poisoned state **not automatically recoverable** - requires new storage instance

## PASS

No blocking issues identified. All security requirements are implemented and tested.
