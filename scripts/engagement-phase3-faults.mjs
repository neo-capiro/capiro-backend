#!/usr/bin/env node
/** Pure deterministic fault catalog/controller for Phase 3 local resilience. */

const ACTIONS = new Set(['respond', 'malformed_json', 'partial_response', 'reset']);

function normalizePath(url) {
  try {
    return new URL(String(url ?? ''), 'http://phase3.invalid').pathname;
  } catch {
    return String(url ?? '').split('?')[0];
  }
}

function validateFault(fault) {
  if (!fault || typeof fault !== 'object') throw new Error('Fault must be an object');
  if (typeof fault.id !== 'string' || !fault.id) throw new Error('Fault id is required');
  if (!ACTIONS.has(fault.action)) throw new Error(`Unsupported Phase 3 fault action ${fault.action}`);
  if (fault.owner && !['main-api', 'engagement-api'].includes(fault.owner)) {
    throw new Error(`Unsupported Phase 3 fault owner ${fault.owner}`);
  }
  if (fault.method && !/^[A-Z]+$/.test(fault.method)) {
    throw new Error(`Fault method must be uppercase: ${fault.method}`);
  }
  if (fault.pathname && !String(fault.pathname).startsWith('/')) {
    throw new Error(`Fault pathname must be absolute: ${fault.pathname}`);
  }
  if (fault.delayMs != null && (!Number.isFinite(fault.delayMs) || fault.delayMs < 0)) {
    throw new Error(`Fault delayMs must be non-negative: ${fault.delayMs}`);
  }
  if (fault.action === 'respond' && (!Number.isInteger(fault.status) || fault.status < 100)) {
    throw new Error(`Respond fault needs an HTTP status: ${fault.status}`);
  }
  return {
    id: fault.id,
    action: fault.action,
    owner: fault.owner ?? null,
    method: fault.method ?? null,
    pathname: fault.pathname ?? null,
    status: fault.status ?? null,
    delayMs: fault.delayMs ?? 0,
    headers: { ...(fault.headers ?? {}) },
    body: fault.body ?? null,
    fragment: String(fault.fragment ?? '{"partial":'),
    once: fault.once !== false,
  };
}

export function faultMatchesRequest(fault, request) {
  const normalized = validateFault(fault);
  if (normalized.owner && normalized.owner !== request.owner) return false;
  if (normalized.method && normalized.method !== String(request.method ?? '').toUpperCase()) return false;
  if (normalized.pathname && normalized.pathname !== normalizePath(request.url)) return false;
  return true;
}

export function createPhase3FaultController(initial = []) {
  const faults = initial.map(validateFault);
  const hits = [];

  return {
    arm(fault) {
      const normalized = validateFault(fault);
      if (faults.some((row) => row.id === normalized.id)) {
        throw new Error(`Phase 3 fault id already armed: ${normalized.id}`);
      }
      faults.push(normalized);
      return normalized;
    },
    clear() {
      faults.splice(0, faults.length);
    },
    match(request) {
      const index = faults.findIndex((fault) => faultMatchesRequest(fault, request));
      if (index < 0) return null;
      const fault = faults[index];
      hits.push({
        id: fault.id,
        owner: request.owner,
        method: request.method,
        pathname: normalizePath(request.url),
      });
      if (fault.once) faults.splice(index, 1);
      return fault;
    },
    snapshot() {
      return {
        armed: faults.map((fault) => fault.id),
        hits: [...hits],
      };
    },
  };
}

export function phase3FaultJsonBody(fault) {
  if (typeof fault.body === 'string') return fault.body;
  return JSON.stringify(
    fault.body ?? {
      statusCode: fault.status ?? 500,
      code: `ENGAGEMENT_PHASE3_FAULT_${String(fault.id).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
      message: `Phase 3 injected fault: ${fault.id}`,
    },
  );
}
