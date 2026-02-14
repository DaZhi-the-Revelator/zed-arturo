# Complete Rebuild Guide for Arturo Tree-Sitter and Zed Extension

This guide provides a comprehensive process for rebuilding both the tree-sitter grammar and Zed extension from scratch. Follow these steps whenever you make changes to either repository.

## Overview

The rebuild process consists of two main phases:

1. **Tree-Sitter Grammar**: Regenerate parser files from grammar.js and update query files
2. **Zed Extension**: Fetch updated grammar and rebuild the extension

## Prerequisites

- Node.js (v14+) and npm installed
- Rust toolchain installed with wasm32-wasip1 target
- Git command-line tools
- Both repositories cloned to your machine

## Phase 1: Rebuild Tree-Sitter Grammar

Location: `C:\Users\virgil\Packages\Mine\tree-sitter-arturo`

### Step 1: Navigate to tree-sitter-arturo

```cmd
cd C:\Users\virgil\Packages\Mine\tree-sitter-arturo
```

### Step 2: Clean Old Generated Files

```cmd
del /Q src\parser.c 2>nul
del /Q src\grammar.json 2>nul
del /Q src\node-types.json 2>nul
del /Q parser.exp 2>nul
del /Q parser.lib 2>nul
del /Q parser.obj 2>nul
rmdir /S /Q build 2>nul
```

**What this does**: Removes all generated parser files and build artifacts to ensure a clean rebuild.

### Step 3: Generate Parser from Grammar

**CRITICAL**: This must be done FIRST, before npm install.

```cmd
npm run generate
```

**What this does**: Runs `tree-sitter generate` to create:

- `src/parser.c` - The C parser implementation
- `src/grammar.json` - Grammar structure data
- `src/node-types.json` - AST node type definitions

### Step 4: Install/Update Dependencies

```cmd
npm install
```

**What this does**: Installs dependencies and compiles the native addon using parser.c.

**NOTE**: This step must come AFTER `npm run generate` because npm install tries to compile parser.c.

### Step 5: Run Tests

```cmd
npm test
```

**What this does**: Verifies the grammar works correctly with test cases in `test/corpus/`.

### Step 6: Check Current Branch

```cmd
git branch
```

**What this does**: Confirms you're on the correct branch (should be `2.0-dev`).

### Step 7: Stage and Commit Changes

If you modified `grammar.js` or query files:

```cmd
git add -A
git commit -m "Description of changes"
```

**Example commit messages**:

- "Enhanced outline.scm with explicit function/constant captures"
- "Fixed grammar.js label structure for better queries"
- "Updated highlights.scm operator list"

### Step 8: Push to GitHub

```cmd
git push origin 2.0-dev
```

**CRITICAL**: The Zed extension fetches the grammar from GitHub, so changes must be pushed.

### Step 9: Get Latest Commit Hash

```cmd
git rev-parse HEAD
```

**IMPORTANT**: Copy this full commit hash. You'll need it for `extension.toml` in the Zed extension.

**Example**: `3797f71d9ef100c9e1d4b4b727de0e29db0b04fb`

## Phase 2: Update and Rebuild Zed Extension

Location: `C:\Users\virgil\Packages\Mine\zed-arturo`

### Step 1: Navigate to zed-arturo

```cmd
cd C:\Users\virgil\Packages\Mine\zed-arturo
```

### Step 2: Check Current Branch

```cmd
git branch
```

**What this does**: Confirms you're on the correct branch (should be `2.0-dev`).

### Step 3: Update Grammar Commit Hash in extension.toml

**ONLY do this if you pushed changes to tree-sitter-arturo.**

Edit `extension.toml` and update the commit hash:

```toml
[grammars.arturo]
repository = "https://github.com/DaZhi-the-Revelator/tree-sitter-arturo"
commit = "PASTE_THE_COMMIT_HASH_HERE"
```

**Example**:

```toml
commit = "3797f71d9ef100c9e1d4b4b727de0e29db0b04fb"
```

### Step 4: Run the Build Script

**The easy way** - Use the build script:

```cmd
build-embedded.bat
```

This script automatically handles:

- Cleaning old build artifacts
- Removing the old grammar directory
- Rebuilding the LSP bundle
- Compiling the Rust extension
- Embedding bundle.js in the WASM
- Verifying the build

**Follow the on-screen prompts and verify each step completes successfully.**

### Step 5: Manual Rebuild (Alternative)

If the script fails or you prefer manual control:

