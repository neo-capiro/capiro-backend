import type { Request } from 'express';

/** Express removes the mount prefix from req.path while middleware runs. */
export function mountedRequestPath(req: Request): string {
  return (req.baseUrl ?? '') + (req.baseUrl && req.path === '/' ? '' : req.path);
}
