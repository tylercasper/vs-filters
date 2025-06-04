import * as vscode from 'vscode';
import * as path from 'path';
import { FiltersTreeDataProvider } from './filtersTree';

let fileClipboard: { uri: vscode.Uri; isCut: boolean } | null = null;

function updateContextVariables(treeView: vscode.TreeView<any>) {
  const selection = treeView.selection;
  const hasSelection = selection && selection.length > 0;
  const selectedItem = hasSelection ? selection[0] : null;
  const isFileSelected = selectedItem?.contextValue === 'file';
  
  vscode.commands.executeCommand('setContext', 'vsFilters.canCopyFile', isFileSelected);
  vscode.commands.executeCommand('setContext', 'vsFilters.canCutFile', isFileSelected);
  vscode.commands.executeCommand('setContext', 'vsFilters.canDeleteFile', isFileSelected);
  vscode.commands.executeCommand('setContext', 'vsFilters.canRenameFile', isFileSelected);
  vscode.commands.executeCommand('setContext', 'vsFilters.canPaste', fileClipboard !== null);
}


function clearClipboard(treeView: vscode.TreeView<any>) {
  fileClipboard = null;
  updateContextVariables(treeView);
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new FiltersTreeDataProvider();

  // Register the tree in the Explorer view container with drag-and-drop support.
  const treeView = vscode.window.createTreeView('vsFilters', {
    treeDataProvider: provider,
    dragAndDropController: provider,
    showCollapseAll: true,
    canSelectMany: false
  });

  const selectionHandler = treeView.onDidChangeSelection((e) => {
    updateContextVariables(treeView);
  });

  updateContextVariables(treeView);

  const expandRootFilters = async () => {
    try {
      const rootNodes = await provider.getChildren();
      for (const rootNode of rootNodes) {
        await treeView.reveal(rootNode, { expand: true, select: false, focus: false });
      }
    } catch (error) {
    }
  };

  const treeDataChangeHandler = provider.onDidChangeTreeData(() => {
    setTimeout(expandRootFilters, 500);
  });

  setTimeout(expandRootFilters, 2000);

  context.subscriptions.push(
    provider,
    treeView,
    selectionHandler,
    treeDataChangeHandler,
    vscode.commands.registerCommand('vsFilters.refresh', () => provider.refresh()),
    // Open file when a leaf item is clicked.
    vscode.commands.registerCommand('vsFilters.openFile', async (uri: vscode.Uri) => {
      // Open the file without stealing focus
      await vscode.window.showTextDocument(uri, { preserveFocus: true });
    }),
    vscode.commands.registerCommand('vsFilters.openToSide', async (fileNode: any) => {
      // Context menu commands receive the tree item, we need to get the URI
      const uri = fileNode?.resourceUri || fileNode?.uri || fileNode;
      if (uri) {
        // Open to the side and leave focus on the editor (user's intent)
        await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside });
      }
    }),
    vscode.commands.registerCommand('vsFilters.createFilter', async (folderNode) => {
      const filterName = await vscode.window.showInputBox({
        prompt: 'Enter filter name',
        placeHolder: 'e.g., Source Files, Headers, etc.'
      });
      
      if (filterName && folderNode) {
        await provider.createFilter(folderNode, filterName);
      }
    }),
    vscode.commands.registerCommand('vsFilters.deleteFilter', async (folderNode) => {
      if (folderNode) {
        await provider.deleteFilter(folderNode);
      }
    }),
    vscode.commands.registerCommand('vsFilters.openWith', async (fileNode: any) => {
      const uri = fileNode?.resourceUri || fileNode?.uri || fileNode;
      if (uri) {
        try {
          await vscode.commands.executeCommand('vscode.openWith', uri);
        } catch (error) {
          console.error('Open With error:', error);
          await vscode.window.showTextDocument(uri);
        }
      }
    }),
    vscode.commands.registerCommand('vsFilters.openInTerminal', async (fileNode: any) => {
      const uri = fileNode?.resourceUri || fileNode?.uri || fileNode;
      if (uri) {
        const dirPath = path.dirname(uri.fsPath);
        const terminal = vscode.window.createTerminal({
          name: `Terminal - ${path.basename(dirPath)}`,
          cwd: dirPath
        });
        terminal.show();
      }
    }),
    vscode.commands.registerCommand('vsFilters.revealInExplorer', async (fileNode: any) => {
      const uri = fileNode?.resourceUri || fileNode?.uri || fileNode;
      if (uri) {
        await vscode.commands.executeCommand('revealFileInOS', uri);
      }
    }),
    vscode.commands.registerCommand('vsFilters.copyPath', async (fileNode: any) => {
      const uri = fileNode?.resourceUri || fileNode?.uri || fileNode;
      if (uri) {
        await vscode.env.clipboard.writeText(uri.fsPath);
        vscode.window.showInformationMessage('Path copied to clipboard');
      }
    }),
    vscode.commands.registerCommand('vsFilters.copyRelativePath', async (fileNode: any) => {
      const uri = fileNode?.resourceUri || fileNode?.uri || fileNode;
      if (uri) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (workspaceFolder) {
          const relativePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
          await vscode.env.clipboard.writeText(relativePath);
          vscode.window.showInformationMessage('Relative path copied to clipboard');
        }
      }
    }),
    vscode.commands.registerCommand('vsFilters.cut', async (fileNode: any) => {
      if (!fileNode) {
        const selection = treeView.selection;
        if (selection && selection.length > 0) {
          fileNode = selection[0];
        } else {
          vscode.window.showErrorMessage('No file selected to cut');
          return;
        }
      }

      const uri = fileNode?.resourceUri || fileNode?.uri || fileNode;
      if (uri && fileNode?.contextValue === 'file') {
        try {
          fileClipboard = { uri, isCut: true };
          updateContextVariables(treeView);
          const fileName = path.basename(uri.fsPath);
          vscode.window.showInformationMessage(`${fileName} cut to clipboard`);
        } catch (error) {
          console.error('Cut command error:', error);
          vscode.window.showErrorMessage('Failed to cut file');
        }
      } else {
        vscode.window.showErrorMessage('Can only cut files, not folders');
      }
    }),
    vscode.commands.registerCommand('vsFilters.copy', async (fileNode: any) => {
      if (!fileNode) {
        const selection = treeView.selection;
        if (selection && selection.length > 0) {
          fileNode = selection[0];
        } else {
          vscode.window.showErrorMessage('No file selected to copy');
          return;
        }
      }

      const uri = fileNode?.resourceUri || fileNode?.uri || fileNode;
      if (uri && fileNode?.contextValue === 'file') {
        try {
          fileClipboard = { uri, isCut: false };
          updateContextVariables(treeView);
          const fileName = path.basename(uri.fsPath);
          vscode.window.showInformationMessage(`${fileName} copied to clipboard`);
        } catch (error) {
          console.error('Copy command error:', error);
          vscode.window.showErrorMessage('Failed to copy file');
        }
      } else {
        vscode.window.showErrorMessage('Can only copy files, not folders');
      }
    }),
    vscode.commands.registerCommand('vsFilters.paste', async (node: any) => {
      if (!fileClipboard) {
        vscode.window.showWarningMessage('Nothing to paste');
        return;
      }

      if (!node) {
        const selection = treeView.selection;
        if (selection && selection.length > 0) {
          node = selection[0];
        } else {
          vscode.window.showErrorMessage('No item selected for paste target');
          return;
        }
      }

      const targetUri = node?.resourceUri || node?.uri || node;
      if (!targetUri) {
        vscode.window.showErrorMessage('Invalid paste target');
        return;
      }

      try {
        // Always paste into the workspace root directory, never into filter virtual directories
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri) || 
                                vscode.workspace.getWorkspaceFolder(fileClipboard.uri);
        if (!workspaceFolder) {
          vscode.window.showErrorMessage('Could not determine workspace folder');
          return;
        }

        let destinationDir = workspaceFolder.uri;
        
        // If pasting relative to a file, use its parent directory
        if (node?.contextValue === 'file') {
          const realFileDir = path.dirname(targetUri.fsPath);
          // Only use the file's directory if it's a real directory (not a virtual filter path)
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(realFileDir));
            destinationDir = vscode.Uri.file(realFileDir);
          } catch {
            // File's directory doesn't exist (virtual filter), use workspace root
            destinationDir = workspaceFolder.uri;
          }
        }

        const sourceFileName = path.basename(fileClipboard.uri.fsPath);
        let destinationPath = vscode.Uri.joinPath(destinationDir, sourceFileName);

        // Generate unique filename if destination already exists using repeated "copy"
        try {
          await vscode.workspace.fs.stat(destinationPath);
          const parsedPath = path.parse(sourceFileName);
          let copyCount = 1;
          let newFileName: string;
          
          do {
            const suffix = ' copy'.repeat(copyCount);
            newFileName = `${parsedPath.name}${suffix}${parsedPath.ext}`;
            destinationPath = vscode.Uri.joinPath(destinationDir, newFileName);
            
            try {
              await vscode.workspace.fs.stat(destinationPath);
              copyCount++;
            } catch {
              // File doesn't exist, we can use this name
              break;
            }
          } while (copyCount < 20); // Safety limit
        } catch {
          // File doesn't exist, which is fine - use original name
        }

        const finalFileName = path.basename(destinationPath.fsPath);
        
        // Check if source file still exists before attempting to paste
        try {
          await vscode.workspace.fs.stat(fileClipboard.uri);
        } catch (error) {
          clearClipboard(treeView);
          vscode.window.showErrorMessage('Source file no longer exists');
          return;
        }

        if (fileClipboard.isCut) {
          await vscode.workspace.fs.rename(fileClipboard.uri, destinationPath);
          if (finalFileName !== sourceFileName) {
            vscode.window.showInformationMessage(`${sourceFileName} moved as ${finalFileName}`);
          } else {
            vscode.window.showInformationMessage(`${finalFileName} moved`);
          }
          clearClipboard(treeView);
        } else {
          await vscode.workspace.fs.copy(fileClipboard.uri, destinationPath, { overwrite: true });
          if (finalFileName !== sourceFileName) {
            vscode.window.showInformationMessage(`${sourceFileName} copied as ${finalFileName}`);
          } else {
            vscode.window.showInformationMessage(`${finalFileName} copied`);
          }
        }

        // Apply filter logic based on current selection context
        let targetFilter: string | undefined;
        
        // Determine target filter based on current selection
        if (node?.contextValue === 'folder') {
          // Pasting into a specific filter folder
          targetFilter = await provider.getFilterPathFromNode(node);
        } else if (node?.contextValue === 'unfilteredFolder') {
          // Pasting into unfiltered folder - explicitly remove filter
          targetFilter = '';
        } else if (node?.contextValue === 'file') {
          // Pasting next to a file - use that file's filter
          targetFilter = await provider.getFileFilter(targetUri);
        }
        // If no specific context, file will remain unfiltered (in workspace root)
        
        // Apply the determined filter
        if (targetFilter) {
          try {
            await provider.moveFileToFilterPath(destinationPath, targetFilter);
          } catch (error) {
            console.error('Failed to apply filter to pasted file:', error);
            // Don't show error to user as the file was still pasted successfully
          }
        }

        updateContextVariables(treeView);
        provider.refresh();
      } catch (error) {
        console.error('Paste command error:', error);
        vscode.window.showErrorMessage(`Failed to paste file: ${error}`);
      }
    }),
    vscode.commands.registerCommand('vsFilters.deleteFile', async (fileNode: any) => {
      if (!fileNode) {
        const selection = treeView.selection;
        if (selection && selection.length > 0) {
          fileNode = selection[0];
        } else {
          vscode.window.showErrorMessage('No file selected to delete');
          return;
        }
      }

      const uri = fileNode?.resourceUri || fileNode?.uri || fileNode;
      if (uri && fileNode?.contextValue === 'file') {
        const fileName = path.basename(uri.fsPath);
        const result = await vscode.window.showWarningMessage(
          `Are you sure you want to delete '${fileName}'?`,
          'Delete', 'Cancel'
        );
        if (result === 'Delete') {
          try {
            if (fileClipboard && fileClipboard.uri.fsPath === uri.fsPath) {
              clearClipboard(treeView);
            }
            
            await vscode.workspace.fs.delete(uri, { useTrash: true });
            
            await provider.deleteFileFromFilters(uri);
            
            updateContextVariables(treeView);
            provider.refresh();
            vscode.window.showInformationMessage(`${fileName} deleted`);
          } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete file: ${error}`);
          }
        }
      } else {
        vscode.window.showErrorMessage('Can only delete files, not folders');
      }
    }),
    vscode.commands.registerCommand('vsFilters.renameFile', async (fileNode: any) => {
      if (!fileNode) {
        const selection = treeView.selection;
        if (selection && selection.length > 0) {
          fileNode = selection[0];
        } else {
          vscode.window.showErrorMessage('No file selected to rename');
          return;
        }
      }

      const uri = fileNode?.resourceUri || fileNode?.uri || fileNode;
      if (uri && fileNode?.contextValue === 'file') {
        const oldName = path.basename(uri.fsPath);
        const newName = await vscode.window.showInputBox({
          prompt: 'Enter new name',
          value: oldName,
          validateInput: (value) => {
            if (!value || value.trim() === '') {
              return 'Name cannot be empty';
            }
            return null;
          }
        });
        
        if (newName && newName !== oldName) {
          const newUri = vscode.Uri.file(path.join(path.dirname(uri.fsPath), newName));
          try {
            if (fileClipboard && fileClipboard.uri.fsPath === uri.fsPath) {
              fileClipboard.uri = newUri;
            }
            
            await vscode.workspace.fs.rename(uri, newUri);
            
            await provider.renameFileInFilters(uri, newUri);
            
            updateContextVariables(treeView);
            provider.refresh();
            vscode.window.showInformationMessage(`Renamed ${oldName} to ${newName}`);
          } catch (error) {
            vscode.window.showErrorMessage(`Failed to rename file: ${error}`);
          }
        }
      } else {
        vscode.window.showErrorMessage('Can only rename files, not folders');
      }
    }),
    vscode.commands.registerCommand('vsFilters.focus', async () => {
      try {
        // Focus the tree view directly without switching explorer views
        if (treeView.selection && treeView.selection.length > 0) {
          await treeView.reveal(treeView.selection[0], { focus: true, select: false });
        } else {
          // If no selection, we need to ensure the explorer is visible first
          await vscode.commands.executeCommand('workbench.view.explorer');
        }
      } catch (error) {
      }
    })
  );
}

export function deactivate() {
  fileClipboard = null;
  vscode.commands.executeCommand('setContext', 'vsFilters.canCopyFile', false);
  vscode.commands.executeCommand('setContext', 'vsFilters.canCutFile', false);
  vscode.commands.executeCommand('setContext', 'vsFilters.canDeleteFile', false);
  vscode.commands.executeCommand('setContext', 'vsFilters.canRenameFile', false);
  vscode.commands.executeCommand('setContext', 'vsFilters.canPaste', false);
}
