"use strict";

// src/helpers/resolve-security-md.ts
var import_node_fs2 = require("node:fs");
var import_node_os = require("node:os");
var import_node_path2 = require("node:path");
var import_node_util = require("node:util");

// src/native.ts
var import_node_module = require("node:module");

// ../native/platform.mts
var libc = process.platform !== "linux" ? void 0 : process.report.getReport().header.glibcVersionRuntime === void 0 ? "musl" : "gnu";
var nativeTarget = `${process.platform}-${process.arch}${libc === void 0 ? "" : `-${libc}`}`;

// src/native.ts
function unixBinding() {
  return (0, import_node_module.createRequire)(__filename)(
    `./native/${nativeTarget}/unix.node`
  );
}
function windowsBinding() {
  return (0, import_node_module.createRequire)(__filename)(
    `./native/${nativeTarget}/windows.node`
  );
}

// ../native/windows-files.mts
var import_node_path = require("node:path");

// ../native/windows-flags.mts
var windowsFlags = {
  DELETE: 65536,
  FILE_READ_ATTRIBUTES: 128,
  GENERIC_READ: 2147483648,
  GENERIC_WRITE: 1073741824,
  FILE_SHARE_READ: 1,
  FILE_SHARE_WRITE: 2,
  FILE_SHARE_DELETE: 4,
  CREATE_NEW: 1,
  CREATE_ALWAYS: 2,
  OPEN_EXISTING: 3,
  OPEN_ALWAYS: 4,
  FILE_ATTRIBUTE_DIRECTORY: 16,
  FILE_ATTRIBUTE_NORMAL: 128,
  FILE_ATTRIBUTE_REPARSE_POINT: 1024,
  FILE_FLAG_BACKUP_SEMANTICS: 33554432,
  FILE_FLAG_OPEN_REPARSE_POINT: 2097152,
  FILE_FLAG_OVERLAPPED: 1073741824,
  FILE_NAME_OPENED: 8,
  FILE_BEGIN: 0,
  FILE_CURRENT: 1,
  FILE_END: 2
};

