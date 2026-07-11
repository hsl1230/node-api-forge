/**
 * Endpoint Documentation Service
 *
 * Multi-phase LLM pipeline — mirrors the agl-essentials approach:
 *   Phase 1  (Code Facts):  Fast model extracts structured facts from source code
 *   Phase 2  (Write):       Best model writes the full markdown document
 *   Phase 3  (Self-Check):  Optional quality gate using fast model
 *
 * Generated docs are persisted as markdown files in {workspaceRoot}/.docs/
 * keyed by method + path.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ApiEndpoint } from '../discovery/types';
import { selectBestModel, selectFastModel } from '../shared/lm-utils';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface EndpointDocResult {
  summary: string;
  doc: string;
}

export type ProgressReporter = (step: string, detail?: string) => void;
export const noopReporter: ProgressReporter = () => {};

// ─── Doc Store ────────────────────────────────────────────────────────────────

const DOCS_DIR  = '.docs';
const INDEX_FILE = 'index.json';

interface DocIndexEntry {
  summary: string;
  file: string;
  generatedAt: string;
}
type DocIndex = Record<string, DocIndexEntry>;

function buildDocKey(method: string, routePath: string): string {
  return `${method.toUpperCase()}--${routePath
    .replace(/^\//, '')
    .replace(/\//g, '-')
    .replace(/:/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

function getDocsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, DOCS_DIR);
}

export function getExistingDoc(workspaceRoot: string, method: string, routePath: string): EndpointDocResult | undefined {
  const key = buildDocKey(method, routePath);
  const docsDir = getDocsDir(workspaceRoot);
  const indexPath = path.join(docsDir, INDEX_FILE);
  if (!fs.existsSync(indexPath)) return undefined;

  try {
    const index: DocIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index[key];
    if (!entry) return undefined;
    const mdPath = path.join(docsDir, entry.file);
    if (!fs.existsSync(mdPath)) return undefined;
    return { summary: entry.summary, doc: fs.readFileSync(mdPath, 'utf-8') };
  } catch {
    return undefined;
  }
}

export function getDocFilePath(workspaceRoot: string, method: string, routePath: string): string {
  return path.join(getDocsDir(workspaceRoot), `${buildDocKey(method, routePath)}.md`);
}

function persistDoc(workspaceRoot: string, method: string, routePath: string, result: EndpointDocResult): void {
  const docsDir = getDocsDir(workspaceRoot);
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

  const key = buildDocKey(method, routePath);
  const fileName = `${key}.md`;
  const mdPath = path.join(docsDir, fileName);
  fs.writeFileSync(mdPath, result.doc, 'utf-8');

  const indexPath = path.join(docsDir, INDEX_FILE);
  let index: DocIndex = {};
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')); } catch { /* new */ }
  index[key] = { summary: result.summary, file: fileName, generatedAt: new Date().toISOString() };
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');
}

// ─── Doc Service ──────────────────────────────────────────────────────────────

/**
 * Generate documentation for a discovered endpoint.
 *
 * @param endpoint       Discovered endpoint data
 * @param componentFiles All source files in the endpoint's component tree
 * @param workspaceRoot  Root directory used for doc storage
 * @param report         Progress reporter — sends steps to the webview log
 */
