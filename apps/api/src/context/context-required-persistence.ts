import { isContextPacketPersistenceError } from '@capiro/meriv2-core';

/**
 * External-deliverable Context Packet boundary.
 *
 * Call this first inside any best-effort context catch. Ordinary loading failures
 * may degrade to neutral context, but a required persistence failure must escape
 * so the surface cannot generate, file, export, or send without durable provenance.
 */
export function rethrowRequiredContextPersistence(error: unknown): void {
  if (isContextPacketPersistenceError(error)) throw error;
}
