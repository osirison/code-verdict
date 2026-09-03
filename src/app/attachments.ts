import * as vscode from 'vscode';
import {
  ATTACHMENT_TOTAL_BUDGET,
  type Attachment,
  type AttachmentEvidenceSource,
  type AttachmentKind,
  type AttachmentRange,
} from './reviewContext';
import { modelVisiblePathForUri, type ModelVisibleWorkspaceRoot } from './modelVisiblePath';

export interface AttachmentUri {
  readonly path: string;
  toString(skipEncoding?: boolean): string;
}

export interface AttachmentFileSystem {
  readFile(uri: AttachmentUri): Promise<Uint8Array>;
  readDirectory(uri: AttachmentUri): Promise<readonly [string, number][]>;
  stat(uri: AttachmentUri): Promise<{ size: number }>;
}

export interface AttachmentResolverDeps {
  fs: AttachmentFileSystem;
  joinPath(base: AttachmentUri, ...parts: string[]): AttachmentUri;
  parseUri(value: string): AttachmentUri;
  getDiagnostics(): readonly AttachmentDiagnostic[];
  fileType: { file: number; directory: number };
}

export interface FileAttachmentTarget {
  uri: AttachmentUri;
  /** Workspace-relative path used in the prompt and finding validation. */
  workspacePath: string;
}

export interface FolderAttachmentTarget extends FileAttachmentTarget {
  maxDepth?: number;
  maxFiles?: number;
  maxDirectories?: number;
  contentBudget?: number;
}

export interface SelectionAttachmentTarget extends FileAttachmentTarget {
  range: AttachmentRange;
}

export interface SymbolAttachmentTarget extends SelectionAttachmentTarget {
  name: string;
}

export interface AttachmentDiagnostic {
  workspacePath: string;
  range: AttachmentRange;
  severity: string;
  message: string;
  source?: string;
  code?: string | number;
}

export function inclusiveAttachmentRange(
  start: { line: number },
  end: { line: number; character: number },
): AttachmentRange {
  const endLine = end.character === 0 && end.line > start.line
    ? end.line
    : end.line + 1;
  return { startLine: start.line + 1, endLine };
}

export interface ProblemsAttachmentTarget {
  diagnostics?: readonly AttachmentDiagnostic[];
  label?: string;
}

export interface PastedAttachmentTarget {
  text: string;
  label?: string;
  path?: string;
}

export type AttachmentTarget =
  | FileAttachmentTarget
  | FolderAttachmentTarget
  | SelectionAttachmentTarget
  | SymbolAttachmentTarget
  | ProblemsAttachmentTarget
  | PastedAttachmentTarget;

export interface AttachmentWarning {
  code: 'attachment-unreadable';
  attachmentId: string;
  label: string;
  path: string;
  reason: string;
}

export interface RevalidatedAttachments {
  attachments: Attachment[];
  warnings: AttachmentWarning[];
}

export const DEFAULT_FOLDER_MAX_DEPTH = 4;
export const DEFAULT_FOLDER_MAX_FILES = 50;
export const DEFAULT_FOLDER_MAX_DIRECTORIES = 100;

const FOLDER_TRUNCATION_MARKER = '[Folder attachment truncated: additional files were not included.]';

function defaultDeps(): AttachmentResolverDeps {
  const workspaceRoots = (): ModelVisibleWorkspaceRoot[] => (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    path: folder.uri.path,
  }));
  return {
    fs: {
      readFile: (uri) => Promise.resolve(vscode.workspace.fs.readFile(uri as vscode.Uri)),
      readDirectory: (uri) => Promise.resolve(vscode.workspace.fs.readDirectory(uri as vscode.Uri)),
      stat: (uri) => Promise.resolve(vscode.workspace.fs.stat(uri as vscode.Uri)),
    },
    joinPath: (base, ...parts) => vscode.Uri.joinPath(base as vscode.Uri, ...parts),
    parseUri: (value) => vscode.Uri.parse(value),
    getDiagnostics: () => vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) => diagnostics.map((diagnostic) => ({
      workspacePath: modelVisiblePathForUri(
        uri.path,
        vscode.workspace.asRelativePath(uri, false),
        workspaceRoots(),
      ),
      range: inclusiveAttachmentRange(diagnostic.range.start, diagnostic.range.end),
      severity: vscode.DiagnosticSeverity[diagnostic.severity].toLowerCase(),
      message: diagnostic.message,
      source: diagnostic.source,
      code: typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code,
    }))),
    fileType: { file: vscode.FileType.File, directory: vscode.FileType.Directory },
  };
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? path;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function sourceUri(target: FileAttachmentTarget): string {
  return target.uri.toString(true);
}

