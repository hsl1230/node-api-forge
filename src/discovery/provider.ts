import { DiscoveryContext, DiscoveryResult, FrameworkFingerprint } from './types';

export interface ProviderSupport {
  supported: boolean;
  confidence: number;
  reasons: string[];
}

export interface ApiDiscoveryProvider {
  readonly id: string;

  supports(fingerprint: FrameworkFingerprint): ProviderSupport;

  discover(context: DiscoveryContext, fingerprint: FrameworkFingerprint): Promise<DiscoveryResult>;

  clearCache?(projectRoot?: string): void;
}
