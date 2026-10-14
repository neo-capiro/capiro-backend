/** Decode generated memo sections; each service retains its grounding policy. */
export interface GenSection {
  heading: string;
  paragraphs: Array<{ text: string; claimIds: string[] }>;
}

export function parseSections(text: string): GenSection[] {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return [];
  let parsed: { sections?: unknown };
  try {
    parsed = JSON.parse(trimmed) as { sections?: unknown };
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]) as { sections?: unknown };
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed.sections)) return [];
  const out: GenSection[] = [];
  for (const raw of parsed.sections) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.heading !== 'string') continue;
    const paras = Array.isArray(s.paragraphs) ? s.paragraphs : [];
    const paragraphs = paras
      .map((p) => {
        const r = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
        const t = typeof r.text === 'string' ? r.text.trim() : '';
        const ids = Array.isArray(r.claimIds)
          ? r.claimIds.filter((x): x is string => typeof x === 'string')
          : [];
        return { text: t, claimIds: ids };
      })
      .filter((p) => p.text);
    out.push({ heading: s.heading.trim(), paragraphs });
  }
  return out;
}
