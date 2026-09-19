export interface MeriDocumentRequest {
  request: string;
  completeRead: boolean;
  contacts: boolean;
}

const DOCUMENT = /\b(transcripts?|documents?|files?|uploads?)\b/i;
const READ =
  /\b(read|review|summari[sz]e|extract|list|find|identify|pull|know|tell|what|which|who)\b/i;

/** A location correction continues the preceding request, not a new assignment.
 * Only user text participates; document text and assistant guesses are excluded. */
export function isMeriDocumentLocationClarification(text: string): boolean {
  return (
    text.length <= 500 &&
    !/[?]/.test(text) &&
    /\b(uploaded|stored|saved|attached|files?|documents?|transcripts?)\b/i.test(text) &&
    /\b(into|under|in|on|uploaded|attached)\b/i.test(text) &&
    !READ.test(text) &&
    !/\b(instead|forget|cancel|stop|new topic)\b/i.test(text)
  );
}

export function resolveMeriDocumentRequest(
  messages: readonly { role?: unknown; text?: unknown }[],
): MeriDocumentRequest | null {
  const users = messages.filter(
    (message): message is { role: 'user'; text: string } =>
      message?.role === 'user' && typeof message.text === 'string',
  );
  const latest = users.at(-1)?.text.trim() ?? '';
  let request = latest;
  if (isMeriDocumentLocationClarification(latest)) {
    // Walk only adjacent location corrections, never across a different task.
    for (const previous of users.slice(-4, -1).reverse()) {
      if (isMeriDocumentLocationClarification(previous.text)) continue;
      if (DOCUMENT.test(previous.text) && READ.test(previous.text)) {
        request = `${previous.text}\n\nFile location clarification: ${latest}`;
      }
      break;
    }
  }
  if (!DOCUMENT.test(request) || !READ.test(request)) return null;
  // Creation/filing alone is not permission to research every client file.
  if (
    /\b(create|draft|write|save|file|upload)\b/i.test(request) &&
    !/\b(read|review|summari[sz]e|extract|list|find|identify|pull|from)\b/i.test(request)
  )
    return null;
  return {
    request,
    completeRead:
      /\b(all|every|entire|whole|full|everything|list|summari[sz]e|extract|review|meetings|action items)\b/i.test(
        request,
      ),
    contacts:
      /\b(contact information|contact details|contacts|email|phone|positions|full names|exact names)\b/i.test(
        request,
      ),
  };
}
