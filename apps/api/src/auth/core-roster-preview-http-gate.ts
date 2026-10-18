import type { RequestHandler } from 'express';
import { coreRosterPreviewDecision } from './preview-native-read-mode.js';

/**
 * Install immediately after NestFactory.create, before CORS, parsers and
 * AppModule's route exclusions. It covers direct VPC requests as well as ALB
 * forwarding; the ALB's Host rules are not an application authorization gate.
 */
export function coreRosterPreviewHttpGate(
  enabled: boolean,
  nativeGetsEnabled: boolean,
): RequestHandler {
  return (req, res, next) => {
    const decision = coreRosterPreviewDecision(req, enabled, nativeGetsEnabled);
    if (decision === 'unrelated') {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    if (decision === 'preview') {
      next();
      return;
    }
    const status = decision === 'unavailable' ? 503 : 404;
    res.status(status).json({ statusCode: status, message: status === 503 ? 'Preview reads unavailable' : 'Not Found' });
  };
}
