import type { MeriService } from './meri.service.js';
import type { MeriV3ProxyService } from './meriv3-proxy.service.js';
import type { MeriV3VisualAnalysisService } from './meri-v3-visual-analysis.service.js';

/** The current chat entry point is owned by V3, including its optional arguments. */
export type MeriChatStream = MeriV3ProxyService['streamMessage'];
export type MeriStreamArgs = Parameters<MeriChatStream>;

/** The existing MeriService token exposes current chat/image ports and retained services. */
export type MeriRuntimeService = Omit<MeriService, 'getArtifactImage'> & {
  streamMessage: MeriChatStream;
  getArtifactImage: MeriV3VisualAnalysisService['getArtifactImage'];
};
