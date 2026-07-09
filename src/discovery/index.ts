import { ApiDiscoveryEngine } from './discovery-engine';
import { ExpressDiscoveryProvider } from './providers/express-discovery-provider';
import { FastifyDiscoveryProvider } from './providers/fastify-discovery-provider';
import { LambdaDiscoveryProvider } from './providers/lambda-discovery-provider';
import { NestDiscoveryProvider } from './providers/nest-discovery-provider';

export function createDefaultDiscoveryEngine(): ApiDiscoveryEngine {
  return new ApiDiscoveryEngine([
    new NestDiscoveryProvider(),
    new FastifyDiscoveryProvider(),
    new ExpressDiscoveryProvider(),
    new LambdaDiscoveryProvider()
  ]);
}

export * from './types';
