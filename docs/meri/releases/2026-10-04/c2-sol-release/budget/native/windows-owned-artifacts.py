"""Windows NTFS handle-relative primitives; no path-based child I/O fallback."""
import ctypes as c
import re
import struct

MAX_BYTES = 32 * 1024 * 1024
K = c.WinDLL("kernel32", use_last_error=True)
N = c.WinDLL("ntdll")
ULONG, HANDLE, PTR = c.c_ulong, c.c_void_p, c.c_void_p

class Unicode(c.Structure):
    _fields_ = [("Length", c.c_ushort), ("MaximumLength", c.c_ushort), ("Buffer", PTR)]

class Attributes(c.Structure):
    _fields_ = [("Length", ULONG), ("RootDirectory", HANDLE), ("ObjectName", c.POINTER(Unicode)),
                ("Attributes", ULONG), ("SecurityDescriptor", PTR), ("SecurityQualityOfService", PTR)]

class IoStatus(c.Structure):
    _fields_ = [("Status", PTR), ("Information", c.c_size_t)]

class FileInfo(c.Structure):
    _fields_ = [("attributes", ULONG), ("createdLow", ULONG), ("createdHigh", ULONG),
                ("accessLow", ULONG), ("accessHigh", ULONG), ("writtenLow", ULONG), ("writtenHigh", ULONG),
                ("volume", ULONG), ("sizeHigh", ULONG), ("sizeLow", ULONG), ("links", ULONG),
                ("indexHigh", ULONG), ("indexLow", ULONG)]

class TagInfo(c.Structure):
    _fields_ = [("attributes", ULONG), ("tag", ULONG)]

def signature(dll, name, result, args):
    function = getattr(dll, name)
    function.restype, function.argtypes = result, args
    return function

Create = signature(K, "CreateFileW", HANDLE, [c.c_wchar_p, ULONG, ULONG, PTR, ULONG, ULONG, HANDLE])
Close = signature(K, "CloseHandle", c.c_int, [HANDLE])
Info = signature(K, "GetFileInformationByHandle", c.c_int, [HANDLE, c.POINTER(FileInfo)])
Tag = signature(K, "GetFileInformationByHandleEx", c.c_int, [HANDLE, c.c_int, PTR, ULONG])
Read = signature(K, "ReadFile", c.c_int, [HANDLE, PTR, ULONG, c.POINTER(ULONG), PTR])
Write = signature(K, "WriteFile", c.c_int, [HANDLE, PTR, ULONG, c.POINTER(ULONG), PTR])
Seek = signature(K, "SetFilePointerEx", c.c_int, [HANDLE, c.c_longlong, PTR, ULONG])
Flush = signature(K, "FlushFileBuffers", c.c_int, [HANDLE])
DriveType = signature(K, "GetDriveTypeW", ULONG, [c.c_wchar_p])
Volume = signature(K, "GetVolumeInformationW", c.c_int,
                   [c.c_wchar_p, c.c_wchar_p, ULONG, PTR, PTR, PTR, c.c_wchar_p, ULONG])
NtCreate = signature(N, "NtCreateFile", c.c_long,
                     [c.POINTER(HANDLE), ULONG, c.POINTER(Attributes), c.POINTER(IoStatus),
                      PTR, ULONG, ULONG, ULONG, ULONG, PTR, ULONG])
NtList = signature(N, "NtQueryDirectoryFile", c.c_long,
                   [HANDLE, HANDLE, PTR, PTR, c.POINTER(IoStatus), PTR, ULONG, ULONG,
                    c.c_ubyte, c.POINTER(Unicode), c.c_ubyte])
NtError = signature(N, "RtlNtStatusToDosError", ULONG, [c.c_long])

def checked(result):
    if not result:
        raise c.WinError(c.get_last_error())
    return result

def nt_checked(status):
    if status < 0:
        raise c.WinError(NtError(status))

class Handle:
    def __init__(self, value):
        self.value = value
    def __enter__(self):
        return self
    def __exit__(self, *ignored):
        self.close()
    def close(self):
        if self.value is not None:
            Close(self.value)
            self.value = None

def validate_name(name):
    if (not isinstance(name, str) or not name or name in (".", "..") or
        re.search(r'[/\\:<>"|?*\x00-\x1f]', name) or name[-1] in ". " or
        re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\..*)?", name, re.I) or
        len(name.encode("utf-16-le")) > 510):
        raise ValueError("INVALID_COMPONENT")

def inspect(handle):
    tag = TagInfo()
    checked(Tag(handle.value, 9, c.byref(tag), c.sizeof(tag)))
    if tag.attributes & 0x400 or tag.tag:
        raise ValueError("REPARSE_REFUSED")
    info = FileInfo()
    checked(Info(handle.value, c.byref(info)))
    directory = bool(info.attributes & 0x10)
    if not directory and info.links != 1:
        raise ValueError("HARDLINK_REFUSED")
    return {"identity": f"{info.volume:x}:{info.indexHigh:x}:{info.indexLow:x}:{info.createdHigh:x}:{info.createdLow:x}",
            "directory": directory, "size": (info.sizeHigh << 32) | info.sizeLow, "links": info.links}

