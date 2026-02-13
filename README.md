# Arturo Language Support for Zed

A comprehensive language extension for [Arturo](https://arturo-lang.io/) in [Zed](https://zed.dev/), providing intelligent code editing features through a custom Language Server Protocol (LSP) implementation.

## Version

**Current Version**: 0.5.5

## Features

Please note Zed keymaps may have changed - use the Command Palette, Keymap and Key Context View when needed

### ✅ Core Language Intelligence

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

- **Signature Help**: Real-time parameter hints as you type function calls with active parameter tracking

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

### ✅ Outline Icons

Visual icons in the outline view and breadcrumbs:

- 🔧 Functions
- 📦 Variables
- 🔢 Constants
- 🔤 Strings
- And more for better navigation

### 📊 Supported Types

The LSP understands Arturo's complete type system:

**Primitives**: `:null`, `:logical`, `:integer`, `:floating`, `:char`, `:string`  
**Numbers**: `:complex`, `:rational`, `:quantity`, `:version`  
**Collections**: `:block`, `:dictionary`, `:range`, `:path`  
**Functions**: `:function`, `:method`, `:module`  
**Advanced**: `:type`, `:literal`, `:regex`, `:date`, `:color`, `:unit`  
**System**: `:binary`, `:database`, `:socket`, `:error`, `:object`

## Installation

### From Zed Extensions

1. Open Zed
2. Go to Extensions (`Cmd+Shift+X` / `Ctrl+Shift+X`)
3. Search for "Arturo"
4. Click "Install"

### Development Installation

1. Clone this repository:

   ```bash
   git clone https://github.com/DaZhi-the-Revelator/zed-arturo.git
   cd zed-arturo
   ```

2. Build the extension:

   ```bash
   ./build-embedded.bat (Windows)
   ./Build-embedded.sh (Linux / Mac)
   ```

3. Install as a dev extension. From the extensions page, click the 'Install Dev Extension' button (or the zed: install dev extension action) and select the directory containing your extension.

## Requirements

- Zed Editor (latest version)
- Arturo language runtime (for executing code)

## Configuration

The extension works out of the box with no configuration required. The LSP starts automatically when you open an `.art` file.

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

## Project Structure

```txt
zed-arturo/
├── extension.toml          # Extension metadata
├── language-server/        # LSP implementation
│   ├── server.js          # Main LSP server (1900+ lines, all features)
│   ├── package.json       # Node.js dependencies
│   └── README.md          # LSP documentation
├── languages/             # Language configuration
│   └── arturo/
│       ├── config.toml    # Language settings
│       ├── highlights.scm # Syntax highlighting queries
│       ├── brackets.scm   # Rainbow bracket pairs
│       └── folds.scm      # Code folding queries
├── grammars/             # Tree-sitter grammar
│   └── arturo/           # Linked from tree-sitter-arturo repo
└── src/                  # Rust extension code
    └── lib.rs           # Extension entry point
```

## Development

### Building from Source

```bash
# Install dependencies
cd language-server
npm install

# Test the LSP standalone
node server.js --stdio

# Build the Zed extension
cd ..
./build-embedded.bat (Windows)
./Build-embedded.sh (Linux / Mac)
```

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues.

### Areas for Contribution

- Add more function signatures to `BUILTIN_FUNCTIONS` in `server.js`
- Implement Semantic Tokens for enhanced highlighting
- Improve type inference accuracy
- Add code snippets
- Enhance documentation
- Report bugs or suggest features

## Changelog

### v0.5.5 (Current)

- 🐛 **CRITICAL FIX: Document Symbols (Outline/Breadcrumbs)** - Fully working now!
  - **ROOT CAUSE**: Labels were defined as a single token including the colon (`myFunc:`), making it impossible for tree-sitter queries to capture just the identifier
  - **BREAKING CHANGE**: Modified tree-sitter grammar to separate label identifier from colon
    - Old: `label: $ => /[a-zA-Z_][\w-]*\??:/` (single token)
    - New: `label: $ => seq(field('identifier', /[a-zA-Z_][\w-]*\??/), ':')` (sequence with field)
  - Updated all query files (highlights.scm, outline.scm, tags.scm) to use new structure
  - Symbol names now display without trailing colon (e.g., `myFunc` instead of `myFunc:`)
  - Buffer Symbols (Ctrl+Shift+O) now shows all functions and variables
  - Outline Panel displays complete symbol tree with proper nesting
  - Breadcrumbs show current function/variable context (not just filename)

### v0.5.4

- 🐛 **FIXED: Document Symbols (Outline/Breadcrumbs)** - Partial fix (Buffer symbols showed with trailing colons)
  - **ROOT CAUSE**: Zed uses tree-sitter queries (`outline.scm`) for outline/breadcrumbs, not LSP documentSymbol
  - **FIX**: Created `queries/outline.scm` and `queries/tags.scm` files to define symbol extraction rules via tree-sitter
  - **LIMITATION**: Labels still showed with trailing colons due to grammar structure
  - **IMPORTANT**: You must rebuild the Zed extension after adding these files (run `build-embedded.bat`)
  - **BONUS FIX**: Also fixed LSP handler to use `connection.onRequest('textDocument/documentSymbol', ...)` pattern (for potential future use)
  - Outline panel displays all functions and variables (but with colons)
  - Breadcrumbs show current symbol context (but with colons)
  - Fixed outline icon configuration to use correct Zed format (changed from array to map)
  - Added comprehensive logging for debugging symbol extraction
  - Document symbols are now sorted by line number for better organization

### v0.5.3

- ✨ **NEW: Code Snippets** - 19 built-in snippets for common Arturo patterns
  - Control flow: `if`, `ifelse`, `unless`, `when`, `switch`
  - Loops: `while`, `loop`
  - Functions: `func`, `tfunc` (typed function)
  - Collections: `map`, `filter`, `fold`, `dict`, `block`
  - Error handling: `try` (try-catch)
  - I/O: `print`, `inspect`
  - Other: `interp` (interpolated string), `comment`
  - Just type the prefix and press Tab to expand!

- ✨ **NEW: Smart Auto-Closing** - Enhanced bracket and quote pairing
  - Added auto-closing for `{:` `:}` (multiline strings)
  - Added auto-closing for `«` `»` and `««` `»»` (guillemet strings)
  - Added auto-closing for `|` `|` (interpolation markers)
  - Improved autoclose_before to include newlines and tabs

- ✨ **NEW: Intelligent Word Selection** - Smart identifier selection
  - Double-click now selects entire Arturo identifiers including hyphens and `?`
  - Examples: `my-function`, `prime?`, `contains?`, `my-var?`
  - Defined `word_characters = "a-zA-Z0-9_-?"` in config

- ✨ **NEW: Outline Icons** - Visual symbols in outline view
  - Functions show 🔧 icon
  - Variables show 📦 icon
  - Constants, strings, and other symbols have appropriate icons
  - Improves navigation in outline view and breadcrumbs

- 🔧 **ENHANCED: Indentation Settings** - Explicit 4-space indentation
  - Matches LSP formatter settings
  - Consistent code formatting across the extension

### v0.5.2

- ✨ **NEW: Rainbow Brackets Support** - Added bracket matching visualization
  - Created `brackets.scm` file defining bracket pairs for rainbow coloring
  - Supports square brackets `[]` (blocks) and dictionary brackets `#[]`
  - Users can enable rainbow brackets by adding `"colorize_brackets": true` in Zed settings
  - Different nesting levels displayed with different colors for better code structure visualization
  - No extension code changes required - leverages Zed's built-in rainbow brackets feature
  - 🐛 **FIXED**: Rainbow brackets now work correctly (was failing with "Invalid node type" error)

### v0.5.1

- 🐛 **CRITICAL FIX: Rename Symbol** - Now fully working (F2 triggers inline rename box, changes apply)
  - Root cause: `getWordAtPosition()` helper function didn't handle cursor at start of word
  - When Zed calls `textDocument/rename` at the start position of a word (from prepareRename), the function returned null
  - Fixed by adding special case to detect word starting at cursor position
  - Rename now works perfectly from any cursor position within a symbol

### v0.5.0

- 🐛 **CRITICAL FIX: Rename Symbol** - Now fully working (F2 triggers inline rename box, changes apply)
  - Root cause: duplicate `isInComment` function with incompatible signatures caused silent logic errors
  - Removed redundant 3-argument definition; updated all 6 call sites to use `isInComment(line, col)`
- 🐛 **CRITICAL FIX: Document Highlights** - Now fully working (mouseover highlights all occurrences)
  - Same root cause as Rename Symbol fix above
- 🗑️ **REMOVED: Call Hierarchy** - Zed does not support the Call Hierarchy LSP protocol
  - Removed `callHierarchyProvider` capability, all three handler blocks, and unused imports
  - Will be re-added if/when Zed adds support
- 📝 Updated all documentation to reflect 14 LSP features (was 15)

### v0.4.9

- 🐛 **CRITICAL FIX: Hover Information** - Fixed function signature mismatch causing hover to fail
  - Hover now works for built-in functions, variables, user-defined functions, types, and attributes
  - In-lined comment detection logic to resolve signature conflict
  - Displays function signatures with descriptions for 80+ built-in functions
- 🐛 **FIXED: Type Checking** - Now correctly detects type mismatches in binary operations
  - Added type checking for operations mixing numbers and strings
  - Error messages specify the exact type mismatch (e.g., "Cannot add number and string")
  - Type checking validates both literal types and inferred variable types
- 🐛 **FIXED: Document Formatting** - Improved spacing normalization
  - Correctly normalizes spacing around colons for assignments (`name: value`)
  - Normalizes spacing around operators (`+`, `-`, `*`, `/`, `=`, `<`, `>`)
  - Removes excessive whitespace
  - Example: `y :    10` now formats to `y: 10`
- 🐛 **FIXED: Rename Symbol** - Enhanced validation and safety
  - Improved identifier validation
  - Better conflict detection with built-in functions
  - More robust symbol detection across all use cases
- 📝 Updated documentation to reflect all fixes and improvements

### v0.4.8

- ✨ **NEW: Document Highlights** - Highlights all occurrences of symbol under cursor
  - Provides instant visual feedback for symbol usage
  - Faster than Find References for quick code scanning
  - Automatically updates as you move cursor
- ✨ **ENHANCED: Built-in Function Signatures** - Massively expanded from 9 to 80+ functions
  - Added comprehensive signatures for control flow (if, unless, when, switch, while, until, etc.)
  - Added all common string operations (upper, lower, split, join, replace, strip, etc.)
  - Added collection operations (map, filter, fold, sort, reverse, unique, flatten, etc.)
  - Added math operations (add, sub, mul, div, pow, sqrt, abs, min, max, sum, average, etc.)
  - Added trigonometry functions (sin, cos, tan)
  - Added logic operations (and, or, not)
  - Added comparison operators (equal?, greater?, less?)
  - Added dictionary operations (keys, values, has)
  - Added I/O operations (read, write, input)
  - Signature help now works for 80+ common functions!
- 📝 Updated server.js header to include Document Highlights
- 📝 All LSP features fully documented

### v0.4.7

- ✨ **NEW: Semantic Tokens** - Enhanced syntax highlighting from the LSP server
- ✨ **NEW: Workspace Symbols** - Global symbol search across all files
- ✨ **NEW: Call Hierarchy** - Function call relationship visualization
- 🐛 **CRITICAL FIX**: Fixed `connection.onPrepareCallHierarchy is not a function` error
  - Changed Call Hierarchy handlers from `connection.onPrepareCallHierarchy()` to `connection.onRequest('textDocument/prepareCallHierarchy', ...)`
  - Changed `connection.onCallHierarchyIncomingCalls()` to `connection.onRequest('callHierarchy/incomingCalls', ...)`
  - Changed `connection.onCallHierarchyOutgoingCalls()` to `connection.onRequest('callHierarchy/outgoingCalls', ...)`
  - These methods don't exist in vscode-languageserver 9.x, must use onRequest pattern
- 🐛 Fixed `connection.onInlayHint` error (changed to use `connection.onRequest` for LSP 3.17 compatibility)
- 🔧 Updated imports to include SemanticTokensBuilder and Call Hierarchy types
- ✅ Verified Semantic Tokens and Workspace Symbols use correct handler patterns
- 📝 Updated documentation to reflect all implemented LSP 3.17 features
- 📝 Clarified that all LSP 3.17 features (except Code Lens) are now implemented

### v0.4.6

- 🐛 Fixed highlights.scm operator definitions (removed non-existent operators)
- 📝 Corrected README about LSP version support (Zed supports 3.17, not "10.0+")
- ✅ Verified hover functionality is working correctly
- 📝 Clarified that vscode-languageserver is a standard LSP library, not VSCode-specific
- 📝 Updated documentation about Inlay Hints and Semantic Tokens support

### v0.4.5

- ✅ Re-implemented all core LSP features after revert
- ✅ Signature Help with active parameter tracking
- ✅ Find All References (scope-aware)
- ✅ Rename Symbol with validation
- ✅ Document Formatting (bracket-aware indentation)
- ✅ Folding Ranges (multi-line blocks)
- ✅ Document Symbols (outline view)
- ✅ Enhanced server.js (1842 lines, 65KB)
- ✅ Optimized tree-sitter grammar for WASM compilation
- 🔧 Fixed "out of memory" grammar compilation error
- 📝 Comprehensive documentation updates

### v0.4.0

- Documented LSP capabilities
- Enhanced type checking

### v0.3.0

- Added type checking
- Improved hover information
- Enhanced code completion

### v0.2.0

- Initial LSP implementation
- Basic syntax highlighting
- Go-to-definition support

### v0.1.0

- Initial release
- Tree-sitter grammar integration
- Basic syntax highlighting

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
