import { Injectable } from '@nestjs/common';
import type { PublicCaptureCredentialResolverPort, PublicCaptureDeepgramCredential } from './public-capture-credentials.js';

@Injectable()
export class PublicCaptureCredentialsAdapter implements PublicCaptureCredentialResolverPort {
  async resolve(): Promise<PublicCaptureDeepgramCredential> {
    const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
    if (!apiKey) throw new Error('DEEPGRAM_API_KEY is required for platform public hearing capture');
    return { apiKey, billingMode:'PLATFORM_SHARED_PUBLIC_CAPTURE', source:'PLATFORM_SECRET' };
  }
}
