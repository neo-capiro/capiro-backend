/**
 * Public type surface of the shared Context Plane.
 *
 * Each adopted product owns a thin `<product>-context-plane.service.ts` that
 * calls ContextPlaneGatewayService and projects the resulting packet into the
 * shape its own reasoning path already expects. Those adapters need the packet
 * TYPE, but they must not import the compiler / resolver / packet
 * implementation modules to obtain it — that coupling is exactly what the
 * architecture guard exists to prevent.
 *
 * This module is therefore the only approved type boundary out of the Context
 * Plane. It exports types only; it must never export a service, a compiler, or
 * any runtime value.
 */
export type { Phase17CompiledContextPacket as ContextPlanePacket } from './context-packet-v2.service.js';
