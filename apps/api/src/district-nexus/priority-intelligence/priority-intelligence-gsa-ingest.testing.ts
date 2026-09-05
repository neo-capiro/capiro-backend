/**
 * Type alias for building FrppRawRow fixtures in DB-gated rehearsals.
 * Re-exported here (rather than from the ingest service) so the integration
 * spec does not have to import the parser's type graph directly.
 */
export type { FrppRawRow as FrppIngestTestRow } from './priority-intelligence-gsa-frpp-parser.js';
