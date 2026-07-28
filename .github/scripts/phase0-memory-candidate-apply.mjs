import fs from 'node:fs';

const file = 'apps/api/src/memory/memory-candidate.service.ts';
let source = fs.readFileSync(file, 'utf8');
function replaceOnce(search, replacement) {
  if (!source.includes(search)) throw new Error(`Candidate anchor not found: ${search.slice(0, 160)}`);
  source = source.replace(search, replacement);
}

replaceOnce(
  `  confidence?: number | null;\n}\n`,
  `  confidence?: number | null;\n  /** Phase 0 governed auto-learning provenance. These fields are optional for\n   * explicit human saves and required by the auto-learn caller. */\n  sourceConversationId?: string | null;\n  sourceMessageId?: string | null;\n  sourceExcerpt?: string | null;\n}\n`,
);

replaceOnce(
  `    const payload = {\n      key: record.key,\n      value: record.value,\n      source: record.source,\n      scope: record.scope,\n      ownerUserId: record.ownerUserId,\n      clientId: record.clientId ?? null,\n      expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,\n      confidence: candidateConfidence,\n    };\n    const provenance = { tool: 'save_memory', tenantId, userId: proposedByUserId };\n`,
  `    const sourceExcerpt =\n      typeof record.sourceExcerpt === 'string' ? record.sourceExcerpt.slice(0, 4_000) : null;\n    const sourceConversationId =\n      typeof record.sourceConversationId === 'string' ? record.sourceConversationId : null;\n    const sourceMessageId = typeof record.sourceMessageId === 'string' ? record.sourceMessageId : null;\n    const payload = {\n      key: record.key,\n      value: record.value,\n      source: record.source,\n      scope: record.scope,\n      ownerUserId: record.ownerUserId,\n      clientId: record.clientId ?? null,\n      expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,\n      confidence: candidateConfidence,\n      sourceConversationId,\n      sourceMessageId,\n      sourceExcerpt,\n    };\n    const provenance = {\n      tool: 'save_memory',\n      tenantId,\n      userId: proposedByUserId,\n      sourceConversationId,\n      sourceMessageId,\n      sourceExcerpt,\n    };\n`,
);

replaceOnce(
  `      ...(typeof record.confidence === 'number' && Number.isFinite(record.confidence)\n        ? { confidence: Math.min(1, Math.max(0, record.confidence)) }\n        : {}),\n    };\n`,
  `      ...(typeof record.confidence === 'number' && Number.isFinite(record.confidence)\n        ? { confidence: Math.min(1, Math.max(0, record.confidence)) }\n        : {}),\n      ...(record.sourceConversationId ? { sourceConversationId: record.sourceConversationId } : {}),\n      ...(record.sourceMessageId ? { sourceMessageId: record.sourceMessageId } : {}),\n      ...(record.sourceExcerpt ? { sourceExcerpt: record.sourceExcerpt.slice(0, 4_000) } : {}),\n    };\n`,
);

replaceOnce(
  `  const raw = payload as { clientId?: unknown; expiresAt?: unknown; confidence?: unknown };\n`,
  `  const raw = payload as {\n    clientId?: unknown;\n    expiresAt?: unknown;\n    confidence?: unknown;\n    sourceConversationId?: unknown;\n    sourceMessageId?: unknown;\n    sourceExcerpt?: unknown;\n  };\n`,
);

replaceOnce(
  `    confidence:\n      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)\n        ? raw.confidence\n        : null,\n  };\n`,
  `    confidence:\n      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)\n        ? raw.confidence\n        : null,\n    sourceConversationId:\n      typeof raw.sourceConversationId === 'string' ? raw.sourceConversationId : null,\n    sourceMessageId: typeof raw.sourceMessageId === 'string' ? raw.sourceMessageId : null,\n    sourceExcerpt: typeof raw.sourceExcerpt === 'string' ? raw.sourceExcerpt.slice(0, 4_000) : null,\n  };\n`,
);

fs.writeFileSync(file, source);
console.log('Memory candidate source provenance applied.');
