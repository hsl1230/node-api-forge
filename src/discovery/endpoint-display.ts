import { ApiEndpoint } from './types';

export function formatEndpointDisplayLabel(endpoint: ApiEndpoint): string {
  const method = endpoint.method ?? 'UNKNOWN';
  const displayName = (endpoint as { displayName?: unknown }).displayName;
  if (typeof displayName === 'string' && displayName.trim().length > 0) {
    return `${method} ${displayName.trim()}`;
  }

  const route = endpoint.resolvedPath ?? endpoint.pathExpression ?? '<missing-path>';
  return `${method} ${route}`;
}
