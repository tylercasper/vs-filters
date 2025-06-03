// src/filtersTree.ts

import * as vscode from 'vscode';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * The TreeDataProvider that builds a separate "VS Filters" view per workspace folder.
 * In a multi-root workspace, each folder's .vcxproj.filters tree appears as its own branch.
 */
export class FiltersTreeDataProvider implements vscode.TreeDataProvider<TreeItem>, vscode.TreeDragAndDropController<TreeItem> {
  public readonly dragMimeTypes = ['application/vnd.code.tree.vsfilters'];
  public readonly dropMimeTypes = ['application/vnd.code.tree.vsfilters'];
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cache: for each workspace folder path (fsPath), store its root FolderNode. */
  private trees = new Map<string, FolderNode>();

  private watchers: vscode.Disposable[] = [];
  
  /** Debounce timer for refresh operations */
  private refreshTimer: NodeJS.Timeout | undefined;
  
  /** Flag to track if we're currently in a drag operation */
  private isDragging = false;

  constructor() {
    const filtersWatcher = vscode.workspace.createFileSystemWatcher('**/*.vcxproj.filters');
    filtersWatcher.onDidChange(() => this.debouncedRefresh());
    filtersWatcher.onDidCreate(() => this.debouncedRefresh());
    filtersWatcher.onDidDelete(() => this.debouncedRefresh());
    this.watchers.push(filtersWatcher);

    const sourceFilesWatcher = vscode.workspace.createFileSystemWatcher('**/*');
    sourceFilesWatcher.onDidCreate((uri) => {
      if (!this.shouldExcludeFile(vscode.workspace.asRelativePath(uri))) {
        this.debouncedRefresh();
      }
    });
    sourceFilesWatcher.onDidDelete((uri) => {
      if (!this.shouldExcludeFile(vscode.workspace.asRelativePath(uri))) {
        this.debouncedRefresh();
      }
    });
    this.watchers.push(sourceFilesWatcher);
    
    const workspaceWatcher = vscode.workspace.onDidRenameFiles(() => {
      this.debouncedRefresh();
    });
    this.watchers.push(workspaceWatcher);
  }
  
  /** Debounced refresh that prevents multiple rapid refreshes and respects drag state */
  private debouncedRefresh(): void {
    if (this.isDragging) {
      return;
    }
    
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    
    this.refreshTimer = setTimeout(() => {
      this.refresh();
      this.refreshTimer = undefined;
    }, 300);
  }

