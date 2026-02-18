/**
 * Workspace Indexer for Arturo LSP
 *
 * Scans all .art files in the workspace and builds a cross-file index of
 * user-defined functions and variables. This allows hover, completion,
 * go-to-definition, and signature help to work for user functions across
 * the entire project, not just the currently open file.
 *
 * Design:
 *  - On initialization, scans all .art files found via workspace folders
 *  - Maintains a per-file symbol table that is updated when files change
 *  - Exposes the merged workspace-wide view to server.js
 *  - Extracts parameter names from function definitions for signature help
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip single-line Arturo comments (; to end of line).
 * Does not attempt to handle multiline strings perfectly — good enough for
 * symbol extraction purposes.
 */
function stripComments(text) {
    return text.split('\n').map(line => {
        let inString = false;
        let stringChar = null;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            const prev = i > 0 ? line[i - 1] : '';
            if (!inString) {
                if (ch === '"' || ch === '{' || ch === '\u00ab') {
                    inString = true; stringChar = ch;
                } else if (ch === ';') {
                    return line.substring(0, i);
                }
            } else {
                if ((stringChar === '"'       && ch === '"'       && prev !== '\\') ||
                    (stringChar === '{'       && ch === '}'                       ) ||
                    (stringChar === '\u00ab'  && ch === '\u00bb'                  )) {
                    inString = false; stringChar = null;
                }
            }
        }
        return line;
    }).join('\n');
}

/**
 * Extract parameter names from a function/method definition string.
 * Handles:
 *   function [param1 param2 param3]
 *   $[param1 param2]
 *   function 'singleParam
 */
function extractParams(defValue) {
    const blockMatch = defValue.match(/(?:function|method|\$)\s*\[([^\]]*)\]/);
    if (blockMatch) {
        return blockMatch[1].trim().split(/\s+/)
            .map(p => p.replace(/:[a-zA-Z]+/g, '').trim())
            .filter(p => p && !p.startsWith(':'));
    }
    const singleMatch = defValue.match(/(?:function|method)\s+'(\w+)/);
    if (singleMatch) return [singleMatch[1]];
    return [];
}

/**
 * Parse a single .art source file and return its symbol table.
 *
 * Returns:
 *   {
 *     functions: Map<name, { line, column, params, docComment, filePath }>
 *     variables: Map<name, { line, column, type, filePath }>
 *   }
 */
function parseArtFile(filePath) {
    let source;
    try {
        source = fs.readFileSync(filePath, 'utf8');
    } catch {
        return { functions: new Map(), variables: new Map() };
    }

    const clean = stripComments(source);
    const rawLines = source.split('\n');
    const cleanLines = clean.split('\n');

    const functions = new Map();
    const variables = new Map();

    cleanLines.forEach((line, lineIndex) => {
        // Match:  name: function [...] [...]  or  name: $[...] [...]
        const assignMatch = line.match(/^(\w[\w-]*)\s*:\s*(.+)/);
        if (!assignMatch) return;

        const name  = assignMatch[1];
        const value = assignMatch[2].trim();
        const col   = line.indexOf(name);

        // Grab the comment on the preceding line (if any) as a doc-comment
        let docComment = '';
        if (lineIndex > 0) {
            const prevRaw = rawLines[lineIndex - 1].trim();
            if (prevRaw.startsWith(';')) {
                docComment = prevRaw.replace(/^;\s*/, '');
            }
        }

        if (value.startsWith('function') || value.startsWith('$') || value.startsWith('method')) {
            functions.set(name, {
                line:       lineIndex,
                column:     col,
                params:     extractParams(value),
                docComment,
                filePath,
            });
        } else {
            variables.set(name, {
                line:    lineIndex,
                column:  col,
                type:    inferSimpleType(value),
                filePath,
            });
        }
    });

    return { functions, variables };
}

/**
 * Very lightweight type inference — mirrors the logic in server.js but kept
 * independent to avoid a circular dependency.
 */
