/**
 * A globally shared public-hearing capture cannot be billed to an arbitrary
 * subscriber's BYOK credential. The capture worker must resolve a platform-owned
 * Deepgram key outside the tenant boundary and may attribute cost separately.
 */
export type PublicCaptureCredentialSource = 'PLATFORM_SECRET' | 'PLATFORM_KMS';

export interface PublicCaptureDeepgramCredential {
  apiKey: string;
  source: PublicCaptureCredentialSource;
  credentialId?: string;
  billingMode: 'PLATFORM_SHARED_PUBLIC_CAPTURE';
}

export interface PublicCaptureCredentialResolverPort {
  resolve(input: {
    captureId: string;
    hearingId: string;
  }): Promise<PublicCaptureDeepgramCredential>;
}

export function assertPublicCaptureCredential(
  credential: PublicCaptureDeepgramCredential,
): PublicCaptureDeepgramCredential {
  if (!credential.apiKey.trim()) throw new Error('Public capture Deepgram credential is empty');
  if (credential.billingMode !== 'PLATFORM_SHARED_PUBLIC_CAPTURE') {
    throw new Error('Public capture must use the shared public-capture billing mode');
  }
  const unsafe = credential as unknown as Record<string, unknown>;
  if ('tenantId' in unsafe || 'userId' in unsafe || 'clientId' in unsafe) {
    throw new Error('Tenant-scoped identity must not enter the global public capture credential');
  }
  return credential;
}