```cmd
REM Clean old files
del /Q bundle.js extension.wasm 2>nul
rmdir /S /Q grammars\arturo 2>nul
rmdir /S /Q target\wasm32-wasip1\release 2>nul

REM Build LSP bundle
cd language-server
call npm install
call npm run build
cd ..

REM Ensure embedded configuration
cd src
copy /Y lib-embedded.rs lib.rs
cd ..

REM Build WASM extension
cargo clean
cargo build --release --target wasm32-wasip1

REM Copy final WASM
copy /Y target\wasm32-wasip1\release\zed_arturo.wasm extension.wasm

REM Clear Zed cache
rmdir /S /Q "%LOCALAPPDATA%\Zed\extensions\work\arturo" 2>nul
```

## Phase 3: Install in Zed

### Step 1: Close Zed Completely

**CRITICAL**: Ensure Zed is completely closed (not minimized).

Check Task Manager if needed: `Ctrl+Shift+Esc` → Look for "Zed" process → End Task

### Step 2: Reopen Zed

Launch Zed fresh.

### Step 3: Install Dev Extension

1. Press `Ctrl+Shift+X` to open Extensions panel
2. Click **Install Dev Extension** button (or use Command Palette: `zed: install dev extension`)
3. Browse to: `C:\Users\virgil\Packages\Mine\zed-arturo`
4. Click **Open** or **Select Folder**

### Step 4: Verify Installation

1. Zed will show a notification that the extension is installed
2. The extension should appear in the Extensions list

### Step 5: Test the Extension

1. Create or open a `.art` file
2. Verify syntax highlighting works
3. Test LSP features:
   - Hover over symbols
   - Try code completion (`Ctrl+Space`)
   - Check outline view (`Ctrl+Shift+O` or outline panel `Ctrl+Shift+B`)
   - Verify breadcrumbs show current function/variable
   - **Check for icons** in outline and breadcrumbs

### Step 6: Check Outline Icons Specifically

The main fix in this rebuild is outline icons. Verify:

1. Open an `.art` file with function and variable definitions
2. Open the outline panel (`Ctrl+Shift+B`) or buffer symbols (`Ctrl+Shift+O`)
3. Look for icons next to symbols:
   - Functions (assignments with block values) should have function icons
   - Variables (other assignments) should have variable/constant icons
4. Check breadcrumbs at the top of the editor - icons should appear there too

**Example test file**:

```arturo
; Test file for outline icons
name: "Arturo"
version: 1.0

greet: function [person][
    print ["Hello" person]
]

calculate: [x][
    x * 2
]
```

Expected outline:

- name (variable icon)
- version (variable icon)  
- greet (function icon)
- calculate (function icon)

### Step 7: Check Logs (if issues occur)

1. Open Zed Log: Menu → **View** → **Zed Log** (or `Ctrl+Shift+L`)
2. Look for "Arturo" or "arturo-lsp" entries
3. Check for initialization messages or errors
4. Look for grammar fetch/compile messages

## What Gets Rebuilt When

### Tree-Sitter Grammar Changes

Files that affect the grammar:

- `grammar.js` - Core grammar rules
- `queries/*.scm` - Tree-sitter query files (highlights, outline, brackets, etc.)

**When changed, you must**:

1. Rebuild tree-sitter grammar (`npm run generate`)
2. Test locally (`npm test`)
3. Commit and push changes
4. Get new commit hash
5. Update `extension.toml` in zed-arturo
6. Rebuild Zed extension

### Zed Extension Changes

Files that only affect the extension:

- `language-server/server.js` - LSP implementation
- `languages/arturo/config.toml` - Language configuration
- `src/lib.rs` or `src/lib-embedded.rs` - Rust extension code
- `extension.toml` - Extension metadata (NOT grammar commit hash)

**When changed, you only need to**:

1. Rebuild Zed extension (run `build-embedded.bat`)
2. Reinstall in Zed

**You do NOT need to rebuild tree-sitter-arturo.**

### Grammar Commit Hash Changes

**When to update**: Only when you've pushed new commits to tree-sitter-arturo that you want the Zed extension to use.

**How Zed uses it**:

1. During `cargo build`, Zed fetches the exact commit specified
2. Zed compiles the grammar from that commit
3. The compiled grammar is used for syntax highlighting and queries

**Important**: If you don't update the commit hash, Zed will keep using the old grammar even if you've pushed new changes.

## Troubleshooting

### Outline Icons Not Showing

**Symptoms**: Outline view shows symbols but no icons, or all symbols have the same icon.

**Diagnosis**:

1. Check that `queries/outline.scm` exists in tree-sitter-arturo
2. Verify the outline.scm has been updated with `@definition.function` and `@definition.constant` captures
3. Confirm the grammar commit hash in `extension.toml` points to a commit with the updated outline.scm

