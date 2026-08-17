import { Injectable } from '@nestjs/common';
import {
  Phase17RuntimeCoordinator,
  type Phase17RuntimePorts,
} from './phase1-7-runtime.contract.js';
import {
  PHASE17_RUNTIME_MANIFEST,
  type Phase17RuntimeManifest,
} from './phase1-7-runtime.manifest.js';

@Injectable()
export class Phase17RuntimeRegistryService {
  manifest(): Phase17RuntimeManifest {
    return PHASE17_RUNTIME_MANIFEST;
  }

  createInspectOnlyCoordinator(ports: Phase17RuntimePorts): Phase17RuntimeCoordinator {
    return new Phase17RuntimeCoordinator(ports);
  }
}
