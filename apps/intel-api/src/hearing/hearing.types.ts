/**
 * Shared types for the Live Hearing capability.
 */

/** A finalized transcript segment as produced by Deepgram, pre-persistence. */
export interface FinalSegment {
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel?: string;
  confidence?: number;
}

/** An interim (non-final) transcript event — streamed to UI, never persisted. */
export interface InterimSegment {
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel?: string;
}

/** Result of the extraction pass over a final segment. */
export interface ExtractionResult {
  entityMentions: Array<{
    entityType: string;
    entityRef?: string;
    entityLabel: string;
    confidence?: number;
  }>;
  keyQuote?: { text: string; confidence?: number; issueTags: string[] };
  actionItem?: { description: string };
  clientRelevanceScore?: number;
  issueTags: string[];
  resolvedSpeakerId?: string;
  resolvedSpeakerName?: string;
  summaryCard?: { cardType: string; title: string; body?: string };
}

/** WS message envelopes (server -> browser). */
export type ServerWsMessage =
  | { type: 'interim'; segment: InterimSegment }
  | { type: 'final'; segmentId: string; segment: FinalSegment }
  | {
      type: 'card';
      card: { id: string; cardType: string; title: string; body?: string; startMs?: number };
    }
  | { type: 'status'; status: string }
  | { type: 'error'; message: string; code?: string };

/**
 * Browser -> gateway protocol.
 *
 * The browser no longer starts sending MediaRecorder bytes as soon as the
 * application socket opens. It first announces the exact container MIME type,
 * waits for `capture_ready`, then sends binary WebM/Opus frames. `capture_stop`
 * is a graceful drain request; `stop` and base64 `audio` remain accepted only
 * for compatibility with an older deployed web bundle.
 */
export type ClientWsMessage =
  | {
      type: 'capture_start';
      mimeType: string;
      displaySurface?: string;
    }
  | { type: 'capture_stop' }
  | { type: 'audio'; chunk: string }
  | { type: 'stop' };
