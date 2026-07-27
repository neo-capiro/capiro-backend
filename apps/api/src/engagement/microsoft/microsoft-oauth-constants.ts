// Pulled out of microsoft-oauth.service.ts so microsoft-graph-sync.service.ts
// can depend on these without importing the service file itself. That
// service-to-service import used to be one-directional (graph-sync -> oauth);
// once oauth started injecting MicrosoftGraphSyncService for the disconnect
// path (Phase E), the two-way import became a real circular module load, and
// graph-sync.service.ts reads MICROSOFT_SCOPES at module-top-level (not just
// inside a method body), so the cycle resolved with an undefined binding
// depending on which file a test/entrypoint imported first. This file has no
// dependency on either service, so both can import it with no cycle.
export const MICROSOFT_SCOPES = [
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.Read',
];

export function normalizePem(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('-----BEGIN')) return trimmed;
  // Assume base64-encoded PEM transported via env var.
  return Buffer.from(trimmed, 'base64').toString('utf8');
}