function inferSimpleType(value) {
    value = value.trim();
    if (/^-?\d+$/.test(value))                          return ':integer';
    if (/^-?\d+\.\d+$/.test(value))                    return ':floating';
    if (/^(true|false|maybe)$/.test(value))             return ':logical';
    if (value === 'null')                               return ':null';
    if (value.startsWith('"') || value.startsWith('{')) return ':string';
    if (value.startsWith('['))                          return ':block';
    if (value.startsWith('#['))                         return ':dictionary';
    if (value.startsWith('function') || value.startsWith('$')) return ':function';
    if (value.startsWith('method'))                     return ':method';
    if (/^#([0-9a-fA-F]{6}|[a-z]+)$/.test(value))     return ':color';
    if (value.includes('..'))                           return ':range';
    return ':any';
}

// ─── WorkspaceIndexer class ───────────────────────────────────────────────────

class WorkspaceIndexer {
    constructor(logger) {
        this.logger     = logger || console;
        /** Map<filePath, { functions: Map, variables: Map }> */
        this.fileIndex  = new Map();
        /** Merged view — rebuilt whenever any file changes */
        this.functions  = new Map();   // name → { ...info, filePath }
        this.variables  = new Map();   // name → { ...info, filePath }
        this.rootPaths  = [];
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Scan all .art files under the given workspace root paths.
     * Non-blocking: yields between files so the LSP stays responsive.
     */
    async indexWorkspace(rootPaths) {
        this.rootPaths = rootPaths || [];
        if (this.rootPaths.length === 0) {
            this.logger.log('[WorkspaceIndexer] No workspace folders — skipping scan');
            return;
        }

        this.logger.log(`[WorkspaceIndexer] Scanning ${this.rootPaths.length} workspace folder(s)...`);
        const artFiles = [];
        for (const root of this.rootPaths) {
            this._collectArtFiles(root, artFiles);
        }

        this.logger.log(`[WorkspaceIndexer] Found ${artFiles.length} .art file(s)`);

        for (const filePath of artFiles) {
            this._indexFile(filePath);
            // Yield to event loop every 20 files so we don't block
            if (artFiles.indexOf(filePath) % 20 === 19) {
                await new Promise(r => setImmediate(r));
            }
        }

        this._rebuildMerged();
        this.logger.log(
            `[WorkspaceIndexer] Indexed ${this.functions.size} functions, ` +
            `${this.variables.size} variables across ${this.fileIndex.size} files`
        );
    }

    /**
     * Re-index a single file (called when the file is saved or changed).
     * Accepts either a file:// URI or a plain filesystem path.
     */
    indexFile(uriOrPath) {
        const filePath = uriOrPath.startsWith('file://')
            ? decodeURIComponent(uriOrPath.replace(/^file:\/\//, '').replace(/^\/([A-Z]:)/, '$1'))
            : uriOrPath;

        if (!filePath.endsWith('.art')) return;

        this._indexFile(filePath);
        this._rebuildMerged();
        this.logger.log(`[WorkspaceIndexer] Re-indexed ${path.basename(filePath)}`);
    }

    /**
     * Remove a file from the index (called when a file is deleted).
     */
    removeFile(uriOrPath) {
        const filePath = uriOrPath.startsWith('file://')
            ? decodeURIComponent(uriOrPath.replace(/^file:\/\//, '').replace(/^\/([A-Z]:)/, '$1'))
            : uriOrPath;

        if (this.fileIndex.has(filePath)) {
            this.fileIndex.delete(filePath);
            this._rebuildMerged();
            this.logger.log(`[WorkspaceIndexer] Removed ${path.basename(filePath)} from index`);
        }
    }

    /**
     * Get the signature object for a user-defined function, suitable for
     * use in hover and signature help.
     * Returns null if not found.
     */
    getFunctionInfo(name) {
        const info = this.functions.get(name);
        if (!info) return null;

        const paramStr = info.params.map(p => p).join(' ');
        const signature = `${name}${paramStr ? ' ' + paramStr : ''} -> :any`;

        return {
            signature,
            description:  info.docComment || `User-defined function in ${path.basename(info.filePath)}`,
            params:       info.params.map(p => ({ name: p, type: ':any' })),
            returns:      ':any',
            isUserDefined: true,
            filePath:     info.filePath,
            line:         info.line,
        };
    }

    /**
     * Check whether a name is a known user-defined function.
     */
    hasFunction(name) {
        return this.functions.has(name);
    }

    /**
     * Check whether a name is a known user-defined variable.
     */
    hasVariable(name) {
        return this.variables.has(name);
    }

    /**
     * Get all user-defined function names (for completion).
     */
    getAllFunctionNames() {
        return Array.from(this.functions.keys());
    }

    /**
     * Get all user-defined variable names (for completion).
     */
    getAllVariableNames() {
        return Array.from(this.variables.keys());
    }

    /**
     * Get location info for go-to-definition.
     * Returns { filePath, line, column } or null.
     */
    getDefinitionLocation(name) {
        const fn = this.functions.get(name);
        if (fn) return { filePath: fn.filePath, line: fn.line, column: fn.column };
        const vr = this.variables.get(name);
        if (vr) return { filePath: vr.filePath, line: vr.line, column: vr.column };
        return null;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    _indexFile(filePath) {
        const symbols = parseArtFile(filePath);
        this.fileIndex.set(filePath, symbols);
    }

    /**
     * Rebuild the merged function/variable maps from all file indexes.
     * Later files win on name collision (alphabetical by path for determinism).
     */
    _rebuildMerged() {
        this.functions = new Map();
        this.variables = new Map();

        // Sort paths for deterministic ordering
        const sortedPaths = Array.from(this.fileIndex.keys()).sort();

        for (const filePath of sortedPaths) {
            const { functions, variables } = this.fileIndex.get(filePath);
            functions.forEach((info, name) => this.functions.set(name, info));
            variables.forEach((info, name) => this.variables.set(name, info));
        }
    }

    /**
     * Recursively collect all .art files under a directory.
     * Skips node_modules, .git, .cache, and hidden directories.
     */
    _collectArtFiles(dir, result) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (entry.name.startsWith('.') ||
                entry.name === 'node_modules' ||
                entry.name === '.cache') continue;

            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this._collectArtFiles(full, result);
            } else if (entry.isFile() && entry.name.endsWith('.art')) {
                result.push(full);
            }
        }
    }
}

module.exports = WorkspaceIndexer;