function rangeLabel(range: AttachmentRange): string {
  return `${range.startLine}-${range.endLine}`;
}

function assertRange(range: AttachmentRange): void {
  if (
    !Number.isInteger(range.startLine)
    || !Number.isInteger(range.endLine)
    || range.startLine < 1
    || range.endLine < range.startLine
  ) {
    throw new Error(`invalid attachment range: ${range.startLine}-${range.endLine}`);
  }
}

function selectLines(content: string, range: AttachmentRange): string {
  assertRange(range);
  return content.split(/\r?\n/).slice(range.startLine - 1, range.endLine).join('\n');
}

function representedLineCount(content: string): number {
  return content === '' ? 0 : content.split(/\r?\n/).length;
}

function fileAttachment(
  kind: 'file' | 'selection' | 'symbol',
  target: FileAttachmentTarget | SelectionAttachmentTarget | SymbolAttachmentTarget,
  content: string,
): Attachment {
  const path = normalizePath(target.workspacePath);
  const range = kind === 'file' ? undefined : (target as SelectionAttachmentTarget).range;
  const name = basename(path);
  const symbolName = kind === 'symbol' ? (target as SymbolAttachmentTarget).name : undefined;
  const label = symbolName
    ? `${symbolName} (${path}:${rangeLabel(range as AttachmentRange)})`
    : range
      ? `${path}:${rangeLabel(range)}`
      : path;
  const baseId = symbolName ?? name;
  const selectedContent = range ? selectLines(content, range) : content;
  const startLine = range?.startLine ?? 1;
  const visibleLines = representedLineCount(selectedContent);
  return {
    id: baseId,
    baseId,
    kind,
    label,
    path,
    range,
    content: selectedContent,
    truncated: false,
    sourceUri: sourceUri(target),
    evidence: visibleLines > 0
      ? [{
          path,
          range: { startLine, endLine: startLine + visibleLines - 1 },
          contentStart: 0,
          contentEnd: selectedContent.length,
        }]
      : [],
  };
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum
    ? Math.floor(value)
    : fallback;
}

function diagnosticRecords(diagnostics: readonly AttachmentDiagnostic[]): Array<{
  content: string;
  evidence: AttachmentEvidenceSource;
}> {
  let contentOffset = 0;
  return [...diagnostics]
    .sort((left, right) => (
      left.workspacePath.localeCompare(right.workspacePath)
      || left.range.startLine - right.range.startLine
      || left.range.endLine - right.range.endLine
      || left.message.localeCompare(right.message)
    ))
    .map((diagnostic) => {
      assertRange(diagnostic.range);
      const origin = [diagnostic.source, diagnostic.code].filter((part) => part !== undefined).join(' ');
      const path = normalizePath(diagnostic.workspacePath);
      const content = `${path}:${rangeLabel(diagnostic.range)} [${diagnostic.severity}]${origin ? ` ${origin}` : ''}: ${diagnostic.message}`;
      const record = {
        content,
        evidence: {
          path,
          range: { ...diagnostic.range },
          contentStart: contentOffset,
          contentEnd: contentOffset + content.length,
          wholeRange: true,
        },
      };
      contentOffset += content.length + 1;
      return record;
    });
}

