import type { Request, Response, NextFunction } from 'express';

const CLIENT_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const READ_PATH = new RegExp(`^/api/(?:me|clients|clients/${CLIENT_ID})$`);

/** Runs before auth/dispatch, including unknown routes and implicit HEAD. */
export function previewRoutePolicy(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Cache-Control', 'no-store');
  const path = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
  const override = ['x-http-method-override', 'x-method-override', 'x-http-method'].some((key) => key in req.headers) ||
    new URL(req.originalUrl ?? req.url ?? '', 'http://preview.invalid').searchParams.has('_method');
  if (override || req.method !== 'GET' || !READ_PATH.test(path)) {
    res.status(403).json({ statusCode: 403, message: 'Preview route unavailable' });
    return;
  }
  next();
}
