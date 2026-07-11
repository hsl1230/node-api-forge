import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExternalCallLibraryConfig } from '../discovery/analyzer/external-call-analyzer';

export const NODE_API_FORGE_CONFIG_FILES = {
  preferred: '.http-forge/node-api-forge.config.json'
} as const;

interface NodeApiForgeProjectConfig {
  frameworks?: string[];
  customSeedLoaderModulePath?: string;
  autoRefreshOnFileChanges?: boolean;
  contextProperties?: string[];
  searchComponentLibAllowlist?: string[];
  externalCallLibraries?: ExternalCallLibraryConfig[];
  apiExplorerFrameworkPageSize?: number;
}

export function resolveNodeApiForgeWorkspaceRoot(filePath?: string): string | undefined {
  if (filePath) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (workspaceFolder) {
      return workspaceFolder.uri.fsPath;
    }
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function resolveNodeApiForgeProjectConfigPaths(workspaceRoot: string): string[] {
  return [path.join(workspaceRoot, NODE_API_FORGE_CONFIG_FILES.preferred)];
}

function readProjectConfig(workspaceRoot?: string): { config: NodeApiForgeProjectConfig; configPath?: string } {
  if (!workspaceRoot) {
    return { config: {} };
  }

  for (const configPath of resolveNodeApiForgeProjectConfigPaths(workspaceRoot)) {
    if (!fs.existsSync(configPath)) {
      continue;
    }

    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(content) as NodeApiForgeProjectConfig;
      return { config: isRecord(parsed) ? parsed : {}, configPath };
    } catch (error) {
      console.warn(
        '[node-api-forge config] Failed to parse project config:',
        configPath,
        error instanceof Error ? error.message : String(error)
      );
      return { config: {}, configPath };
    }
  }

  return { config: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readExternalCallLibraries(value: unknown): ExternalCallLibraryConfig[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((entry): entry is ExternalCallLibraryConfig => {
    if (!isRecord(entry)) {
      return false;
    }

    return typeof entry.package === 'string'
      && typeof entry.client === 'string'
      && typeof entry.type === 'string';
  });
}

export function getNodeApiForgeFrameworks(workspaceRoot?: string): string[] {
  const { config } = readProjectConfig(workspaceRoot);
  return readStringArray(config.frameworks) ?? ['auto'];
}

export function getNodeApiForgeCustomSeedLoaderModulePath(workspaceRoot?: string): string | undefined {
  const { config } = readProjectConfig(workspaceRoot);
  const configured = readString(config.customSeedLoaderModulePath);
  if (configured) {
    return path.isAbsolute(configured) || !workspaceRoot
      ? configured
      : path.resolve(workspaceRoot, configured);
  }

  return undefined;
}

export function getNodeApiForgeAutoRefreshOnFileChanges(workspaceRoot?: string): boolean {
  const { config } = readProjectConfig(workspaceRoot);
  return readBoolean(config.autoRefreshOnFileChanges) ?? true;
}

export function getNodeApiForgeContextProperties(workspaceRoot?: string): string[] | undefined {
  const { config } = readProjectConfig(workspaceRoot);
  return readStringArray(config.contextProperties);
}

export function getNodeApiForgeSearchComponentLibAllowlist(workspaceRoot?: string): string[] {
  const { config } = readProjectConfig(workspaceRoot);
  return readStringArray(config.searchComponentLibAllowlist) ?? [];
}

export function getNodeApiForgeExternalCallLibraries(workspaceRoot?: string): ExternalCallLibraryConfig[] {
  const { config } = readProjectConfig(workspaceRoot);
  return readExternalCallLibraries(config.externalCallLibraries) ?? [];
}

export function getNodeApiForgeApiExplorerFrameworkPageSize(workspaceRoot?: string): number {
  const { config } = readProjectConfig(workspaceRoot);
  return readNumber(config.apiExplorerFrameworkPageSize) ?? 200;
}