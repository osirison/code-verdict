import * as vscode from 'vscode';
import { ALL_COMMAND_IDS } from './commands';
import { registerBuiltInProviders } from './registry';

export function activate(context: vscode.ExtensionContext): void {
  registerBuiltInProviders();
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
