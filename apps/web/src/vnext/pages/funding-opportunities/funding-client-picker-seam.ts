export const FUNDING_CLIENT_PICKER_EVENT = 'funding-opportunities:open-client-picker';

/** Request the mounted Funding Opportunities page to open its canonical picker. */
export function requestFundingClientPicker(): void {
  window.dispatchEvent(new Event(FUNDING_CLIENT_PICKER_EVENT));
}