// ../native/windows-files.mts
var widePath = (path) => Buffer.from(path, "utf16le");
var pathText = (path) => path.toString("utf16le");
function windowsFileSystem(native) {
  function check(error, path) {
    if (error === 0) return;
    const code = (/* @__PURE__ */ new Map([
      [2, "ENOENT"],
      [3, "ENOENT"],
      [267, "ENOTDIR"],
      [1921, "ELOOP"]
    ])).get(error);
    throw Object.assign(
      new Error(`Windows filesystem error ${error}: ${pathText(path)}`),
      { code, winerror: error }
    );
  }
  function absolute(path) {
    const result = native.windowsAbsolutePath(path);
    check(result.error, path);
    return result.value;
  }
  function operationPath(path) {
    const resolved = absolute(path);
    const text = pathText(resolved);
    if (text.startsWith("\\\\?\\") || text.startsWith("\\\\.\\"))
      return resolved;
    return widePath(
      text.startsWith("\\\\") ? `\\\\?\\UNC\\${text.slice(2)}` : `\\\\?\\${text}`
    );
  }
  function open(path, access = 0, disposition = windowsFlags.OPEN_EXISTING, follow = true) {
    const result = native.openWindowsFile(
      operationPath(path),
      access,
      windowsFlags.FILE_SHARE_READ | windowsFlags.FILE_SHARE_WRITE | windowsFlags.FILE_SHARE_DELETE,
      disposition,
      windowsFlags.FILE_FLAG_BACKUP_SEMANTICS | (follow ? 0 : windowsFlags.FILE_FLAG_OPEN_REPARSE_POINT)
    );
    check(result.error, path);
    return result.handle;
  }
  function finalPath(path) {
    const handle = open(path);
    try {
      const result = handle.finalPath(0);
      check(result.error, path);
      return result.path;
    } finally {
      check(handle.close(), path);
    }
  }
  function realpath(path) {
    let normalizedText;
    if (pathText(path).startsWith("\\\\?\\")) {
      const text2 = pathText(path).replaceAll("/", "\\");
      const root = /^\\\\\?\\(?:UNC\\[^\\]+\\[^\\]+(?:\\|$)|[^\\]+\\)/iu.exec(text2)?.[0] ?? import_node_path.win32.parse(text2).root;
      normalizedText = root + import_node_path.win32.join("\\", text2.slice(root.length)).slice(1).replace(/\\+$/u, "");
    } else {
      const text2 = pathText(absolute(path));
      const root = import_node_path.win32.parse(text2).root;
      normalizedText = root + text2.slice(root.length).replace(/\\+$/u, "");
    }
    const normalized = widePath(normalizedText);
    const resolved = finalPath(normalized);
    if (pathText(normalized).startsWith("\\\\?\\")) return resolved;
    const text = pathText(resolved);
    const shortened = text.startsWith("\\\\?\\UNC\\") ? `\\\\${text.slice(8)}` : text.startsWith("\\\\?\\") ? text.slice(4) : text;
    const candidate = widePath(shortened);
    try {
      if (finalPath(candidate).equals(resolved)) return candidate;
    } catch {
    }
    return resolved;
  }
  function stat(path, follow = true) {
    const handle = open(
      path,
      windowsFlags.FILE_READ_ATTRIBUTES,
      windowsFlags.OPEN_EXISTING,
      follow
    );
    try {
      const info = handle.attributes();
      check(info.error, path);
      const type = handle.fileType();
      check(type.error, path);
      const link = !follow && info.reparseTag === 2684354572;
      const directory = (info.attributes & windowsFlags.FILE_ATTRIBUTE_DIRECTORY) !== 0;
      return {
        isDirectory: () => !link && directory,
        isFile: () => !link && !directory && type.value === 1,
        isSymbolicLink: () => link,
        isReparsePoint: () => (info.attributes & windowsFlags.FILE_ATTRIBUTE_REPARSE_POINT) !== 0
      };
    } finally {
      check(handle.close(), path);
    }
  }
  function identity(path) {
    const handle = open(path, windowsFlags.FILE_READ_ATTRIBUTES);
    try {
      const result = handle.identity();
      check(result.error, path);
      return { volume: result.volume, fileId: result.fileId };
    } finally {
      check(handle.close(), path);
    }
  }
  function entriesWithTypes(path) {
    const result = native.windowsDirectoryEntries(operationPath(path));
    check(result.error, path);
    return result.value.map(({ name, isDirectory, isSymbolicLink }) => ({
      name,
      isDirectory: () => isDirectory,
      isSymbolicLink: () => isSymbolicLink
    }));
  }
  function mkdir(path) {
    check(native.createWindowsDirectories(operationPath(path)), path);
  }
  function readInto(path, buffer) {
    const handle = open(path, windowsFlags.GENERIC_READ);
    let length = 0;
    try {
      while (length < buffer.length) {
        const result = handle.read(
          buffer,
          length,
          Math.min(buffer.length - length, 4294967295)
        );
        check(result.error, path);
        if (result.value === 0) break;
        length += result.value;
      }
    } finally {
      check(handle.close(), path);
    }
    return length;
  }
  function writeFile(path, buffer) {
    const handle = open(path, windowsFlags.GENERIC_WRITE, windowsFlags.CREATE_ALWAYS);
    let offset = 0;
    try {
      while (offset < buffer.length) {
        const result = handle.write(
          buffer,
          offset,
          Math.min(buffer.length - offset, 4294967295)
        );
        check(result.error, path);
        if (result.value === 0)
          throw new Error(
            `Windows file write made no progress: ${pathText(path)}`
          );
        offset += result.value;
      }
    } finally {
      check(handle.close(), path);
    }
  }
  return {
    absolute,
    realpath,
    stat,
    identity,
    entriesWithTypes,
    mkdir,
    readInto,
    writeFile
  };
}

