# Arturo Language Support for Zed

A comprehensive language extension for [Arturo](https://arturo-lang.io/) in [Zed](https://zed.dev/), providing intelligent code editing features through a custom Language Server Protocol (LSP) implementation.

## Version

**Current Version**: 1.0.1

## Features

Please note Zed keymaps may have changed - use the Command Palette, Keymap and Key Context View when needed

### ✅ REPL / Interactive Evaluation

Full Zed REPL integration via a native Jupyter kernel (`arturo-kernel`):

- Evaluate cells with `Ctrl+Shift+Enter` (Windows/Linux) or `Cmd+Shift+Enter` (macOS)
- Cell separator: `; %%`
- Stateful sessions — variables and functions defined in one cell are available in subsequent cells
- stdout and stderr streamed directly into the REPL panel
- Interrupt running execution with `Ctrl+C`
- See `arturo-kernel/README.md` for build and install instructions

### ✅ Core Language Intelligence

- **Diagnostics**: Comprehensive code validation including:
  - Undefined variables
  - Unmatched brackets
  - Type mismatches in binary operations
  - Duplicate variable definitions
  - Unused variables
  - Unreachable code after return statements
  - Invalid type annotations
  - Division by zero
  - Wrong number of function arguments
  - Empty function bodies
  - Type comparison warnings

- **Type Checking**: Validates type annotations and checks for type compatibility based on Arturo's comprehensive type system
- **Go-to-Definition**: Navigate to variable and function definitions with a single keystroke
- **Hover Information**: Display type information, documentation, and examples for 500+ built-in functions

### ✅ Advanced Code Editing

- **Intelligent Code Completion**: Context-aware autocomplete for:
  - 500+ built-in functions with signatures
  - User-defined variables and functions
  - 30+ type annotations (`:integer`, `:string`, `:block`, etc.)
  - 100+ attribute names (`.with`, `.else`, `.string`, etc.)
  - Physical units (`` `m``, `` `kg``, `` `s``, etc.)
  - Named colors (`#red`, `#blue`, `#cyan`, etc.)

- **Signature Help**: Real-time parameter hints as you type function calls with active parameter tracking, powered by Dynamic Signature Generation (see below) — covers all 521+ built-in Arturo functions plus user-defined functions from your workspace

- **Dynamic Signature Generation**: A self-updating signature index that replaces the old static list of 80 manually-defined functions
  - **Signature Indexer (`lib/signature-indexer.js`)**: Core `SignatureIndexer` class with full cache lifecycle management
  - **Stale-While-Revalidate Pattern**: Cache is loaded instantly on startup; background task refreshes it every 24 hours without blocking the editor
  - **Offline-First Design**: Ships with a seed cache of the 80 most popular functions so the extension works perfectly without internet from day one
  - **User Function Indexing**: Automatically scans and indexes all user-defined functions across workspace files — their signatures appear in Signature Help, Hover, and Completion alongside the 521+ built-ins, with parameter types extracted from annotations
  - **Delta Updates**: Uses SHA hashes from Arturo's `.nim` source files on GitHub to detect which library files have changed, fetching only the updated signatures rather than doing a full refresh each cycle
  - **Graceful Degradation**: Falls back to the last known good cache if any network fetch fails; falls back to full refresh if delta data is unavailable

- **Find All References**: Scope-aware reference finding that:
  - Excludes false positives (comments, strings, literals)
  - Uses word boundary detection
  - Skips built-in functions

- **Rename Symbol**: Safe symbol renaming with:
  - Identifier validation
  - Conflict detection with built-ins
  - Protection for reserved names

- **Document Formatting**: Auto-format entire documents with:
  - Proper bracket-aware indentation
  - 4-space indent levels
  - Comment preservation

- **Folding Ranges**: Code folding support for:
  - Block literals `[...]`
  - Dictionary literals `#[...]`
  - String blocks `{...}`

- **Document Symbols**: Document outline showing:
  - All functions with their types
  - All variables with their inferred types

- **Inlay Hints**: Inline code annotations showing:
  - Parameter names in function calls
  - Inferred types for variable assignments
  - Enhances code readability without cluttering the source

- **Semantic Tokens**: Enhanced syntax highlighting from the LSP server:
  - More accurate token classification
  - Distinguishes between builtin and user-defined functions
  - Highlights types, keywords, and operators

- **Workspace Symbols**: Global symbol search across all files:
  - Search for functions and variables by name
  - Quick navigation across your entire project

- **Document Highlights**: Automatic symbol highlighting:
  - Highlights all occurrences of the symbol under cursor
  - Visual feedback for symbol usage in current file
  - Faster than Find All References for quick scanning

- **Code Actions**: Quick fixes and refactorings:
  - Define undefined variables
  - Add type annotations to variables
  - Extract code to function
  - Fix type mismatches

### ✅ Syntax Highlighting

Powered by tree-sitter with support for:

- Keywords and control flow
- Built-in functions (500+ recognized)
- String literals (multiple formats: `"..."`, `{...}`, `{:...:}`, `««...»»`)
- Number literals (integers, floats, rationals, scientific notation)
- Type annotations (`:integer`, `:string`, etc.)
- Attribute parameters (`.with`, `.else`, etc.)
- Comments (`;` single-line)
- Color literals (`#RGB`, `#RRGGBB`, `#RRGGBBAA`)
- Unit literals (`` `m``, `` `kg``, etc.)

### ✅ Rainbow Brackets (Optional)

Visual bracket matching with color-coded nesting levels:

- Square brackets `[]` (blocks)
- Dictionary brackets `#[]`

**To enable**: Add to your Zed `settings.json`:

```json
{
  "languages": {
    "Arturo": {
      "colorize_brackets": true
    }
  }
}
```

Or enable globally for all languages:

```json
{
  "colorize_brackets": true
}
```

### ✅ Code Snippets

19 built-in code snippets for common Arturo patterns:

**Control Flow**:

- `if` → If statement
- `ifelse` → If-else statement  
- `unless` → Unless statement
- `when` → When statement
- `switch` → Switch statement

**Loops**:

- `while` → While loop
- `loop` → Loop over collection

**Functions**:

- `func` → Function definition
- `tfunc` → Typed function definition

**Collections**:

- `map` → Map over collection
- `filter` → Filter collection
- `fold` → Fold/reduce collection
- `dict` → Dictionary literal
- `block` → Block literal

**Error Handling**:

- `try` → Try-catch block

**I/O & Debugging**:

- `print` → Print statement
- `inspect` → Inspect value

**Other**:

- `interp` → Interpolated string
- `comment` → Comment block

Just type the prefix and press Tab to expand!

### ✅ Smart Auto-Closing

Automatic bracket and quote pairing:

- Blocks: `[` `]`
- Dictionaries: `{` `}`  
- Strings: `"` `"`, `{:` `:}`, `««` `»»`, `«` `»`
- Interpolation: `|` `|`
- Parentheses: `(` `)`

### ✅ Intelligent Word Selection

Double-click to select entire Arturo identifiers including:

- Hyphens: `my-function`
- Question marks: `prime?`, `contains?`
- Combined: `my-var?`

### 📊 Supported Types

The LSP understands Arturo's complete type system:

**Primitives**: `:null`, `:logical`, `:integer`, `:floating`, `:char`, `:string`  
**Numbers**: `:complex`, `:rational`, `:quantity`, `:version`  
**Collections**: `:block`, `:dictionary`, `:range`, `:path`  
**Functions**: `:function`, `:method`, `:module`  
**Advanced**: `:type`, `:literal`, `:regex`, `:date`, `:color`, `:unit`  
**System**: `:binary`, `:database`, `:socket`, `:error`, `:object`

## Installation

1. Open Zed
2. Go to Extensions (`Cmd+Shift+X` / `Ctrl+Shift+X`)
3. Search for "Arturo"
4. Click "Install"

## Requirements

- Zed Editor (latest version)
- Arturo language runtime (for executing code)

## Configuration

The extension works out of the box with no configuration required. The LSP starts automatically when you open an `.art` file.

### LSP Feature Toggles (v2.0+)

You can selectively enable or disable specific LSP features through your Zed `settings.json`:

```json
"lsp": {
	"arturo-lsp": {
	  "initialization_options": {
	    "settings": {
	      "completion": "on",			// Disable code completion
	      "signatures": "on",			// Enable signature help (default)
	      "formatting": "on",			// Disable document formatting
	      "highlights": "on",			// Enable document highlights (default)
	      "advancedServerLogs": "on"	// Enable advanced server logs
	    }
	  }
	}
}
```

**Available Features**:

- `completions` - Code completion and autocomplete suggestions
- `signatures` - Signature help (parameter hints)
- `formatting` - Document formatting
- `highlights` - Document highlights (symbol occurrences)
- `advancedserverlogs` - Advanced debug LSP server logs for troubleshooting

**Default Behavior**: All features except `advancedserverlogs` are enabled by default. Set a feature to `"off"` to disable it.

**IMPORTANT**: Settings changes require a **Zed restart** to take effect. This is because settings are only read when the LSP server initializes.

**When to Use**:

- Disable `completions` if you prefer manual typing without autocomplete
- Disable `signatures` if parameter hints feel intrusive
- Disable `formatting` if you have custom formatting preferences
- Disable `highlights` if you find automatic highlighting distracting
- Enable `advancedserverlogs` when troubleshooting LSP server initialization issues

**How to Change Settings**:

1. Edit your `settings.json` with the desired changes
2. Save the file
3. **Close and restart Zed completely**
4. Open an `.art` file to verify the changes took effect

## Usage

### Basic Editing

Simply open any `.art` file and the extension will provide:

- Syntax highlighting
- Code completion (triggered automatically or with `Ctrl+Space`)
- Hover information (hover over any symbol)
- Error diagnostics (shown inline)
- Inlay hints (parameter names and types shown inline)

### Advanced Features

**Go to Definition**: Right-click on a symbol → "Go to Definition" or press `F12`

**Find References**: Right-click on a symbol → "Find All References" or press `Shift+F12`

**Rename Symbol**: Right-click on a symbol → "Rename Symbol" or press `F2`

**Format Document**: Right-click → "Format Document" or press `Shift+Alt+F`

**Signature Help**: Start typing a function call with `[` and parameter hints appear automatically

**Inlay Hints**: Parameter names and type information appear inline as you type (can be toggled in Zed settings)

**Rainbow Brackets**: Enable in Zed settings to see color-coded bracket pairs

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues.

## License

MIT License - see LICENSE file for details

## Links

- **Arturo Language**: <https://arturo-lang.io/>
- **Zed Editor**: <https://zed.dev/>
- **Tree-sitter**: <https://tree-sitter.github.io/>
- **LSP Specification**: <https://microsoft.github.io/language-server-protocol/>
- **GitHub Repository**: <https://github.com/DaZhi-the-Revelator/zed-arturo>

## Support

For issues, questions, or suggestions:

- Open an issue on [GitHub](https://github.com/DaZhi-the-Revelator/zed-arturo/issues)
- Join the Arturo community on Discord
- Check the [Arturo documentation](https://arturo-lang.io/documentation)

---

### Made with ❤️ for the Arturo community