**Fix**:

1. Update `queries/outline.scm` in tree-sitter-arturo (see Phase 1)
2. Commit and push changes
3. Update commit hash in `extension.toml`
4. Rebuild Zed extension completely (see Phase 2)
5. Clear Zed cache and reinstall

**Verification**:

1. After rebuild, check `grammars/arturo/queries/outline.scm` in zed-arturo directory
2. It should contain the updated capture names (e.g., `@definition.function`)
3. This file is fetched from GitHub during cargo build

### Grammar Not Updating

**Problem**: Changed grammar.js but syntax highlighting didn't change.

**Causes**:

1. Didn't run `npm run generate` after editing grammar.js
2. Didn't push changes to GitHub
3. Didn't update commit hash in extension.toml
4. Zed is using cached grammar

**Fix**:

1. In tree-sitter-arturo: `npm run generate`, test, commit, push
2. Copy commit hash: `git rev-parse HEAD`
3. In zed-arturo: Update extension.toml with new hash
4. Delete `grammars/arturo` directory in zed-arturo
5. Run `build-embedded.bat`
6. Zed will fetch and compile the new grammar

### LSP Features Not Working

**Problem**: Syntax highlighting works but no hover/completion/etc.

**Diagnosis**: Check Zed Log for "arturo-lsp" errors.

**Common causes**:

1. `bundle.js` not properly embedded in WASM
2. Settings have features disabled
3. LSP server crashed on initialization

**Fix**:

1. Verify `bundle.js` exists at root after running language-server build
2. Check `extension.wasm` size (should be 2-4MB)
3. Run `cargo clean` before `cargo build` to ensure fresh embedding
4. Check settings.json - features should be "on" or omitted for defaults
5. Restart Zed after checking settings (settings are read at LSP init)

### npm install Fails with "Cannot find module './parser'"

**Problem**: Running `npm install` before generating parser.c.

**Fix**:

1. Always run `npm run generate` FIRST
2. Then run `npm install`

**Why**: npm install tries to compile parser.c with node-gyp, but parser.c doesn't exist until you run `npm run generate`.

### Cargo Build Fails

**Problem**: Various build errors during `cargo build --release --target wasm32-wasip1`.

**Common causes**:

1. bundle.js not found at root
2. wasm32-wasip1 target not installed
3. Grammar fetch/compile failed

**Fix**:

1. Verify bundle.js exists: `dir bundle.js`
2. Check WASM target: `rustup target list | findstr wasm32-wasip1`
3. Add target if missing: `rustup target add wasm32-wasip1`
4. Check network connection (Zed needs to fetch grammar from GitHub)
5. Verify commit hash in extension.toml is correct
6. Try clean build: `cargo clean && cargo build --release --target wasm32-wasip1`

### Extension.wasm Too Small

**Problem**: Extension built but WASM file is much smaller than expected.

**Symptoms**:

- bundle.js is ~500KB-1MB
- extension.wasm is less than 2MB (should be at least 2MB)

**Diagnosis**: bundle.js was not embedded; cargo used cached build.

**Fix**:

1. Run `cargo clean` to clear cache
2. Verify `src/lib.rs` is the embedded version: `copy /Y src\lib-embedded.rs src\lib.rs`
3. Rebuild: `cargo build --release --target wasm32-wasip1`
4. Check new size of extension.wasm

### Zed Doesn't See the Extension

**Problem**: Extension doesn't appear after installation.

**Checks**:

1. `extension.toml` exists in root
2. `extension.wasm` exists in root
3. Zed was completely closed before reinstalling

**Fix**:

1. Close Zed completely (check Task Manager)
2. Verify both files exist and are recent
3. Reopen Zed
4. Try Install Dev Extension again

## Quick Reference: Complete Rebuild Sequence

For copy-paste convenience when doing a full rebuild from scratch:

```cmd
REM === PHASE 1: TREE-SITTER REBUILD ===
cd C:\Users\virgil\Packages\Mine\tree-sitter-arturo

REM Clean
del /Q src\parser.c src\grammar.json src\node-types.json parser.* 2>nul
rmdir /S /Q build 2>nul

REM Generate and test
npm run generate
npm install
npm test

REM Commit and push (if you made changes)
git add -A
git commit -m "Your commit message here"
git push origin 2.0-dev

REM Get commit hash
git rev-parse HEAD
REM Copy this hash!

REM === PHASE 2: ZED EXTENSION REBUILD ===
cd C:\Users\virgil\Packages\Mine\zed-arturo

REM Update extension.toml with the new commit hash (if needed)
REM Edit extension.toml: [grammars.arturo] commit = "PASTE_HASH_HERE"

REM Run build script
build-embedded.bat

REM === PHASE 3: INSTALL IN ZED ===
REM 1. Close Zed completely
REM 2. Reopen Zed
REM 3. Ctrl+Shift+X → Install Dev Extension → Select zed-arturo folder
REM 4. Open a .art file and test
REM 5. Check outline (Ctrl+Shift+B) for icons
```

