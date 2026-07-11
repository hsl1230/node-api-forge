/**
 * Shared Language Model utilities.
 * Ported from agl-essentials — resilient model selection that doesn't depend
 * on hardcoded family names (Copilot model families change over time).
 */

import * as vscode from 'vscode';

const PREFERRED_FAMILIES = ['claude-opus', 'claude-sonnet', 'gpt-5', 'gpt-4o', 'gpt-4', 'copilot'];
const FAST_FAMILIES     = ['claude-sonnet', 'gpt-5', 'claude-opus', 'gpt-4o', 'gpt-4', 'copilot'];

export async function selectBestModel(): Promise<vscode.LanguageModelChat | undefined> {
  let allModels: vscode.LanguageModelChat[];
  try {
    allModels = await vscode.lm.selectChatModels();
  } catch {
    return undefined;
  }
  if (allModels.length === 0) return undefined;

  const copilotModels = allModels.filter(m => m.vendor === 'copilot');
  const candidates = copilotModels.length > 0 ? copilotModels : allModels;

  for (const familyPrefix of PREFERRED_FAMILIES) {
    const matches = candidates.filter(m => m.family.startsWith(familyPrefix));
    if (matches.length > 0) {
      return matches.reduce((a, b) => {
        const verA = parseFamilyVersion(a.family);
        const verB = parseFamilyVersion(b.family);
        if (verA !== verB) return verA > verB ? a : b;
        return a.maxInputTokens >= b.maxInputTokens ? a : b;
      });
    }
  }
  return candidates.reduce((a, b) => a.maxInputTokens >= b.maxInputTokens ? a : b);
}

export async function selectFastModel(): Promise<vscode.LanguageModelChat | undefined> {
  let allModels: vscode.LanguageModelChat[];
  try {
    allModels = await vscode.lm.selectChatModels();
  } catch {
    return undefined;
  }
  if (allModels.length === 0) return undefined;

  const copilotModels = allModels.filter(m => m.vendor === 'copilot');
  const candidates = copilotModels.length > 0 ? copilotModels : allModels;

  for (const familyPrefix of FAST_FAMILIES) {
    const matches = candidates.filter(m => m.family.startsWith(familyPrefix));
    if (matches.length > 0) {
      return matches.reduce((a, b) => a.maxInputTokens >= b.maxInputTokens ? a : b);
    }
  }
  return candidates.reduce((a, b) => a.maxInputTokens >= b.maxInputTokens ? a : b);
}

function parseFamilyVersion(family: string): number {
  const match = family.match(/(\d+(?:\.\d+)?)\s*$/);
  return match ? parseFloat(match[1]) : 0;
}
