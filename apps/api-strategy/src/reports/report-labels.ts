/** Shared labels for every executive report format and narrative evidence. */
export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: "Draft",
    in_progress: "In progress",
    internal_review: "Internal review",
    active: "Active",
    suggested: "Suggested",
  };
  return labels[status] ?? titleCase(status);
}

export function kindLabel(kind: string): string {
  return titleCase(kind);
}

export function strategyTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    appropriations: "Appropriations",
    authorization: "Authorization",
    regulatory: "Regulatory / policy",
    coalition: "Coalition / positioning",
    procurement: "Contract / procurement",
    earmark: "Grant / earmark",
    amendment: "Amendment ask",
  };
  return labels[type] ?? titleCase(type);
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
