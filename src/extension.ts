import * as vscode from 'vscode';
import { FiltersTreeDataProvider } from './filtersTree';

export function activate(context: vscode.ExtensionContext) {
  const provider = new FiltersTreeDataProvider();

  // Register the tree in the Explorer view container.
  vscode.window.registerTreeDataProvider('vsFilters', provider);

  context.subscriptions.push(
    vscode.commands.registerCommand('vsFilters.refresh', () => provider.refresh()),
    // Open file when a leaf item is clicked.
    vscode.commands.registerCommand('vsFilters.openFile', (uri: vscode.Uri) => {
      vscode.window.showTextDocument(uri);
    })
  );
}

export function deactivate() {}
