export const MAX_FUNDING_POSITIONS = 50;

export const MAX_PE_IMPACTS = 100;

export const MAX_RELATED_VEHICLES = 25;

export const MAX_PROVISIONS = 50;

export const FUNDING_UNAVAILABLE =
  'Funding intelligence is not yet enabled for this vehicle. No $0 is shown unless a source states zero.';

export const FUNDING_NO_DATA =
  'No reviewed funding positions are linked to this bill yet. No $0 is shown unless a source states zero.';

export const STATE_FUNDING_UNSUPPORTED =
  'State funding data is not available. No $0 is shown unless a source states zero.';

export const FUNDING_NO_PRIMARY_POSITION =
  'Program-element links are available, but no reviewed funding position can be shown. No $0 is shown unless a source states zero.';

export const FUNDING_TABLES_PENDING = 'Funding tables are available; amounts await verification.';

export const OVERRIDE_RECONCILIATION_GUARDRAIL =
  'Official provisions explicitly change table amounts, but those overrides have not been numerically reconciled. No topline amount or comparison is shown until verification is complete.';

export const OVERRIDE_RECONCILIATION_MARKER = '[overrides-reconciled]';

export const SCOPE_GUARDRAIL =
  'This bill carries figures on more than one funding scope. Amounts are only compared within the same fiscal year and the same scope, so no cross-scope delta is shown.';

export const STAGE_ORDER: Record<string, number> = {
  president: 0,
  house: 1,
  senate: 2,
  conference: 3,
  enacted: 4,
};
