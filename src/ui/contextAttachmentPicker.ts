import * as vscode from 'vscode';
import {
  inclusiveAttachmentRange,
  resolveAttachment,
  type FileAttachmentTarget,
  type SymbolAttachmentTarget,
} from '../app/attachments';
import {
  labelledWorkspaceRoots,
  modelVisiblePathForUri,
  type ModelVisibleWorkspaceRoot,
} from '../app/modelVisiblePath';
import type { Attachment, AttachmentRange } from '../app/reviewContext';
import { CONTEXT_PICKER_CHOICES, CONTEXT_PICKER_PLACEHOLDER } from './contextPicker';

export function modelVisibleWorkspaceRoots(): ModelVisibleWorkspaceRoot[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    path: folder.uri.path,
    sourceUri: folder.uri.toString(true),
  }));
}

export function attachmentRange(selection: vscode.Selection): AttachmentRange {
  return inclusiveAttachmentRange(selection.start, selection.end);
}

export function attachmentFileTarget(uri: vscode.Uri): FileAttachmentTarget {
  return {
    uri,
    workspacePath: modelVisiblePathForUri(
      uri.path,
      vscode.workspace.asRelativePath(uri, false),
      modelVisibleWorkspaceRoots(),
    ),
  };
}

/** Resolve a canonical root-qualified path within that root; otherwise require one global match. */
export async function findReferenceFile(name: string): Promise<FileAttachmentTarget | undefined> {
  const normalized = name.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) return undefined;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const labelledRoots = labelledWorkspaceRoots(modelVisibleWorkspaceRoots());
  const qualifiedRootIndex = labelledRoots.findIndex((root) => normalized.startsWith(`${root.label}/`));
  if (qualifiedRootIndex >= 0) {
    const folder = folders[qualifiedRootIndex];
    const root = labelledRoots[qualifiedRootIndex];
    const relativePath = root ? normalized.slice(root.label.length + 1) : '';
    if (!folder || relativePath === '') return undefined;
    const matches = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, relativePath), undefined, 2);
    return matches.length === 1 ? attachmentFileTarget(matches[0] as vscode.Uri) : undefined;
  }
  const matches = await vscode.workspace.findFiles(`**/${normalized}`, undefined, 2);
  return matches.length === 1 ? attachmentFileTarget(matches[0] as vscode.Uri) : undefined;
}

async function pickSymbol(): Promise<Attachment | undefined> {
  const query = await vscode.window.showInputBox({ placeHolder: 'Search symbols' });
  if (!query?.trim()) return undefined;
  const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    'vscode.executeWorkspaceSymbolProvider',
    query.trim(),
  ) ?? [];
  const picked = await vscode.window.showQuickPick(
    symbols.slice(0, 100).map((symbol) => ({
      label: symbol.name,
      description: attachmentFileTarget(symbol.location.uri).workspacePath,
      symbol,
    })),
    { placeHolder: 'Search symbols' },
  );
  if (!picked) return undefined;
  const target: SymbolAttachmentTarget = {
    ...attachmentFileTarget(picked.symbol.location.uri),
    name: picked.symbol.name,
    range: attachmentRange(new vscode.Selection(
      picked.symbol.location.range.start,
      picked.symbol.location.range.end,
    )),
  };
  return resolveAttachment('symbol', target);
}

export async function pickContextAttachment(): Promise<Attachment | undefined> {
  const choice = await vscode.window.showQuickPick(
    CONTEXT_PICKER_CHOICES.map((candidate) => ({ ...candidate })),
    { placeHolder: CONTEXT_PICKER_PLACEHOLDER },
  );
  if (!choice) return undefined;
  if (choice.attachmentKind === 'file' || choice.attachmentKind === 'folder') {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: choice.attachmentKind === 'file',
      canSelectFolders: choice.attachmentKind === 'folder',
      canSelectMany: false,
      openLabel: 'Add Context',
    });
    const uri = picked?.[0];
    return uri ? resolveAttachment(choice.attachmentKind, attachmentFileTarget(uri)) : undefined;
  }
  if (choice.attachmentKind === 'selection') {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage('Verdict: select editor text before attaching the current selection.');
      return undefined;
    }
    return resolveAttachment('selection', {
      ...attachmentFileTarget(editor.document.uri),
      range: attachmentRange(editor.selection),
    });
  }
  if (choice.attachmentKind === 'symbol') return pickSymbol();
  if (choice.attachmentKind === 'problems') return resolveAttachment('problems', {});
  const text = await vscode.env.clipboard.readText();
  if (!text) {
    void vscode.window.showInformationMessage('Verdict: the clipboard contains no text to attach.');
    return undefined;
  }
  return resolveAttachment('pasted', { text });
}