async function resolveFolder(
  target: FolderAttachmentTarget,
  deps: AttachmentResolverDeps,
): Promise<Attachment> {
  const budget = boundedInteger(target.contentBudget, ATTACHMENT_TOTAL_BUDGET, 1);
  const maxDepth = boundedInteger(target.maxDepth, DEFAULT_FOLDER_MAX_DEPTH, 0);
  const maxFiles = boundedInteger(target.maxFiles, DEFAULT_FOLDER_MAX_FILES, 1);
  const maxDirectories = boundedInteger(target.maxDirectories, DEFAULT_FOLDER_MAX_DIRECTORIES, 1);
  const path = normalizePath(target.workspacePath).replace(/\/$/, '');
  const chunks: string[] = [];
  const evidence: AttachmentEvidenceSource[] = [];
  const includedUris: string[] = [];
  const usableBudget = Math.max(0, budget - FOLDER_TRUNCATION_MARKER.length - 1);
  let used = 0;
  let bytesRead = 0;
  let filesConsidered = 0;
  let directoriesRead = 0;
  let truncated = false;

  const visit = async (uri: AttachmentUri, relativePath: string, depth: number): Promise<void> => {
    if (directoriesRead >= maxDirectories) {
      truncated = true;
      return;
    }
    directoriesRead += 1;
    let entries: readonly [string, number][];
    try {
      entries = await deps.fs.readDirectory(uri);
    } catch {
      truncated = true;
      return;
    }
    for (const [name, type] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
      const child = deps.joinPath(uri, name);
      const childRelative = relativePath ? `${relativePath}/${name}` : name;
      if (type === deps.fileType.directory) {
        if (depth >= maxDepth) truncated = true;
        else await visit(child, childRelative, depth + 1);
        continue;
      }
      if (type !== deps.fileType.file) continue;
      if (filesConsidered >= maxFiles) {
        truncated = true;
        continue;
      }
      filesConsidered += 1;
      const header = `--- ${path}/${childRelative}\n`;
      const separator = chunks.length > 0 ? '\n\n' : '';
      const remaining = usableBudget - used - header.length - separator.length;
      if (remaining < 0) {
        truncated = true;
        continue;
      }
      try {
        const stat = await deps.fs.stat(child);
        if (stat.size > remaining || stat.size > budget - bytesRead) {
          truncated = true;
          continue;
        }
        const bytes = await deps.fs.readFile(child);
        bytesRead += bytes.byteLength;
        if (bytes.byteLength > remaining || bytesRead > budget) {
          truncated = true;
          continue;
        }
        const content = new TextDecoder().decode(bytes);
        if (content.includes('\0') || content.length > remaining) {
          truncated = true;
          continue;
        }
        const chunk = `${separator}${header}${content}`;
        const contentStart = used + separator.length + header.length;
        chunks.push(chunk);
        includedUris.push(child.toString(true));
        const lines = representedLineCount(content);
        if (lines > 0) {
          evidence.push({
            path: `${path}/${childRelative}`,
            range: { startLine: 1, endLine: lines },
            contentStart,
            contentEnd: contentStart + content.length,
          });
        }
        used += chunk.length;
      } catch {
        truncated = true;
      }
    }
  };

  await visit(target.uri, '', 0);
  const body = chunks.join('');
  const content = truncated
    ? FOLDER_TRUNCATION_MARKER.length <= budget
      ? `${body}${body ? '\n' : ''}${FOLDER_TRUNCATION_MARKER}`
      : body
    : body || ('[Folder contained no readable files.]'.length <= budget ? '[Folder contained no readable files.]' : '');
  const baseId = basename(path);
  return {
    id: baseId,
    baseId,
    kind: 'folder',
    label: path,
    path,
    content,
    truncated,
    sourceUri: sourceUri(target),
    sourceUris: includedUris,
    evidence,
  };
}