// src/helpers/posix-path.ts
var import_node_fs = require("node:fs");
var utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decodePosixBytes(bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    let value = "";
    for (let offset = 0; offset < bytes.length; ) {
      let decoded = false;
      for (let size = 1; size <= 4 && offset + size <= bytes.length; size++) {
        try {
          value += utf8.decode(bytes.subarray(offset, offset + size));
          offset += size;
          decoded = true;
          break;
        } catch {
        }
      }
      if (!decoded) value += String.fromCharCode(56320 + bytes[offset++]);
    }
    return value;
  }
}
function encodePosixPath(value) {
  return Buffer.concat(
    value.split(/([\udc80-\udcff])/u).map(
      (part) => /^[\udc80-\udcff]$/u.test(part) ? Buffer.from([part.charCodeAt(0) - 56320]) : Buffer.from(part)
    )
  );
}
var SymlinkLoopError = class extends Error {
};
function resolvePosixPath(value) {
  const seen = /* @__PURE__ */ new Map();
  function follow(directory, path) {
    if (path.startsWith("/")) directory = "/";
    for (const name of path.split("/")) {
      if (name === "" || name === ".") continue;
      if (name === "..") {
        directory = directory.slice(0, directory.lastIndexOf("/")) || "/";
        continue;
      }
      const candidate = `${directory === "/" ? "" : directory}/${name}`;
      const bytes = Buffer.from(candidate, "latin1");
      if (!(0, import_node_fs.lstatSync)(bytes).isSymbolicLink()) {
        directory = candidate;
        continue;
      }
      const cached = seen.get(candidate);
      if (cached === null) {
        throw new SymlinkLoopError(
          `Symlink loop from ${decodePosixBytes(bytes)}`
        );
      }
      if (cached !== void 0) {
        directory = cached;
        continue;
      }
      seen.set(candidate, null);
      directory = follow(
        directory,
        (0, import_node_fs.readlinkSync)(bytes, { encoding: "buffer" }).toString("latin1")
      );
      seen.set(candidate, directory);
    }
    return directory;
  }
  const cwd = value[0] === 47 ? Buffer.from("/") : import_node_fs.realpathSync.native(".", { encoding: "buffer" });
  return Buffer.from(
    follow(cwd.toString("latin1"), value.toString("latin1")),
    "latin1"
  );
}

