import { Alert, Button } from 'antd';

export interface PeSecondaryFailedProps {
  /** Short section name, e.g. "program team". */
  label: string;
  onRetry?: () => void;
  /** Stable test id; defaults to pe-secondary-failed. */
  testId?: string;
}

/**
 * Phase 5 — failed secondary sections must never render as a success Empty.
 * Distinguish "request failed" from "loaded and truly empty."
 */
export function PeSecondaryFailed({
  label,
  onRetry,
  testId = 'pe-secondary-failed',
}: PeSecondaryFailedProps) {
  return (
    <Alert
      type="error"
      showIcon
      data-testid={testId}
      message={`Failed to load ${label}`}
      description="This is not an empty result — the request failed. Retry before treating this section as empty."
      action={
        onRetry ? (
          <Button size="small" danger onClick={onRetry} data-testid="pe-secondary-retry">
            Retry
          </Button>
        ) : undefined
      }
    />
  );
}

export default PeSecondaryFailed;
