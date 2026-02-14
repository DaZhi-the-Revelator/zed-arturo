# Arturo Language Server

This directory contains the Language Server Protocol (LSP) implementation for Arturo.

## Features

- **Type Checking**: Validates type annotations and checks for type compatibility
- **Go-to-Definition**: Navigate to variable and function definitions
- **Hover Information**: Display type information and documentation for symbols
- **Code Completion**: Autocomplete for built-in functions, types, and user-defined symbols
- **Signature Help**: Real-time parameter hints with active parameter tracking
- **Find All References**: Scope-aware reference finding
- **Rename Symbol**: Safe symbol renaming with validation
- **Document Formatting**: Auto-format with bracket-aware indentation
- **Folding Ranges**: Code folding support
- **Document Symbols**: Document outline
- **Inlay Hints**: Inline parameter names and type information
- **Semantic Tokens**: Enhanced syntax highlighting
- **Workspace Symbols**: Global symbol search
- **Document Highlights**: Automatic symbol highlighting
- **Code Actions**: Quick fixes and refactorings
- **Diagnostics**: Real-time error and warning messages

## Installation

The language server is automatically bundled with the Zed extension. To install dependencies manually:

```bash
cd language-server
npm install
```

## Usage

The language server is automatically started by Zed when you open an Arturo file (`.art`).

### Configuration (v2.0+)

You can toggle specific LSP features on/off through Zed settings:

```json
{
  "lsp": {
    "arturo": {
      "completions": "off",  // Disable code completion
      "signatures": "on",    // Enable signature help (default)
      "formatting": "off",   // Disable document formatting
      "highlights": "on"     // Enable document highlights (default)
    }
  }
}
```

**Available Features**:

- `completions` - Code completion and autocomplete suggestions
- `signatures` - Signature help (parameter hints)
- `formatting` - Document formatting
- `highlights` - Document highlights (symbol occurrences)

All features are enabled by default. Set a feature to `"off"` to disable it.

## Development

To test the language server standalone:

```bash
node server.js --stdio
```

## Type System

The language server understands Arturo's type system including:

- Primitives: `:null`, `:logical`, `:integer`, `:floating`, `:char`, `:string`
- Collections: `:block`, `:dictionary`, `:range`
- Functions: `:function`, `:method`
- Advanced: `:complex`, `:rational`, `:quantity`, `:color`, `:date`
- And many more...