def checked_handle(raw, directory):
    handle = Handle(raw)
    try:
        if inspect(handle)["directory"] != directory:
            raise ValueError("WRONG_OBJECT_KIND")
        return handle
    except BaseException:
        handle.close()
        raise

def open_volume(drive):
    if not re.fullmatch(r"[A-Z]:", drive):
        raise ValueError("LOCAL_DRIVE_REQUIRED")
    root = drive + "\\"
    filesystem = c.create_unicode_buffer(32)
    if DriveType(root) != 3:
        raise ValueError("FIXED_LOCAL_DRIVE_REQUIRED")
    checked(Volume(root, None, 0, None, None, None, filesystem, 32))
    if filesystem.value != "NTFS":
        raise ValueError("NTFS_REQUIRED")
    raw = Create(root, 0x80000000 | 0x100000, 1, None, 3, 0x02000000 | 0x00200000, None)
    if raw == HANDLE(-1).value:
        raise c.WinError(c.get_last_error())
    return checked_handle(raw, True)

def open_child(parent, name, directory, create=False, write=False):
    validate_name(name)
    # Keep the UTF-16 backing storage alive through NtCreateFile.
    encoded = name.encode("utf-16-le")
    buffer = c.create_string_buffer(encoded + b"\0\0")
    unicode = Unicode(len(encoded), len(encoded) + 2, c.cast(buffer, PTR))
    attributes = Attributes(c.sizeof(Attributes), parent.value, c.pointer(unicode), 0x40, None, None)
    status, raw = IoStatus(), HANDLE()
    access = 0x80000000 | 0x100000 | (0x40000000 if write else 0)
    options = 0x00200000 | 0x20 | (1 if directory else 0x40)
    nt_checked(NtCreate(c.byref(raw), access, c.byref(attributes), c.byref(status),
                        None, 0, 1, 2 if create else 1, options, None, 0))
    return checked_handle(raw.value, directory)

def read_bytes(handle):
    before = inspect(handle)
    if before["directory"] or before["size"] > MAX_BYTES:
        raise ValueError("FILE_SIZE_OR_KIND_REFUSED")
    checked(Seek(handle.value, 0, None, 0))
    chunks, total = [], 0
    while True:
        buffer, count = c.create_string_buffer(65536), ULONG()
        checked(Read(handle.value, buffer, len(buffer), c.byref(count), None))
        if not count.value:
            break
        total += count.value
        if total > MAX_BYTES:
            raise ValueError("ARTIFACT_TOO_LARGE")
        chunks.append(buffer.raw[:count.value])
    if inspect(handle) != before or total != before["size"]:
        raise ValueError("FILE_CHANGED_DURING_READ")
    return b"".join(chunks)

def write_bytes(handle, data):
    if len(data) > MAX_BYTES or inspect(handle)["size"] != 0:
        raise ValueError("NEW_BOUNDED_FILE_REQUIRED")
    checked(Seek(handle.value, 0, None, 0))
    offset = 0
    while offset < len(data):
        piece, count = data[offset:offset + 65536], ULONG()
        buffer = c.create_string_buffer(piece)
        checked(Write(handle.value, buffer, len(piece), c.byref(count), None))
        if count.value == 0:
            raise ValueError("SHORT_WRITE")
        offset += count.value
    checked(Flush(handle.value))

def list_names(handle):
    if not inspect(handle)["directory"]:
        raise ValueError("DIRECTORY_REQUIRED")
    names, restart = [], True
    while True:
        buffer, status = c.create_string_buffer(65536), IoStatus()
        code = NtList(handle.value, None, None, None, c.byref(status), buffer, len(buffer), 12, 0, None, restart)
        if (code & 0xffffffff) == 0x80000006:  # STATUS_NO_MORE_FILES
            break
        nt_checked(code)
        restart = False
        data, offset = buffer.raw[:status.Information], 0
        if not data:
            raise ValueError("INVALID_DIRECTORY_RESULT")
        while True:
            if offset + 12 > len(data):
                raise ValueError("INVALID_DIRECTORY_RESULT")
            next_offset, _, length = struct.unpack_from("<III", data, offset)
            if length % 2 or offset + 12 + length > len(data):
                raise ValueError("INVALID_DIRECTORY_RESULT")
            name = data[offset + 12:offset + 12 + length].decode("utf-16-le")
            if name not in (".", ".."):
                validate_name(name)
                names.append(name)
            if len(names) > 10000:
                raise ValueError("DIRECTORY_ENTRY_LIMIT")
            if not next_offset:
                break
            if next_offset < 12 or offset + next_offset >= len(data):
                raise ValueError("INVALID_DIRECTORY_RESULT")
            offset += next_offset
    if len(set(name.casefold() for name in names)) != len(names):
        raise ValueError("CASE_COLLISION")
    return sorted(names)
