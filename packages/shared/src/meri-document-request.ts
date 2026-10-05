export interface MeriDocumentRequest {
  request: string;
  completeRead: boolean;
  contacts: boolean;
}

const DOCUMENT = /\b(transcripts?|documents?|files?|uploads?)\b/i;
/** Asking for everything in a file requires a complete, contiguous read. */
const EXHAUSTIVE = /\b(all|every|entire|whole|full|everything|list|meetings|action items)\b/i;
/** Summaries, extractions and reviews are complete reads unless a location is named. */
const BROAD = /\b(summari[sz]e|extract|review)\b/i;
const TARGETED =
  /\b(?:slides?|pages?|sections?|tabs?|sheets?|chapters?|paragraphs?|rows?|lines?)\s+\d+/i;
const APPENDED_ATTACHMENT =
  /\n\n(?:Attached (?:document|image) |Attachment "|Documents uploaded earlier in this chat \(retained after chat summary\):)/;

/**
 * The API appends each attachment's extracted text to the user's turn
 * ("Attached document …", filing references, unavailable notices, and the
 * compaction carry-over). Request classification must use what the user typed:
 * file text is data, and its words ("all", "list", "strategy", "$M") are not
 * the user's request.
 */
export function stripAppendedAttachmentText(text: string): string {
  const match = APPENDED_ATTACHMENT.exec(text);
  return match ? text.slice(0, match.index) : text;
}
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
  const raw = users.at(-1)?.text ?? '';
  // A file carried on this turn makes it a document turn, but only the user's
  // own words decide what is being asked of it.
  const attached = APPENDED_ATTACHMENT.test(raw);
  const latest = stripAppendedAttachmentText(raw).trim();
  let request = latest;
  if (isMeriDocumentLocationClarification(latest)) {
    // Walk only adjacent location corrections, never across a different task.
    for (const previous of users.slice(-4, -1).reverse()) {
      const previousText = stripAppendedAttachmentText(previous.text).trim();
      if (isMeriDocumentLocationClarification(previousText)) continue;
      if (DOCUMENT.test(previousText) && READ.test(previousText)) {
        request = `${previousText}\n\nFile location clarification: ${latest}`;
      }
      break;
    }
  }
  if (!(attached || DOCUMENT.test(request)) || !READ.test(request)) return null;
  // Creation/filing alone is not permission to research every client file.
  if (
    /\b(create|draft|write|save|file|upload)\b/i.test(request) &&
    !/\b(read|review|summari[sz]e|extract|list|find|identify|pull|from)\b/i.test(request)
  )
    return null;
  return {
    request,
    // "Summarize slide 6" is a targeted read; "summarize the deck" is not.
    completeRead: EXHAUSTIVE.test(request) || (BROAD.test(request) && !TARGETED.test(request)),
    contacts:
      /\b(contact information|contact details|contacts|email|phone|positions|full names|exact names)\b/i.test(
        request,
      ),
  };
}
