/**
 * In-diff triage in the *editor* (issue #10): the flagged line carries editor
 * decorations and the finding renders as a peek-style comment thread anchored
 * to it, so a reviewer can stay in the file they are reading.
 *
 * The webview's in-diff screen is the canonical rendering and always shows —
 * this is the layer on top, and it only engages when the reviewed file is
 * genuinely open-able here: the path has to resolve inside a workspace folder
 * *and* the flagged code has to still be on (or near) the agent's line. A
 * reviewer usually reviews someone else's branch without it checked out, so
 * silence is the common, correct outcome.
 */
import * as vscode from 'vscode';
import { documentCandidates, resolveAnchor } from '../domain/anchor';
import type { ReviewItem, Verdict } from '../domain/types';

export interface InDiffAnchorTarget {
  item: ReviewItem;
  verdict?: Verdict;
  agentLabel: string;
}

/** The gutter/line treatment for the flagged line, one type per severity. */
const SEVERITY_COLORS: Record<ReviewItem['severity'], string> = {
  blocker: '#ff5f56',
  major: '#ffa657',
  minor: '#d2a8ff',
  nit: '#8b949e',
};

const VERDICT_LABEL: Record<Verdict, string> = {
  accepted: 'Accepted',
  rejected: 'Rejected',
  skipped: 'Skipped',
};

/**
 * The reviewed path is repository-relative; each workspace folder is a
 * candidate root. A hit only counts when the code the agent quoted is still
 * there — a same-named file from a different checkout must not be marked up.
 */
export async function locateInWorkspace(
  anchor: { file: string; line: number; code: string },
): Promise<{ document: vscode.TextDocument; line: number } | undefined> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const uri = vscode.Uri.joinPath(folder.uri, ...anchor.file.split('/'));
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      continue;
    }
    const resolved = resolveAnchor(documentCandidates(document.getText()), anchor);
    if (resolved.state === 'lost') continue;
    if (resolved.line < 1 || resolved.line > document.lineCount) continue;
    return { document, line: resolved.line };
  }
  return undefined;
}

export class InDiffEditor {
  private readonly decorations = new Map<ReviewItem['severity'], vscode.TextEditorDecorationType>();
  private controller?: vscode.CommentController;
  private thread?: vscode.CommentThread;
  private decorated?: vscode.TextEditor;
  private shownItemId?: string;
  private disposed = false;
  /** Generation token: opening a document is async, and `J J J` is fast. */
  private showSeq = 0;

  /**
   * Point the editor at one finding. Passing `undefined` (left triage, or the
   * mode is no longer "in diff") clears everything this class put on screen.
   *
   * A superseded call returns without touching the screen — the reviewer moved
   * on, and the newer call owns what is decorated.
   */
  async show(target?: InDiffAnchorTarget): Promise<boolean> {
    const token = ++this.showSeq;
    if (this.disposed) return false;
    if (!target) {
      this.clear();
      return false;
    }
    const located = await locateInWorkspace(target.item);
    if (this.disposed || token !== this.showSeq) return false;
    if (!located) {
      // Nothing to decorate — the file is not in this workspace, or the
      // author rewrote the flagged code away. Leave no stale marks behind.
      this.clear();
      return false;
    }
    const { document, line } = located;
    // Beside, never over: the review tab is the thing being driven, and
    // replacing it with the file would take the action bar off screen.
    const editor = await vscode.window.showTextDocument(document, {
      preview: true,
      preserveFocus: true,
      viewColumn: vscode.ViewColumn.Beside,
    });
    if (this.disposed || token !== this.showSeq) return false;
    const range = document.lineAt(line - 1).range;
    this.decorate(editor, target.item.severity, range);
    this.peek(document.uri, range, target);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.shownItemId = target.item.id;
    return true;
  }

  /** Whether the last `show` put this item on a real editor line. */
  isShowing(itemId: string): boolean {
    return this.shownItemId === itemId;
  }

  clear(): void {
    for (const [, type] of this.decorations) this.decorated?.setDecorations(type, []);
    this.decorated = undefined;
    this.shownItemId = undefined;
    this.thread?.dispose();
    this.thread = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
    for (const [, type] of this.decorations) type.dispose();
    this.decorations.clear();
    this.controller?.dispose();
    this.controller = undefined;
  }

  // ---- editor decorations ----------------------------------------------------------

  private decorationFor(severity: ReviewItem['severity']): vscode.TextEditorDecorationType {
    const existing = this.decorations.get(severity);
    if (existing) return existing;
    const color = SEVERITY_COLORS[severity];
    const type = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: `${color}1f`,
      borderWidth: '0 0 0 2px',
      borderStyle: 'solid',
      borderColor: color,
      overviewRulerColor: color,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.decorations.set(severity, type);
    return type;
  }

  private decorate(
    editor: vscode.TextEditor,
    severity: ReviewItem['severity'],
    range: vscode.Range,
  ): void {
    // Clear every severity on both editors, not just the type being set:
    // moving between findings — in this file or another — would otherwise
    // leave the previous line tinted behind us.
    for (const [, type] of this.decorations) {
      editor.setDecorations(type, []);
      this.decorated?.setDecorations(type, []);
    }
    editor.setDecorations(this.decorationFor(severity), [range]);
    this.decorated = editor;
  }

  // ---- the peek widget --------------------------------------------------------------

  private peek(uri: vscode.Uri, range: vscode.Range, target: InDiffAnchorTarget): void {
    const controller = this.commentController();
    if (!controller) return;
    // One thread at a time — the widget follows the selected finding rather
    // than papering the file with every item at once.
    this.thread?.dispose();
    const item = target.item;
    const thread = controller.createCommentThread(uri, range, [
      {
        author: { name: target.agentLabel },
        body: new vscode.MarkdownString(
          [
            `**${item.title}**`,
            '',
            item.body,
            item.suggestion
              ? ['', '_Suggested change_', '```suggestion', item.suggestion.new, '```'].join('\n')
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        ),
        mode: vscode.CommentMode.Preview,
      },
    ]);
    thread.label = [
      item.severity.toUpperCase(),
      `${item.confidence}%`,
      target.verdict ? VERDICT_LABEL[target.verdict] : 'Undecided',
    ].join(' · ');
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.thread = thread;
  }

  private commentController(): vscode.CommentController | undefined {
    if (this.controller) return this.controller;
    // Guarded: the Comments API is a stable but optional surface, and the
    // decorations alone are still worth having if it is unavailable.
    if (typeof vscode.comments?.createCommentController !== 'function') return undefined;
    this.controller = vscode.comments.createCommentController(
      'codeVerdict.review',
      'Verdict review',
    );
    return this.controller;
  }
}
