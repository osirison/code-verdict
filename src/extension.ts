import * as vscode from 'vscode';
import { ALL_COMMAND_IDS } from './commands';

export function activate(context: vscode.ExtensionContext): void {
  for (const id of ALL_COMMAND_IDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => {
        void vscode.window.showInformationMessage(
          `Verdict: "${id}" is not implemented yet — the extension is under construction.`,
        );
      }),
    );
  }
}

export function deactivate(): void {}
