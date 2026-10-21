import type { INestApplication } from '@nestjs/common';
import { json } from 'express';
import { objectiveGenerationRawBody } from './objective-generation-raw-body.js';

/** Install before Nest init; retain Nest's ordinary parser registration. */
export function configureStrategyBodyParsers(app: INestApplication): void {
  app.use(objectiveGenerationRawBody());
  // Existing headroom for plan snapshots / draft payloads is unchanged.
  app.use(json({ limit: '8mb' }));
}
