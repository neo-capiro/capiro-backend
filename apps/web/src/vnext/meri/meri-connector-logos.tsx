export type MeriConnectorId = 'hubspot' | 'airtable' | 'sharepoint';

/**
 * Simplified brand marks for the connectors Meri can read from — the
 * "Connected Sources" rail, the Integrations page, and the composer's
 * "Add to conversation" popover previously showed a single letter tile
 * (H / A / S) for all three, which reads as a placeholder rather than a
 * real connector.
 */
export function ConnectorMark({ id, size = 16 }: { id: MeriConnectorId; size?: number }) {
  const props = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true } as const;

  if (id === 'hubspot') {
    return (
      <svg {...props} fill="none">
        <circle cx="8" cy="16" r="4.5" stroke="#FF7A59" strokeWidth="2.25" />
        <path d="M9.7 13L15 8.3M10.5 16H14" stroke="#FF7A59" strokeWidth="2" strokeLinecap="round" />
        <circle cx="16.5" cy="7" r="2.25" fill="#FF7A59" />
        <circle cx="16.5" cy="16" r="2.25" fill="#FF7A59" />
      </svg>
    );
  }

  if (id === 'airtable') {
    return (
      <svg {...props}>
        <path d="M12 3L21 7.3L12 11.6L3 7.3Z" fill="#FCB400" />
        <path d="M12.7 12.8L20.7 9.1V15.9L12.7 19.7Z" fill="#18BFFF" />
        <path d="M11.3 12.8L3.3 9.1V15.9L11.3 19.7Z" fill="#F82B60" />
      </svg>
    );
  }

  return (
    <svg {...props}>
      <circle cx="9.5" cy="9" r="5.5" fill="#036C70" />
      <circle cx="15.5" cy="8" r="4.5" fill="#1A9BA1" />
      <circle cx="12" cy="15" r="5" fill="#37C6D0" />
    </svg>
  );
}
