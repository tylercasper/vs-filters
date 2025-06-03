// src/filtersTree.ts

import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * The TreeDataProvider that builds a separate "VS Filters" view per workspace folder.
 * In a multi-root workspace, each folder's .vcxproj.filters tree appears as its own branch.
 */
export class FiltersTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cache: for each workspace folder path (fsPath), store its root FolderNode. */
  private trees = new Map<string, FolderNode>();

  constructor() {
    // (Optional) Watch for any .vcxproj.filters file changes and auto-refresh:
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.vcxproj.filters');
    watcher.onDidChange(() => this.refresh());
    watcher.onDidCreate(() => this.refresh());
    watcher.onDidDelete(() => this.refresh());
  }

  /** Called when the user triggers "Refresh VS Filters" */
  refresh(): void {
    this.trees.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * getChildren is called by VS Code when it needs to know:
   *  - If element===undefined, "list me the top‐level nodes."
   *  - If element is a FolderNode or FileNode, "list me its children."
   */
  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    // 1) If there's no workspace open, return empty.
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return [];
    }

    // 2) If element is undefined, we need to return one node per workspace folder.
    if (!element) {
      // Each workspace folder becomes a top‐level FolderNode that can be expanded
      // to show filters under that folder.
      return folders.map((wf) => {
        // If we've already built the tree for this folder, return its root.
        if (this.trees.has(wf.uri.fsPath)) {
          return this.trees.get(wf.uri.fsPath)!;
        }
        // Otherwise, create a new "stub" root node; children populated when expanded.
        const root = new FolderNode(wf.uri, path.basename(wf.uri.fsPath));
        this.trees.set(wf.uri.fsPath, root);
        return root;
      });
    }

    // 3) If the element is a FolderNode, return its children (either file-nodes or subfolder-nodes).
    if (element instanceof FolderNode) {
      // If this FolderNode has already been populated, just return the cached children.
      if (element.populated) {
        this.sortChildren(element.children);
        return element.children;
      }

      // Otherwise, build/populate for the first time:
      //   - If this FolderNode is the workspace root, parse .filters and build subtrees.
      //   - If it's a deeper folder, it already exists as a child of its parent.
      const fsPath = element.uri.fsPath;
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(element.uri);
      if (workspaceFolder && fsPath === workspaceFolder.uri.fsPath) {
        // We are expanding the **workspace root** node.  Build its filter‐tree only once.
        const fullTree = await this.buildTree(workspaceFolder.uri);
        // "fullTree" is a FolderNode whose uri/fsPath is the workspace folder itself.
        // Grab its immediate children and assign them under `element.children`.
        element.children = fullTree.children;
        // Update the cache with the fully populated tree
        this.trees.set(fsPath, element);
      }

      element.populated = true;
      this.sortChildren(element.children);
      return element.children;
    }

    // 4) If the element is a FileNode, it has no children.
    return [];
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  // ----------------------------------------------------------------------------
  // PRIVATE HELPERS BELOW
  // ----------------------------------------------------------------------------

  /**
   * Sort children: folders first (alphabetically), then files (alphabetically)
   */
  private sortChildren(children: TreeItem[]): void {
    children.sort((a, b) => {
      const aIsFolder = a instanceof FolderNode;
      const bIsFolder = b instanceof FolderNode;
      
      // If one is a folder and the other is a file, folder comes first
      if (aIsFolder && !bIsFolder) return -1;
      if (!aIsFolder && bIsFolder) return 1;
      
      // Both are the same type, sort alphabetically by label
      const aLabel = typeof a.label === 'string' ? a.label : (a.label?.label || '');
      const bLabel = typeof b.label === 'string' ? b.label : (b.label?.label || '');
      return aLabel.localeCompare(bLabel);
    });
  }

  /**
   * Read the .vcxproj.filters file (if any) under the given folderUri,
   * parse it, and return a FolderNode whose children represent the filters‐tree.
   */
  private async buildTree(folderUri: vscode.Uri): Promise<FolderNode> {
    const filtersPath = await findFiltersFile(folderUri);
    // Create a "virtual root" node representing the workspace folder.
    const root = new FolderNode(folderUri, path.basename(folderUri.fsPath));
    root.populated = true;

    if (!filtersPath) {
      // No .vcxproj.filters found: return just the empty root (no children).
      return root;
    }

    // Read & parse the XML
    const xml = await fs.readFile(filtersPath.fsPath, 'utf-8');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const data = parser.parse(xml);

    /**
     * In a typical .vcxproj.filters, you have entries like:
     * <ItemGroup>
     *   <ClCompile Include="foo.cpp">
     *     <Filter>Source Files\ModuleA</Filter>
     *   </ClCompile>
     *   ...
     * </ItemGroup>
     *
     * The parser turns that into something like:
     * data.Project.ItemGroup → { ClCompile: [ { '@_Include': 'foo.cpp', Filter: 'Source Files\\ModuleA' }, … ], … }
     */
    const items: any[] = [];

    // The XML may contain multiple <ItemGroup> sections. Collect all file‐related entries.
    if (data.Project && data.Project.ItemGroup) {
      const groups = Array.isArray(data.Project.ItemGroup)
        ? data.Project.ItemGroup
        : [data.Project.ItemGroup];

      for (const group of groups) {
        for (const tag of Object.keys(group)) {
          const entries = (group as any)[tag];
          // Handle both single entries and arrays of entries
          const entryArray = Array.isArray(entries) ? entries : [entries];
          for (const entry of entryArray) {
            const include = entry['@_Include'];
            const filter = entry.Filter;
            if (include && filter) {
              // Handle case where filter might be an array (multiple <Filter> tags)
              const filterString = Array.isArray(filter) ? filter[filter.length - 1] : filter;
              items.push({ include: include as string, filter: filterString as string });
            }
          }
        }
      }
    }

    // Map filter‐path → FolderNode.  The empty string "" maps to the root FolderNode.
    const nodeMap = new Map<string, FolderNode>();
    nodeMap.set('', root);

    /** Ensure that a FolderNode exists for a given filter path (e.g. "Source Files\ModuleA") */
    const ensureNode = (filterPath: string): FolderNode => {
      if (nodeMap.has(filterPath)) {
        return nodeMap.get(filterPath)!;
      }
      // Split off parent folder: everything before the last backslash
      const idx = filterPath.lastIndexOf('\\');
      const parentFilter = idx < 0 ? '' : filterPath.substring(0, idx);
      const leafName = idx < 0 ? filterPath : filterPath.substring(idx + 1);
      const parentNode = ensureNode(parentFilter);

      // Create a new FolderNode whose uri is just a fake path under folderUri
      const fakeUri = vscode.Uri.joinPath(folderUri, filterPath);
      const folderNode = new FolderNode(fakeUri, leafName);
      folderNode.populated = true; // children get added immediately next
      parentNode.children.push(folderNode);
      nodeMap.set(filterPath, folderNode);
      return folderNode;
    };

    for (const { include, filter } of items) {
      const parentNode = ensureNode(filter);
      // Resolve the actual file's Uri relative to the workspace folder.
      const fileUri = vscode.Uri.joinPath(folderUri, include.replace(/\\/g, '/'));
      // Create a leaf FileNode
      parentNode.children.push(new FileNode(fileUri));
    }

    const sortNodeRecursively = (node: FolderNode) => {
      this.sortChildren(node.children);
      for (const child of node.children) {
        if (child instanceof FolderNode) {
          sortNodeRecursively(child);
        }
      }
    };
    sortNodeRecursively(root);

    return root;
  }
}

