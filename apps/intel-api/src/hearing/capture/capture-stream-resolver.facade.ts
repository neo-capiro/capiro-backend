import { Injectable } from '@nestjs/common';
import {
  StreamResolverService,
  type ResolveResult,
} from '../stream-resolver.service.js';
import {
  classifyStreamResolution,
  type ClassifiedStreamResolution,
  type StreamResolutionContext,
} from './stream-resolution-policy.js';

export interface CaptureResolutionRequest {
  pageUrl?: string;
  hearingId?: string;
  context: StreamResolutionContext;
}

export interface CaptureResolutionResponse {
  resolver: ResolveResult;
  classified: ClassifiedStreamResolution;
}

/**
 * The server-capture seam around the existing resolver. Final resolution must be
 * executed by the capture worker, in the same egress environment that consumes
 * the stream, because media URLs can be short-lived or IP-bound.
 */
@Injectable()
export class CaptureStreamResolverFacade {
  constructor(private readonly resolver: StreamResolverService) {}

  async resolveForCapture(request: CaptureResolutionRequest): Promise<CaptureResolutionResponse> {
    const result = await this.resolver.resolve({
      pageUrl: request.pageUrl,
      hearingId: request.hearingId,
    });
    return {
      resolver: result,
      classified: classifyStreamResolution(result, request.context),
    };
  }
}
