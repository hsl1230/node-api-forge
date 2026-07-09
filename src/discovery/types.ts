export type ApiFramework = 'express' | 'nestjs' | 'fastify' | 'unknown';

export type EndpointConfidence = 'high' | 'medium' | 'low';

export interface SourceLocation {
  filePath: string;
  line: number;
  column?: number;
  symbolName?: string;
  accessMode?: 'read' | 'write';
}

export interface ApiMiddleware {
  name: string;
  location?: SourceLocation;
}

export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie' | 'body' | 'locals' | (string & {});

export interface ApiParameter {
  name: string;
  location: ParameterLocation;
  type?: string; // 'string', 'number', 'boolean', 'object', etc.
  required?: boolean;
  description?: string;
  example?: string;
  detectionLocation?: SourceLocation;
  evidenceLocations?: SourceLocation[];
  conflictingTypes?: string[];
}

export interface ApiRequestBody {
  type?: string; // 'json', 'form', 'text', 'multipart', etc.
  schema?: string; // Inferred schema or hint
  required?: boolean;
  example?: unknown;
  detectionLocation?: SourceLocation;
}

export interface ApiResponse {
  statusCode?: number; // Default: 200
  headers?: ApiParameter[];
  body?: {
    type?: string;
    schema?: string;
  };
}

export interface ApiCookie {
  name: string;
  type?: 'request' | 'response';
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  detectionLocation?: SourceLocation;
}

export interface ApiEndpoint {
  method: string;
  framework: ApiFramework;
  projectName?: string;
  pathExpression: string;
  resolvedPath?: string;
  displayName?: string;
  operationId?: string;
  confidence: EndpointConfidence;
  handlerLocation: SourceLocation;
  middleware: ApiMiddleware[];
  parameters?: ApiParameter[];
  requestBody?: ApiRequestBody;
  responses?: ApiResponse[];
  cookies?: ApiCookie[];
  description?: string;
}

export interface DiscoveryWarning {
  code:
    | 'provider-not-supported'
    | 'provider-failed'
    | 'dynamic-path-unresolved'
    | 'parameter-type-conflict'
    | 'component-dependency-limit-reached'
    | 'seed-manifest-invalid'
    | 'seed-endpoint-unmatched'
    | 'seed-loader-failed'
    | 'project-fingerprint-missing';
  message: string;
  framework?: ApiFramework;
  filePath?: string;
}

export interface DiscoveryStats {
  frameworksDetected: ApiFramework[];
  providersRun: string[];
  endpointCount: number;
  unresolvedEndpointCount: number;
  scanDurationMs: number;
  parameterCacheReusedEndpoints?: number;
  parameterCacheRecomputedEndpoints?: number;
  parameterTraversalTruncatedEndpoints?: number;
}

export interface DiscoveryResult {
  endpoints: ApiEndpoint[];
  warnings: DiscoveryWarning[];
  stats: DiscoveryStats;
}

export interface FrameworkFingerprint {
  projectRoot: string;
  packageJsonPath?: string;
  packageJson?: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  evidenceFiles: string[];
}

export interface DiscoveryContext {
  workspaceFolder: string;
  includeProjectRoots?: string[];
  envOverrides?: Record<string, string>;
  frameworksByProjectRoot?: Record<string, ApiFramework[]>;
  customSeedLoaderModulePath?: string;
  /**
   * Sub-property names on request/response objects to track as shared context.
   * Defaults to ["locals"] (Express res.locals convention).
   * Add names like "context" or "state" for custom patterns.
   */
  contextProperties?: string[];
}
