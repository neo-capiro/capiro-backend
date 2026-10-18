import { NotFoundException } from '@nestjs/common';

/** Exact tool names a deployment may execute through `POST /api/clio/tools/:name`.
 * Unset keeps today's behavior (every registered tool). The preview Core task
 * sets it from infra/cdk/lib/preview/first-chat-core-meri-tools.json, the same
 * list the preview listener enumerates, so an unlisted (including write) tool
 * is refused here even if it reached the task another way. Config validation
 * rejects a malformed list at startup. */
export const MERI_TOOL_ALLOWLIST_PATTERN = /^[a-z][a-z0-9_]{1,63}(,[a-z][a-z0-9_]{1,63})*$/;

export function parseMeriToolAllowlist(raw: string | undefined): ReadonlySet<string> | null {
  if (raw === undefined || raw === '') return null;
  if (!MERI_TOOL_ALLOWLIST_PATTERN.test(raw)) throw new Error('MERI_TOOL_ALLOWLIST is malformed');
  const names = raw.split(',');
  if (new Set(names).size !== names.length) throw new Error('MERI_TOOL_ALLOWLIST has duplicates');
  return new Set(names);
}

let cached: { raw: string | undefined; allowlist: ReadonlySet<string> | null } | null = null;

function currentAllowlist(): ReadonlySet<string> | null {
  const raw = process.env.MERI_TOOL_ALLOWLIST;
  if (!cached || cached.raw !== raw) cached = { raw, allowlist: parseMeriToolAllowlist(raw) };
  return cached.allowlist;
}

/** Same 404 as an unregistered tool, so the list itself is not disclosed. */
export function assertMeriToolAllowed(name: string, allowlist: ReadonlySet<string> | null = currentAllowlist()): void {
  if (allowlist && !allowlist.has(name)) throw new NotFoundException('Meri tool not found');
}