## Manual Rebuild Commands (If Script Fails)

```cmd
REM Navigate to zed-arturo
cd C:\Users\virgil\Packages\Mine\zed-arturo

REM Clean everything
del /Q bundle.js extension.wasm 2>nul
rmdir /S /Q grammars\arturo 2>nul
rmdir /S /Q target\wasm32-wasip1\release 2>nul

REM Build LSP bundle
cd language-server
call npm install
call npm run build
cd ..

REM Verify bundle was created
dir bundle.js

REM Configure embedded build
cd src
copy /Y lib-embedded.rs lib.rs
cd ..

REM Clean and rebuild WASM
cargo clean
cargo build --release --target wasm32-wasip1

REM Copy and rename WASM
copy /Y target\wasm32-wasip1\release\zed_arturo.wasm extension.wasm

REM Verify files
dir bundle.js
dir extension.wasm

REM Clear Zed cache
rmdir /S /Q "%LOCALAPPDATA%\Zed\extensions\work\arturo" 2>nul

echo Rebuild complete!
```

## Important Reminders

- **ALWAYS run `npm run generate` before `npm install`** in tree-sitter-arturo
- **ALWAYS push grammar changes to GitHub** before updating Zed extension
- **ALWAYS update extension.toml commit hash** when using new grammar commits
- **ALWAYS close Zed completely** before reinstalling extension
- **Settings require full Zed restart** - they're read at LSP initialization
- **Zed fetches grammar from GitHub** during cargo build - ensure network connectivity
- **Grammar is at `grammars/arturo`** after Zed fetches it - can verify query files there
- **WASM target is wasm32-wasip1** not regular release or wasm32-wasip2

## File Locations Reference

### Tree-Sitter (source)

- Grammar definition: `grammar.js`
- Generated parser: `src/parser.c`
- Query files: `queries/*.scm`
  - `highlights.scm` - Syntax highlighting
  - `outline.scm` - Outline/breadcrumbs (icons)
  - `brackets.scm` - Rainbow brackets
  - `injections.scm` - Language injections
  - `tags.scm` - Symbol tagging

### Zed Extension (source)

- Extension metadata: `extension.toml`
- LSP server source: `language-server/server.js`
- Language config: `languages/arturo/config.toml`
- Rust source: `src/lib.rs` or `src/lib-embedded.rs`

### Zed Extension (generated)

- LSP bundle: `bundle.js` (root)
- Compiled WASM: `target/wasm32-wasip1/release/zed_arturo.wasm`
- Final WASM: `extension.wasm` (root)
- Fetched grammar: `grammars/arturo/` (entire tree-sitter repo)
  - Includes `grammars/arturo/queries/*.scm` fetched from GitHub

### Zed Cache

- Cached extension: `%LOCALAPPDATA%\Zed\extensions\work\arturo`
- This directory should be deleted when reinstalling

## Testing Checklist

After rebuilding, verify these features work:

- [ ] Syntax highlighting (keywords, strings, numbers, comments)
- [ ] Code completion (functions, variables, types, attributes)
- [ ] Hover information (shows types and documentation)
- [ ] Go to definition (F12)
- [ ] Find references (Shift+F12)
- [ ] Document symbols outline (Ctrl+Shift+O)
- [ ] Outline panel (Ctrl+Shift+B)
- [ ] Breadcrumbs (top of editor)
- [ ] **Outline icons** (functions vs variables)
- [ ] Signature help (parameter hints)
- [ ] Document formatting (Shift+Alt+F)
- [ ] Rename symbol (F2)
- [ ] Document highlights (symbol under cursor)
- [ ] Inlay hints (parameter names inline)
- [ ] Folding ranges (collapse blocks)
- [ ] Rainbow brackets (if enabled in settings)

## Version Information

- Tree-sitter version: 2.0-dev
- Extension version: 2.0-dev (will be updated to match)
- Node.js requirement: 14+ (for ESM support)
- Rust requirement: Latest stable
- WASM target: wasm32-wasip1 (required by Zed)
- LSP protocol: 3.17

## References

- Tree-sitter documentation: https://tree-sitter.github.io/
- Zed extension docs: https://zed.dev/docs/extensions
- Arturo language: https://arturo-lang.io/
