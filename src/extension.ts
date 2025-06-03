import * as vscode from 'vscode';
import { FiltersTreeDataProvider } from './filtersTree';

export function activate(context: vscode.ExtensionContext) {
  const provider = new FiltersTreeDataProvider();

  // Register the tree in the Explorer view container with drag-and-drop support.
  const treeView = vscode.window.createTreeView('vsFilters', {
    treeDataProvider: provider,
    dragAndDropController: provider
  });

  context.subscriptions.push(
    provider, // Add provider to subscriptions for proper disposal
    treeView,
    vscode.commands.registerCommand('vsFilters.refresh', () => provider.refresh()),
    // Open file when a leaf item is clicked.
    vscode.commands.registerCommand('vsFilters.openFile', (uri: vscode.Uri) => {
      vscode.window.showTextDocument(uri);
    }),
    // Create filter command
    vscode.commands.registerCommand('vsFilters.createFilter', async (folderNode) => {
      const filterName = await vscode.window.showInputBox({
        prompt: 'Enter filter name',
        placeHolder: 'e.g., Source Files, Headers, etc.'
      });
      
      if (filterName && folderNode) {
        await provider.createFilter(folderNode, filterName);
      }
    }),
    // Delete filter command
    vscode.commands.registerCommand('vsFilters.deleteFilter', async (folderNode) => {
      if (folderNode) {
        await provider.deleteFilter(folderNode);
      }
    })
  );
}

export function deactivate() {}
