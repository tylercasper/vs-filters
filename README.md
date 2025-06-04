# VS Filters

A VS Code extension that structures files into virtual folders based on Visual Studio `.vcxproj.filters` files, with support for creating, editing, and organizing filters.

## Features

### View, Create, and Manage Filters
- **Create new filters**: Right-click on any existing filter to create a new sub-filter
- **Delete filters**: Right-click on any filter to delete it and all of its sub-filters
- **Drag and drop files**: Move files between filters by dragging them from one filter to another
- **File watching**: Configurable exclusion patterns and file limit to maintain performance

## Usage

#### VS Filters panel is visible in its own dedicated pane within the Explorer sidebar 

## Extension Settings

This extension contributes the following settings:

### `vsFilters.excludePatterns`
- **Description**: Glob patterns for files and directories to exclude from the VS Filters view.

### `vsFilters.maxFiles`
- **Description**: Maximum number of files to scan when searching for unfiltered files. Higher values may impact performance on very large projects.

## Known Issues
- Files can be moved between filters only by draging and dropping onto the desired filter itself, not onto files within the desired filter.

## License

This project is licensed under the GNU GPL v3.0. See [LICENSE](LICENSE).