// src/helpers/resolve-security-md.ts
var MAX_SECURITY_MD_BYTES = 1024 * 1024;
var utf82 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
var HomeExpansionError = class extends Error {
};
var windows = process.platform === "win32";
var windowsFiles = () => windowsFileSystem(windowsBinding());
var encodePath = (path) => windows ? Buffer.from(path, "utf16le") : encodePosixPath(path);
var decodePath = (path) => windows ? path.toString("utf16le") : decodePosixBytes(path);
var statPath = (path) => windows ? windowsFiles().stat(path) : (0, import_node_fs2.statSync)(path);
function windowsParts(value) {
  const path = value.replaceAll("/", "\\");
  if (path.startsWith("\\\\")) {
    const start = path.slice(0, 8).toUpperCase() === "\\\\?\\UNC\\" ? 8 : 2;
    const server = path.indexOf("\\", start);
    const share = server === -1 ? -1 : path.indexOf("\\", server + 1);
    return share === -1 ? [value, "", ""] : [value.slice(0, share), value[share], value.slice(share + 1)];
  }
  const drive = path[1] === ":" ? 2 : 0;
  const root = path[drive] === "\\" ? 1 : 0;
  return [
    value.slice(0, drive),
    value.slice(drive, drive + root),
    value.slice(drive + root)
  ];
}
function windowsJoin(left, right) {
  const [leftDrive, leftRoot, leftPath] = windowsParts(left);
  const [rightDrive, rightRoot, rightPath] = windowsParts(right);
  if (rightRoot) return (rightDrive || leftDrive) + rightRoot + rightPath;
  if (rightDrive && rightDrive.toLowerCase() !== leftDrive.toLowerCase())
    return right;
  const drive = rightDrive || leftDrive;
  const path = leftPath + (leftPath && !/[/\\]$/u.test(leftPath) ? "\\" : "") + rightPath;
  const root = leftRoot || (path && drive && !/[:/\\]$/u.test(drive) ? "\\" : "");
  return drive + root + path;
}
function parsedPath(value) {
  let root = windows ? windowsParts(value).slice(0, 2).join("").replaceAll("/", "\\") : value.startsWith("//") && !value.startsWith("///") ? "//" : (0, import_node_path2.parse)(value).root;
  if (windows && root.startsWith("\\\\") && !root.endsWith("\\")) {
    const parts2 = root.split("\\");
    if (parts2.length === 4 && !"?.".includes(parts2[2]) || parts2.length === 6)
      root += "\\";
  }
  const parts = value.slice(root.length).split(process.platform === "win32" ? /[/\\]/u : /\//u).filter((part) => part !== "" && part !== ".");
  if (windows && !root && windowsParts(parts[0] ?? "")[0]) parts.unshift(".");
  return root + parts.join(import_node_path2.sep) || ".";
}
function resolvedPath(path) {
  if (process.platform !== "win32") return resolvePosixPath(path);
  try {
    return windowsFiles().realpath(path);
  } catch (error) {
    if (error.code === "ELOOP")
      throw new SymlinkLoopError(`Symlink loop from ${decodePath(path)}`);
    throw error;
  }
}
function expandHome(path, posixHome2) {
  if (!path.startsWith("~")) return path;
  if (process.platform === "win32") {
    const environment = (name) => windowsBinding().windowsEnvironment(Buffer.from(name, "utf16le"))?.toString("utf16le");
    const separator2 = path.search(/[/\\]/u);
    const end2 = separator2 === -1 ? path.length : separator2;
    const username = path.slice(1, end2);
    const currentUsername = environment("USERNAME");
    let home2 = environment("USERPROFILE");
    const homePath = environment("HOMEPATH");
    if (home2 === void 0 && homePath !== void 0) {
      home2 = windowsJoin(environment("HOMEDRIVE") ?? "", homePath);
    }
    if (home2 === void 0)
      throw new HomeExpansionError("Could not determine home directory.");
    if (username !== "" && username !== currentUsername) {
      const [drive, root, tail] = windowsParts(home2);
      const separator3 = Math.max(tail.lastIndexOf("/"), tail.lastIndexOf("\\"));
      if (currentUsername !== tail.slice(separator3 + 1)) {
        throw new HomeExpansionError("Could not determine home directory.");
      }
      const parent = drive + root + tail.slice(0, separator3 + 1).replace(/[/\\]+$/u, "");
      home2 = windowsJoin(parent, username);
    }
    if (home2.startsWith("~"))
      throw new HomeExpansionError("Could not determine home directory.");
    return windowsJoin(home2, separator2 === -1 ? "" : path.slice(end2 + 1));
  }
  if (path === "~" || path.startsWith("~/")) {
    const home2 = posixHome2 ?? (0, import_node_os.homedir)();
    if (home2.startsWith("~"))
      throw new HomeExpansionError("Could not determine home directory.");
    return home2 + path.slice(1) || "/";
  }
  const separator = path.indexOf("/");
  const end = separator === -1 ? path.length : separator;
  const result = unixBinding().userHome(encodePosixPath(path.slice(1, end)));
  if (result.value === null)
    throw new HomeExpansionError("Could not determine home directory.");
  const home = decodePosixBytes(result.value).replace(/\/+$/u, "");
  if (home.startsWith("~"))
    throw new HomeExpansionError("Could not determine home directory.");
  return home + path.slice(end) || "/";
}
function appendPath(directory, name) {
  const separator = encodePath(import_node_path2.sep);
  return Buffer.concat(
    directory.subarray(-separator.length).equals(separator) ? [directory, name] : [directory, separator, name]
  );
}
function parentDirectory(path) {
  if (process.platform === "win32")
    return encodePath((0, import_node_path2.dirname)(decodePath(path)));
  const separator = path.lastIndexOf(47);
  return separator === -1 ? Buffer.from(".") : path.subarray(0, Math.max(1, separator));
}
function windowsRelativePath(path, root) {
  const files = windowsFiles();
  const rootIdentity = files.identity(root);
  const parts = [];
  let current = path;
  while (true) {
    const identity = files.identity(current);
    if (identity.volume === rootIdentity.volume && identity.fileId.equals(rootIdentity.fileId))
      return encodePath(parts.reverse().join("\\"));
    const parent = parentDirectory(current);
    if (parent.equals(current)) return void 0;
    parts.push((0, import_node_path2.basename)(decodePath(current)));
    current = parent;
  }
}
function inside(path, root, label) {
  if (process.platform === "win32") {
    const result = windowsRelativePath(path, root);
    if (result !== void 0) return result;
  } else {
    if (path.equals(root)) return Buffer.alloc(0);
    const prefix = appendPath(root, Buffer.alloc(0));
    if (path.subarray(0, prefix.length).equals(prefix)) {
      return path.subarray(prefix.length);
    }
  }
  throw new Error(`${label} is outside the scan root: ${decodePath(path)}`);
}
function resolveRoot(repo, posixHome2) {
  let root;
  try {
    root = resolvedPath(encodePath(parsedPath(expandHome(repo, posixHome2))));
  } catch (error) {
    if (error instanceof SymlinkLoopError || error instanceof HomeExpansionError)
      throw error;
    throw new Error(`scan root does not exist: ${repo}`);
  }
  if (!statPath(root).isDirectory()) {
    throw new Error(`scan root is not a directory: ${decodePath(root)}`);
  }
  return root;
}
function fileStat(path) {
  try {
    return statPath(path);
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(
      error.code ?? ""
    ) || windows && [21, 123].includes(error.winerror ?? 0)) {
      return void 0;
    }
    throw error;
  }
}
function asciiJson(value) {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}
function comparePaths(left, right) {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex);
    const rightPoint = right.codePointAt(rightIndex);
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
    leftIndex += leftPoint > 65535 ? 2 : 1;
    rightIndex += rightPoint > 65535 ? 2 : 1;
  }
  return left.length - right.length;
}
function listSecurityMd(repo, posixHome2) {
  const root = resolveRoot(repo, posixHome2);
  const policies = [];
  function walk(directory, prefix) {
    const entries = (windows ? windowsFiles().entriesWithTypes(directory) : (0, import_node_fs2.readdirSync)(directory, { encoding: "buffer", withFileTypes: true })).map((entry) => ({
      bytes: entry.name,
      name: decodePath(entry.name),
      entry
    }));
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const { bytes, name, entry: listedEntry } of entries) {
      if (name === ".git") continue;
      const path = appendPath(directory, bytes);
      const source = prefix === "" ? name : `${prefix}/${name}`;
      const listedDirectory = listedEntry.isDirectory() && !listedEntry.isSymbolicLink();
      if (!listedDirectory && name !== "SECURITY.md") continue;
      let entry;
      try {
        entry = windows ? windowsFiles().stat(path, false) : (0, import_node_fs2.lstatSync)(path, { throwIfNoEntry: listedDirectory });
      } catch (error) {
        if (listedDirectory || !["ENOENT", "ENOTDIR"].includes(
          error.code ?? ""
        ))
          throw error;
      }
      if (entry === void 0) continue;
      if (listedDirectory && !entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (!entry.isReparsePoint?.()) walk(path, source);
      } else if (name === "SECURITY.md" && (entry.isFile() || entry.isSymbolicLink())) {
        if (entry.isSymbolicLink() && fileStat(path)?.isDirectory()) continue;
        policies.push(source);
      }
    }
  }
  walk(root, "");
  return policies.sort(comparePaths);
}
function readPolicy(path, displayedPath) {
  const buffer = Buffer.alloc(MAX_SECURITY_MD_BYTES + 1);
  let length = 0;
  if (windows) {
    length = windowsFiles().readInto(path, buffer);
  } else {
    const file = (0, import_node_fs2.openSync)(path, "r");
    try {
      while (length < buffer.length) {
        const count = (0, import_node_fs2.readSync)(
          file,
          buffer,
          length,
          buffer.length - length,
          null
        );
        if (count === 0) break;
        length += count;
      }
    } finally {
      (0, import_node_fs2.closeSync)(file);
    }
  }
  if (length > MAX_SECURITY_MD_BYTES) {
    throw new Error(`SECURITY.md exceeds 1 MiB: ${decodePath(displayedPath)}`);
  }
  try {
    return utf82.decode(buffer.subarray(0, length));
  } catch {
    throw new Error(
      `SECURITY.md is not valid UTF-8: ${decodePath(displayedPath)}`
    );
  }
}
function resolveSecurityMd(repo, scope, posixHome2) {
  const root = resolveRoot(repo, posixHome2);
  const expandedScope = parsedPath(expandHome(scope, posixHome2));
  const requestedScope = process.platform === "win32" ? windowsFiles().absolute(
    encodePath(windowsJoin(decodePath(root), expandedScope))
  ) : expandedScope.startsWith("/") ? encodePosixPath(expandedScope) : appendPath(root, encodePosixPath(expandedScope));
  let resolvedScope;
  try {
    resolvedScope = resolvedPath(requestedScope);
  } catch (error) {
    if (error instanceof SymlinkLoopError) throw error;
    throw new Error(`scan scope does not exist: ${decodePath(requestedScope)}`);
  }
  inside(resolvedScope, root, "scan scope");
  const targetDirectory = statPath(resolvedScope).isDirectory() ? resolvedScope : parentDirectory(resolvedScope);
  const directories = [targetDirectory];
  let current = targetDirectory;
  while (inside(current, root, "scan scope").length !== 0) {
    current = parentDirectory(current);
    directories.unshift(current);
  }
  const sections = [];
  for (const directory of directories) {
    const policy = appendPath(directory, encodePath("SECURITY.md"));
    if (!fileStat(policy)?.isFile()) continue;
    const resolvedPolicy = resolvedPath(policy);
    inside(resolvedPolicy, root, "SECURITY.md");
    const content = readPolicy(resolvedPolicy, policy);
    if (/^[\p{White_Space}\u001c-\u001f]*$/u.test(content)) continue;
    const source = decodePath(inside(policy, root, "SECURITY.md")).split(import_node_path2.sep).join("/");
    let section = `## SECURITY.md source: ${asciiJson(source)}

${content}`;
    if (!section.endsWith("\n")) section += "\n";
    sections.push(section);
  }
  return sections.join("\n");
}
function resolveSecurityMdCommand(args2, posixHome2 = process.env.HOME) {
  try {
    const options = {
      repo: { type: "string" },
      list: { type: "boolean" },
      scope: { type: "string" },
      out: { type: "string", default: "-" },
      help: { type: "boolean", short: "h" }
    };
    const names = Object.keys(options);
    let parsedArgs = [];
    for (let index = 0; index < args2.length; index++) {
      let arg = args2[index];
      if (arg === "--") throw new Error("Unexpected argument '--'");
      if (arg.startsWith("-h")) {
        if (/^-h+-/u.test(arg)) throw new Error(`Unexpected argument '${arg}'`);
        if (/^-h+=/u.test(arg)) (0, import_node_util.parseArgs)({ args: [arg], options });
        arg = "--help";
      }
      if (arg.startsWith("--") && arg !== "--") {
        const equals = arg.indexOf("=");
        const name = arg.slice(2, equals === -1 ? void 0 : equals);
        const matches = names.filter((option2) => option2.startsWith(name));
        const option = matches.length === 1 ? matches[0] : void 0;
        if (option !== void 0) {
          arg = `--${option}${equals === -1 ? "" : arg.slice(equals)}`;
          const next = args2[index + 1];
          if (equals === -1 && options[option].type === "string" && next !== void 0) {
            const prefix = next.split("=", 1)[0];
            const optional = next.startsWith("-h") || names.some((name2) => `--${name2}`.startsWith(prefix));
            if (!next.startsWith("-") || next === "-" || !optional && (next.includes(" ") || new RegExp("^-(?:\\p{Decimal_Number}+|\\p{Decimal_Number}*\\.\\p{Decimal_Number}+)\\n?$", "u").test(
              next
            ))) {
              arg += `=${next}`;
              index++;
            }
          }
        }
        if (matches.length) (0, import_node_util.parseArgs)({ args: [arg], options });
      }
      parsedArgs.push(arg);
      if (arg === "--help") {
        parsedArgs = [arg];
        break;
      }
    }
    const { values } = (0, import_node_util.parseArgs)({
      args: parsedArgs,
      options
    });
    if (values.help) {
      console.log(
        "Concatenate the SECURITY.md files that apply to a scan path.\n\nUsage: launch_codex_security_mcp[.cmd] --helper resolve-security-md --repo PATH [--list | --scope PATH] [--out PATH]\n\n--out PATH  output path, or - for stdout (default: -)"
      );
      return 0;
    }
    if (values.repo === void 0) throw new Error("--repo is required");
    if (values.list && values.scope !== void 0) {
      throw new Error("--list cannot be combined with --scope");
    }
    if (!values.list && values.scope === void 0) {
      throw new Error("--scope is required unless --list is specified");
    }
    const repo = parsedPath(values.repo);
    const guidance = values.list ? `[${listSecurityMd(repo, posixHome2).map(asciiJson).join(", ")}]
` : resolveSecurityMd(repo, parsedPath(values.scope), posixHome2);
    const outputPath = parsedPath(values.out);
    if (outputPath === "-") {
      process.stdout.write(Buffer.from(guidance, "utf8"));
    } else {
      const output = encodePath(outputPath);
      if (windows) {
        windowsFiles().mkdir(parentDirectory(output));
        windowsFiles().writeFile(
          output,
          Buffer.from(guidance.replace(/\n/g, "\r\n"))
        );
      } else {
        (0, import_node_fs2.mkdirSync)(parentDirectory(output), { recursive: true });
        (0, import_node_fs2.writeFileSync)(output, guidance, "utf8");
      }
    }
  } catch (error) {
    console.error(`resolve-security-md: error: ${error.message}`);
    return error instanceof SymlinkLoopError || error instanceof HomeExpansionError ? 1 : 2;
  }
  return 0;
}

// helpers-main.ts
var commandLine = process.argv.slice(2);
if (process.platform === "win32") {
  const original = windowsBinding().windowsArguments();
  commandLine = original.slice(original.length - commandLine.length).map((argument) => argument.toString("utf16le"));
}
var posixHome = process.env.HOME;
if (commandLine[0] === "--helper") {
  if (process.platform === "win32") {
    commandLine = commandLine.slice(1);
  } else {
    const [homeSet, home, ...args2] = decodePosixBytes(
      Buffer.from(commandLine[1] ?? "", "hex")
    ).split("\0").slice(0, -1);
    posixHome = homeSet ? home : void 0;
    commandLine = args2;
  }
}
var [command, ...args] = commandLine;
if (command === "resolve-security-md") {
  process.exitCode = resolveSecurityMdCommand(args, posixHome);
} else {
  console.error(
    "Usage: launch_codex_security_mcp[.cmd] --helper resolve-security-md [options]"
  );
  process.exitCode = 2;
}
