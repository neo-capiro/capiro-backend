/**
 * Anthropic structured output here is requested by appending the JSON schema
 * to the prompt as text (see LlmCompletionService.buildRequest), not via a
 * forced tool call — there is no hard schema enforcement on the provider
 * side. A low, fixed `temperature` used to keep the model reliably terse
 * enough to emit bare JSON; once a pinned model rejected any non-default
 * temperature outright, plain `JSON.parse(text)` started failing on ordinary
 * wrapping (a ```json fence, a leading/trailing sentence) that the model is
 * otherwise entitled to add. This tolerates that wrapping without weakening
 * the parse: it only ever narrows to a single balanced top-level object.
 */
export function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced?.[1] ? fenced[1].trim() : trimmed;
  if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}