/** Base abstract type for our tree items */
abstract class TreeItem extends vscode.TreeItem {}

/** Represents an actual file in the .filters. Clicking opens it. */
class FileNode extends TreeItem {
  constructor(public readonly uri: vscode.Uri) {
    super(path.basename(uri.fsPath), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = uri;
    this.command = {
      command: 'vsFilters.openFile',
      title: 'Open File',
      arguments: [uri],
    };
    this.contextValue = 'file';
  }
}

/**
 * Represents either:
 *  - The workspace‐root node (uri.fsPath = workspaceFolder.fsPath), or
 *  - A logical "filter" folder (fakeUri under workspaceFolder).
 */
class FolderNode extends TreeItem {
  /** Becomes true once children have been populated (so we don't re‐parse repeatedly). */
  populated = false;
  children: TreeItem[] = [];

  constructor(public readonly uri: vscode.Uri, label: string) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'folder';
  }
}

/**
 * Try to locate **the first** .vcxproj.filters file under the given workspace folder.
 * Adjust the glob-exclude patterns as needed.
 */
async function findFiltersFile(folder: vscode.Uri): Promise<vscode.Uri | undefined> {
  const candidates = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/*.vcxproj.filters'),
    '**/{bin,obj,build,out,tmp}/**',
    1
  );
  return candidates.length > 0 ? candidates[0] : undefined;
}
