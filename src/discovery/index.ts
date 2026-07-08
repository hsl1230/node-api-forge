import { ApiDiscoveryEngine } from './discovery-engine';
import { ExpressDiscoveryProvider } from './providers/express-discovery-provider';
import { FastifyDiscoveryProvider } from './providers/fastify-discovery-provider';
import { NestDiscoveryProvider } from './providers/nest-discovery-provider';

export function createDefaultDiscoveryEngine(): ApiDiscoveryEngine {
  return new ApiDiscoveryEngine([
    new NestDiscoveryProvider(),
    new FastifyDiscoveryProvider(),
    new ExpressDiscoveryProvider()
  ]);
}

export * from './types';
