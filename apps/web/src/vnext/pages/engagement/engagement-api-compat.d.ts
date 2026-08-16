import type { OutreachV3DeliveryView, OutreachV3GenerationJobItem } from './engagement-api.js';

declare module './engagement-api.js' {
  interface OutreachV3GenerationJobItem {
    /** Compatibility alias consumed by the first vNext recovery renderer. */
    errorMessage?: string | null;
  }

  interface OutreachV3DeliveryView {
    /** Compatibility aliases while the renderer migrates to the durable view. */
    lastErrorCode?: string | null;
    lastErrorMessage?: string | null;
    recipientSnapshot?: Record<string, unknown>;
  }
}

export type _EngagementApiAugmentation = OutreachV3DeliveryView | OutreachV3GenerationJobItem;
