import * as fs from 'fs';
import * as path from 'path';
import { ApiEndpoint, DiscoveryContext, DiscoveryWarning } from './types';

export function loadHybridSeedEndpoints(
  projectRoot: string,
  context: DiscoveryContext
): { endpoints: ApiEndpoint[]; warnings: DiscoveryWarning[] } {
  return loadCustomSeedEndpoints(projectRoot, context);
}

function loadCustomSeedEndpoints(
  projectRoot: string,
  context: DiscoveryContext
): { endpoints: ApiEndpoint[]; warnings: DiscoveryWarning[] } {
  const modulePathSetting = context.customSeedLoaderModulePath?.trim();
  if (!modulePathSetting) {
    console.log('[seed-loader] No customSeedLoaderModulePath configured');
    return { endpoints: [], warnings: [] };
  }

  const resolvedModulePath = path.isAbsolute(modulePathSetting)
    ? modulePathSetting
    : path.join(projectRoot, modulePathSetting);

  console.log('[seed-loader] Looking for custom loader at:', resolvedModulePath);

  if (!fs.existsSync(resolvedModulePath)) {
    console.warn('[seed-loader] Custom loader module not found:', resolvedModulePath);
    return {
      endpoints: [],
      warnings: [
        {
          code: 'seed-loader-failed',
          filePath: resolvedModulePath,
          message: `Custom seed loader module not found: ${resolvedModulePath}`
        }
      ]
    };
  }

  try {
    console.log('[seed-loader] Loading custom loader module...');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loaded = require(resolvedModulePath) as {
      loadSeedManifestEndpoints?: (
        currentProjectRoot: string,
        discoveryContext: DiscoveryContext
      ) => { endpoints?: ApiEndpoint[]; warnings?: DiscoveryWarning[] } | ApiEndpoint[];
      default?: (
        currentProjectRoot: string,
        discoveryContext: DiscoveryContext
      ) => { endpoints?: ApiEndpoint[]; warnings?: DiscoveryWarning[] } | ApiEndpoint[];
    };

    const loader = loaded.loadSeedManifestEndpoints ?? loaded.default;
    if (typeof loader !== 'function') {
      console.warn('[seed-loader] Custom loader module does not export loadSeedManifestEndpoints or default function');
      return {
        endpoints: [],
        warnings: [
          {
            code: 'seed-loader-failed',
            filePath: resolvedModulePath,
            message: `Custom seed loader module must export a function named loadSeedManifestEndpoints or a default function.`
          }
        ]
      };
    }

    console.log('[seed-loader] Calling loader function with projectRoot:', projectRoot);
    const result = loader(projectRoot, context);
    if (Array.isArray(result)) {
      console.log('[seed-loader] Loader returned array with', result.length, 'endpoints');
      return { endpoints: result, warnings: [] };
    }

    const endpointCount = result?.endpoints?.length ?? 0;
    const warningCount = result?.warnings?.length ?? 0;
    console.log('[seed-loader] Loader returned object with', endpointCount, 'endpoints and', warningCount, 'warnings');
    return {
      endpoints: result?.endpoints ?? [],
      warnings: result?.warnings ?? []
    };
  } catch (error) {
    console.error('[seed-loader] Error loading custom loader:', error instanceof Error ? error.message : String(error));
    return {
      endpoints: [],
      warnings: [
        {
          code: 'seed-loader-failed',
          filePath: resolvedModulePath,
          message: `Custom seed loader failed at ${resolvedModulePath}: ${error instanceof Error ? error.message : String(error)}`
        }
      ]
    };
  }
}