export async function generateEndpointDoc(
  endpoint: ApiEndpoint,
  componentFiles: string[],
  workspaceRoot: string,
  report: ProgressReporter = noopReporter
): Promise<EndpointDocResult | undefined> {
  // ─── Model selection ───────────────────────────────────────────────────────
  report('Selecting language models');
  const [model, fastModel] = await Promise.all([selectBestModel(), selectFastModel()]);
  if (!model) {
    report('✗ No language model', 'GitHub Copilot is not available. Ensure it is installed and signed in.');
    return undefined;
  }
  const extractionModel = fastModel ?? model;
  report('  ✓ Writing model', `${model.name ?? model.id} (family: ${model.family})`);
  if (extractionModel !== model) {
    report('  ✓ Extraction model', `${extractionModel.name ?? extractionModel.id} (family: ${extractionModel.family}) — used for Phase 1`);
  }

  // ─── Read source files ─────────────────────────────────────────────────────
  const sourceBudget = Math.floor(extractionModel.maxInputTokens * 0.65 * 3);
  const sourceSnippets = readSourceFiles(componentFiles, sourceBudget);
  report('  Source files read', `${sourceSnippets.length.toLocaleString()} chars from ${componentFiles.length} files`);

  // ─── Phase 1: Code fact extraction ────────────────────────────────────────
  report('Phase 1: Code fact extraction');
  const codeFactPrompt = buildCodeFactPrompt(endpoint, sourceSnippets);
  const codeFacts = await callModel(extractionModel, codeFactPrompt, report, 'Phase 1');
  report('  ✓ Code facts extracted', `${codeFacts.length.toLocaleString()} chars`);

  // ─── Phase 2: Write document ───────────────────────────────────────────────
  report('Phase 2: Writing documentation');
  const mergePrompt = buildMergePrompt(endpoint, codeFacts);
  const parsed = await callModelParsed(model, mergePrompt, report, 'Phase 2');
  const lineCount = parsed.doc.split('\n').length;
  report('  ✓ Document written', `${parsed.doc.length.toLocaleString()} chars, ${lineCount} lines`);

  // ─── Phase 3: Self-check (if draft is short) ──────────────────────────────
  const minLines = 120;
  if (lineCount < minLines && parsed.doc.length > 200) {
    report('Phase 3: Self-check', `Draft is only ${lineCount} lines — asking model to expand`);
    const checkPrompt = buildSelfCheckPrompt(endpoint, parsed.doc, codeFacts);
    const revised = await callModelParsed(extractionModel, checkPrompt, report, 'Phase 3');
    if (revised.doc.split('\n').length > lineCount) {
      report('  ✓ Revised draft', `${revised.doc.length.toLocaleString()} chars, ${revised.doc.split('\n').length} lines`);
      Object.assign(parsed, revised);
    } else {
      report('  Self-check did not improve length — keeping original draft');
    }
  }

  // ─── Persist ───────────────────────────────────────────────────────────────
  const route = endpoint.resolvedPath ?? endpoint.pathExpression;
  persistDoc(workspaceRoot, endpoint.method, route, parsed);
  report('  ✓ Saved', getDocFilePath(workspaceRoot, endpoint.method, route));

  return parsed;
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildCodeFactPrompt(endpoint: ApiEndpoint, sourceSnippets: string): string {
  const route = endpoint.resolvedPath ?? endpoint.pathExpression;
  const params = (endpoint.parameters ?? [])
    .map(p => `  ${p.name} (${p.location}${p.required ? ', required' : ''}): ${p.type ?? 'unknown'}`)
    .join('\n');
  const mwList = (endpoint.middleware ?? [])
    .map(m => `  - ${m.name}${m.location?.filePath ? ` [${path.basename(m.location.filePath)}:${m.location.line}]` : ''}`)
    .join('\n');

  return [
    `You are a senior backend engineer analysing an API endpoint for documentation.`,
    `Extract structured facts from the source code below. Be thorough and precise.`,
    ``,
    `## Endpoint`,
    `Method: ${endpoint.method}`,
    `Path: ${route}`,
    `Framework: ${endpoint.framework}`,
    `Handler: ${endpoint.handlerLocation.filePath}:${endpoint.handlerLocation.line}`,
    params ? `Parameters:\n${params}` : `Parameters: none`,
    mwList ? `Middleware chain:\n${mwList}` : `Middleware: none`,
    ``,
    `## Source Code`,
    sourceSnippets,
    ``,
    `## Instructions`,
    `Extract these facts from the code above:`,
    `1. **Purpose** — what does this endpoint do? (1-2 sentences)`,
    `2. **Business logic** — key steps performed (numbered list)`,
    `3. **Input contract** — each parameter: name, type, source (path/query/body/header), required, validation rules, default`,
    `4. **Output** — response shape, status codes, error cases`,
    `5. **Middleware behaviour** — what each middleware does (skip generic auth/cors/etc.)`,
    `6. **Data dependencies** — external services, databases, caches called`,
    `7. **Edge cases** — error handling, fallbacks, feature flags`,
    ``,
    `Format as a structured text report. Do NOT write a markdown document yet — just extract facts.`,
  ].join('\n');
}

function buildMergePrompt(endpoint: ApiEndpoint, codeFacts: string): string {
  const route = endpoint.resolvedPath ?? endpoint.pathExpression;

  return [
    `You are a technical writer creating internal API documentation for your engineering team.`,
    ``,
    `## Endpoint`,
    `${endpoint.method} ${route}  (${endpoint.framework}, confidence: ${endpoint.confidence ?? 'unknown'})`,
    ``,
    `## Extracted Code Facts`,
    codeFacts,
    ``,
    `## Instructions`,
    `Write a comprehensive reference document for this endpoint in Markdown.`,
    ``,
    `Required sections (use ## headings):`,
    `1. **Summary** — 2-3 sentence overview`,
    `2. **Request** — method, path, authentication (if any), parameters table`,
    `3. **Request Body** — schema description (if applicable)`,
    `4. **Response** — status codes, response schema, example`,
    `5. **Middleware Chain** — brief description of each middleware's role`,
    `6. **Business Logic** — step-by-step description of what the handler does`,
    `7. **Error Handling** — known error cases and status codes`,
    `8. **Notes** — edge cases, caveats, related endpoints`,
    ``,
    `Format: clean Markdown. Use tables for parameters. Be precise and concise.`,
    ``,
    `Start your response with:`,
    `---SUMMARY---`,
    `<one-paragraph summary>`,
    `---DOC---`,
    `<full markdown document>`,
    `---END---`,
  ].join('\n');
}

function buildSelfCheckPrompt(endpoint: ApiEndpoint, draft: string, codeFacts: string): string {
  const route = endpoint.resolvedPath ?? endpoint.pathExpression;
  return [
    `You are reviewing API documentation for ${endpoint.method} ${route}.`,
    ``,
    `## Original Code Facts`,
    codeFacts.substring(0, 20_000),
    ``,
    `## Current Draft`,
    draft,
    ``,
    `## Instructions`,
    `Review the draft above. If any sections are missing, incomplete, or too brief, expand them.`,
    `Ensure all parameters, middleware, and business logic steps are documented.`,
    ``,
    `Return the complete revised document using the same format:`,
    `---SUMMARY---`,
    `<summary>`,
    `---DOC---`,
    `<full document>`,
    `---END---`,
  ].join('\n');
}

// ─── Model helpers ────────────────────────────────────────────────────────────

async function callModel(
  model: vscode.LanguageModelChat,
  prompt: string,
  report: ProgressReporter,
  phase: string
): Promise<string> {
  try {
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const token = new vscode.CancellationTokenSource().token;
    const response = await model.sendRequest(messages, {}, token);
    let text = '';
    for await (const chunk of response.text) {
      text += chunk;
    }
    return text.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    report(`  ✗ ${phase} failed`, msg);
    return '';
  }
}

async function callModelParsed(
  model: vscode.LanguageModelChat,
  prompt: string,
  report: ProgressReporter,
  phase: string
): Promise<EndpointDocResult> {
  const raw = await callModel(model, prompt, report, phase);
  return parseDocResult(raw);
}

function parseDocResult(raw: string): EndpointDocResult {
  const summaryMatch = raw.match(/---SUMMARY---\s*([\s\S]*?)---DOC---/);
  const docMatch     = raw.match(/---DOC---\s*([\s\S]*?)---END---/);

  const summary = summaryMatch ? summaryMatch[1].trim() : raw.split('\n')[0]?.trim() ?? '';
  const doc     = docMatch     ? docMatch[1].trim()     : raw.trim();

  return { summary, doc };
}

// ─── Source file reader ───────────────────────────────────────────────────────

function readSourceFiles(filePaths: string[], totalBudget: number = 200_000): string {
  const parts: string[] = [];
  let used = 0;

  for (const fp of filePaths) {
    if (used >= totalBudget) break;
    try {
      const content = fs.readFileSync(fp, 'utf-8');
      const remaining = totalBudget - used;
      const snippet = content.length > remaining ? content.slice(0, remaining) + '\n...[truncated]' : content;
      parts.push(`\n### File: ${fp}\n\`\`\`\n${snippet}\n\`\`\``);
      used += snippet.length;
    } catch { /* unreadable */ }
  }

  return parts.join('\n');
}