  /** Clean up resources */
  dispose(): void {
    this.watchers.forEach(watcher => watcher.dispose());
    this._onDidChangeTreeData.dispose();
    
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
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
        const root = new FolderNode(wf.uri, path.basename(wf.uri.fsPath), true);
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
  // DRAG AND DROP SUPPORT
  // ----------------------------------------------------------------------------

  async handleDrag(source: TreeItem[], dataTransfer: vscode.DataTransfer): Promise<void> {
    this.isDragging = true;
    
    const dragData = source.map(item => ({
      uri: item instanceof FileNode || item instanceof FolderNode ? item.uri.toString() : '',
      type: item instanceof FileNode ? 'file' : 'folder',
      label: typeof item.label === 'string' ? item.label : (item.label?.label || '')
    }));
    
    dataTransfer.set('application/vnd.code.tree.vsfilters', new vscode.DataTransferItem(JSON.stringify(dragData)));
    
    setTimeout(() => {
      this.isDragging = false;
    }, 1000);
  }

  async handleDrop(target: TreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    this.isDragging = false;
    
    const transferItem = dataTransfer.get('application/vnd.code.tree.vsfilters');
    if (!transferItem) {
      return;
    }

    const dragData = JSON.parse(transferItem.value);
    if (!Array.isArray(dragData)) {
      return;
    }

    if (!(target instanceof FolderNode)) {
      return;
    }

    for (const item of dragData) {
      if (item.type === 'file') {
        const fileUri = vscode.Uri.parse(item.uri);
        await this.moveFileToFilter(fileUri, target);
      } else if (item.type === 'folder') {
        const folderUri = vscode.Uri.parse(item.uri);
        await this.moveFilterToParent(folderUri, target);
      }
    }

    // Refresh immediately after drop completes (bypassing debounce)
    this.refresh();
  }

  // ----------------------------------------------------------------------------
  // FILTER MANAGEMENT METHODS
  // ----------------------------------------------------------------------------

  async createFilter(parentFolder: FolderNode, filterName: string): Promise<void> {
    try {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(parentFolder.uri);
      if (!workspaceFolder) {
        throw new Error('Could not find workspace folder');
      }

      let filtersPath = await findFiltersFile(workspaceFolder.uri);
      if (!filtersPath) {
        const projectName = path.basename(workspaceFolder.uri.fsPath);
        filtersPath = vscode.Uri.joinPath(workspaceFolder.uri, `${projectName}.vcxproj.filters`);
        await this.createNewFiltersFile(filtersPath);
        vscode.window.showInformationMessage(`Created new .vcxproj.filters file: ${path.basename(filtersPath.fsPath)}`);
      }

      const parentPath = this.getFilterPath(parentFolder, workspaceFolder.uri);
      const newFilterPath = parentPath ? `${parentPath}\\${filterName}` : filterName;

      await this.addFilterToXML(filtersPath, newFilterPath);

      this.debouncedRefresh();
      
      vscode.window.showInformationMessage(`Filter "${filterName}" created successfully`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create filter: ${error}`);
    }
  }

  async deleteFilter(folderNode: FolderNode): Promise<void> {
    try {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(folderNode.uri);
      if (!workspaceFolder) {
        throw new Error('Could not find workspace folder');
      }

      const filtersPath = await findFiltersFile(workspaceFolder.uri);
      if (!filtersPath) {
        throw new Error('No .vcxproj.filters file found');
      }

      const filterPath = this.getFilterPath(folderNode, workspaceFolder.uri);
      if (!filterPath) {
        throw new Error('Cannot delete root folder');
      }

      const result = await vscode.window.showWarningMessage(
        `Are you sure you want to delete the filter "${filterPath}" and all sub-filters?`,
        'Yes', 'No'
      );

      if (result !== 'Yes') {
        return;
      }

      await this.removeFilterFromXML(filtersPath, filterPath);

      this.debouncedRefresh();

      vscode.window.showInformationMessage(`Filter "${filterPath}" deleted successfully`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to delete filter: ${error}`);
    }
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
    const root = new FolderNode(folderUri, path.basename(folderUri.fsPath), true);
    root.populated = true;

    if (!filtersPath) {
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

    // First, create all filter definitions (even empty ones)
    if (data.Project && data.Project.ItemGroup) {
      const groups = Array.isArray(data.Project.ItemGroup)
        ? data.Project.ItemGroup
        : [data.Project.ItemGroup];

      for (const group of groups) {
        if (group.Filter) {
          const filters = Array.isArray(group.Filter) ? group.Filter : [group.Filter];
          for (const filterDef of filters) {
            const filterPath = filterDef['@_Include'];
            if (filterPath) {
              ensureNode(filterPath);
            }
          }
        }
      }
    }

    // Keep track of files that are assigned to filters
    const filteredFiles = new Set<string>();

    // Then, add files to their respective filters (only if they exist)
    for (const { include, filter } of items) {
      const parentNode = ensureNode(filter);
      const fileUri = vscode.Uri.joinPath(folderUri, include.replace(/\\/g, '/'));
      
      try {
        // Check if the file actually exists before adding it to the tree
        const stat = await vscode.workspace.fs.stat(fileUri);
        if (stat.type === vscode.FileType.File) {
          // Create a leaf FileNode only if file exists
          parentNode.children.push(new FileNode(fileUri));
        }
      } catch (error) {
        // File doesn't exist - skip it but don't show error
        // This is normal when files have been deleted but XML hasn't been updated
        continue;
      }
      
      // Track this file as being filtered (even if it doesn't exist, for unfiltered detection)
      filteredFiles.add(include.replace(/\\/g, '/'));
    }

    if (filtersPath) {
      await this.cleanupStaleFileReferences(filtersPath, folderUri);
    }

    // Find all files in the workspace and add unfiltered ones to the root
    await this.addUnfilteredFilesToRoot(folderUri, root, filteredFiles);

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

  /**
   * Get the filter path from a tree node (for use in paste operations)
   */
  async getFilterPathFromNode(node: any): Promise<string | undefined> {
    if (!node || node.isWorkspaceRoot) {
      return undefined;
    }
    
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(node.uri);
    if (!workspaceFolder) {
      return undefined;
    }
    
    return this.getFilterPath(node, workspaceFolder.uri);
  }

  /**
   * Get the filter path for a given FolderNode relative to the workspace root
   */
  private getFilterPath(folderNode: FolderNode, workspaceUri: vscode.Uri): string {
    if (folderNode.uri.fsPath === workspaceUri.fsPath) {
      return ''; // This is the workspace root
    }
    
    const relativePath = path.relative(workspaceUri.fsPath, folderNode.uri.fsPath);
    return relativePath.replace(/\//g, '\\');
  }

  /**
   * Get the current filter path for a given file
   */
  async getFileFilter(fileUri: vscode.Uri): Promise<string | undefined> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (!workspaceFolder) {
      return undefined;
    }

    const filtersPath = await findFiltersFile(workspaceFolder.uri);
    if (!filtersPath) {
      return undefined;
    }

    try {
      const xml = await fs.readFile(filtersPath.fsPath, 'utf-8');
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
      const data = parser.parse(xml);

      if (!data.Project || !data.Project.ItemGroup) {
        return undefined;
      }

      const groups = Array.isArray(data.Project.ItemGroup) ? data.Project.ItemGroup : [data.Project.ItemGroup];
      const relativePath = path.relative(workspaceFolder.uri.fsPath, fileUri.fsPath).replace(/\//g, '\\');

      // Find the file in the XML and return its filter
      for (const group of groups) {
        for (const tag of Object.keys(group)) {
          if (tag !== 'Filter' && group[tag]) {
            const items = Array.isArray(group[tag]) ? group[tag] : [group[tag]];
            for (const item of items) {
              if (item['@_Include'] === relativePath && item.Filter) {
                const filter = item.Filter;
                return Array.isArray(filter) ? filter[filter.length - 1] : filter;
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to read filter for file:', error);
    }

    return undefined; // File not found in any filter (unfiltered)
  }

  /**
   * Move a file to a specific filter path
   */
  async moveFileToFilterPath(fileUri: vscode.Uri, filterPath: string): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (!workspaceFolder) {
      throw new Error('Could not find workspace folder for file');
    }

    let filtersPath = await findFiltersFile(workspaceFolder.uri);
    if (!filtersPath) {
      const projectName = path.basename(workspaceFolder.uri.fsPath);
      filtersPath = vscode.Uri.joinPath(workspaceFolder.uri, `${projectName}.vcxproj.filters`);
      await this.createNewFiltersFile(filtersPath);
      vscode.window.showInformationMessage(`Created new .vcxproj.filters file: ${path.basename(filtersPath.fsPath)}`);
    }

    const relativePath = path.relative(workspaceFolder.uri.fsPath, fileUri.fsPath).replace(/\//g, '\\');
    await this.updateFileFilterInXML(filtersPath, relativePath, filterPath);
  }

  /**
   * Move a file to a different filter
   */
  async moveFileToFilter(fileUri: vscode.Uri, targetFolder: FolderNode): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (!workspaceFolder) {
      throw new Error('Could not find workspace folder for file');
    }

    let filtersPath = await findFiltersFile(workspaceFolder.uri);
    if (!filtersPath) {
      const projectName = path.basename(workspaceFolder.uri.fsPath);
      filtersPath = vscode.Uri.joinPath(workspaceFolder.uri, `${projectName}.vcxproj.filters`);
      await this.createNewFiltersFile(filtersPath);
      vscode.window.showInformationMessage(`Created new .vcxproj.filters file: ${path.basename(filtersPath.fsPath)}`);
    }

    const targetFilterPath = this.getFilterPath(targetFolder, workspaceFolder.uri);
    const relativePath = path.relative(workspaceFolder.uri.fsPath, fileUri.fsPath).replace(/\//g, '\\');

    await this.updateFileFilterInXML(filtersPath, relativePath, targetFilterPath);
  }

  /**
   * Move a filter to a different parent filter
   */
  private async moveFilterToParent(sourceFilterUri: vscode.Uri, targetParentFolder: FolderNode): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(sourceFilterUri);
    if (!workspaceFolder) {
      throw new Error('Could not find workspace folder for filter');
    }

    const filtersPath = await findFiltersFile(workspaceFolder.uri);
    if (!filtersPath) {
      throw new Error('No .vcxproj.filters file found');
    }

    const sourceFilterPath = this.getFilterPath({ uri: sourceFilterUri } as FolderNode, workspaceFolder.uri);
    const targetParentPath = this.getFilterPath(targetParentFolder, workspaceFolder.uri);
    
    // Can't move a filter into itself or its descendants
    if (targetParentPath.startsWith(sourceFilterPath)) {
      vscode.window.showErrorMessage('Cannot move a filter into itself or its descendants');
      return;
    }

    // Can't move workspace root
    if (!sourceFilterPath) {
      vscode.window.showErrorMessage('Cannot move the workspace root folder');
      return;
    }

    // Extract the filter name (last part after the last backslash)
    const filterName = sourceFilterPath.split('\\').pop() || sourceFilterPath;
    const newFilterPath = targetParentPath ? `${targetParentPath}\\${filterName}` : filterName;

    try {
      await this.moveFilterInXML(filtersPath, sourceFilterPath, newFilterPath);
      vscode.window.showInformationMessage(`Filter "${sourceFilterPath}" moved to "${newFilterPath}"`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to move filter: ${error}`);
    }
  }

  /**
   * Add a new filter to the XML file structure
   */
  private async addFilterToXML(filtersPath: vscode.Uri, filterPath: string): Promise<void> {
    const xml = await fs.readFile(filtersPath.fsPath, 'utf-8');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const data = parser.parse(xml);

    if (!data.Project) {
      data.Project = {};
    }

    if (!data.Project.ItemGroup) {
      data.Project.ItemGroup = [];
    }

    if (!Array.isArray(data.Project.ItemGroup)) {
      data.Project.ItemGroup = [data.Project.ItemGroup];
    }

    let filterGroup = data.Project.ItemGroup.find((group: any) => group.Filter);
    if (!filterGroup) {
      filterGroup = { Filter: [] };
      data.Project.ItemGroup.push(filterGroup);
    }

    if (!Array.isArray(filterGroup.Filter)) {
      filterGroup.Filter = filterGroup.Filter ? [filterGroup.Filter] : [];
    }

    // Check if filter already exists
    const existingFilter = filterGroup.Filter.find((f: any) => f['@_Include'] === filterPath);
    if (!existingFilter) {
      // Add the new filter
      filterGroup.Filter.push({
        '@_Include': filterPath,
        UniqueIdentifier: `{${this.generateGuid()}}`
      });
    }

    // Write back to file
    const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true });
    const xmlOutput = builder.build(data);
    await fs.writeFile(filtersPath.fsPath, xmlOutput, 'utf-8');
  }

  /**
   * Remove a filter and all its contents from the XML file
   */
  private async removeFilterFromXML(filtersPath: vscode.Uri, filterPath: string): Promise<void> {
    const xml = await fs.readFile(filtersPath.fsPath, 'utf-8');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const data = parser.parse(xml);

    if (!data.Project || !data.Project.ItemGroup) {
      return;
    }

    const groups = Array.isArray(data.Project.ItemGroup) ? data.Project.ItemGroup : [data.Project.ItemGroup];

    for (const group of groups) {
      // Remove filter definition
      if (group.Filter) {
        const filters = Array.isArray(group.Filter) ? group.Filter : [group.Filter];
        group.Filter = filters.filter((f: any) => !f['@_Include']?.startsWith(filterPath));
        if (group.Filter.length === 0) {
          delete group.Filter;
        } else if (group.Filter.length === 1 && Array.isArray(group.Filter)) {
          group.Filter = group.Filter[0];
        }
      }

      // Remove files in this filter and sub-filters
      for (const tag of Object.keys(group)) {
        if (tag !== 'Filter' && group[tag]) {
          const items = Array.isArray(group[tag]) ? group[tag] : [group[tag]];
          group[tag] = items.filter((item: any) => {
            const filter = item.Filter;
            if (!filter) return true;
            const filterString = Array.isArray(filter) ? filter[filter.length - 1] : filter;
            return !filterString.startsWith(filterPath);
          });
          
          if (group[tag].length === 0) {
            delete group[tag];
          } else if (group[tag].length === 1 && Array.isArray(group[tag])) {
            group[tag] = group[tag][0];
          }
        }
      }
    }

    // Clean up empty ItemGroups
    data.Project.ItemGroup = groups.filter((group: any) => Object.keys(group).length > 0);
    if (data.Project.ItemGroup.length === 0) {
      delete data.Project.ItemGroup;
    } else if (data.Project.ItemGroup.length === 1 && Array.isArray(data.Project.ItemGroup)) {
      data.Project.ItemGroup = data.Project.ItemGroup[0];
    }

    // Write back to file
    const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true });
    const xmlOutput = builder.build(data);
    await fs.writeFile(filtersPath.fsPath, xmlOutput, 'utf-8');
  }

  /**
   * Update the filter assignment for a specific file
   */
  private async updateFileFilterInXML(filtersPath: vscode.Uri, filePath: string, newFilterPath: string): Promise<void> {
    const xml = await fs.readFile(filtersPath.fsPath, 'utf-8');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const data = parser.parse(xml);

    // Ensure basic structure exists
    if (!data.Project) {
      data.Project = {};
    }
    if (!data.Project.ItemGroup) {
      data.Project.ItemGroup = [];
    }

    const groups = Array.isArray(data.Project.ItemGroup) ? data.Project.ItemGroup : [data.Project.ItemGroup];
    let fileFound = false;

    // Find and update the file entry
    for (const group of groups) {
      for (const tag of Object.keys(group)) {
        if (tag !== 'Filter') {
          const items = Array.isArray(group[tag]) ? group[tag] : [group[tag]];
          for (const item of items) {
            if (item['@_Include'] === filePath) {
              fileFound = true;
              if (newFilterPath) {
                item.Filter = newFilterPath;
              } else {
                delete item.Filter;
              }
            }
          }
        }
      }
    }

    // If file not found, add it to an appropriate ItemGroup
    if (!fileFound) {
      // Determine the file type based on extension
      const extension = path.extname(filePath).toLowerCase();
      let itemType = 'ClInclude'; // Default to header
      
      if (['.cpp', '.c', '.cc', '.cxx'].includes(extension)) {
        itemType = 'ClCompile';
      } else if (['.rc', '.rc2'].includes(extension)) {
        itemType = 'ResourceCompile';
      } else if (['.txt', '.md', '.xml', '.json'].includes(extension)) {
        itemType = 'Text';
      }

      // Find or create appropriate ItemGroup
      let targetGroup = groups.find((group: any) => group[itemType]);
      if (!targetGroup) {
        targetGroup = {};
        groups.push(targetGroup);
      }

      // Add the file entry
      const newItem: any = { '@_Include': filePath };
      if (newFilterPath) {
        newItem.Filter = newFilterPath;
      }

      if (!targetGroup[itemType]) {
        targetGroup[itemType] = newItem;
      } else if (Array.isArray(targetGroup[itemType])) {
        targetGroup[itemType].push(newItem);
      } else {
        targetGroup[itemType] = [targetGroup[itemType], newItem];
      }

      // Update the data structure
      if (groups.length === 1) {
        data.Project.ItemGroup = groups[0];
      } else {
        data.Project.ItemGroup = groups;
      }
    }

    // Write back to file
    const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true });
    const xmlOutput = builder.build(data);
    await fs.writeFile(filtersPath.fsPath, xmlOutput, 'utf-8');
  }

  /**
   * Move a filter and all its sub-filters and files in the XML
   */
  private async moveFilterInXML(filtersPath: vscode.Uri, oldFilterPath: string, newFilterPath: string): Promise<void> {
    const xml = await fs.readFile(filtersPath.fsPath, 'utf-8');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const data = parser.parse(xml);

    if (!data.Project || !data.Project.ItemGroup) {
      return;
    }

    const groups = Array.isArray(data.Project.ItemGroup) ? data.Project.ItemGroup : [data.Project.ItemGroup];

    for (const group of groups) {
      // Update filter definitions
      if (group.Filter) {
        const filters = Array.isArray(group.Filter) ? group.Filter : [group.Filter];
        for (const filter of filters) {
          const filterInclude = filter['@_Include'];
          if (filterInclude === oldFilterPath) {
            // Exact match - rename this filter
            filter['@_Include'] = newFilterPath;
          } else if (filterInclude && filterInclude.startsWith(oldFilterPath + '\\')) {
            // Sub-filter - update its path
            const relativePath = filterInclude.substring(oldFilterPath.length + 1);
            filter['@_Include'] = `${newFilterPath}\\${relativePath}`;
          }
        }
      }

      // Update file references to filters
      for (const tag of Object.keys(group)) {
        if (tag !== 'Filter' && group[tag]) {
          const items = Array.isArray(group[tag]) ? group[tag] : [group[tag]];
          for (const item of items) {
            if (item.Filter) {
              const filterValue = Array.isArray(item.Filter) ? item.Filter[item.Filter.length - 1] : item.Filter;
              if (filterValue === oldFilterPath) {
                // Exact match - update file's filter reference
                item.Filter = newFilterPath;
              } else if (filterValue && filterValue.startsWith(oldFilterPath + '\\')) {
                // File in sub-filter - update its filter reference
                const relativePath = filterValue.substring(oldFilterPath.length + 1);
                item.Filter = `${newFilterPath}\\${relativePath}`;
              }
            }
          }
        }
      }
    }

    // Write back to file
    const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true });
    const xmlOutput = builder.build(data);
    await fs.writeFile(filtersPath.fsPath, xmlOutput, 'utf-8');
  }

  /**
   * Generate a GUID for new filters
   */
  private generateGuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Remove non-existent files from the XML file
   */
  private async cleanupStaleFileReferences(filtersPath: vscode.Uri, folderUri: vscode.Uri): Promise<void> {
    const xml = await fs.readFile(filtersPath.fsPath, 'utf-8');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const data = parser.parse(xml);

    if (!data.Project || !data.Project.ItemGroup) {
      return;
    }

    const groups = Array.isArray(data.Project.ItemGroup) ? data.Project.ItemGroup : [data.Project.ItemGroup];
    let hasChanges = false;

    for (const group of groups) {
      for (const tag of Object.keys(group)) {
        if (tag !== 'Filter' && group[tag]) {
          const items = Array.isArray(group[tag]) ? group[tag] : [group[tag]];
          const validItems = [];

          for (const item of items) {
            const includePath = item['@_Include'];
            if (includePath) {
              const fileUri = vscode.Uri.joinPath(folderUri, includePath.replace(/\\/g, '/'));
              try {
                const stat = await vscode.workspace.fs.stat(fileUri);
                if (stat.type === vscode.FileType.File) {
                  validItems.push(item);
                } else {
                  hasChanges = true; // File doesn't exist, will be removed
                }
              } catch (error) {
                hasChanges = true; // File doesn't exist, will be removed
              }
            } else {
              validItems.push(item); // Keep items without Include attribute
            }
          }

          if (validItems.length === 0) {
            delete group[tag];
          } else if (validItems.length === 1) {
            group[tag] = validItems[0];
          } else {
            group[tag] = validItems;
          }
        }
      }
    }

    // Only write back if we made changes
    if (hasChanges) {
      // Clean up empty ItemGroups
      data.Project.ItemGroup = groups.filter((group: any) => Object.keys(group).length > 0);
      if (data.Project.ItemGroup.length === 0) {
        delete data.Project.ItemGroup;
      } else if (data.Project.ItemGroup.length === 1 && Array.isArray(data.Project.ItemGroup)) {
        data.Project.ItemGroup = data.Project.ItemGroup[0];
      }

      const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true });
      const xmlOutput = builder.build(data);
      await fs.writeFile(filtersPath.fsPath, xmlOutput, 'utf-8');
    }
  }

  /**
   * Create a new .vcxproj.filters file with basic structure
   */
  private async createNewFiltersFile(filtersPath: vscode.Uri): Promise<void> {
    const basicFiltersXml = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup>
  </ItemGroup>
</Project>`;

    await fs.writeFile(filtersPath.fsPath, basicFiltersXml, 'utf-8');
  }

     /**
    * Add all unfiltered files to the root node
    */
   private async addUnfilteredFilesToRoot(folderUri: vscode.Uri, root: FolderNode, filteredFiles: Set<string>): Promise<void> {
     try {
       // Get configured exclude patterns
       const config = vscode.workspace.getConfiguration('vsFilters');
       const excludePatterns = config.get<string[]>('excludePatterns', [
         'node_modules/**',
         'bin/**',
         'obj/**',
         'build/**',
         'out/**',
         'tmp/**',
         '.vs/**',
         '.git/**',
         'dist/**'
       ]);
       
       // Convert patterns to a single exclude pattern for VS Code's findFiles
       const excludePattern = excludePatterns.length > 0 ? `{${excludePatterns.join(',')}}` : undefined;
       
       const maxFiles = config.get<number>('maxFiles', 25000);
       
       const allFiles = await vscode.workspace.findFiles(
         new vscode.RelativePattern(folderUri, '**/*'),
         excludePattern,
         maxFiles
       );

       for (const fileUri of allFiles) {
         const relativePath = path.relative(folderUri.fsPath, fileUri.fsPath).replace(/\\/g, '/');
         
         if (!filteredFiles.has(relativePath)) {
           try {
             // Check if it's actually a file (not a directory)
             const stat = await vscode.workspace.fs.stat(fileUri);
             if (stat.type === vscode.FileType.File) {
               // Add unfiltered file to root
               root.children.push(new FileNode(fileUri));
             }
           } catch (error) {
             // Skip files that can't be accessed
             continue;
           }
         }
       }
     } catch (error) {
       // If file scanning fails, just continue without unfiltered files
       console.warn('Failed to scan for unfiltered files:', error);
     }
   }

     /**
   * Check if a file should be excluded from watching/display
   */
  private shouldExcludeFile(relativePath: string): boolean {
    // Get configured exclude patterns
    const config = vscode.workspace.getConfiguration('vsFilters');
    const excludePatterns = config.get<string[]>('excludePatterns', [
      'node_modules/**',
      'bin/**',
      'obj/**',
      'build/**',
      'out/**',
      'tmp/**',
      '.vs/**',
      '.git/**',
      'dist/**'
    ]);
    
    // Convert glob patterns to simple path matching
    const simplePatterns = excludePatterns.map(pattern => 
      pattern.replace(/\/?\*\*\/?/g, '')
    );
    
    return simplePatterns.some(pattern => 
      relativePath.includes(pattern) || 
      relativePath.startsWith(pattern) ||
      relativePath.startsWith(pattern + '/')
    );
  }

  /**
   * Update file references in .vcxproj.filters when a file is renamed
   */
  async renameFileInFilters(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(oldUri);
    if (!workspaceFolder) {
      return;
    }

    const filtersPath = await findFiltersFile(workspaceFolder.uri);
    if (!filtersPath) {
      return;
    }

    try {
      const xml = await fs.readFile(filtersPath.fsPath, 'utf-8');
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
      const data = parser.parse(xml);

      if (!data.Project || !data.Project.ItemGroup) {
        return;
      }

      const groups = Array.isArray(data.Project.ItemGroup) ? data.Project.ItemGroup : [data.Project.ItemGroup];
      const oldRelativePath = path.relative(workspaceFolder.uri.fsPath, oldUri.fsPath).replace(/\//g, '\\');
      const newRelativePath = path.relative(workspaceFolder.uri.fsPath, newUri.fsPath).replace(/\//g, '\\');
      let hasChanges = false;

      // Update all file references
      for (const group of groups) {
        for (const tag of Object.keys(group)) {
          if (tag !== 'Filter' && group[tag]) {
            const items = Array.isArray(group[tag]) ? group[tag] : [group[tag]];
            for (const item of items) {
              if (item['@_Include'] === oldRelativePath) {
                item['@_Include'] = newRelativePath;
                hasChanges = true;
              }
            }
          }
        }
      }

      // Write back if changes were made
      if (hasChanges) {
        const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true });
        const xmlOutput = builder.build(data);
        await fs.writeFile(filtersPath.fsPath, xmlOutput, 'utf-8');
      }
    } catch (error) {
      console.error('Failed to update filters file:', error);
      throw error;
    }
  }

  /**
   * Remove file references from .vcxproj.filters when a file is deleted
   */
  async deleteFileFromFilters(fileUri: vscode.Uri): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (!workspaceFolder) {
      return;
    }

    const filtersPath = await findFiltersFile(workspaceFolder.uri);
    if (!filtersPath) {
      return;
    }

    try {
      const xml = await fs.readFile(filtersPath.fsPath, 'utf-8');
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
      const data = parser.parse(xml);

      if (!data.Project || !data.Project.ItemGroup) {
        return;
      }

      const groups = Array.isArray(data.Project.ItemGroup) ? data.Project.ItemGroup : [data.Project.ItemGroup];
      const relativePath = path.relative(workspaceFolder.uri.fsPath, fileUri.fsPath).replace(/\//g, '\\');
      let hasChanges = false;

      // Remove file references
      for (const group of groups) {
        for (const tag of Object.keys(group)) {
          if (tag !== 'Filter' && group[tag]) {
            const items = Array.isArray(group[tag]) ? group[tag] : [group[tag]];
            const filteredItems = items.filter((item: any) => item['@_Include'] !== relativePath);
            
            if (filteredItems.length !== items.length) {
              hasChanges = true;
              if (filteredItems.length === 0) {
                delete group[tag];
              } else if (filteredItems.length === 1) {
                group[tag] = filteredItems[0];
              } else {
                group[tag] = filteredItems;
              }
            }
          }
        }
      }

      // Write back if changes were made
      if (hasChanges) {
        // Clean up empty ItemGroups
        data.Project.ItemGroup = groups.filter((group: any) => Object.keys(group).length > 0);
        if (data.Project.ItemGroup.length === 0) {
          delete data.Project.ItemGroup;
        } else if (data.Project.ItemGroup.length === 1) {
          data.Project.ItemGroup = data.Project.ItemGroup[0];
        }

        const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true });
        const xmlOutput = builder.build(data);
        await fs.writeFile(filtersPath.fsPath, xmlOutput, 'utf-8');
      }
    } catch (error) {
      console.error('Failed to update filters file:', error);
    }
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

  constructor(public readonly uri: vscode.Uri, label: string, public readonly isWorkspaceRoot: boolean = false) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = isWorkspaceRoot ? 'workspaceRoot' : 'folder';
  }
}

/**
 * Try to locate **the first** .vcxproj.filters file under the given workspace folder.
 * Uses configurable exclude patterns.
 */
async function findFiltersFile(folder: vscode.Uri): Promise<vscode.Uri | undefined> {
  // Get configured exclude patterns
  const config = vscode.workspace.getConfiguration('vsFilters');
  const excludePatterns = config.get<string[]>('excludePatterns', [
    'node_modules/**',
    'bin/**', 
    'obj/**',
    'build/**',
    'out/**',
    'tmp/**',
    '.vs/**',
    '.git/**',
    'dist/**'
  ]);
  
  const excludePattern = excludePatterns.length > 0 ? `{${excludePatterns.join(',')}}` : undefined;
  
  const candidates = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/*.vcxproj.filters'),
    excludePattern,
    1
  );
  return candidates.length > 0 ? candidates[0] : undefined;
}
