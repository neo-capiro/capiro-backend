import { ServiceUnavailableException } from '@nestjs/common';
import type { RetainedSourceV02Admission } from './admission.js';

/**
 * Retained 0.2 source reads require current source inventory and full output
 * validation before release. None of the eleven owner adapters currently
 * provides both on this authenticated route. In particular, the legacy
 * model-facing handlers cannot establish Meri's source coverage or result
 * lineage. Keep this boundary closed until each owner installs its specific
 * producer and validator; never fall through to executeFromAuthenticatedUser.
 */
export async function readRetainedSourceV02(
  admission: RetainedSourceV02Admission,
): Promise<unknown> {
  throw new ServiceUnavailableException({
    code: 'MERI_RETAINED_SOURCE_UNAVAILABLE',
    operation: admission.operation.id,
  });
}