/** Resolve and cache reviewable evidence at the moment the reviewer attaches it. */
export async function resolveAttachment(
  kind: AttachmentKind,
  target: AttachmentTarget,
  deps: AttachmentResolverDeps = defaultDeps(),
): Promise<Attachment> {
  if (kind === 'folder') return resolveFolder(target as FolderAttachmentTarget, deps);
  if (kind === 'problems') {
    const problems = target as ProblemsAttachmentTarget;
    const diagnostics = problems.diagnostics ?? deps.getDiagnostics();
    const records = diagnosticRecords(diagnostics);
    return {
      id: 'problems',
      baseId: 'problems',
      kind,
      label: problems.label ?? 'Problems',
      path: 'problems',
      content: records.map((record) => record.content).join('\n') || '[No current problems.]',
      truncated: false,
      evidence: records.map((record) => record.evidence),
    };
  }
  if (kind === 'pasted') {
    const pasted = target as PastedAttachmentTarget;
    const key = pasted.path ?? `pasted:${stableHash(pasted.text)}`;
    return {
      id: basename(key),
      baseId: basename(key),
      kind,
      label: pasted.label ?? 'Pasted text',
      path: key,
      content: pasted.text,
      truncated: false,
    };
  }

  const fileTarget = target as FileAttachmentTarget;
  const content = new TextDecoder().decode(await deps.fs.readFile(fileTarget.uri));
  return fileAttachment(kind, fileTarget, content);
}

/** Canonical URI plus an inclusive line range is the identity of filesystem evidence. */
export function attachmentKey(attachment: Attachment): string {
  const source = attachment.sourceUri ?? normalizePath(attachment.path);
  const range = attachment.range ? `:${attachment.range.startLine}-${attachment.range.endLine}` : '';
  return `${source}${range}`;
}

/** Keep first-attached cached content, then assign stable ids and distinguishing labels. */
export function deduplicateAttachments(attachments: readonly Attachment[]): Attachment[] {
  const byKey = new Map<string, Attachment>();
  for (const attachment of attachments) {
    const key = attachmentKey(attachment);
    if (!byKey.has(key)) byKey.set(key, attachment);
  }
  const unique = [...byKey.values()];
  const groups = new Map<string, Attachment[]>();
  for (const attachment of unique) {
    const baseId = attachment.baseId ?? attachment.id;
    const group = groups.get(baseId) ?? [];
    group.push(attachment);
    groups.set(baseId, group);
  }

  const identities = new Map<string, { id: string; label: string }>();
  for (const [baseId, group] of groups) {
    if (group.length === 1) continue;
    [...group].sort((left, right) => attachmentKey(left).localeCompare(attachmentKey(right)))
      .forEach((attachment, index) => {
        const suffix = index + 1;
        identities.set(attachmentKey(attachment), {
          id: `${baseId}-${suffix}`,
          label: attachment.label,
        });
      });
  }

  return unique.map((attachment) => ({ ...attachment, ...identities.get(attachmentKey(attachment)) }));
}

/** Re-read only at run start to prove cached filesystem evidence is still readable. */
export async function revalidateAttachments(
  attachments: readonly Attachment[],
  deps?: AttachmentResolverDeps,
): Promise<RevalidatedAttachments> {
  const readable: Attachment[] = [];
  const warnings: AttachmentWarning[] = [];
  for (const attachment of attachments) {
    const sources = attachment.sourceUris && attachment.sourceUris.length > 0
      ? attachment.sourceUris
      : attachment.sourceUri
        ? [attachment.sourceUri]
        : [];
    try {
      const resolverDeps = sources.length > 0 || (attachment.kind === 'folder' && attachment.sourceUri)
        ? deps ?? defaultDeps()
        : undefined;
      for (const source of sources) await resolverDeps?.fs.readFile(resolverDeps.parseUri(source));
      if (attachment.kind === 'folder' && sources.length === 0 && attachment.sourceUri) {
        await resolverDeps?.fs.readDirectory(resolverDeps.parseUri(attachment.sourceUri));
      }
      readable.push(attachment);
    } catch (error) {
      warnings.push({
        code: 'attachment-unreadable',
        attachmentId: attachment.id,
        label: attachment.label,
        path: attachment.path,
        reason: error instanceof Error ? error.message : 'The attachment could not be read.',
      });
    }
  }
  return { attachments: readable, warnings };
}