/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ 5093
(module) {

"use strict";


/**
 * completion-ranker.js
 *
 * High-precision completion ranking for the Arturo LSP.
 *
 * ## Ranking model
 *
 * Each candidate is assigned a numeric score (higher = better). The score is
 * then encoded into a zero-padded `sortText` string so that editors which sort
 * completion lists lexicographically (including Zed) display items in the
 * correct order without any extra client-side logic.
 *
 * ### Score components (additive)
 *
 *   PREFIX_EXACT    +500  label starts with the query (case-sensitive)
 *   PREFIX_ICASE    +450  label starts with the query (case-insensitive)
 *   SUBSTRING       +200  label contains the query (not at position 0)
 *   ACRONYM         +150  query letters match the start of hyphen-separated segments
 *
 *   KIND_LOCAL_VAR  +400  variable defined in the current document
 *   KIND_LOCAL_FN   +380  function defined in the current document
 *   KIND_WS_VAR     +300  variable from another workspace file
 *   KIND_WS_FN      +280  function from another workspace file
 *   KIND_BUILTIN    +200  built-in function from the signature indexer
 *   KIND_TYPE       +100  type annotation
 *   KIND_ATTR       +100  attribute (already filtered to exact context)
 *   KIND_COLOR      +80   named colour
 *   KIND_UNIT       +80   physical unit
 *
 *   RECENCY         0–150 recently used symbols in the current document (decays with distance)
 *   FREQUENCY       0–100 how many times the symbol appears in the current document (capped)
 *   SCOPE_PROXIMITY 0–100 how close the symbol's definition is to the cursor (decays with line distance)
 *   QUERY_LENGTH    0–50  longer queries indicate stronger user intent; reward more specific matches
 *
 * The final `sortText` is `(9999 - score)` zero-padded to 4 digits so that
 * the item with the highest score sorts first ("0001" < "9999").
 *
 * ## Usage
 *
 *   const CompletionRanker = require('./lib/completion-ranker');
 *   const ranker = new CompletionRanker();
 *
 *   // Build context once per completion request
 *   const ctx = ranker.buildContext(document, position, documentSymbols, workspaceIndexer);
 *
 *   // Rank a list of raw CompletionItem objects
 *   const ranked = ranker.rank(items, query, ctx);
 *   // ranked items now have .sortText and .preselect set
 */

// ── Score constants ──────────────────────────────────────────────────────────

const S = {
    PREFIX_EXACT:    500,
    PREFIX_ICASE:    450,
    SUBSTRING:       200,
    ACRONYM:         150,

    KIND_LOCAL_VAR:  400,
    KIND_LOCAL_FN:   380,
    KIND_WS_VAR:     300,
    KIND_WS_FN:      280,
    KIND_BUILTIN:    200,
    KIND_TYPE:       100,
    KIND_ATTR:       100,
    KIND_COLOR:       80,
    KIND_UNIT:        80,

    RECENCY_MAX:     150,
    FREQUENCY_MAX:   100,
    PROXIMITY_MAX:   100,
    QUERY_LEN_MAX:    50,
};

// Maximum score possible — used for sortText normalisation
const MAX_SCORE = S.PREFIX_EXACT + S.KIND_LOCAL_VAR + S.RECENCY_MAX +
                  S.FREQUENCY_MAX + S.PROXIMITY_MAX + S.QUERY_LEN_MAX;

// CompletionItemKind values (mirror vscode-languageserver constants)
const CIK = {
    Function: 3,
    Variable: 6,
    Class:    7,   // used for types
    Property: 10,  // used for attributes
    Unit:     11,
    Color:    16,
};

// ── CompletionRanker ─────────────────────────────────────────────────────────

class CompletionRanker {
    constructor() {}

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Build a context object from the current editor state.
     *
     * @param {import('vscode-languageserver-textdocument').TextDocument} document
     * @param {{line: number, character: number}} position  LSP Position
     * @param {Map}  docSymbols  documentSymbols.get(uri) — {variables, functions}
     * @param {object} wsIndexer  workspaceIndexer instance
     * @returns {RankContext}
     */
    buildContext(document, position, docSymbols, wsIndexer) {
        const text = document.getText();
        const lines = text.split('\n');
        const cursorLine = position.line;

        // Build frequency and recency maps from the document text
        const frequency = new Map();   // symbolName → count
        const lastSeen  = new Map();   // symbolName → most recent line number

        const TOKEN_RE = /[a-zA-Z_][a-zA-Z0-9_-]*\??/g;
        lines.forEach((line, lineIdx) => {
            // Skip comment lines
            const commentIdx = line.indexOf(';');
            const usableLine = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
            let m;
            while ((m = TOKEN_RE.exec(usableLine)) !== null) {
                const tok = m[0];
                frequency.set(tok, (frequency.get(tok) || 0) + 1);
                // Keep the most recent (closest to cursor) occurrence
                if (!lastSeen.has(tok) || Math.abs(lineIdx - cursorLine) < Math.abs(lastSeen.get(tok) - cursorLine)) {
                    lastSeen.set(tok, lineIdx);
                }
            }
        });

        // Collect local symbol names and definition lines
        const localVars = new Map();  // name → line
        const localFns  = new Map();  // name → line
        if (docSymbols) {
            docSymbols.variables.forEach((info, name) => localVars.set(name, info.line));
            docSymbols.functions.forEach((info, name) => localFns.set(name, info.line));
        }

        // Workspace symbol sets (names only — for O(1) lookup)
        const wsVarNames = new Set(wsIndexer ? wsIndexer.getAllVariableNames() : []);
        const wsFnNames  = new Set(wsIndexer ? wsIndexer.getAllFunctionNames() : []);

        return { cursorLine, frequency, lastSeen, localVars, localFns, wsVarNames, wsFnNames };
    }

    /**
     * Rank an array of CompletionItem objects in-place and return the sorted array.
     *
     * Items are mutated to add `.sortText` and, for the best candidate, `.preselect = true`.
     *
     * @param {Array}  items   Raw completion items (will be mutated)
     * @param {string} query   The prefix the user has typed (may be empty)
     * @param {object} ctx     Context from buildContext()
     * @returns {Array} The same items array, now sorted
     */
    rank(items, query, ctx) {
        const q = query || '';
        const ql = q.toLowerCase();

        let bestScore = -1;
        let bestItem  = null;

        for (const item of items) {
            const score = this._score(item, q, ql, ctx);
            item._rankScore = score;

            // sortText: invert score so that lower string = higher rank
            const inverted = Math.max(0, MAX_SCORE - score);
            item.sortText = String(inverted).padStart(5, '0') + '_' + item.label;

            if (score > bestScore) {
                bestScore = score;
                bestItem  = item;
            }
        }

        // Mark the single best item as preselected — only when the user has
        // typed something (empty query should not force a preselection)
        if (bestItem && q.length > 0) {
            bestItem.preselect = true;
        }

        items.sort((a, b) => a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0);
        return items;
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _score(item, q, ql, ctx) {
        let score = 0;
        const label = item.label;
        const labelL = label.toLowerCase();

        // ── Match quality ─────────────────────────────────────────────────────
        if (q.length > 0) {
            if (label.startsWith(q)) {
                score += S.PREFIX_EXACT;
            } else if (labelL.startsWith(ql)) {
                score += S.PREFIX_ICASE;
            } else if (labelL.includes(ql)) {
                score += S.SUBSTRING;
                // Penalise by how deep the match is — earlier is better
                const idx = labelL.indexOf(ql);
                score -= Math.min(idx * 5, 80);
            } else if (this._acronymMatch(label, q)) {
                score += S.ACRONYM;
            } else {
                // No match at all — heavily penalise but keep in list
                // (the editor may have its own fuzzy filter on top)
                score -= 300;
            }

            // Reward longer queries (more specific user intent)
            score += Math.min(q.length * 5, S.QUERY_LEN_MAX);
        }

        // ── Kind / origin ─────────────────────────────────────────────────────
        const kind = item.kind;

        if (kind === CIK.Property) {
            // Attributes — always shown in attribute context only, rank high
            score += S.KIND_ATTR;
        } else if (kind === CIK.Class) {
            score += S.KIND_TYPE;
        } else if (kind === CIK.Color) {
            score += S.KIND_COLOR;
        } else if (kind === CIK.Unit) {
            score += S.KIND_UNIT;
        } else if (kind === CIK.Variable) {
            if (ctx.localVars.has(label)) {
                score += S.KIND_LOCAL_VAR;
            } else if (ctx.wsVarNames.has(label)) {
                score += S.KIND_WS_VAR;
            } else {
                score += S.KIND_BUILTIN;
            }
        } else if (kind === CIK.Function) {
            if (ctx.localFns.has(label)) {
                score += S.KIND_LOCAL_FN;
            } else if (ctx.wsFnNames.has(label)) {
                score += S.KIND_WS_FN;
            } else {
                score += S.KIND_BUILTIN;
            }
        }

        // ── Frequency ─────────────────────────────────────────────────────────
        const freq = ctx.frequency.get(label) || 0;
        if (freq > 0) {
            // log scale: 1→20, 5→50, 10→69, 50→100
            score += Math.min(Math.round(Math.log(freq + 1) / Math.log(51) * S.FREQUENCY_MAX), S.FREQUENCY_MAX);
        }

        // ── Recency ───────────────────────────────────────────────────────────
        if (ctx.lastSeen.has(label)) {
            const dist = Math.abs(ctx.lastSeen.get(label) - ctx.cursorLine);
            // Decays from RECENCY_MAX at dist=0 to 0 at dist≥50
            score += Math.max(0, Math.round(S.RECENCY_MAX * (1 - dist / 50)));
        }

        // ── Scope proximity (definition distance) ─────────────────────────────
        const defLine = ctx.localVars.get(label) ?? ctx.localFns.get(label) ?? null;
        if (defLine !== null) {
            const dist = Math.abs(defLine - ctx.cursorLine);
            score += Math.max(0, Math.round(S.PROXIMITY_MAX * (1 - dist / 100)));
        }

        return score;
    }

    /**
     * Check whether the lowercase query `q` matches the first letters of
     * hyphen-separated segments in `label`.
     * e.g. "sl" matches "sort-list", "sp" matches "split-path"
     */
    _acronymMatch(label, q) {
        const ql = q.toLowerCase();
        const segments = label.split('-');
        if (ql.length > segments.length) return false;
        for (let i = 0; i < ql.length; i++) {
            if (!segments[i] || segments[i][0].toLowerCase() !== ql[i]) return false;
        }
        return true;
    }
}

module.exports = CompletionRanker;


/***/ },

/***/ 6317
(module, __unused_webpack_exports, __webpack_require__) {

"use strict";
/**
 * Arturo Nim Source Parser
 *
 * Parses Arturo's standard library .nim source files directly from GitHub
 * to extract complete function signatures for all 521+ builtins.
 *
 * Each builtin in the source has this structure:
 *
 *   builtin "name",
 *       alias       = someAlias,
 *       op          = opXxx,
 *       rule        = XxxPrecedence,
 *       description = "human readable description",
 *       args        = {
 *           "paramName": {Type1,Type2,...}
 *       },
 *       attrs       = {
 *           "attrName": ({Type,...},"attr description")
 *       },
 *       returns     = {Type1,Type2,...},
 *       example     = """...""":
 *           <implementation>
 *
 * The parser is intentionally simple — it uses a line-by-line state machine
 * rather than a full Nim AST parser, which is sufficient given the highly
 * consistent formatting of Arturo's source files.
 */



const https = __webpack_require__(2057);

// ─── Constants ────────────────────────────────────────────────────────────────

const GITHUB_API_ROOT = 'https://api.github.com';
const GITHUB_RAW_ROOT = 'https://raw.githubusercontent.com';
const REPO            = 'arturo-lang/arturo';
const BRANCH          = 'master';
const LIBRARY_PATH    = 'src/library';

// Map Nim type names (as they appear in the source) to Arturo :type notation
const TYPE_MAP = {
    'Integer':          ':integer',
    'Floating':         ':floating',
    'Complex':          ':complex',
    'Rational':         ':rational',
    'Version':          ':version',
    'Type':             ':type',
    'Char':             ':char',
    'String':           ':string',
    'Regex':            ':regex',
    'Literal':          ':literal',
    'PathLiteral':      ':literal',   // path literals behave like literals to users
    'Block':            ':block',
    'Inline':           ':inline',
    'Dictionary':       ':dictionary',
    'Function':         ':function',
    'Method':           ':method',
    'Object':           ':object',
    'Module':           ':module',
    'Path':             ':path',
    'PathLabel':        ':path',
    'Range':            ':range',
    'Date':             ':date',
    'Unit':             ':unit',
    'Quantity':         ':quantity',
    'Color':            ':color',
    'Binary':           ':binary',
    'Database':         ':database',
    'Socket':           ':socket',
    'Error':            ':error',
    'Logical':          ':logical',
    'Nothing':          ':nothing',
    'Null':             ':null',
    'Any':              ':any',
    // Arturo uses "Nothing" for void returns; map both
    'nothing':          ':nothing',
    'null':             ':null',
    'any':              ':any',
};

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

/**
 * Fetch a URL and return the response body as a string.
 * Follows a single redirect (GitHub raw URLs sometimes redirect).
 */
function fetchUrl(url, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const headers = {
            'User-Agent': 'arturo-zed-extension/2.0',
            ...extraHeaders,
        };

        const req = https.get(url, { headers, timeout: 15000 }, (res) => {
            // Handle redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchUrl(res.headers.location, extraHeaders).then(resolve).catch(reject);
                res.resume();
                return;
            }

            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }

            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Timeout fetching ${url}`));
        });
    });
}

// ─── GitHub helpers ───────────────────────────────────────────────────────────

/**
 * Get the list of .nim files in the library directory via the GitHub Contents API.
 * Returns an array of { name, download_url } objects.
 */
async function getLibraryFileList() {
    const url = `${GITHUB_API_ROOT}/repos/${REPO}/contents/${LIBRARY_PATH}?ref=${BRANCH}`;
    const json = await fetchUrl(url, { 'Accept': 'application/vnd.github.v3+json' });
    const entries = JSON.parse(json);

    return entries
        .filter(e => e.type === 'file' && e.name.endsWith('.nim'))
        .map(e => ({
            name: e.name,
            url: `${GITHUB_RAW_ROOT}/${REPO}/${BRANCH}/${LIBRARY_PATH}/${e.name}`,
        }));
}

// ─── Type utilities ───────────────────────────────────────────────────────────

/**
 * Convert a comma-separated Nim type set string like
 * "Integer,Floating,Complex,Literal,PathLiteral"
 * into a slash-joined Arturo type string like
 * ":integer/:floating/:complex/:literal"
 *
 * Duplicates (e.g. Literal and PathLiteral both → :literal) are removed.
 */
function parseTypeSet(raw) {
    if (!raw || raw.trim() === '') return ':any';

    const seen = new Set();
    const types = [];

    raw.split(',').forEach(t => {
        const name = t.trim();
        const mapped = TYPE_MAP[name];
        if (mapped && !seen.has(mapped)) {
            seen.add(mapped);
            types.push(mapped);
        }
        // Unknown Nim types are silently skipped — they're usually internal
    });

    return types.length > 0 ? types.join('/') : ':any';
}

/**
 * Build a human-readable signature string from the parsed components.
 * e.g.  "add valueA :integer/:floating valueB :integer/:floating -> :integer/:floating"
 */
function buildSignature(name, params, returns) {
    const paramStr = params
        .map(p => `${p.name} ${p.type}`)
        .join(' ');
    return `${name}${paramStr ? ' ' + paramStr : ''} -> ${returns}`;
}

// ─── Core parser ──────────────────────────────────────────────────────────────

/**
 * Parse a single .nim source file and return an array of function descriptor
 * objects:
 *
 *   {
 *     name:        string,
 *     description: string,
 *     params:      [{ name, type }],
 *     attrs:       [{ name, type, description }],
 *     returns:     string,
 *     signature:   string,
 *     module:      string,   // filename without .nim
 *   }
 */
function parseNimFile(source, moduleName, log) {
    log = log || (() => {});
    const lines  = source.split('\n');
    const result = [];

    // ── State machine ──────────────────────────────────────────────────────
    // We scan line by line looking for  builtin "name",
    // then collect fields until we hit the implementation body (the line ending
    // with  :  after the last field, followed by indented Nim code).

    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // ── Detect start of a builtin block ─────────────────────────────
        const builtinMatch = line.match(/^\s+builtin\s+"([^"]+)"\s*,\s*$/);
        if (!builtinMatch) {
            i++;
            continue;
        }

        const funcName = builtinMatch[1];
        i++;

        // ── Collect fields ───────────────────────────────────────────────
        let description = '';
        let rawArgs     = '';       // everything between the outer { } of args
        let rawAttrs    = '';       // everything between the outer { } of attrs
        let rawReturns  = '';       // everything between the outer { } of returns
        let inArgs      = false;
        let inAttrs     = false;
        let depth       = 0;        // brace depth while collecting multi-line sets

        // We stop collecting when we encounter the implementation line,
        // which is a line that ends with  :  at the builtin indentation level
        // (the colon that closes the macro call and opens the Nim body).
        const implPattern = /^\s+\w.*\s*:\s*$/;
        // More precisely: after the last field the line ends with  """:  or  },
        // followed by a blank comment line  #===...  We detect end-of-fields by
        // finding a line that ends with  :  and is NOT inside a string/braces.

        let done = false;

        while (i < lines.length && !done) {
            const fl = lines[i];

            // ── Inside a multi-line brace block ─────────────────────────
            if (inArgs || inAttrs) {
                const open  = (fl.match(/\{/g) || []).length;
                const close = (fl.match(/\}/g) || []).length;
                depth += open - close;

                if (inArgs)  rawArgs  += fl + '\n';
                if (inAttrs) rawAttrs += fl + '\n';

                if (depth <= 0) {
                    inArgs  = false;
                    inAttrs = false;
                    depth   = 0;
                }
                i++;
                continue;
            }

            // ── description (single-line or triple-quoted) ─────────────────
            // Triple-quoted: description = """
            //     multi-line text
            // """,
            const descTriple = fl.match(/^\s+description\s*=\s*"""/);
            if (descTriple) {
                const sameLine = fl.match(/"""(.+?)"""/);
                if (sameLine) {
                    description = sameLine[1].trim();
                    i++;
                } else {
                    const parts = [];
                    const afterOpen = fl.replace(/^\s+description\s*=\s*"""/, '').trim();
                    if (afterOpen) parts.push(afterOpen);
                    i++;
                    while (i < lines.length) {
                        const dl = lines[i];
                        const endIdx = dl.indexOf('"""');
                        if (endIdx !== -1) {
                            const before = dl.substring(0, endIdx).trim();
                            if (before) parts.push(before);
                            i++;
                            break;
                        }
                        const trimmed = dl.trim();
                        if (trimmed) parts.push(trimmed);
                        i++;
                    }
                    description = parts.join(' ').trim();
                }
                continue;
            }
            const descMatch = fl.match(/^\s+description\s*=\s*"((?:[^"\\]|\\.)*)"/);
            if (descMatch) {
                description = descMatch[1].replace(/\\"/g, '"');
                i++;
                continue;
            }

            // ── args (may be NoArgs or a multi-line block) ───────────────
            const argsNoArgs = fl.match(/^\s+args\s*=\s*NoArgs\s*,?\s*$/);
            if (argsNoArgs) {
                rawArgs = 'NoArgs';
                i++;
                continue;
            }
            const argsStart = fl.match(/^\s+args\s*=\s*\{/);
            if (argsStart) {
                const open  = (fl.match(/\{/g) || []).length;
                const close = (fl.match(/\}/g) || []).length;
                depth = open - close;
                rawArgs = fl + '\n';
                inArgs  = depth > 0;
                i++;
                continue;
            }

            // ── attrs (may be NoAttrs or a multi-line block) ─────────────
            const attrsNoAttrs = fl.match(/^\s+attrs\s*=\s*NoAttrs\s*,?\s*$/);
            if (attrsNoAttrs) {
                rawAttrs = 'NoAttrs';
                i++;
                continue;
            }
            const attrsStart = fl.match(/^\s+attrs\s*=\s*\{/);
            if (attrsStart) {
                const open  = (fl.match(/\{/g) || []).length;
                const close = (fl.match(/\}/g) || []).length;
                depth = open - close;
                rawAttrs = fl + '\n';
                inAttrs  = depth > 0;
                i++;
                continue;
            }

            // ── returns ──────────────────────────────────────────────────
            const returnsMatch = fl.match(/^\s+returns\s*=\s*\{([^}]+)\}/);
            if (returnsMatch) {
                rawReturns = returnsMatch[1];
                i++;
                continue;
            }

            // ── End of field block: line ending with  ":  ────────────────
            // The example field ends with  """:  which signals end of header.
            // We also stop if we hit the implementation comment line.
            if (fl.match(/"""\s*:\s*$/) || fl.match(/^\s+#={5,}/)) {
                done = true;
                // Don't increment i — the caller loop will advance past this
                continue;
            }

            // ── Skip other fields (alias, op, rule, example lines) ───────
            i++;
        }

        // ── Parse collected raw strings ───────────────────────────────────

        // Params
        const params = [];
        if (rawArgs && rawArgs !== 'NoArgs') {
            // Match:  "paramName": {Type1,Type2,...}
            const paramPattern = /"([^"]+)"\s*:\s*\{([^}]+)\}/g;
            let m;
            while ((m = paramPattern.exec(rawArgs)) !== null) {
                params.push({
                    name: m[1],
                    type: parseTypeSet(m[2]),
                });
            }
        }

        // Attrs
        const attrs = [];
        if (rawAttrs && rawAttrs !== 'NoAttrs') {
            // Match:  "attrName": ({Type,...},"description")
            const attrPattern = /"([^"]+)"\s*:\s*\(\{([^}]*)\}\s*,\s*"([^"]*)"\)/g;
            let m;
            while ((m = attrPattern.exec(rawAttrs)) !== null) {
                attrs.push({
                    name:        m[1],
                    type:        parseTypeSet(m[2]),
                    description: m[3],
                });
            }
            // Log if we got rawAttrs but parsed no attrs (regex mismatch diagnostic)
            if (attrs.length === 0 && rawAttrs.trim().length > 10) {
                log(`[NimParser] WARNING: ${funcName} has attrs block but 0 attrs parsed. rawAttrs snippet: ${rawAttrs.replace(/\n/g,' ').slice(0,200)}`);
            }
        }

        // Returns
        const returns = rawReturns ? parseTypeSet(rawReturns) : ':any';

        // Skip if we got no description (probably a malformed/internal entry)
        if (!description) {
            log(`[NimParser] Skipping ${funcName} in ${moduleName}: no description found`);
            continue;
        }

        result.push({
            name:        funcName,
            description,
            params,
            attrs,
            returns,
            signature:   buildSignature(funcName, params, returns),
            module:      moduleName,
        });
    }

    return result;
}

// ─── Delta support ────────────────────────────────────────────────────────────

/**
 * Fetch the current file-level SHAs for all .nim files in the library
 * directory via the GitHub Trees API (recursive=1 gives all files in one
 * request — much cheaper than one Contents API call per file).
 *
 * Returns a Map<filename, sha>  e.g.  { 'Arithmetic.nim' => 'a3f...', ... }
 */
async function getLibraryFileSHAs() {
    const url = `${GITHUB_API_ROOT}/repos/${REPO}/git/trees/${BRANCH}?recursive=1`;
    const json = await fetchUrl(url, { 'Accept': 'application/vnd.github.v3+json' });
    const data = JSON.parse(json);

    const shas = new Map();
    const prefix = LIBRARY_PATH + '/';

    for (const item of data.tree) {
        if (item.type === 'blob' &&
            item.path.startsWith(prefix) &&
            item.path.endsWith('.nim') &&
            !item.path.slice(prefix.length).includes('/')) {   // top-level only
            const filename = item.path.slice(prefix.length);
            shas.set(filename, item.sha);
        }
    }

    return shas;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch Arturo library .nim files from GitHub and parse them.
 *
 * Supports delta mode: if `knownSHAs` is provided (a Map<filename, sha> from
 * a previous fetch stored in the cache), only files whose SHA has changed are
 * re-fetched.  Files that haven't changed reuse the signatures already present
 * in `existingSignatures`.
 *
 * Returns:
 *   {
 *     signatures: Map<name, sigObject>,  // full merged set
 *     fileSHAs:   Map<filename, sha>,    // current SHAs — store in cache
 *   }
 *
 * @param {Function}         [logger]
 * @param {Map<string,string>} [knownSHAs]          Previous SHA map or null for full fetch
 * @param {Map<string,object>} [existingSignatures] Signatures from cache (used for unchanged files)
 * @param {Function}         [onProgress]
 */
async function parseLibraryFromGitHub(logger, knownSHAs, existingSignatures, onProgress) {
    const log = logger || console.log;

    // ── Get current file SHAs (one API call) ─────────────────────────────────
    log('[NimParser] Fetching library file SHAs from GitHub...');
    let currentSHAs;
    try {
        currentSHAs = await getLibraryFileSHAs();
        log(`[NimParser] Got SHAs for ${currentSHAs.size} library files`);
    } catch (err) {
        // Trees API failed — fall back to Contents API listing (no delta)
        log(`[NimParser] Trees API failed (${err.message}), falling back to full fetch`);
        currentSHAs = null;
    }

    // ── Determine which files need fetching ───────────────────────────────────
    let filesToFetch;
    if (!currentSHAs) {
        // Trees API failed — fetch everything
        filesToFetch = await getLibraryFileList();
        filesToFetch = filesToFetch.map(f => ({ ...f, changed: true }));
    } else {
        // Build list from SHA map; mark changed files
        filesToFetch = [];
        for (const [filename, sha] of currentSHAs) {
            const changed = !knownSHAs || knownSHAs.get(filename) !== sha;
            filesToFetch.push({
                name:    filename,
                url:     `${GITHUB_RAW_ROOT}/${REPO}/${BRANCH}/${LIBRARY_PATH}/${filename}`,
                sha,
                changed,
            });
        }
        const changedCount = filesToFetch.filter(f => f.changed).length;
        log(`[NimParser] ${changedCount} of ${filesToFetch.length} files changed since last fetch`);
    }

    // ── Start with existing signatures, overwrite changed files ──────────────
    const signatures = new Map(existingSignatures || []);
    let done = 0;
    let fetched = 0;

    for (const file of filesToFetch) {
        if (!file.changed) {
            done++;
            if (onProgress) onProgress(done, filesToFetch.length, file.name);
            continue;
        }

        const moduleName = file.name.replace(/\.nim$/, '');
        try {
            const source = await fetchUrl(file.url);
            const funcs  = parseNimFile(source, moduleName, log);

            funcs.forEach(f => {
                signatures.set(f.name, {
                    signature:   f.signature,
                    description: f.description,
                    params:      f.params,
                    attrs:       f.attrs,
                    returns:     f.returns,
                    module:      f.module,
                });
            });

            fetched++;
            done++;
            log(`[NimParser] Parsed ${file.name}: ${funcs.length} functions (total: ${signatures.size})`);
            if (onProgress) onProgress(done, filesToFetch.length, file.name);

        } catch (err) {
            log(`[NimParser] Warning: failed to parse ${file.name}: ${err.message}`);
            done++;
        }
    }

    log(`[NimParser] Complete. Fetched ${fetched} changed files. ${signatures.size} total functions.`);
    return { signatures, fileSHAs: currentSHAs || new Map() };
}

/**
 * Parse a single .nim source string (for testing or offline use).
 * Returns the same Map format as parseLibraryFromGitHub.
 */
function parseNimSource(source, moduleName = 'unknown', log) {
    const funcs = parseNimFile(source, moduleName, log);
    const signatures = new Map();
    funcs.forEach(f => {
        signatures.set(f.name, {
            signature:   f.signature,
            description: f.description,
            params:      f.params,
            attrs:       f.attrs,
            returns:     f.returns,
            module:      f.module,
        });
    });
    return signatures;
}

module.exports = { parseLibraryFromGitHub, parseNimSource };


/***/ },

/***/ 2701
(module, __unused_webpack_exports, __webpack_require__) {

/**
 * Signature Indexer for Arturo LSP
 * 
 * Implements dynamic signature generation with:
 * - Standard library indexing via tree-sitter parsing
 * - Stale-While-Revalidate caching pattern
 * - Offline-first design with seed cache
 * - Automatic background updates
 */

const fs = __webpack_require__(4383);
const path = __webpack_require__(2003);
const https = __webpack_require__(2057);
const { parseLibraryFromGitHub } = __webpack_require__(6317);
const WorkspaceIndexer = __webpack_require__(4318);

class SignatureIndexer {
    constructor(logger) {
        this.logger = logger || console;
        this.signatures = new Map();
        // When running from bundle.js, __dirname is the extension work dir.
        // When running directly from source (dev), __dirname is lib/, so go up.
        // We detect bundle mode by checking if we're a single flat file (no lib subdir).
        const isBundle = !__dirname.endsWith('lib');
        const baseDir  = isBundle ? __dirname : path.join(__dirname, '..');
        this.cacheDir      = path.join(baseDir, '.cache');
        this.cacheFile     = path.join(this.cacheDir, 'signatures.json');
        this.seedCacheFile = path.join(baseDir, 'seed-cache.json');
        this.isInitialized = false;
        this.lastUpdate = null;
        this.updateInProgress = false;
        /** Map<filename, sha> stored in cache to enable delta updates */
        this.fileSHAs = new Map();
        /** Workspace indexer for user-defined functions */
        this.workspaceIndexer = new WorkspaceIndexer(logger);
    }

    /**
     * Initialize the indexer with stale-while-revalidate pattern
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }

        this.logger.log('[SignatureIndexer] Initializing...');

        // Phase 1: Load cache immediately for instant startup
        await this.loadCache();

        // Phase 2: Schedule background update (non-blocking)
        this.scheduleBackgroundUpdate();

        this.isInitialized = true;
        this.logger.log(`[SignatureIndexer] Initialized with ${this.signatures.size} builtin signatures`);
    }

    /**
     * Load signatures from cache (or seed cache if no cache exists)
     */
    async loadCache() {
        try {
            // Try to load from user cache first
            if (fs.existsSync(this.cacheFile)) {
                const cacheData = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
                this.signatures = new Map(Object.entries(cacheData.signatures));
                this.lastUpdate = new Date(cacheData.lastUpdate);
                // Restore file SHAs for delta updates
                if (cacheData.fileSHAs) {
                    this.fileSHAs = new Map(Object.entries(cacheData.fileSHAs));
                }
                this.logger.log(`[SignatureIndexer] Loaded ${this.signatures.size} signatures from cache`);
                return;
            }
        } catch (err) {
            this.logger.log(`[SignatureIndexer] Failed to load cache: ${err.message}`);
        }

        // Fall back to seed cache (shipped with extension)
        try {
            if (fs.existsSync(this.seedCacheFile)) {
                const seedData = JSON.parse(fs.readFileSync(this.seedCacheFile, 'utf8'));
                this.signatures = new Map(Object.entries(seedData.signatures));
                this.logger.log(`[SignatureIndexer] Loaded ${this.signatures.size} signatures from seed cache`);
                return;
            }
        } catch (err) {
            this.logger.log(`[SignatureIndexer] Failed to load seed cache: ${err.message}`);
        }

        this.logger.log('[SignatureIndexer] No cache available, will fetch from network');
    }

    /**
     * Schedule a background update (non-blocking)
     */
    scheduleBackgroundUpdate() {
        // Don't start another update if one is already in progress
        if (this.updateInProgress) {
            return;
        }

        // Check if we need to update (every 24 hours)
        // If lastUpdate is null it means we're running from the seed cache
        // (no full fetch has ever succeeded) — always fetch in that case.
        const now = new Date();
        if (this.lastUpdate) {
            const hoursSinceUpdate = (now - this.lastUpdate) / (1000 * 60 * 60);
            if (hoursSinceUpdate < 24) {
                this.logger.log('[SignatureIndexer] Cache is fresh, skipping update');
                return;
            }
        } else {
            this.logger.log('[SignatureIndexer] No prior full fetch — will fetch now');
        }

        // Start background update
        this.updateInProgress = true;
        this.logger.log('[SignatureIndexer] Starting background update...');

        this.fetchAndUpdateSignatures()
            .then(() => {
                this.logger.log(`[SignatureIndexer] Background update completed. Total signatures: ${this.signatures.size}`);
            })
            .catch(err => {
                this.logger.log(`[SignatureIndexer] Background update FAILED: ${err.message}`);
                this.logger.log(`[SignatureIndexer] Stack: ${err.stack}`);
            })
            .finally(() => {
                this.updateInProgress = false;
            });
    }

    /**
     * Fetch signatures from Arturo documentation and update cache
     */
    async fetchAndUpdateSignatures() {
        try {
            const newSignatures = await this.fetchSignaturesFromDocs();
            
            if (newSignatures.size > 0) {
                // Merge with existing signatures (keep user-defined ones)
                newSignatures.forEach((sig, name) => {
                    this.signatures.set(name, sig);
                });

                // Save to cache
                await this.saveCache();
                
                this.logger.log(`[SignatureIndexer] Updated with ${newSignatures.size} new signatures`);
            }
        } catch (err) {
            throw new Error(`Failed to fetch signatures: ${err.message}`);
        }
    }

    /**
     * Fetch and parse signatures from Arturo's GitHub source.
     * Uses delta mode: only re-fetches .nim files whose SHA has changed.
     */
    async fetchSignaturesFromDocs() {
        const result = await parseLibraryFromGitHub(
            msg  => this.logger.log(msg),
            this.fileSHAs.size > 0 ? this.fileSHAs : null,
            this.signatures
        );
        // Store the updated SHAs for the next delta run
        this.fileSHAs = result.fileSHAs;
        return result.signatures;
    }

    /**
     * Save signatures to cache file
     */
    async saveCache() {
        try {
            // Ensure cache directory exists
            if (!fs.existsSync(this.cacheDir)) {
                fs.mkdirSync(this.cacheDir, { recursive: true });
            }

            // Convert Map to object for JSON serialization
            const cacheData = {
                signatures: Object.fromEntries(this.signatures),
                fileSHAs:   Object.fromEntries(this.fileSHAs),
                lastUpdate: new Date().toISOString(),
                version: '2.0'
            };

            fs.writeFileSync(this.cacheFile, JSON.stringify(cacheData, null, 2));
            this.logger.log(`[SignatureIndexer] Saved ${this.signatures.size} signatures to cache`);
        } catch (err) {
            this.logger.log(`[SignatureIndexer] Failed to save cache: ${err.message}`);
        }
    }

    /**
     * Get signature for a function
     */
    getSignature(functionName) {
        return this.signatures.get(functionName) || null;
    }

    /**
     * Get all function names
     */
    getAllFunctionNames() {
        return Array.from(this.signatures.keys());
    }

    /**
     * Check if function exists in index
     */
    hasFunction(functionName) {
        return this.signatures.has(functionName);
    }

    /**
     * Get all known attribute names derived from loaded signatures.
     * Walks every signature's attrs array and collects the names.
     * Returns a Set<string> so callers can do O(1) lookups.
     */
    getAllAttrNames() {
        const attrs = new Set();
        for (const sig of this.signatures.values()) {
            if (Array.isArray(sig.attrs)) {
                for (const attr of sig.attrs) {
                    if (attr.name) attrs.add(attr.name);
                }
            }
        }
        return attrs;
    }

    /**
     * Add a custom signature (for user-defined functions)
     */
    addSignature(functionName, signature) {
        this.signatures.set(functionName, signature);
    }

    /**
     * Get statistics about the index
     */
    getStats() {
        return {
            totalSignatures: this.signatures.size,
            lastUpdate: this.lastUpdate,
            isInitialized: this.isInitialized,
            updateInProgress: this.updateInProgress
        };
    }
}

module.exports = SignatureIndexer;


/***/ },

/***/ 4318
(module, __unused_webpack_exports, __webpack_require__) {

"use strict";
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



const fs   = __webpack_require__(4383);
const path = __webpack_require__(2003);

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


/***/ },

/***/ 3281
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
/// <reference path="../../typings/thenable.d.ts" />
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ProgressType = exports.ProgressToken = exports.createMessageConnection = exports.NullLogger = exports.ConnectionOptions = exports.ConnectionStrategy = exports.AbstractMessageBuffer = exports.WriteableStreamMessageWriter = exports.AbstractMessageWriter = exports.MessageWriter = exports.ReadableStreamMessageReader = exports.AbstractMessageReader = exports.MessageReader = exports.SharedArrayReceiverStrategy = exports.SharedArraySenderStrategy = exports.CancellationToken = exports.CancellationTokenSource = exports.Emitter = exports.Event = exports.Disposable = exports.LRUCache = exports.Touch = exports.LinkedMap = exports.ParameterStructures = exports.NotificationType9 = exports.NotificationType8 = exports.NotificationType7 = exports.NotificationType6 = exports.NotificationType5 = exports.NotificationType4 = exports.NotificationType3 = exports.NotificationType2 = exports.NotificationType1 = exports.NotificationType0 = exports.NotificationType = exports.ErrorCodes = exports.ResponseError = exports.RequestType9 = exports.RequestType8 = exports.RequestType7 = exports.RequestType6 = exports.RequestType5 = exports.RequestType4 = exports.RequestType3 = exports.RequestType2 = exports.RequestType1 = exports.RequestType0 = exports.RequestType = exports.Message = exports.RAL = void 0;
exports.MessageStrategy = exports.CancellationStrategy = exports.CancellationSenderStrategy = exports.CancellationReceiverStrategy = exports.ConnectionError = exports.ConnectionErrors = exports.LogTraceNotification = exports.SetTraceNotification = exports.TraceFormat = exports.TraceValues = exports.Trace = void 0;
const messages_1 = __webpack_require__(6177);
Object.defineProperty(exports, "Message", ({ enumerable: true, get: function () { return messages_1.Message; } }));
Object.defineProperty(exports, "RequestType", ({ enumerable: true, get: function () { return messages_1.RequestType; } }));
Object.defineProperty(exports, "RequestType0", ({ enumerable: true, get: function () { return messages_1.RequestType0; } }));
Object.defineProperty(exports, "RequestType1", ({ enumerable: true, get: function () { return messages_1.RequestType1; } }));
Object.defineProperty(exports, "RequestType2", ({ enumerable: true, get: function () { return messages_1.RequestType2; } }));
Object.defineProperty(exports, "RequestType3", ({ enumerable: true, get: function () { return messages_1.RequestType3; } }));
Object.defineProperty(exports, "RequestType4", ({ enumerable: true, get: function () { return messages_1.RequestType4; } }));
Object.defineProperty(exports, "RequestType5", ({ enumerable: true, get: function () { return messages_1.RequestType5; } }));
Object.defineProperty(exports, "RequestType6", ({ enumerable: true, get: function () { return messages_1.RequestType6; } }));
Object.defineProperty(exports, "RequestType7", ({ enumerable: true, get: function () { return messages_1.RequestType7; } }));
Object.defineProperty(exports, "RequestType8", ({ enumerable: true, get: function () { return messages_1.RequestType8; } }));
Object.defineProperty(exports, "RequestType9", ({ enumerable: true, get: function () { return messages_1.RequestType9; } }));
Object.defineProperty(exports, "ResponseError", ({ enumerable: true, get: function () { return messages_1.ResponseError; } }));
Object.defineProperty(exports, "ErrorCodes", ({ enumerable: true, get: function () { return messages_1.ErrorCodes; } }));
Object.defineProperty(exports, "NotificationType", ({ enumerable: true, get: function () { return messages_1.NotificationType; } }));
Object.defineProperty(exports, "NotificationType0", ({ enumerable: true, get: function () { return messages_1.NotificationType0; } }));
Object.defineProperty(exports, "NotificationType1", ({ enumerable: true, get: function () { return messages_1.NotificationType1; } }));
Object.defineProperty(exports, "NotificationType2", ({ enumerable: true, get: function () { return messages_1.NotificationType2; } }));
Object.defineProperty(exports, "NotificationType3", ({ enumerable: true, get: function () { return messages_1.NotificationType3; } }));
Object.defineProperty(exports, "NotificationType4", ({ enumerable: true, get: function () { return messages_1.NotificationType4; } }));
Object.defineProperty(exports, "NotificationType5", ({ enumerable: true, get: function () { return messages_1.NotificationType5; } }));
Object.defineProperty(exports, "NotificationType6", ({ enumerable: true, get: function () { return messages_1.NotificationType6; } }));
Object.defineProperty(exports, "NotificationType7", ({ enumerable: true, get: function () { return messages_1.NotificationType7; } }));
Object.defineProperty(exports, "NotificationType8", ({ enumerable: true, get: function () { return messages_1.NotificationType8; } }));
Object.defineProperty(exports, "NotificationType9", ({ enumerable: true, get: function () { return messages_1.NotificationType9; } }));
Object.defineProperty(exports, "ParameterStructures", ({ enumerable: true, get: function () { return messages_1.ParameterStructures; } }));
const linkedMap_1 = __webpack_require__(3352);
Object.defineProperty(exports, "LinkedMap", ({ enumerable: true, get: function () { return linkedMap_1.LinkedMap; } }));
Object.defineProperty(exports, "LRUCache", ({ enumerable: true, get: function () { return linkedMap_1.LRUCache; } }));
Object.defineProperty(exports, "Touch", ({ enumerable: true, get: function () { return linkedMap_1.Touch; } }));
const disposable_1 = __webpack_require__(4019);
Object.defineProperty(exports, "Disposable", ({ enumerable: true, get: function () { return disposable_1.Disposable; } }));
const events_1 = __webpack_require__(2676);
Object.defineProperty(exports, "Event", ({ enumerable: true, get: function () { return events_1.Event; } }));
Object.defineProperty(exports, "Emitter", ({ enumerable: true, get: function () { return events_1.Emitter; } }));
const cancellation_1 = __webpack_require__(9850);
Object.defineProperty(exports, "CancellationTokenSource", ({ enumerable: true, get: function () { return cancellation_1.CancellationTokenSource; } }));
Object.defineProperty(exports, "CancellationToken", ({ enumerable: true, get: function () { return cancellation_1.CancellationToken; } }));
const sharedArrayCancellation_1 = __webpack_require__(4996);
Object.defineProperty(exports, "SharedArraySenderStrategy", ({ enumerable: true, get: function () { return sharedArrayCancellation_1.SharedArraySenderStrategy; } }));
Object.defineProperty(exports, "SharedArrayReceiverStrategy", ({ enumerable: true, get: function () { return sharedArrayCancellation_1.SharedArrayReceiverStrategy; } }));
const messageReader_1 = __webpack_require__(9085);
Object.defineProperty(exports, "MessageReader", ({ enumerable: true, get: function () { return messageReader_1.MessageReader; } }));
Object.defineProperty(exports, "AbstractMessageReader", ({ enumerable: true, get: function () { return messageReader_1.AbstractMessageReader; } }));
Object.defineProperty(exports, "ReadableStreamMessageReader", ({ enumerable: true, get: function () { return messageReader_1.ReadableStreamMessageReader; } }));
const messageWriter_1 = __webpack_require__(3193);
Object.defineProperty(exports, "MessageWriter", ({ enumerable: true, get: function () { return messageWriter_1.MessageWriter; } }));
Object.defineProperty(exports, "AbstractMessageWriter", ({ enumerable: true, get: function () { return messageWriter_1.AbstractMessageWriter; } }));
Object.defineProperty(exports, "WriteableStreamMessageWriter", ({ enumerable: true, get: function () { return messageWriter_1.WriteableStreamMessageWriter; } }));
const messageBuffer_1 = __webpack_require__(9244);
Object.defineProperty(exports, "AbstractMessageBuffer", ({ enumerable: true, get: function () { return messageBuffer_1.AbstractMessageBuffer; } }));
const connection_1 = __webpack_require__(577);
Object.defineProperty(exports, "ConnectionStrategy", ({ enumerable: true, get: function () { return connection_1.ConnectionStrategy; } }));
Object.defineProperty(exports, "ConnectionOptions", ({ enumerable: true, get: function () { return connection_1.ConnectionOptions; } }));
Object.defineProperty(exports, "NullLogger", ({ enumerable: true, get: function () { return connection_1.NullLogger; } }));
Object.defineProperty(exports, "createMessageConnection", ({ enumerable: true, get: function () { return connection_1.createMessageConnection; } }));
Object.defineProperty(exports, "ProgressToken", ({ enumerable: true, get: function () { return connection_1.ProgressToken; } }));
Object.defineProperty(exports, "ProgressType", ({ enumerable: true, get: function () { return connection_1.ProgressType; } }));
Object.defineProperty(exports, "Trace", ({ enumerable: true, get: function () { return connection_1.Trace; } }));
Object.defineProperty(exports, "TraceValues", ({ enumerable: true, get: function () { return connection_1.TraceValues; } }));
Object.defineProperty(exports, "TraceFormat", ({ enumerable: true, get: function () { return connection_1.TraceFormat; } }));
Object.defineProperty(exports, "SetTraceNotification", ({ enumerable: true, get: function () { return connection_1.SetTraceNotification; } }));
Object.defineProperty(exports, "LogTraceNotification", ({ enumerable: true, get: function () { return connection_1.LogTraceNotification; } }));
Object.defineProperty(exports, "ConnectionErrors", ({ enumerable: true, get: function () { return connection_1.ConnectionErrors; } }));
Object.defineProperty(exports, "ConnectionError", ({ enumerable: true, get: function () { return connection_1.ConnectionError; } }));
Object.defineProperty(exports, "CancellationReceiverStrategy", ({ enumerable: true, get: function () { return connection_1.CancellationReceiverStrategy; } }));
Object.defineProperty(exports, "CancellationSenderStrategy", ({ enumerable: true, get: function () { return connection_1.CancellationSenderStrategy; } }));
Object.defineProperty(exports, "CancellationStrategy", ({ enumerable: true, get: function () { return connection_1.CancellationStrategy; } }));
Object.defineProperty(exports, "MessageStrategy", ({ enumerable: true, get: function () { return connection_1.MessageStrategy; } }));
const ral_1 = __webpack_require__(9590);
exports.RAL = ral_1.default;


/***/ },

/***/ 9850
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.CancellationTokenSource = exports.CancellationToken = void 0;
const ral_1 = __webpack_require__(9590);
const Is = __webpack_require__(8585);
const events_1 = __webpack_require__(2676);
var CancellationToken;
(function (CancellationToken) {
    CancellationToken.None = Object.freeze({
        isCancellationRequested: false,
        onCancellationRequested: events_1.Event.None
    });
    CancellationToken.Cancelled = Object.freeze({
        isCancellationRequested: true,
        onCancellationRequested: events_1.Event.None
    });
    function is(value) {
        const candidate = value;
        return candidate && (candidate === CancellationToken.None
            || candidate === CancellationToken.Cancelled
            || (Is.boolean(candidate.isCancellationRequested) && !!candidate.onCancellationRequested));
    }
    CancellationToken.is = is;
})(CancellationToken || (exports.CancellationToken = CancellationToken = {}));
const shortcutEvent = Object.freeze(function (callback, context) {
    const handle = (0, ral_1.default)().timer.setTimeout(callback.bind(context), 0);
    return { dispose() { handle.dispose(); } };
});
class MutableToken {
    constructor() {
        this._isCancelled = false;
    }
    cancel() {
        if (!this._isCancelled) {
            this._isCancelled = true;
            if (this._emitter) {
                this._emitter.fire(undefined);
                this.dispose();
            }
        }
    }
    get isCancellationRequested() {
        return this._isCancelled;
    }
    get onCancellationRequested() {
        if (this._isCancelled) {
            return shortcutEvent;
        }
        if (!this._emitter) {
            this._emitter = new events_1.Emitter();
        }
        return this._emitter.event;
    }
    dispose() {
        if (this._emitter) {
            this._emitter.dispose();
            this._emitter = undefined;
        }
    }
}
class CancellationTokenSource {
    get token() {
        if (!this._token) {
            // be lazy and create the token only when
            // actually needed
            this._token = new MutableToken();
        }
        return this._token;
    }
    cancel() {
        if (!this._token) {
            // save an object by returning the default
            // cancelled token when cancellation happens
            // before someone asks for the token
            this._token = CancellationToken.Cancelled;
        }
        else {
            this._token.cancel();
        }
    }
    dispose() {
        if (!this._token) {
            // ensure to initialize with an empty token if we had none
            this._token = CancellationToken.None;
        }
        else if (this._token instanceof MutableToken) {
            // actually dispose
            this._token.dispose();
        }
    }
}
exports.CancellationTokenSource = CancellationTokenSource;


/***/ },

/***/ 577
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.createMessageConnection = exports.ConnectionOptions = exports.MessageStrategy = exports.CancellationStrategy = exports.CancellationSenderStrategy = exports.CancellationReceiverStrategy = exports.RequestCancellationReceiverStrategy = exports.IdCancellationReceiverStrategy = exports.ConnectionStrategy = exports.ConnectionError = exports.ConnectionErrors = exports.LogTraceNotification = exports.SetTraceNotification = exports.TraceFormat = exports.TraceValues = exports.Trace = exports.NullLogger = exports.ProgressType = exports.ProgressToken = void 0;
const ral_1 = __webpack_require__(9590);
const Is = __webpack_require__(8585);
const messages_1 = __webpack_require__(6177);
const linkedMap_1 = __webpack_require__(3352);
const events_1 = __webpack_require__(2676);
const cancellation_1 = __webpack_require__(9850);
var CancelNotification;
(function (CancelNotification) {
    CancelNotification.type = new messages_1.NotificationType('$/cancelRequest');
})(CancelNotification || (CancelNotification = {}));
var ProgressToken;
(function (ProgressToken) {
    function is(value) {
        return typeof value === 'string' || typeof value === 'number';
    }
    ProgressToken.is = is;
})(ProgressToken || (exports.ProgressToken = ProgressToken = {}));
var ProgressNotification;
(function (ProgressNotification) {
    ProgressNotification.type = new messages_1.NotificationType('$/progress');
})(ProgressNotification || (ProgressNotification = {}));
class ProgressType {
    constructor() {
    }
}
exports.ProgressType = ProgressType;
var StarRequestHandler;
(function (StarRequestHandler) {
    function is(value) {
        return Is.func(value);
    }
    StarRequestHandler.is = is;
})(StarRequestHandler || (StarRequestHandler = {}));
exports.NullLogger = Object.freeze({
    error: () => { },
    warn: () => { },
    info: () => { },
    log: () => { }
});
var Trace;
(function (Trace) {
    Trace[Trace["Off"] = 0] = "Off";
    Trace[Trace["Messages"] = 1] = "Messages";
    Trace[Trace["Compact"] = 2] = "Compact";
    Trace[Trace["Verbose"] = 3] = "Verbose";
})(Trace || (exports.Trace = Trace = {}));
var TraceValues;
(function (TraceValues) {
    /**
     * Turn tracing off.
     */
    TraceValues.Off = 'off';
    /**
     * Trace messages only.
     */
    TraceValues.Messages = 'messages';
    /**
     * Compact message tracing.
     */
    TraceValues.Compact = 'compact';
    /**
     * Verbose message tracing.
     */
    TraceValues.Verbose = 'verbose';
})(TraceValues || (exports.TraceValues = TraceValues = {}));
(function (Trace) {
    function fromString(value) {
        if (!Is.string(value)) {
            return Trace.Off;
        }
        value = value.toLowerCase();
        switch (value) {
            case 'off':
                return Trace.Off;
            case 'messages':
                return Trace.Messages;
            case 'compact':
                return Trace.Compact;
            case 'verbose':
                return Trace.Verbose;
            default:
                return Trace.Off;
        }
    }
    Trace.fromString = fromString;
    function toString(value) {
        switch (value) {
            case Trace.Off:
                return 'off';
            case Trace.Messages:
                return 'messages';
            case Trace.Compact:
                return 'compact';
            case Trace.Verbose:
                return 'verbose';
            default:
                return 'off';
        }
    }
    Trace.toString = toString;
})(Trace || (exports.Trace = Trace = {}));
var TraceFormat;
(function (TraceFormat) {
    TraceFormat["Text"] = "text";
    TraceFormat["JSON"] = "json";
})(TraceFormat || (exports.TraceFormat = TraceFormat = {}));
(function (TraceFormat) {
    function fromString(value) {
        if (!Is.string(value)) {
            return TraceFormat.Text;
        }
        value = value.toLowerCase();
        if (value === 'json') {
            return TraceFormat.JSON;
        }
        else {
            return TraceFormat.Text;
        }
    }
    TraceFormat.fromString = fromString;
})(TraceFormat || (exports.TraceFormat = TraceFormat = {}));
var SetTraceNotification;
(function (SetTraceNotification) {
    SetTraceNotification.type = new messages_1.NotificationType('$/setTrace');
})(SetTraceNotification || (exports.SetTraceNotification = SetTraceNotification = {}));
var LogTraceNotification;
(function (LogTraceNotification) {
    LogTraceNotification.type = new messages_1.NotificationType('$/logTrace');
})(LogTraceNotification || (exports.LogTraceNotification = LogTraceNotification = {}));
var ConnectionErrors;
(function (ConnectionErrors) {
    /**
     * The connection is closed.
     */
    ConnectionErrors[ConnectionErrors["Closed"] = 1] = "Closed";
    /**
     * The connection got disposed.
     */
    ConnectionErrors[ConnectionErrors["Disposed"] = 2] = "Disposed";
    /**
     * The connection is already in listening mode.
     */
    ConnectionErrors[ConnectionErrors["AlreadyListening"] = 3] = "AlreadyListening";
})(ConnectionErrors || (exports.ConnectionErrors = ConnectionErrors = {}));
class ConnectionError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        Object.setPrototypeOf(this, ConnectionError.prototype);
    }
}
exports.ConnectionError = ConnectionError;
var ConnectionStrategy;
(function (ConnectionStrategy) {
    function is(value) {
        const candidate = value;
        return candidate && Is.func(candidate.cancelUndispatched);
    }
    ConnectionStrategy.is = is;
})(ConnectionStrategy || (exports.ConnectionStrategy = ConnectionStrategy = {}));
var IdCancellationReceiverStrategy;
(function (IdCancellationReceiverStrategy) {
    function is(value) {
        const candidate = value;
        return candidate && (candidate.kind === undefined || candidate.kind === 'id') && Is.func(candidate.createCancellationTokenSource) && (candidate.dispose === undefined || Is.func(candidate.dispose));
    }
    IdCancellationReceiverStrategy.is = is;
})(IdCancellationReceiverStrategy || (exports.IdCancellationReceiverStrategy = IdCancellationReceiverStrategy = {}));
var RequestCancellationReceiverStrategy;
(function (RequestCancellationReceiverStrategy) {
    function is(value) {
        const candidate = value;
        return candidate && candidate.kind === 'request' && Is.func(candidate.createCancellationTokenSource) && (candidate.dispose === undefined || Is.func(candidate.dispose));
    }
    RequestCancellationReceiverStrategy.is = is;
})(RequestCancellationReceiverStrategy || (exports.RequestCancellationReceiverStrategy = RequestCancellationReceiverStrategy = {}));
var CancellationReceiverStrategy;
(function (CancellationReceiverStrategy) {
    CancellationReceiverStrategy.Message = Object.freeze({
        createCancellationTokenSource(_) {
            return new cancellation_1.CancellationTokenSource();
        }
    });
    function is(value) {
        return IdCancellationReceiverStrategy.is(value) || RequestCancellationReceiverStrategy.is(value);
    }
    CancellationReceiverStrategy.is = is;
})(CancellationReceiverStrategy || (exports.CancellationReceiverStrategy = CancellationReceiverStrategy = {}));
var CancellationSenderStrategy;
(function (CancellationSenderStrategy) {
    CancellationSenderStrategy.Message = Object.freeze({
        sendCancellation(conn, id) {
            return conn.sendNotification(CancelNotification.type, { id });
        },
        cleanup(_) { }
    });
    function is(value) {
        const candidate = value;
        return candidate && Is.func(candidate.sendCancellation) && Is.func(candidate.cleanup);
    }
    CancellationSenderStrategy.is = is;
})(CancellationSenderStrategy || (exports.CancellationSenderStrategy = CancellationSenderStrategy = {}));
var CancellationStrategy;
(function (CancellationStrategy) {
    CancellationStrategy.Message = Object.freeze({
        receiver: CancellationReceiverStrategy.Message,
        sender: CancellationSenderStrategy.Message
    });
    function is(value) {
        const candidate = value;
        return candidate && CancellationReceiverStrategy.is(candidate.receiver) && CancellationSenderStrategy.is(candidate.sender);
    }
    CancellationStrategy.is = is;
})(CancellationStrategy || (exports.CancellationStrategy = CancellationStrategy = {}));
var MessageStrategy;
(function (MessageStrategy) {
    function is(value) {
        const candidate = value;
        return candidate && Is.func(candidate.handleMessage);
    }
    MessageStrategy.is = is;
})(MessageStrategy || (exports.MessageStrategy = MessageStrategy = {}));
var ConnectionOptions;
(function (ConnectionOptions) {
    function is(value) {
        const candidate = value;
        return candidate && (CancellationStrategy.is(candidate.cancellationStrategy) || ConnectionStrategy.is(candidate.connectionStrategy) || MessageStrategy.is(candidate.messageStrategy));
    }
    ConnectionOptions.is = is;
})(ConnectionOptions || (exports.ConnectionOptions = ConnectionOptions = {}));
var ConnectionState;
(function (ConnectionState) {
    ConnectionState[ConnectionState["New"] = 1] = "New";
    ConnectionState[ConnectionState["Listening"] = 2] = "Listening";
    ConnectionState[ConnectionState["Closed"] = 3] = "Closed";
    ConnectionState[ConnectionState["Disposed"] = 4] = "Disposed";
})(ConnectionState || (ConnectionState = {}));
function createMessageConnection(messageReader, messageWriter, _logger, options) {
    const logger = _logger !== undefined ? _logger : exports.NullLogger;
    let sequenceNumber = 0;
    let notificationSequenceNumber = 0;
    let unknownResponseSequenceNumber = 0;
    const version = '2.0';
    let starRequestHandler = undefined;
    const requestHandlers = new Map();
    let starNotificationHandler = undefined;
    const notificationHandlers = new Map();
    const progressHandlers = new Map();
    let timer;
    let messageQueue = new linkedMap_1.LinkedMap();
    let responsePromises = new Map();
    let knownCanceledRequests = new Set();
    let requestTokens = new Map();
    let trace = Trace.Off;
    let traceFormat = TraceFormat.Text;
    let tracer;
    let state = ConnectionState.New;
    const errorEmitter = new events_1.Emitter();
    const closeEmitter = new events_1.Emitter();
    const unhandledNotificationEmitter = new events_1.Emitter();
    const unhandledProgressEmitter = new events_1.Emitter();
    const disposeEmitter = new events_1.Emitter();
    const cancellationStrategy = (options && options.cancellationStrategy) ? options.cancellationStrategy : CancellationStrategy.Message;
    function createRequestQueueKey(id) {
        if (id === null) {
            throw new Error(`Can't send requests with id null since the response can't be correlated.`);
        }
        return 'req-' + id.toString();
    }
    function createResponseQueueKey(id) {
        if (id === null) {
            return 'res-unknown-' + (++unknownResponseSequenceNumber).toString();
        }
        else {
            return 'res-' + id.toString();
        }
    }
    function createNotificationQueueKey() {
        return 'not-' + (++notificationSequenceNumber).toString();
    }
    function addMessageToQueue(queue, message) {
        if (messages_1.Message.isRequest(message)) {
            queue.set(createRequestQueueKey(message.id), message);
        }
        else if (messages_1.Message.isResponse(message)) {
            queue.set(createResponseQueueKey(message.id), message);
        }
        else {
            queue.set(createNotificationQueueKey(), message);
        }
    }
    function cancelUndispatched(_message) {
        return undefined;
    }
    function isListening() {
        return state === ConnectionState.Listening;
    }
    function isClosed() {
        return state === ConnectionState.Closed;
    }
    function isDisposed() {
        return state === ConnectionState.Disposed;
    }
    function closeHandler() {
        if (state === ConnectionState.New || state === ConnectionState.Listening) {
            state = ConnectionState.Closed;
            closeEmitter.fire(undefined);
        }
        // If the connection is disposed don't sent close events.
    }
    function readErrorHandler(error) {
        errorEmitter.fire([error, undefined, undefined]);
    }
    function writeErrorHandler(data) {
        errorEmitter.fire(data);
    }
    messageReader.onClose(closeHandler);
    messageReader.onError(readErrorHandler);
    messageWriter.onClose(closeHandler);
    messageWriter.onError(writeErrorHandler);
    function triggerMessageQueue() {
        if (timer || messageQueue.size === 0) {
            return;
        }
        timer = (0, ral_1.default)().timer.setImmediate(() => {
            timer = undefined;
            processMessageQueue();
        });
    }
    function handleMessage(message) {
        if (messages_1.Message.isRequest(message)) {
            handleRequest(message);
        }
        else if (messages_1.Message.isNotification(message)) {
            handleNotification(message);
        }
        else if (messages_1.Message.isResponse(message)) {
            handleResponse(message);
        }
        else {
            handleInvalidMessage(message);
        }
    }
    function processMessageQueue() {
        if (messageQueue.size === 0) {
            return;
        }
        const message = messageQueue.shift();
        try {
            const messageStrategy = options?.messageStrategy;
            if (MessageStrategy.is(messageStrategy)) {
                messageStrategy.handleMessage(message, handleMessage);
            }
            else {
                handleMessage(message);
            }
        }
        finally {
            triggerMessageQueue();
        }
    }
    const callback = (message) => {
        try {
            // We have received a cancellation message. Check if the message is still in the queue
            // and cancel it if allowed to do so.
            if (messages_1.Message.isNotification(message) && message.method === CancelNotification.type.method) {
                const cancelId = message.params.id;
                const key = createRequestQueueKey(cancelId);
                const toCancel = messageQueue.get(key);
                if (messages_1.Message.isRequest(toCancel)) {
                    const strategy = options?.connectionStrategy;
                    const response = (strategy && strategy.cancelUndispatched) ? strategy.cancelUndispatched(toCancel, cancelUndispatched) : cancelUndispatched(toCancel);
                    if (response && (response.error !== undefined || response.result !== undefined)) {
                        messageQueue.delete(key);
                        requestTokens.delete(cancelId);
                        response.id = toCancel.id;
                        traceSendingResponse(response, message.method, Date.now());
                        messageWriter.write(response).catch(() => logger.error(`Sending response for canceled message failed.`));
                        return;
                    }
                }
                const cancellationToken = requestTokens.get(cancelId);
                // The request is already running. Cancel the token
                if (cancellationToken !== undefined) {
                    cancellationToken.cancel();
                    traceReceivedNotification(message);
                    return;
                }
                else {
                    // Remember the cancel but still queue the message to
                    // clean up state in process message.
                    knownCanceledRequests.add(cancelId);
                }
            }
            addMessageToQueue(messageQueue, message);
        }
        finally {
            triggerMessageQueue();
        }
    };
    function handleRequest(requestMessage) {
        if (isDisposed()) {
            // we return here silently since we fired an event when the
            // connection got disposed.
            return;
        }
        function reply(resultOrError, method, startTime) {
            const message = {
                jsonrpc: version,
                id: requestMessage.id
            };
            if (resultOrError instanceof messages_1.ResponseError) {
                message.error = resultOrError.toJson();
            }
            else {
                message.result = resultOrError === undefined ? null : resultOrError;
            }
            traceSendingResponse(message, method, startTime);
            messageWriter.write(message).catch(() => logger.error(`Sending response failed.`));
        }
        function replyError(error, method, startTime) {
            const message = {
                jsonrpc: version,
                id: requestMessage.id,
                error: error.toJson()
            };
            traceSendingResponse(message, method, startTime);
            messageWriter.write(message).catch(() => logger.error(`Sending response failed.`));
        }
        function replySuccess(result, method, startTime) {
            // The JSON RPC defines that a response must either have a result or an error
            // So we can't treat undefined as a valid response result.
            if (result === undefined) {
                result = null;
            }
            const message = {
                jsonrpc: version,
                id: requestMessage.id,
                result: result
            };
            traceSendingResponse(message, method, startTime);
            messageWriter.write(message).catch(() => logger.error(`Sending response failed.`));
        }
        traceReceivedRequest(requestMessage);
        const element = requestHandlers.get(requestMessage.method);
        let type;
        let requestHandler;
        if (element) {
            type = element.type;
            requestHandler = element.handler;
        }
        const startTime = Date.now();
        if (requestHandler || starRequestHandler) {
            const tokenKey = requestMessage.id ?? String(Date.now()); //
            const cancellationSource = IdCancellationReceiverStrategy.is(cancellationStrategy.receiver)
                ? cancellationStrategy.receiver.createCancellationTokenSource(tokenKey)
                : cancellationStrategy.receiver.createCancellationTokenSource(requestMessage);
            if (requestMessage.id !== null && knownCanceledRequests.has(requestMessage.id)) {
                cancellationSource.cancel();
            }
            if (requestMessage.id !== null) {
                requestTokens.set(tokenKey, cancellationSource);
            }
            try {
                let handlerResult;
                if (requestHandler) {
                    if (requestMessage.params === undefined) {
                        if (type !== undefined && type.numberOfParams !== 0) {
                            replyError(new messages_1.ResponseError(messages_1.ErrorCodes.InvalidParams, `Request ${requestMessage.method} defines ${type.numberOfParams} params but received none.`), requestMessage.method, startTime);
                            return;
                        }
                        handlerResult = requestHandler(cancellationSource.token);
                    }
                    else if (Array.isArray(requestMessage.params)) {
                        if (type !== undefined && type.parameterStructures === messages_1.ParameterStructures.byName) {
                            replyError(new messages_1.ResponseError(messages_1.ErrorCodes.InvalidParams, `Request ${requestMessage.method} defines parameters by name but received parameters by position`), requestMessage.method, startTime);
                            return;
                        }
                        handlerResult = requestHandler(...requestMessage.params, cancellationSource.token);
                    }
                    else {
                        if (type !== undefined && type.parameterStructures === messages_1.ParameterStructures.byPosition) {
                            replyError(new messages_1.ResponseError(messages_1.ErrorCodes.InvalidParams, `Request ${requestMessage.method} defines parameters by position but received parameters by name`), requestMessage.method, startTime);
                            return;
                        }
                        handlerResult = requestHandler(requestMessage.params, cancellationSource.token);
                    }
                }
                else if (starRequestHandler) {
                    handlerResult = starRequestHandler(requestMessage.method, requestMessage.params, cancellationSource.token);
                }
                const promise = handlerResult;
                if (!handlerResult) {
                    requestTokens.delete(tokenKey);
                    replySuccess(handlerResult, requestMessage.method, startTime);
                }
                else if (promise.then) {
                    promise.then((resultOrError) => {
                        requestTokens.delete(tokenKey);
                        reply(resultOrError, requestMessage.method, startTime);
                    }, error => {
                        requestTokens.delete(tokenKey);
                        if (error instanceof messages_1.ResponseError) {
                            replyError(error, requestMessage.method, startTime);
                        }
                        else if (error && Is.string(error.message)) {
                            replyError(new messages_1.ResponseError(messages_1.ErrorCodes.InternalError, `Request ${requestMessage.method} failed with message: ${error.message}`), requestMessage.method, startTime);
                        }
                        else {
                            replyError(new messages_1.ResponseError(messages_1.ErrorCodes.InternalError, `Request ${requestMessage.method} failed unexpectedly without providing any details.`), requestMessage.method, startTime);
                        }
                    });
                }
                else {
                    requestTokens.delete(tokenKey);
                    reply(handlerResult, requestMessage.method, startTime);
                }
            }
            catch (error) {
                requestTokens.delete(tokenKey);
                if (error instanceof messages_1.ResponseError) {
                    reply(error, requestMessage.method, startTime);
                }
                else if (error && Is.string(error.message)) {
                    replyError(new messages_1.ResponseError(messages_1.ErrorCodes.InternalError, `Request ${requestMessage.method} failed with message: ${error.message}`), requestMessage.method, startTime);
                }
                else {
                    replyError(new messages_1.ResponseError(messages_1.ErrorCodes.InternalError, `Request ${requestMessage.method} failed unexpectedly without providing any details.`), requestMessage.method, startTime);
                }
            }
        }
        else {
            replyError(new messages_1.ResponseError(messages_1.ErrorCodes.MethodNotFound, `Unhandled method ${requestMessage.method}`), requestMessage.method, startTime);
        }
    }
    function handleResponse(responseMessage) {
        if (isDisposed()) {
            // See handle request.
            return;
        }
        if (responseMessage.id === null) {
            if (responseMessage.error) {
                logger.error(`Received response message without id: Error is: \n${JSON.stringify(responseMessage.error, undefined, 4)}`);
            }
            else {
                logger.error(`Received response message without id. No further error information provided.`);
            }
        }
        else {
            const key = responseMessage.id;
            const responsePromise = responsePromises.get(key);
            traceReceivedResponse(responseMessage, responsePromise);
            if (responsePromise !== undefined) {
                responsePromises.delete(key);
                try {
                    if (responseMessage.error) {
                        const error = responseMessage.error;
                        responsePromise.reject(new messages_1.ResponseError(error.code, error.message, error.data));
                    }
                    else if (responseMessage.result !== undefined) {
                        responsePromise.resolve(responseMessage.result);
                    }
                    else {
                        throw new Error('Should never happen.');
                    }
                }
                catch (error) {
                    if (error.message) {
                        logger.error(`Response handler '${responsePromise.method}' failed with message: ${error.message}`);
                    }
                    else {
                        logger.error(`Response handler '${responsePromise.method}' failed unexpectedly.`);
                    }
                }
            }
        }
    }
    function handleNotification(message) {
        if (isDisposed()) {
            // See handle request.
            return;
        }
        let type = undefined;
        let notificationHandler;
        if (message.method === CancelNotification.type.method) {
            const cancelId = message.params.id;
            knownCanceledRequests.delete(cancelId);
            traceReceivedNotification(message);
            return;
        }
        else {
            const element = notificationHandlers.get(message.method);
            if (element) {
                notificationHandler = element.handler;
                type = element.type;
            }
        }
        if (notificationHandler || starNotificationHandler) {
            try {
                traceReceivedNotification(message);
                if (notificationHandler) {
                    if (message.params === undefined) {
                        if (type !== undefined) {
                            if (type.numberOfParams !== 0 && type.parameterStructures !== messages_1.ParameterStructures.byName) {
                                logger.error(`Notification ${message.method} defines ${type.numberOfParams} params but received none.`);
                            }
                        }
                        notificationHandler();
                    }
                    else if (Array.isArray(message.params)) {
                        // There are JSON-RPC libraries that send progress message as positional params although
                        // specified as named. So convert them if this is the case.
                        const params = message.params;
                        if (message.method === ProgressNotification.type.method && params.length === 2 && ProgressToken.is(params[0])) {
                            notificationHandler({ token: params[0], value: params[1] });
                        }
                        else {
                            if (type !== undefined) {
                                if (type.parameterStructures === messages_1.ParameterStructures.byName) {
                                    logger.error(`Notification ${message.method} defines parameters by name but received parameters by position`);
                                }
                                if (type.numberOfParams !== message.params.length) {
                                    logger.error(`Notification ${message.method} defines ${type.numberOfParams} params but received ${params.length} arguments`);
                                }
                            }
                            notificationHandler(...params);
                        }
                    }
                    else {
                        if (type !== undefined && type.parameterStructures === messages_1.ParameterStructures.byPosition) {
                            logger.error(`Notification ${message.method} defines parameters by position but received parameters by name`);
                        }
                        notificationHandler(message.params);
                    }
                }
                else if (starNotificationHandler) {
                    starNotificationHandler(message.method, message.params);
                }
            }
            catch (error) {
                if (error.message) {
                    logger.error(`Notification handler '${message.method}' failed with message: ${error.message}`);
                }
                else {
                    logger.error(`Notification handler '${message.method}' failed unexpectedly.`);
                }
            }
        }
        else {
            unhandledNotificationEmitter.fire(message);
        }
    }
    function handleInvalidMessage(message) {
        if (!message) {
            logger.error('Received empty message.');
            return;
        }
        logger.error(`Received message which is neither a response nor a notification message:\n${JSON.stringify(message, null, 4)}`);
        // Test whether we find an id to reject the promise
        const responseMessage = message;
        if (Is.string(responseMessage.id) || Is.number(responseMessage.id)) {
            const key = responseMessage.id;
            const responseHandler = responsePromises.get(key);
            if (responseHandler) {
                responseHandler.reject(new Error('The received response has neither a result nor an error property.'));
            }
        }
    }
    function stringifyTrace(params) {
        if (params === undefined || params === null) {
            return undefined;
        }
        switch (trace) {
            case Trace.Verbose:
                return JSON.stringify(params, null, 4);
            case Trace.Compact:
                return JSON.stringify(params);
            default:
                return undefined;
        }
    }
    function traceSendingRequest(message) {
        if (trace === Trace.Off || !tracer) {
            return;
        }
        if (traceFormat === TraceFormat.Text) {
            let data = undefined;
            if ((trace === Trace.Verbose || trace === Trace.Compact) && message.params) {
                data = `Params: ${stringifyTrace(message.params)}\n\n`;
            }
            tracer.log(`Sending request '${message.method} - (${message.id})'.`, data);
        }
        else {
            logLSPMessage('send-request', message);
        }
    }
    function traceSendingNotification(message) {
        if (trace === Trace.Off || !tracer) {
            return;
        }
        if (traceFormat === TraceFormat.Text) {
            let data = undefined;
            if (trace === Trace.Verbose || trace === Trace.Compact) {
                if (message.params) {
                    data = `Params: ${stringifyTrace(message.params)}\n\n`;
                }
                else {
                    data = 'No parameters provided.\n\n';
                }
            }
            tracer.log(`Sending notification '${message.method}'.`, data);
        }
        else {
            logLSPMessage('send-notification', message);
        }
    }
    function traceSendingResponse(message, method, startTime) {
        if (trace === Trace.Off || !tracer) {
            return;
        }
        if (traceFormat === TraceFormat.Text) {
            let data = undefined;
            if (trace === Trace.Verbose || trace === Trace.Compact) {
                if (message.error && message.error.data) {
                    data = `Error data: ${stringifyTrace(message.error.data)}\n\n`;
                }
                else {
                    if (message.result) {
                        data = `Result: ${stringifyTrace(message.result)}\n\n`;
                    }
                    else if (message.error === undefined) {
                        data = 'No result returned.\n\n';
                    }
                }
            }
            tracer.log(`Sending response '${method} - (${message.id})'. Processing request took ${Date.now() - startTime}ms`, data);
        }
        else {
            logLSPMessage('send-response', message);
        }
    }
    function traceReceivedRequest(message) {
        if (trace === Trace.Off || !tracer) {
            return;
        }
        if (traceFormat === TraceFormat.Text) {
            let data = undefined;
            if ((trace === Trace.Verbose || trace === Trace.Compact) && message.params) {
                data = `Params: ${stringifyTrace(message.params)}\n\n`;
            }
            tracer.log(`Received request '${message.method} - (${message.id})'.`, data);
        }
        else {
            logLSPMessage('receive-request', message);
        }
    }
    function traceReceivedNotification(message) {
        if (trace === Trace.Off || !tracer || message.method === LogTraceNotification.type.method) {
            return;
        }
        if (traceFormat === TraceFormat.Text) {
            let data = undefined;
            if (trace === Trace.Verbose || trace === Trace.Compact) {
                if (message.params) {
                    data = `Params: ${stringifyTrace(message.params)}\n\n`;
                }
                else {
                    data = 'No parameters provided.\n\n';
                }
            }
            tracer.log(`Received notification '${message.method}'.`, data);
        }
        else {
            logLSPMessage('receive-notification', message);
        }
    }
    function traceReceivedResponse(message, responsePromise) {
        if (trace === Trace.Off || !tracer) {
            return;
        }
        if (traceFormat === TraceFormat.Text) {
            let data = undefined;
            if (trace === Trace.Verbose || trace === Trace.Compact) {
                if (message.error && message.error.data) {
                    data = `Error data: ${stringifyTrace(message.error.data)}\n\n`;
                }
                else {
                    if (message.result) {
                        data = `Result: ${stringifyTrace(message.result)}\n\n`;
                    }
                    else if (message.error === undefined) {
                        data = 'No result returned.\n\n';
                    }
                }
            }
            if (responsePromise) {
                const error = message.error ? ` Request failed: ${message.error.message} (${message.error.code}).` : '';
                tracer.log(`Received response '${responsePromise.method} - (${message.id})' in ${Date.now() - responsePromise.timerStart}ms.${error}`, data);
            }
            else {
                tracer.log(`Received response ${message.id} without active response promise.`, data);
            }
        }
        else {
            logLSPMessage('receive-response', message);
        }
    }
    function logLSPMessage(type, message) {
        if (!tracer || trace === Trace.Off) {
            return;
        }
        const lspMessage = {
            isLSPMessage: true,
            type,
            message,
            timestamp: Date.now()
        };
        tracer.log(lspMessage);
    }
    function throwIfClosedOrDisposed() {
        if (isClosed()) {
            throw new ConnectionError(ConnectionErrors.Closed, 'Connection is closed.');
        }
        if (isDisposed()) {
            throw new ConnectionError(ConnectionErrors.Disposed, 'Connection is disposed.');
        }
    }
    function throwIfListening() {
        if (isListening()) {
            throw new ConnectionError(ConnectionErrors.AlreadyListening, 'Connection is already listening');
        }
    }
    function throwIfNotListening() {
        if (!isListening()) {
            throw new Error('Call listen() first.');
        }
    }
    function undefinedToNull(param) {
        if (param === undefined) {
            return null;
        }
        else {
            return param;
        }
    }
    function nullToUndefined(param) {
        if (param === null) {
            return undefined;
        }
        else {
            return param;
        }
    }
    function isNamedParam(param) {
        return param !== undefined && param !== null && !Array.isArray(param) && typeof param === 'object';
    }
    function computeSingleParam(parameterStructures, param) {
        switch (parameterStructures) {
            case messages_1.ParameterStructures.auto:
                if (isNamedParam(param)) {
                    return nullToUndefined(param);
                }
                else {
                    return [undefinedToNull(param)];
                }
            case messages_1.ParameterStructures.byName:
                if (!isNamedParam(param)) {
                    throw new Error(`Received parameters by name but param is not an object literal.`);
                }
                return nullToUndefined(param);
            case messages_1.ParameterStructures.byPosition:
                return [undefinedToNull(param)];
            default:
                throw new Error(`Unknown parameter structure ${parameterStructures.toString()}`);
        }
    }
    function computeMessageParams(type, params) {
        let result;
        const numberOfParams = type.numberOfParams;
        switch (numberOfParams) {
            case 0:
                result = undefined;
                break;
            case 1:
                result = computeSingleParam(type.parameterStructures, params[0]);
                break;
            default:
                result = [];
                for (let i = 0; i < params.length && i < numberOfParams; i++) {
                    result.push(undefinedToNull(params[i]));
                }
                if (params.length < numberOfParams) {
                    for (let i = params.length; i < numberOfParams; i++) {
                        result.push(null);
                    }
                }
                break;
        }
        return result;
    }
    const connection = {
        sendNotification: (type, ...args) => {
            throwIfClosedOrDisposed();
            let method;
            let messageParams;
            if (Is.string(type)) {
                method = type;
                const first = args[0];
                let paramStart = 0;
                let parameterStructures = messages_1.ParameterStructures.auto;
                if (messages_1.ParameterStructures.is(first)) {
                    paramStart = 1;
                    parameterStructures = first;
                }
                let paramEnd = args.length;
                const numberOfParams = paramEnd - paramStart;
                switch (numberOfParams) {
                    case 0:
                        messageParams = undefined;
                        break;
                    case 1:
                        messageParams = computeSingleParam(parameterStructures, args[paramStart]);
                        break;
                    default:
                        if (parameterStructures === messages_1.ParameterStructures.byName) {
                            throw new Error(`Received ${numberOfParams} parameters for 'by Name' notification parameter structure.`);
                        }
                        messageParams = args.slice(paramStart, paramEnd).map(value => undefinedToNull(value));
                        break;
                }
            }
            else {
                const params = args;
                method = type.method;
                messageParams = computeMessageParams(type, params);
            }
            const notificationMessage = {
                jsonrpc: version,
                method: method,
                params: messageParams
            };
            traceSendingNotification(notificationMessage);
            return messageWriter.write(notificationMessage).catch((error) => {
                logger.error(`Sending notification failed.`);
                throw error;
            });
        },
        onNotification: (type, handler) => {
            throwIfClosedOrDisposed();
            let method;
            if (Is.func(type)) {
                starNotificationHandler = type;
            }
            else if (handler) {
                if (Is.string(type)) {
                    method = type;
                    notificationHandlers.set(type, { type: undefined, handler });
                }
                else {
                    method = type.method;
                    notificationHandlers.set(type.method, { type, handler });
                }
            }
            return {
                dispose: () => {
                    if (method !== undefined) {
                        notificationHandlers.delete(method);
                    }
                    else {
                        starNotificationHandler = undefined;
                    }
                }
            };
        },
        onProgress: (_type, token, handler) => {
            if (progressHandlers.has(token)) {
                throw new Error(`Progress handler for token ${token} already registered`);
            }
            progressHandlers.set(token, handler);
            return {
                dispose: () => {
                    progressHandlers.delete(token);
                }
            };
        },
        sendProgress: (_type, token, value) => {
            // This should not await but simple return to ensure that we don't have another
            // async scheduling. Otherwise one send could overtake another send.
            return connection.sendNotification(ProgressNotification.type, { token, value });
        },
        onUnhandledProgress: unhandledProgressEmitter.event,
        sendRequest: (type, ...args) => {
            throwIfClosedOrDisposed();
            throwIfNotListening();
            let method;
            let messageParams;
            let token = undefined;
            if (Is.string(type)) {
                method = type;
                const first = args[0];
                const last = args[args.length - 1];
                let paramStart = 0;
                let parameterStructures = messages_1.ParameterStructures.auto;
                if (messages_1.ParameterStructures.is(first)) {
                    paramStart = 1;
                    parameterStructures = first;
                }
                let paramEnd = args.length;
                if (cancellation_1.CancellationToken.is(last)) {
                    paramEnd = paramEnd - 1;
                    token = last;
                }
                const numberOfParams = paramEnd - paramStart;
                switch (numberOfParams) {
                    case 0:
                        messageParams = undefined;
                        break;
                    case 1:
                        messageParams = computeSingleParam(parameterStructures, args[paramStart]);
                        break;
                    default:
                        if (parameterStructures === messages_1.ParameterStructures.byName) {
                            throw new Error(`Received ${numberOfParams} parameters for 'by Name' request parameter structure.`);
                        }
                        messageParams = args.slice(paramStart, paramEnd).map(value => undefinedToNull(value));
                        break;
                }
            }
            else {
                const params = args;
                method = type.method;
                messageParams = computeMessageParams(type, params);
                const numberOfParams = type.numberOfParams;
                token = cancellation_1.CancellationToken.is(params[numberOfParams]) ? params[numberOfParams] : undefined;
            }
            const id = sequenceNumber++;
            let disposable;
            if (token) {
                disposable = token.onCancellationRequested(() => {
                    const p = cancellationStrategy.sender.sendCancellation(connection, id);
                    if (p === undefined) {
                        logger.log(`Received no promise from cancellation strategy when cancelling id ${id}`);
                        return Promise.resolve();
                    }
                    else {
                        return p.catch(() => {
                            logger.log(`Sending cancellation messages for id ${id} failed`);
                        });
                    }
                });
            }
            const requestMessage = {
                jsonrpc: version,
                id: id,
                method: method,
                params: messageParams
            };
            traceSendingRequest(requestMessage);
            if (typeof cancellationStrategy.sender.enableCancellation === 'function') {
                cancellationStrategy.sender.enableCancellation(requestMessage);
            }
            return new Promise(async (resolve, reject) => {
                const resolveWithCleanup = (r) => {
                    resolve(r);
                    cancellationStrategy.sender.cleanup(id);
                    disposable?.dispose();
                };
                const rejectWithCleanup = (r) => {
                    reject(r);
                    cancellationStrategy.sender.cleanup(id);
                    disposable?.dispose();
                };
                const responsePromise = { method: method, timerStart: Date.now(), resolve: resolveWithCleanup, reject: rejectWithCleanup };
                try {
                    await messageWriter.write(requestMessage);
                    responsePromises.set(id, responsePromise);
                }
                catch (error) {
                    logger.error(`Sending request failed.`);
                    // Writing the message failed. So we need to reject the promise.
                    responsePromise.reject(new messages_1.ResponseError(messages_1.ErrorCodes.MessageWriteError, error.message ? error.message : 'Unknown reason'));
                    throw error;
                }
            });
        },
        onRequest: (type, handler) => {
            throwIfClosedOrDisposed();
            let method = null;
            if (StarRequestHandler.is(type)) {
                method = undefined;
                starRequestHandler = type;
            }
            else if (Is.string(type)) {
                method = null;
                if (handler !== undefined) {
                    method = type;
                    requestHandlers.set(type, { handler: handler, type: undefined });
                }
            }
            else {
                if (handler !== undefined) {
                    method = type.method;
                    requestHandlers.set(type.method, { type, handler });
                }
            }
            return {
                dispose: () => {
                    if (method === null) {
                        return;
                    }
                    if (method !== undefined) {
                        requestHandlers.delete(method);
                    }
                    else {
                        starRequestHandler = undefined;
                    }
                }
            };
        },
        hasPendingResponse: () => {
            return responsePromises.size > 0;
        },
        trace: async (_value, _tracer, sendNotificationOrTraceOptions) => {
            let _sendNotification = false;
            let _traceFormat = TraceFormat.Text;
            if (sendNotificationOrTraceOptions !== undefined) {
                if (Is.boolean(sendNotificationOrTraceOptions)) {
                    _sendNotification = sendNotificationOrTraceOptions;
                }
                else {
                    _sendNotification = sendNotificationOrTraceOptions.sendNotification || false;
                    _traceFormat = sendNotificationOrTraceOptions.traceFormat || TraceFormat.Text;
                }
            }
            trace = _value;
            traceFormat = _traceFormat;
            if (trace === Trace.Off) {
                tracer = undefined;
            }
            else {
                tracer = _tracer;
            }
            if (_sendNotification && !isClosed() && !isDisposed()) {
                await connection.sendNotification(SetTraceNotification.type, { value: Trace.toString(_value) });
            }
        },
        onError: errorEmitter.event,
        onClose: closeEmitter.event,
        onUnhandledNotification: unhandledNotificationEmitter.event,
        onDispose: disposeEmitter.event,
        end: () => {
            messageWriter.end();
        },
        dispose: () => {
            if (isDisposed()) {
                return;
            }
            state = ConnectionState.Disposed;
            disposeEmitter.fire(undefined);
            const error = new messages_1.ResponseError(messages_1.ErrorCodes.PendingResponseRejected, 'Pending response rejected since connection got disposed');
            for (const promise of responsePromises.values()) {
                promise.reject(error);
            }
            responsePromises = new Map();
            requestTokens = new Map();
            knownCanceledRequests = new Set();
            messageQueue = new linkedMap_1.LinkedMap();
            // Test for backwards compatibility
            if (Is.func(messageWriter.dispose)) {
                messageWriter.dispose();
            }
            if (Is.func(messageReader.dispose)) {
                messageReader.dispose();
            }
        },
        listen: () => {
            throwIfClosedOrDisposed();
            throwIfListening();
            state = ConnectionState.Listening;
            messageReader.listen(callback);
        },
        inspect: () => {
            // eslint-disable-next-line no-console
            (0, ral_1.default)().console.log('inspect');
        }
    };
    connection.onNotification(LogTraceNotification.type, (params) => {
        if (trace === Trace.Off || !tracer) {
            return;
        }
        const verbose = trace === Trace.Verbose || trace === Trace.Compact;
        tracer.log(params.message, verbose ? params.verbose : undefined);
    });
    connection.onNotification(ProgressNotification.type, (params) => {
        const handler = progressHandlers.get(params.token);
        if (handler) {
            handler(params.value);
        }
        else {
            unhandledProgressEmitter.fire(params);
        }
    });
    return connection;
}
exports.createMessageConnection = createMessageConnection;


/***/ },

/***/ 4019
(__unused_webpack_module, exports) {

"use strict";

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.Disposable = void 0;
var Disposable;
(function (Disposable) {
    function create(func) {
        return {
            dispose: func
        };
    }
    Disposable.create = create;
})(Disposable || (exports.Disposable = Disposable = {}));


/***/ },

/***/ 2676
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.Emitter = exports.Event = void 0;
const ral_1 = __webpack_require__(9590);
var Event;
(function (Event) {
    const _disposable = { dispose() { } };
    Event.None = function () { return _disposable; };
})(Event || (exports.Event = Event = {}));
class CallbackList {
    add(callback, context = null, bucket) {
        if (!this._callbacks) {
            this._callbacks = [];
            this._contexts = [];
        }
        this._callbacks.push(callback);
        this._contexts.push(context);
        if (Array.isArray(bucket)) {
            bucket.push({ dispose: () => this.remove(callback, context) });
        }
    }
    remove(callback, context = null) {
        if (!this._callbacks) {
            return;
        }
        let foundCallbackWithDifferentContext = false;
        for (let i = 0, len = this._callbacks.length; i < len; i++) {
            if (this._callbacks[i] === callback) {
                if (this._contexts[i] === context) {
                    // callback & context match => remove it
                    this._callbacks.splice(i, 1);
                    this._contexts.splice(i, 1);
                    return;
                }
                else {
                    foundCallbackWithDifferentContext = true;
                }
            }
        }
        if (foundCallbackWithDifferentContext) {
            throw new Error('When adding a listener with a context, you should remove it with the same context');
        }
    }
    invoke(...args) {
        if (!this._callbacks) {
            return [];
        }
        const ret = [], callbacks = this._callbacks.slice(0), contexts = this._contexts.slice(0);
        for (let i = 0, len = callbacks.length; i < len; i++) {
            try {
                ret.push(callbacks[i].apply(contexts[i], args));
            }
            catch (e) {
                // eslint-disable-next-line no-console
                (0, ral_1.default)().console.error(e);
            }
        }
        return ret;
    }
    isEmpty() {
        return !this._callbacks || this._callbacks.length === 0;
    }
    dispose() {
        this._callbacks = undefined;
        this._contexts = undefined;
    }
}
class Emitter {
    constructor(_options) {
        this._options = _options;
    }
    /**
     * For the public to allow to subscribe
     * to events from this Emitter
     */
    get event() {
        if (!this._event) {
            this._event = (listener, thisArgs, disposables) => {
                if (!this._callbacks) {
                    this._callbacks = new CallbackList();
                }
                if (this._options && this._options.onFirstListenerAdd && this._callbacks.isEmpty()) {
                    this._options.onFirstListenerAdd(this);
                }
                this._callbacks.add(listener, thisArgs);
                const result = {
                    dispose: () => {
                        if (!this._callbacks) {
                            // disposable is disposed after emitter is disposed.
                            return;
                        }
                        this._callbacks.remove(listener, thisArgs);
                        result.dispose = Emitter._noop;
                        if (this._options && this._options.onLastListenerRemove && this._callbacks.isEmpty()) {
                            this._options.onLastListenerRemove(this);
                        }
                    }
                };
                if (Array.isArray(disposables)) {
                    disposables.push(result);
                }
                return result;
            };
        }
        return this._event;
    }
    /**
     * To be kept private to fire an event to
     * subscribers
     */
    fire(event) {
        if (this._callbacks) {
            this._callbacks.invoke.call(this._callbacks, event);
        }
    }
    dispose() {
        if (this._callbacks) {
            this._callbacks.dispose();
            this._callbacks = undefined;
        }
    }
}
exports.Emitter = Emitter;
Emitter._noop = function () { };


/***/ },

/***/ 8585
(__unused_webpack_module, exports) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.stringArray = exports.array = exports.func = exports.error = exports.number = exports.string = exports.boolean = void 0;
function boolean(value) {
    return value === true || value === false;
}
exports.boolean = boolean;
function string(value) {
    return typeof value === 'string' || value instanceof String;
}
exports.string = string;
function number(value) {
    return typeof value === 'number' || value instanceof Number;
}
exports.number = number;
function error(value) {
    return value instanceof Error;
}
exports.error = error;
function func(value) {
    return typeof value === 'function';
}
exports.func = func;
function array(value) {
    return Array.isArray(value);
}
exports.array = array;
function stringArray(value) {
    return array(value) && value.every(elem => string(elem));
}
exports.stringArray = stringArray;


/***/ },

/***/ 3352
(__unused_webpack_module, exports) {

"use strict";

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
var _a;
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.LRUCache = exports.LinkedMap = exports.Touch = void 0;
var Touch;
(function (Touch) {
    Touch.None = 0;
    Touch.First = 1;
    Touch.AsOld = Touch.First;
    Touch.Last = 2;
    Touch.AsNew = Touch.Last;
})(Touch || (exports.Touch = Touch = {}));
class LinkedMap {
    constructor() {
        this[_a] = 'LinkedMap';
        this._map = new Map();
        this._head = undefined;
        this._tail = undefined;
        this._size = 0;
        this._state = 0;
    }
    clear() {
        this._map.clear();
        this._head = undefined;
        this._tail = undefined;
        this._size = 0;
        this._state++;
    }
    isEmpty() {
        return !this._head && !this._tail;
    }
    get size() {
        return this._size;
    }
    get first() {
        return this._head?.value;
    }
    get last() {
        return this._tail?.value;
    }
    has(key) {
        return this._map.has(key);
    }
    get(key, touch = Touch.None) {
        const item = this._map.get(key);
        if (!item) {
            return undefined;
        }
        if (touch !== Touch.None) {
            this.touch(item, touch);
        }
        return item.value;
    }
    set(key, value, touch = Touch.None) {
        let item = this._map.get(key);
        if (item) {
            item.value = value;
            if (touch !== Touch.None) {
                this.touch(item, touch);
            }
        }
        else {
            item = { key, value, next: undefined, previous: undefined };
            switch (touch) {
                case Touch.None:
                    this.addItemLast(item);
                    break;
                case Touch.First:
                    this.addItemFirst(item);
                    break;
                case Touch.Last:
                    this.addItemLast(item);
                    break;
                default:
                    this.addItemLast(item);
                    break;
            }
            this._map.set(key, item);
            this._size++;
        }
        return this;
    }
    delete(key) {
        return !!this.remove(key);
    }
    remove(key) {
        const item = this._map.get(key);
        if (!item) {
            return undefined;
        }
        this._map.delete(key);
        this.removeItem(item);
        this._size--;
        return item.value;
    }
    shift() {
        if (!this._head && !this._tail) {
            return undefined;
        }
        if (!this._head || !this._tail) {
            throw new Error('Invalid list');
        }
        const item = this._head;
        this._map.delete(item.key);
        this.removeItem(item);
        this._size--;
        return item.value;
    }
    forEach(callbackfn, thisArg) {
        const state = this._state;
        let current = this._head;
        while (current) {
            if (thisArg) {
                callbackfn.bind(thisArg)(current.value, current.key, this);
            }
            else {
                callbackfn(current.value, current.key, this);
            }
            if (this._state !== state) {
                throw new Error(`LinkedMap got modified during iteration.`);
            }
            current = current.next;
        }
    }
    keys() {
        const state = this._state;
        let current = this._head;
        const iterator = {
            [Symbol.iterator]: () => {
                return iterator;
            },
            next: () => {
                if (this._state !== state) {
                    throw new Error(`LinkedMap got modified during iteration.`);
                }
                if (current) {
                    const result = { value: current.key, done: false };
                    current = current.next;
                    return result;
                }
                else {
                    return { value: undefined, done: true };
                }
            }
        };
        return iterator;
    }
    values() {
        const state = this._state;
        let current = this._head;
        const iterator = {
            [Symbol.iterator]: () => {
                return iterator;
            },
            next: () => {
                if (this._state !== state) {
                    throw new Error(`LinkedMap got modified during iteration.`);
                }
                if (current) {
                    const result = { value: current.value, done: false };
                    current = current.next;
                    return result;
                }
                else {
                    return { value: undefined, done: true };
                }
            }
        };
        return iterator;
    }
    entries() {
        const state = this._state;
        let current = this._head;
        const iterator = {
            [Symbol.iterator]: () => {
                return iterator;
            },
            next: () => {
                if (this._state !== state) {
                    throw new Error(`LinkedMap got modified during iteration.`);
                }
                if (current) {
                    const result = { value: [current.key, current.value], done: false };
                    current = current.next;
                    return result;
                }
                else {
                    return { value: undefined, done: true };
                }
            }
        };
        return iterator;
    }
    [(_a = Symbol.toStringTag, Symbol.iterator)]() {
        return this.entries();
    }
    trimOld(newSize) {
        if (newSize >= this.size) {
            return;
        }
        if (newSize === 0) {
            this.clear();
            return;
        }
        let current = this._head;
        let currentSize = this.size;
        while (current && currentSize > newSize) {
            this._map.delete(current.key);
            current = current.next;
            currentSize--;
        }
        this._head = current;
        this._size = currentSize;
        if (current) {
            current.previous = undefined;
        }
        this._state++;
    }
    addItemFirst(item) {
        // First time Insert
        if (!this._head && !this._tail) {
            this._tail = item;
        }
        else if (!this._head) {
            throw new Error('Invalid list');
        }
        else {
            item.next = this._head;
            this._head.previous = item;
        }
        this._head = item;
        this._state++;
    }
    addItemLast(item) {
        // First time Insert
        if (!this._head && !this._tail) {
            this._head = item;
        }
        else if (!this._tail) {
            throw new Error('Invalid list');
        }
        else {
            item.previous = this._tail;
            this._tail.next = item;
        }
        this._tail = item;
        this._state++;
    }
    removeItem(item) {
        if (item === this._head && item === this._tail) {
            this._head = undefined;
            this._tail = undefined;
        }
        else if (item === this._head) {
            // This can only happened if size === 1 which is handle
            // by the case above.
            if (!item.next) {
                throw new Error('Invalid list');
            }
            item.next.previous = undefined;
            this._head = item.next;
        }
        else if (item === this._tail) {
            // This can only happened if size === 1 which is handle
            // by the case above.
            if (!item.previous) {
                throw new Error('Invalid list');
            }
            item.previous.next = undefined;
            this._tail = item.previous;
        }
        else {
            const next = item.next;
            const previous = item.previous;
            if (!next || !previous) {
                throw new Error('Invalid list');
            }
            next.previous = previous;
            previous.next = next;
        }
        item.next = undefined;
        item.previous = undefined;
        this._state++;
    }
    touch(item, touch) {
        if (!this._head || !this._tail) {
            throw new Error('Invalid list');
        }
        if ((touch !== Touch.First && touch !== Touch.Last)) {
            return;
        }
        if (touch === Touch.First) {
            if (item === this._head) {
                return;
            }
            const next = item.next;
            const previous = item.previous;
            // Unlink the item
            if (item === this._tail) {
                // previous must be defined since item was not head but is tail
                // So there are more than on item in the map
                previous.next = undefined;
                this._tail = previous;
            }
            else {
                // Both next and previous are not undefined since item was neither head nor tail.
                next.previous = previous;
                previous.next = next;
            }
            // Insert the node at head
            item.previous = undefined;
            item.next = this._head;
            this._head.previous = item;
            this._head = item;
            this._state++;
        }
        else if (touch === Touch.Last) {
            if (item === this._tail) {
                return;
            }
            const next = item.next;
            const previous = item.previous;
            // Unlink the item.
            if (item === this._head) {
                // next must be defined since item was not tail but is head
                // So there are more than on item in the map
                next.previous = undefined;
                this._head = next;
            }
            else {
                // Both next and previous are not undefined since item was neither head nor tail.
                next.previous = previous;
                previous.next = next;
            }
            item.next = undefined;
            item.previous = this._tail;
            this._tail.next = item;
            this._tail = item;
            this._state++;
        }
    }
    toJSON() {
        const data = [];
        this.forEach((value, key) => {
            data.push([key, value]);
        });
        return data;
    }
    fromJSON(data) {
        this.clear();
        for (const [key, value] of data) {
            this.set(key, value);
        }
    }
}
exports.LinkedMap = LinkedMap;
class LRUCache extends LinkedMap {
    constructor(limit, ratio = 1) {
        super();
        this._limit = limit;
        this._ratio = Math.min(Math.max(0, ratio), 1);
    }
    get limit() {
        return this._limit;
    }
    set limit(limit) {
        this._limit = limit;
        this.checkTrim();
    }
    get ratio() {
        return this._ratio;
    }
    set ratio(ratio) {
        this._ratio = Math.min(Math.max(0, ratio), 1);
        this.checkTrim();
    }
    get(key, touch = Touch.AsNew) {
        return super.get(key, touch);
    }
    peek(key) {
        return super.get(key, Touch.None);
    }
    set(key, value) {
        super.set(key, value, Touch.Last);
        this.checkTrim();
        return this;
    }
    checkTrim() {
        if (this.size > this._limit) {
            this.trimOld(Math.round(this._limit * this._ratio));
        }
    }
}
exports.LRUCache = LRUCache;


/***/ },

/***/ 9244
(__unused_webpack_module, exports) {

"use strict";

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.AbstractMessageBuffer = void 0;
const CR = 13;
const LF = 10;
const CRLF = '\r\n';
class AbstractMessageBuffer {
    constructor(encoding = 'utf-8') {
        this._encoding = encoding;
        this._chunks = [];
        this._totalLength = 0;
    }
    get encoding() {
        return this._encoding;
    }
    append(chunk) {
        const toAppend = typeof chunk === 'string' ? this.fromString(chunk, this._encoding) : chunk;
        this._chunks.push(toAppend);
        this._totalLength += toAppend.byteLength;
    }
    tryReadHeaders(lowerCaseKeys = false) {
        if (this._chunks.length === 0) {
            return undefined;
        }
        let state = 0;
        let chunkIndex = 0;
        let offset = 0;
        let chunkBytesRead = 0;
        row: while (chunkIndex < this._chunks.length) {
            const chunk = this._chunks[chunkIndex];
            offset = 0;
            column: while (offset < chunk.length) {
                const value = chunk[offset];
                switch (value) {
                    case CR:
                        switch (state) {
                            case 0:
                                state = 1;
                                break;
                            case 2:
                                state = 3;
                                break;
                            default:
                                state = 0;
                        }
                        break;
                    case LF:
                        switch (state) {
                            case 1:
                                state = 2;
                                break;
                            case 3:
                                state = 4;
                                offset++;
                                break row;
                            default:
                                state = 0;
                        }
                        break;
                    default:
                        state = 0;
                }
                offset++;
            }
            chunkBytesRead += chunk.byteLength;
            chunkIndex++;
        }
        if (state !== 4) {
            return undefined;
        }
        // The buffer contains the two CRLF at the end. So we will
        // have two empty lines after the split at the end as well.
        const buffer = this._read(chunkBytesRead + offset);
        const result = new Map();
        const headers = this.toString(buffer, 'ascii').split(CRLF);
        if (headers.length < 2) {
            return result;
        }
        for (let i = 0; i < headers.length - 2; i++) {
            const header = headers[i];
            const index = header.indexOf(':');
            if (index === -1) {
                throw new Error(`Message header must separate key and value using ':'\n${header}`);
            }
            const key = header.substr(0, index);
            const value = header.substr(index + 1).trim();
            result.set(lowerCaseKeys ? key.toLowerCase() : key, value);
        }
        return result;
    }
    tryReadBody(length) {
        if (this._totalLength < length) {
            return undefined;
        }
        return this._read(length);
    }
    get numberOfBytes() {
        return this._totalLength;
    }
    _read(byteCount) {
        if (byteCount === 0) {
            return this.emptyBuffer();
        }
        if (byteCount > this._totalLength) {
            throw new Error(`Cannot read so many bytes!`);
        }
        if (this._chunks[0].byteLength === byteCount) {
            // super fast path, precisely first chunk must be returned
            const chunk = this._chunks[0];
            this._chunks.shift();
            this._totalLength -= byteCount;
            return this.asNative(chunk);
        }
        if (this._chunks[0].byteLength > byteCount) {
            // fast path, the reading is entirely within the first chunk
            const chunk = this._chunks[0];
            const result = this.asNative(chunk, byteCount);
            this._chunks[0] = chunk.slice(byteCount);
            this._totalLength -= byteCount;
            return result;
        }
        const result = this.allocNative(byteCount);
        let resultOffset = 0;
        let chunkIndex = 0;
        while (byteCount > 0) {
            const chunk = this._chunks[chunkIndex];
            if (chunk.byteLength > byteCount) {
                // this chunk will survive
                const chunkPart = chunk.slice(0, byteCount);
                result.set(chunkPart, resultOffset);
                resultOffset += byteCount;
                this._chunks[chunkIndex] = chunk.slice(byteCount);
                this._totalLength -= byteCount;
                byteCount -= byteCount;
            }
            else {
                // this chunk will be entirely read
                result.set(chunk, resultOffset);
                resultOffset += chunk.byteLength;
                this._chunks.shift();
                this._totalLength -= chunk.byteLength;
                byteCount -= chunk.byteLength;
            }
        }
        return result;
    }
}
exports.AbstractMessageBuffer = AbstractMessageBuffer;


/***/ },

/***/ 9085
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ReadableStreamMessageReader = exports.AbstractMessageReader = exports.MessageReader = void 0;
const ral_1 = __webpack_require__(9590);
const Is = __webpack_require__(8585);
const events_1 = __webpack_require__(2676);
const semaphore_1 = __webpack_require__(4323);
var MessageReader;
(function (MessageReader) {
    function is(value) {
        let candidate = value;
        return candidate && Is.func(candidate.listen) && Is.func(candidate.dispose) &&
            Is.func(candidate.onError) && Is.func(candidate.onClose) && Is.func(candidate.onPartialMessage);
    }
    MessageReader.is = is;
})(MessageReader || (exports.MessageReader = MessageReader = {}));
class AbstractMessageReader {
    constructor() {
        this.errorEmitter = new events_1.Emitter();
        this.closeEmitter = new events_1.Emitter();
        this.partialMessageEmitter = new events_1.Emitter();
    }
    dispose() {
        this.errorEmitter.dispose();
        this.closeEmitter.dispose();
    }
    get onError() {
        return this.errorEmitter.event;
    }
    fireError(error) {
        this.errorEmitter.fire(this.asError(error));
    }
    get onClose() {
        return this.closeEmitter.event;
    }
    fireClose() {
        this.closeEmitter.fire(undefined);
    }
    get onPartialMessage() {
        return this.partialMessageEmitter.event;
    }
    firePartialMessage(info) {
        this.partialMessageEmitter.fire(info);
    }
    asError(error) {
        if (error instanceof Error) {
            return error;
        }
        else {
            return new Error(`Reader received error. Reason: ${Is.string(error.message) ? error.message : 'unknown'}`);
        }
    }
}
exports.AbstractMessageReader = AbstractMessageReader;
var ResolvedMessageReaderOptions;
(function (ResolvedMessageReaderOptions) {
    function fromOptions(options) {
        let charset;
        let result;
        let contentDecoder;
        const contentDecoders = new Map();
        let contentTypeDecoder;
        const contentTypeDecoders = new Map();
        if (options === undefined || typeof options === 'string') {
            charset = options ?? 'utf-8';
        }
        else {
            charset = options.charset ?? 'utf-8';
            if (options.contentDecoder !== undefined) {
                contentDecoder = options.contentDecoder;
                contentDecoders.set(contentDecoder.name, contentDecoder);
            }
            if (options.contentDecoders !== undefined) {
                for (const decoder of options.contentDecoders) {
                    contentDecoders.set(decoder.name, decoder);
                }
            }
            if (options.contentTypeDecoder !== undefined) {
                contentTypeDecoder = options.contentTypeDecoder;
                contentTypeDecoders.set(contentTypeDecoder.name, contentTypeDecoder);
            }
            if (options.contentTypeDecoders !== undefined) {
                for (const decoder of options.contentTypeDecoders) {
                    contentTypeDecoders.set(decoder.name, decoder);
                }
            }
        }
        if (contentTypeDecoder === undefined) {
            contentTypeDecoder = (0, ral_1.default)().applicationJson.decoder;
            contentTypeDecoders.set(contentTypeDecoder.name, contentTypeDecoder);
        }
        return { charset, contentDecoder, contentDecoders, contentTypeDecoder, contentTypeDecoders };
    }
    ResolvedMessageReaderOptions.fromOptions = fromOptions;
})(ResolvedMessageReaderOptions || (ResolvedMessageReaderOptions = {}));
class ReadableStreamMessageReader extends AbstractMessageReader {
    constructor(readable, options) {
        super();
        this.readable = readable;
        this.options = ResolvedMessageReaderOptions.fromOptions(options);
        this.buffer = (0, ral_1.default)().messageBuffer.create(this.options.charset);
        this._partialMessageTimeout = 10000;
        this.nextMessageLength = -1;
        this.messageToken = 0;
        this.readSemaphore = new semaphore_1.Semaphore(1);
    }
    set partialMessageTimeout(timeout) {
        this._partialMessageTimeout = timeout;
    }
    get partialMessageTimeout() {
        return this._partialMessageTimeout;
    }
    listen(callback) {
        this.nextMessageLength = -1;
        this.messageToken = 0;
        this.partialMessageTimer = undefined;
        this.callback = callback;
        const result = this.readable.onData((data) => {
            this.onData(data);
        });
        this.readable.onError((error) => this.fireError(error));
        this.readable.onClose(() => this.fireClose());
        return result;
    }
    onData(data) {
        try {
            this.buffer.append(data);
            while (true) {
                if (this.nextMessageLength === -1) {
                    const headers = this.buffer.tryReadHeaders(true);
                    if (!headers) {
                        return;
                    }
                    const contentLength = headers.get('content-length');
                    if (!contentLength) {
                        this.fireError(new Error(`Header must provide a Content-Length property.\n${JSON.stringify(Object.fromEntries(headers))}`));
                        return;
                    }
                    const length = parseInt(contentLength);
                    if (isNaN(length)) {
                        this.fireError(new Error(`Content-Length value must be a number. Got ${contentLength}`));
                        return;
                    }
                    this.nextMessageLength = length;
                }
                const body = this.buffer.tryReadBody(this.nextMessageLength);
                if (body === undefined) {
                    /** We haven't received the full message yet. */
                    this.setPartialMessageTimer();
                    return;
                }
                this.clearPartialMessageTimer();
                this.nextMessageLength = -1;
                // Make sure that we convert one received message after the
                // other. Otherwise it could happen that a decoding of a second
                // smaller message finished before the decoding of a first larger
                // message and then we would deliver the second message first.
                this.readSemaphore.lock(async () => {
                    const bytes = this.options.contentDecoder !== undefined
                        ? await this.options.contentDecoder.decode(body)
                        : body;
                    const message = await this.options.contentTypeDecoder.decode(bytes, this.options);
                    this.callback(message);
                }).catch((error) => {
                    this.fireError(error);
                });
            }
        }
        catch (error) {
            this.fireError(error);
        }
    }
    clearPartialMessageTimer() {
        if (this.partialMessageTimer) {
            this.partialMessageTimer.dispose();
            this.partialMessageTimer = undefined;
        }
    }
    setPartialMessageTimer() {
        this.clearPartialMessageTimer();
        if (this._partialMessageTimeout <= 0) {
            return;
        }
        this.partialMessageTimer = (0, ral_1.default)().timer.setTimeout((token, timeout) => {
            this.partialMessageTimer = undefined;
            if (token === this.messageToken) {
                this.firePartialMessage({ messageToken: token, waitingTime: timeout });
                this.setPartialMessageTimer();
            }
        }, this._partialMessageTimeout, this.messageToken, this._partialMessageTimeout);
    }
}
exports.ReadableStreamMessageReader = ReadableStreamMessageReader;


/***/ },

/***/ 3193
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.WriteableStreamMessageWriter = exports.AbstractMessageWriter = exports.MessageWriter = void 0;
const ral_1 = __webpack_require__(9590);
const Is = __webpack_require__(8585);
const semaphore_1 = __webpack_require__(4323);
const events_1 = __webpack_require__(2676);
const ContentLength = 'Content-Length: ';
const CRLF = '\r\n';
var MessageWriter;
(function (MessageWriter) {
    function is(value) {
        let candidate = value;
        return candidate && Is.func(candidate.dispose) && Is.func(candidate.onClose) &&
            Is.func(candidate.onError) && Is.func(candidate.write);
    }
    MessageWriter.is = is;
})(MessageWriter || (exports.MessageWriter = MessageWriter = {}));
class AbstractMessageWriter {
    constructor() {
        this.errorEmitter = new events_1.Emitter();
        this.closeEmitter = new events_1.Emitter();
    }
    dispose() {
        this.errorEmitter.dispose();
        this.closeEmitter.dispose();
    }
    get onError() {
        return this.errorEmitter.event;
    }
    fireError(error, message, count) {
        this.errorEmitter.fire([this.asError(error), message, count]);
    }
    get onClose() {
        return this.closeEmitter.event;
    }
    fireClose() {
        this.closeEmitter.fire(undefined);
    }
    asError(error) {
        if (error instanceof Error) {
            return error;
        }
        else {
            return new Error(`Writer received error. Reason: ${Is.string(error.message) ? error.message : 'unknown'}`);
        }
    }
}
exports.AbstractMessageWriter = AbstractMessageWriter;
var ResolvedMessageWriterOptions;
(function (ResolvedMessageWriterOptions) {
    function fromOptions(options) {
        if (options === undefined || typeof options === 'string') {
            return { charset: options ?? 'utf-8', contentTypeEncoder: (0, ral_1.default)().applicationJson.encoder };
        }
        else {
            return { charset: options.charset ?? 'utf-8', contentEncoder: options.contentEncoder, contentTypeEncoder: options.contentTypeEncoder ?? (0, ral_1.default)().applicationJson.encoder };
        }
    }
    ResolvedMessageWriterOptions.fromOptions = fromOptions;
})(ResolvedMessageWriterOptions || (ResolvedMessageWriterOptions = {}));
class WriteableStreamMessageWriter extends AbstractMessageWriter {
    constructor(writable, options) {
        super();
        this.writable = writable;
        this.options = ResolvedMessageWriterOptions.fromOptions(options);
        this.errorCount = 0;
        this.writeSemaphore = new semaphore_1.Semaphore(1);
        this.writable.onError((error) => this.fireError(error));
        this.writable.onClose(() => this.fireClose());
    }
    async write(msg) {
        return this.writeSemaphore.lock(async () => {
            const payload = this.options.contentTypeEncoder.encode(msg, this.options).then((buffer) => {
                if (this.options.contentEncoder !== undefined) {
                    return this.options.contentEncoder.encode(buffer);
                }
                else {
                    return buffer;
                }
            });
            return payload.then((buffer) => {
                const headers = [];
                headers.push(ContentLength, buffer.byteLength.toString(), CRLF);
                headers.push(CRLF);
                return this.doWrite(msg, headers, buffer);
            }, (error) => {
                this.fireError(error);
                throw error;
            });
        });
    }
    async doWrite(msg, headers, data) {
        try {
            await this.writable.write(headers.join(''), 'ascii');
            return this.writable.write(data);
        }
        catch (error) {
            this.handleError(error, msg);
            return Promise.reject(error);
        }
    }
    handleError(error, msg) {
        this.errorCount++;
        this.fireError(error, msg, this.errorCount);
    }
    end() {
        this.writable.end();
    }
}
exports.WriteableStreamMessageWriter = WriteableStreamMessageWriter;


/***/ },

/***/ 6177
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.Message = exports.NotificationType9 = exports.NotificationType8 = exports.NotificationType7 = exports.NotificationType6 = exports.NotificationType5 = exports.NotificationType4 = exports.NotificationType3 = exports.NotificationType2 = exports.NotificationType1 = exports.NotificationType0 = exports.NotificationType = exports.RequestType9 = exports.RequestType8 = exports.RequestType7 = exports.RequestType6 = exports.RequestType5 = exports.RequestType4 = exports.RequestType3 = exports.RequestType2 = exports.RequestType1 = exports.RequestType = exports.RequestType0 = exports.AbstractMessageSignature = exports.ParameterStructures = exports.ResponseError = exports.ErrorCodes = void 0;
const is = __webpack_require__(8585);
/**
 * Predefined error codes.
 */
var ErrorCodes;
(function (ErrorCodes) {
    // Defined by JSON RPC
    ErrorCodes.ParseError = -32700;
    ErrorCodes.InvalidRequest = -32600;
    ErrorCodes.MethodNotFound = -32601;
    ErrorCodes.InvalidParams = -32602;
    ErrorCodes.InternalError = -32603;
    /**
     * This is the start range of JSON RPC reserved error codes.
     * It doesn't denote a real error code. No application error codes should
     * be defined between the start and end range. For backwards
     * compatibility the `ServerNotInitialized` and the `UnknownErrorCode`
     * are left in the range.
     *
     * @since 3.16.0
    */
    ErrorCodes.jsonrpcReservedErrorRangeStart = -32099;
    /** @deprecated use  jsonrpcReservedErrorRangeStart */
    ErrorCodes.serverErrorStart = -32099;
    /**
     * An error occurred when write a message to the transport layer.
     */
    ErrorCodes.MessageWriteError = -32099;
    /**
     * An error occurred when reading a message from the transport layer.
     */
    ErrorCodes.MessageReadError = -32098;
    /**
     * The connection got disposed or lost and all pending responses got
     * rejected.
     */
    ErrorCodes.PendingResponseRejected = -32097;
    /**
     * The connection is inactive and a use of it failed.
     */
    ErrorCodes.ConnectionInactive = -32096;
    /**
     * Error code indicating that a server received a notification or
     * request before the server has received the `initialize` request.
     */
    ErrorCodes.ServerNotInitialized = -32002;
    ErrorCodes.UnknownErrorCode = -32001;
    /**
     * This is the end range of JSON RPC reserved error codes.
     * It doesn't denote a real error code.
     *
     * @since 3.16.0
    */
    ErrorCodes.jsonrpcReservedErrorRangeEnd = -32000;
    /** @deprecated use  jsonrpcReservedErrorRangeEnd */
    ErrorCodes.serverErrorEnd = -32000;
})(ErrorCodes || (exports.ErrorCodes = ErrorCodes = {}));
/**
 * An error object return in a response in case a request
 * has failed.
 */
class ResponseError extends Error {
    constructor(code, message, data) {
        super(message);
        this.code = is.number(code) ? code : ErrorCodes.UnknownErrorCode;
        this.data = data;
        Object.setPrototypeOf(this, ResponseError.prototype);
    }
    toJson() {
        const result = {
            code: this.code,
            message: this.message
        };
        if (this.data !== undefined) {
            result.data = this.data;
        }
        return result;
    }
}
exports.ResponseError = ResponseError;
class ParameterStructures {
    constructor(kind) {
        this.kind = kind;
    }
    static is(value) {
        return value === ParameterStructures.auto || value === ParameterStructures.byName || value === ParameterStructures.byPosition;
    }
    toString() {
        return this.kind;
    }
}
exports.ParameterStructures = ParameterStructures;
/**
 * The parameter structure is automatically inferred on the number of parameters
 * and the parameter type in case of a single param.
 */
ParameterStructures.auto = new ParameterStructures('auto');
/**
 * Forces `byPosition` parameter structure. This is useful if you have a single
 * parameter which has a literal type.
 */
ParameterStructures.byPosition = new ParameterStructures('byPosition');
/**
 * Forces `byName` parameter structure. This is only useful when having a single
 * parameter. The library will report errors if used with a different number of
 * parameters.
 */
ParameterStructures.byName = new ParameterStructures('byName');
/**
 * An abstract implementation of a MessageType.
 */
class AbstractMessageSignature {
    constructor(method, numberOfParams) {
        this.method = method;
        this.numberOfParams = numberOfParams;
    }
    get parameterStructures() {
        return ParameterStructures.auto;
    }
}
exports.AbstractMessageSignature = AbstractMessageSignature;
/**
 * Classes to type request response pairs
 */
class RequestType0 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 0);
    }
}
exports.RequestType0 = RequestType0;
class RequestType extends AbstractMessageSignature {
    constructor(method, _parameterStructures = ParameterStructures.auto) {
        super(method, 1);
        this._parameterStructures = _parameterStructures;
    }
    get parameterStructures() {
        return this._parameterStructures;
    }
}
exports.RequestType = RequestType;
class RequestType1 extends AbstractMessageSignature {
    constructor(method, _parameterStructures = ParameterStructures.auto) {
        super(method, 1);
        this._parameterStructures = _parameterStructures;
    }
    get parameterStructures() {
        return this._parameterStructures;
    }
}
exports.RequestType1 = RequestType1;
class RequestType2 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 2);
    }
}
exports.RequestType2 = RequestType2;
class RequestType3 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 3);
    }
}
exports.RequestType3 = RequestType3;
class RequestType4 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 4);
    }
}
exports.RequestType4 = RequestType4;
class RequestType5 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 5);
    }
}
exports.RequestType5 = RequestType5;
class RequestType6 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 6);
    }
}
exports.RequestType6 = RequestType6;
class RequestType7 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 7);
    }
}
exports.RequestType7 = RequestType7;
class RequestType8 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 8);
    }
}
exports.RequestType8 = RequestType8;
class RequestType9 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 9);
    }
}
exports.RequestType9 = RequestType9;
class NotificationType extends AbstractMessageSignature {
    constructor(method, _parameterStructures = ParameterStructures.auto) {
        super(method, 1);
        this._parameterStructures = _parameterStructures;
    }
    get parameterStructures() {
        return this._parameterStructures;
    }
}
exports.NotificationType = NotificationType;
class NotificationType0 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 0);
    }
}
exports.NotificationType0 = NotificationType0;
class NotificationType1 extends AbstractMessageSignature {
    constructor(method, _parameterStructures = ParameterStructures.auto) {
        super(method, 1);
        this._parameterStructures = _parameterStructures;
    }
    get parameterStructures() {
        return this._parameterStructures;
    }
}
exports.NotificationType1 = NotificationType1;
class NotificationType2 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 2);
    }
}
exports.NotificationType2 = NotificationType2;
class NotificationType3 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 3);
    }
}
exports.NotificationType3 = NotificationType3;
class NotificationType4 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 4);
    }
}
exports.NotificationType4 = NotificationType4;
class NotificationType5 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 5);
    }
}
exports.NotificationType5 = NotificationType5;
class NotificationType6 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 6);
    }
}
exports.NotificationType6 = NotificationType6;
class NotificationType7 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 7);
    }
}
exports.NotificationType7 = NotificationType7;
class NotificationType8 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 8);
    }
}
exports.NotificationType8 = NotificationType8;
class NotificationType9 extends AbstractMessageSignature {
    constructor(method) {
        super(method, 9);
    }
}
exports.NotificationType9 = NotificationType9;
var Message;
(function (Message) {
    /**
     * Tests if the given message is a request message
     */
    function isRequest(message) {
        const candidate = message;
        return candidate && is.string(candidate.method) && (is.string(candidate.id) || is.number(candidate.id));
    }
    Message.isRequest = isRequest;
    /**
     * Tests if the given message is a notification message
     */
    function isNotification(message) {
        const candidate = message;
        return candidate && is.string(candidate.method) && message.id === void 0;
    }
    Message.isNotification = isNotification;
    /**
     * Tests if the given message is a response message
     */
    function isResponse(message) {
        const candidate = message;
        return candidate && (candidate.result !== void 0 || !!candidate.error) && (is.string(candidate.id) || is.number(candidate.id) || candidate.id === null);
    }
    Message.isResponse = isResponse;
})(Message || (exports.Message = Message = {}));


/***/ },

/***/ 9590
(__unused_webpack_module, exports) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
let _ral;
function RAL() {
    if (_ral === undefined) {
        throw new Error(`No runtime abstraction layer installed`);
    }
    return _ral;
}
(function (RAL) {
    function install(ral) {
        if (ral === undefined) {
            throw new Error(`No runtime abstraction layer provided`);
        }
        _ral = ral;
    }
    RAL.install = install;
})(RAL || (RAL = {}));
exports["default"] = RAL;


/***/ },

/***/ 4323
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.Semaphore = void 0;
const ral_1 = __webpack_require__(9590);
class Semaphore {
    constructor(capacity = 1) {
        if (capacity <= 0) {
            throw new Error('Capacity must be greater than 0');
        }
        this._capacity = capacity;
        this._active = 0;
        this._waiting = [];
    }
    lock(thunk) {
        return new Promise((resolve, reject) => {
            this._waiting.push({ thunk, resolve, reject });
            this.runNext();
        });
    }
    get active() {
        return this._active;
    }
    runNext() {
        if (this._waiting.length === 0 || this._active === this._capacity) {
            return;
        }
        (0, ral_1.default)().timer.setImmediate(() => this.doRunNext());
    }
    doRunNext() {
        if (this._waiting.length === 0 || this._active === this._capacity) {
            return;
        }
        const next = this._waiting.shift();
        this._active++;
        if (this._active > this._capacity) {
            throw new Error(`To many thunks active`);
        }
        try {
            const result = next.thunk();
            if (result instanceof Promise) {
                result.then((value) => {
                    this._active--;
                    next.resolve(value);
                    this.runNext();
                }, (err) => {
                    this._active--;
                    next.reject(err);
                    this.runNext();
                });
            }
            else {
                this._active--;
                next.resolve(result);
                this.runNext();
            }
        }
        catch (err) {
            this._active--;
            next.reject(err);
            this.runNext();
        }
    }
}
exports.Semaphore = Semaphore;


/***/ },

/***/ 4996
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SharedArrayReceiverStrategy = exports.SharedArraySenderStrategy = void 0;
const cancellation_1 = __webpack_require__(9850);
var CancellationState;
(function (CancellationState) {
    CancellationState.Continue = 0;
    CancellationState.Cancelled = 1;
})(CancellationState || (CancellationState = {}));
class SharedArraySenderStrategy {
    constructor() {
        this.buffers = new Map();
    }
    enableCancellation(request) {
        if (request.id === null) {
            return;
        }
        const buffer = new SharedArrayBuffer(4);
        const data = new Int32Array(buffer, 0, 1);
        data[0] = CancellationState.Continue;
        this.buffers.set(request.id, buffer);
        request.$cancellationData = buffer;
    }
    async sendCancellation(_conn, id) {
        const buffer = this.buffers.get(id);
        if (buffer === undefined) {
            return;
        }
        const data = new Int32Array(buffer, 0, 1);
        Atomics.store(data, 0, CancellationState.Cancelled);
    }
    cleanup(id) {
        this.buffers.delete(id);
    }
    dispose() {
        this.buffers.clear();
    }
}
exports.SharedArraySenderStrategy = SharedArraySenderStrategy;
class SharedArrayBufferCancellationToken {
    constructor(buffer) {
        this.data = new Int32Array(buffer, 0, 1);
    }
    get isCancellationRequested() {
        return Atomics.load(this.data, 0) === CancellationState.Cancelled;
    }
    get onCancellationRequested() {
        throw new Error(`Cancellation over SharedArrayBuffer doesn't support cancellation events`);
    }
}
class SharedArrayBufferCancellationTokenSource {
    constructor(buffer) {
        this.token = new SharedArrayBufferCancellationToken(buffer);
    }
    cancel() {
    }
    dispose() {
    }
}
class SharedArrayReceiverStrategy {
    constructor() {
        this.kind = 'request';
    }
    createCancellationTokenSource(request) {
        const buffer = request.$cancellationData;
        if (buffer === undefined) {
            return new cancellation_1.CancellationTokenSource();
        }
        return new SharedArrayBufferCancellationTokenSource(buffer);
    }
}
exports.SharedArrayReceiverStrategy = SharedArrayReceiverStrategy;


/***/ },

/***/ 7123
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.createMessageConnection = exports.createServerSocketTransport = exports.createClientSocketTransport = exports.createServerPipeTransport = exports.createClientPipeTransport = exports.generateRandomPipeName = exports.StreamMessageWriter = exports.StreamMessageReader = exports.SocketMessageWriter = exports.SocketMessageReader = exports.PortMessageWriter = exports.PortMessageReader = exports.IPCMessageWriter = exports.IPCMessageReader = void 0;
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ----------------------------------------------------------------------------------------- */
const ril_1 = __webpack_require__(9571);
// Install the node runtime abstract.
ril_1.default.install();
const path = __webpack_require__(2003);
const os = __webpack_require__(9366);
const crypto_1 = __webpack_require__(8749);
const net_1 = __webpack_require__(2135);
const api_1 = __webpack_require__(3281);
__exportStar(__webpack_require__(3281), exports);
class IPCMessageReader extends api_1.AbstractMessageReader {
    constructor(process) {
        super();
        this.process = process;
        let eventEmitter = this.process;
        eventEmitter.on('error', (error) => this.fireError(error));
        eventEmitter.on('close', () => this.fireClose());
    }
    listen(callback) {
        this.process.on('message', callback);
        return api_1.Disposable.create(() => this.process.off('message', callback));
    }
}
exports.IPCMessageReader = IPCMessageReader;
class IPCMessageWriter extends api_1.AbstractMessageWriter {
    constructor(process) {
        super();
        this.process = process;
        this.errorCount = 0;
        const eventEmitter = this.process;
        eventEmitter.on('error', (error) => this.fireError(error));
        eventEmitter.on('close', () => this.fireClose);
    }
    write(msg) {
        try {
            if (typeof this.process.send === 'function') {
                this.process.send(msg, undefined, undefined, (error) => {
                    if (error) {
                        this.errorCount++;
                        this.handleError(error, msg);
                    }
                    else {
                        this.errorCount = 0;
                    }
                });
            }
            return Promise.resolve();
        }
        catch (error) {
            this.handleError(error, msg);
            return Promise.reject(error);
        }
    }
    handleError(error, msg) {
        this.errorCount++;
        this.fireError(error, msg, this.errorCount);
    }
    end() {
    }
}
exports.IPCMessageWriter = IPCMessageWriter;
class PortMessageReader extends api_1.AbstractMessageReader {
    constructor(port) {
        super();
        this.onData = new api_1.Emitter;
        port.on('close', () => this.fireClose);
        port.on('error', (error) => this.fireError(error));
        port.on('message', (message) => {
            this.onData.fire(message);
        });
    }
    listen(callback) {
        return this.onData.event(callback);
    }
}
exports.PortMessageReader = PortMessageReader;
class PortMessageWriter extends api_1.AbstractMessageWriter {
    constructor(port) {
        super();
        this.port = port;
        this.errorCount = 0;
        port.on('close', () => this.fireClose());
        port.on('error', (error) => this.fireError(error));
    }
    write(msg) {
        try {
            this.port.postMessage(msg);
            return Promise.resolve();
        }
        catch (error) {
            this.handleError(error, msg);
            return Promise.reject(error);
        }
    }
    handleError(error, msg) {
        this.errorCount++;
        this.fireError(error, msg, this.errorCount);
    }
    end() {
    }
}
exports.PortMessageWriter = PortMessageWriter;
class SocketMessageReader extends api_1.ReadableStreamMessageReader {
    constructor(socket, encoding = 'utf-8') {
        super((0, ril_1.default)().stream.asReadableStream(socket), encoding);
    }
}
exports.SocketMessageReader = SocketMessageReader;
class SocketMessageWriter extends api_1.WriteableStreamMessageWriter {
    constructor(socket, options) {
        super((0, ril_1.default)().stream.asWritableStream(socket), options);
        this.socket = socket;
    }
    dispose() {
        super.dispose();
        this.socket.destroy();
    }
}
exports.SocketMessageWriter = SocketMessageWriter;
class StreamMessageReader extends api_1.ReadableStreamMessageReader {
    constructor(readable, encoding) {
        super((0, ril_1.default)().stream.asReadableStream(readable), encoding);
    }
}
exports.StreamMessageReader = StreamMessageReader;
class StreamMessageWriter extends api_1.WriteableStreamMessageWriter {
    constructor(writable, options) {
        super((0, ril_1.default)().stream.asWritableStream(writable), options);
    }
}
exports.StreamMessageWriter = StreamMessageWriter;
const XDG_RUNTIME_DIR = process.env['XDG_RUNTIME_DIR'];
const safeIpcPathLengths = new Map([
    ['linux', 107],
    ['darwin', 103]
]);
function generateRandomPipeName() {
    const randomSuffix = (0, crypto_1.randomBytes)(21).toString('hex');
    if (process.platform === 'win32') {
        return `\\\\.\\pipe\\vscode-jsonrpc-${randomSuffix}-sock`;
    }
    let result;
    if (XDG_RUNTIME_DIR) {
        result = path.join(XDG_RUNTIME_DIR, `vscode-ipc-${randomSuffix}.sock`);
    }
    else {
        result = path.join(os.tmpdir(), `vscode-${randomSuffix}.sock`);
    }
    const limit = safeIpcPathLengths.get(process.platform);
    if (limit !== undefined && result.length > limit) {
        (0, ril_1.default)().console.warn(`WARNING: IPC handle "${result}" is longer than ${limit} characters.`);
    }
    return result;
}
exports.generateRandomPipeName = generateRandomPipeName;
function createClientPipeTransport(pipeName, encoding = 'utf-8') {
    let connectResolve;
    const connected = new Promise((resolve, _reject) => {
        connectResolve = resolve;
    });
    return new Promise((resolve, reject) => {
        let server = (0, net_1.createServer)((socket) => {
            server.close();
            connectResolve([
                new SocketMessageReader(socket, encoding),
                new SocketMessageWriter(socket, encoding)
            ]);
        });
        server.on('error', reject);
        server.listen(pipeName, () => {
            server.removeListener('error', reject);
            resolve({
                onConnected: () => { return connected; }
            });
        });
    });
}
exports.createClientPipeTransport = createClientPipeTransport;
function createServerPipeTransport(pipeName, encoding = 'utf-8') {
    const socket = (0, net_1.createConnection)(pipeName);
    return [
        new SocketMessageReader(socket, encoding),
        new SocketMessageWriter(socket, encoding)
    ];
}
exports.createServerPipeTransport = createServerPipeTransport;
function createClientSocketTransport(port, encoding = 'utf-8') {
    let connectResolve;
    const connected = new Promise((resolve, _reject) => {
        connectResolve = resolve;
    });
    return new Promise((resolve, reject) => {
        const server = (0, net_1.createServer)((socket) => {
            server.close();
            connectResolve([
                new SocketMessageReader(socket, encoding),
                new SocketMessageWriter(socket, encoding)
            ]);
        });
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve({
                onConnected: () => { return connected; }
            });
        });
    });
}
exports.createClientSocketTransport = createClientSocketTransport;
function createServerSocketTransport(port, encoding = 'utf-8') {
    const socket = (0, net_1.createConnection)(port, '127.0.0.1');
    return [
        new SocketMessageReader(socket, encoding),
        new SocketMessageWriter(socket, encoding)
    ];
}
exports.createServerSocketTransport = createServerSocketTransport;
function isReadableStream(value) {
    const candidate = value;
    return candidate.read !== undefined && candidate.addListener !== undefined;
}
function isWritableStream(value) {
    const candidate = value;
    return candidate.write !== undefined && candidate.addListener !== undefined;
}
function createMessageConnection(input, output, logger, options) {
    if (!logger) {
        logger = api_1.NullLogger;
    }
    const reader = isReadableStream(input) ? new StreamMessageReader(input) : input;
    const writer = isWritableStream(output) ? new StreamMessageWriter(output) : output;
    if (api_1.ConnectionStrategy.is(options)) {
        options = { connectionStrategy: options };
    }
    return (0, api_1.createMessageConnection)(reader, writer, logger, options);
}
exports.createMessageConnection = createMessageConnection;


/***/ },

/***/ 9571
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
const util_1 = __webpack_require__(2460);
const api_1 = __webpack_require__(3281);
class MessageBuffer extends api_1.AbstractMessageBuffer {
    constructor(encoding = 'utf-8') {
        super(encoding);
    }
    emptyBuffer() {
        return MessageBuffer.emptyBuffer;
    }
    fromString(value, encoding) {
        return Buffer.from(value, encoding);
    }
    toString(value, encoding) {
        if (value instanceof Buffer) {
            return value.toString(encoding);
        }
        else {
            return new util_1.TextDecoder(encoding).decode(value);
        }
    }
    asNative(buffer, length) {
        if (length === undefined) {
            return buffer instanceof Buffer ? buffer : Buffer.from(buffer);
        }
        else {
            return buffer instanceof Buffer ? buffer.slice(0, length) : Buffer.from(buffer, 0, length);
        }
    }
    allocNative(length) {
        return Buffer.allocUnsafe(length);
    }
}
MessageBuffer.emptyBuffer = Buffer.allocUnsafe(0);
class ReadableStreamWrapper {
    constructor(stream) {
        this.stream = stream;
    }
    onClose(listener) {
        this.stream.on('close', listener);
        return api_1.Disposable.create(() => this.stream.off('close', listener));
    }
    onError(listener) {
        this.stream.on('error', listener);
        return api_1.Disposable.create(() => this.stream.off('error', listener));
    }
    onEnd(listener) {
        this.stream.on('end', listener);
        return api_1.Disposable.create(() => this.stream.off('end', listener));
    }
    onData(listener) {
        this.stream.on('data', listener);
        return api_1.Disposable.create(() => this.stream.off('data', listener));
    }
}
class WritableStreamWrapper {
    constructor(stream) {
        this.stream = stream;
    }
    onClose(listener) {
        this.stream.on('close', listener);
        return api_1.Disposable.create(() => this.stream.off('close', listener));
    }
    onError(listener) {
        this.stream.on('error', listener);
        return api_1.Disposable.create(() => this.stream.off('error', listener));
    }
    onEnd(listener) {
        this.stream.on('end', listener);
        return api_1.Disposable.create(() => this.stream.off('end', listener));
    }
    write(data, encoding) {
        return new Promise((resolve, reject) => {
            const callback = (error) => {
                if (error === undefined || error === null) {
                    resolve();
                }
                else {
                    reject(error);
                }
            };
            if (typeof data === 'string') {
                this.stream.write(data, encoding, callback);
            }
            else {
                this.stream.write(data, callback);
            }
        });
    }
    end() {
        this.stream.end();
    }
}
const _ril = Object.freeze({
    messageBuffer: Object.freeze({
        create: (encoding) => new MessageBuffer(encoding)
    }),
    applicationJson: Object.freeze({
        encoder: Object.freeze({
            name: 'application/json',
            encode: (msg, options) => {
                try {
                    return Promise.resolve(Buffer.from(JSON.stringify(msg, undefined, 0), options.charset));
                }
                catch (err) {
                    return Promise.reject(err);
                }
            }
        }),
        decoder: Object.freeze({
            name: 'application/json',
            decode: (buffer, options) => {
                try {
                    if (buffer instanceof Buffer) {
                        return Promise.resolve(JSON.parse(buffer.toString(options.charset)));
                    }
                    else {
                        return Promise.resolve(JSON.parse(new util_1.TextDecoder(options.charset).decode(buffer)));
                    }
                }
                catch (err) {
                    return Promise.reject(err);
                }
            }
        })
    }),
    stream: Object.freeze({
        asReadableStream: (stream) => new ReadableStreamWrapper(stream),
        asWritableStream: (stream) => new WritableStreamWrapper(stream)
    }),
    console: console,
    timer: Object.freeze({
        setTimeout(callback, ms, ...args) {
            const handle = setTimeout(callback, ms, ...args);
            return { dispose: () => clearTimeout(handle) };
        },
        setImmediate(callback, ...args) {
            const handle = setImmediate(callback, ...args);
            return { dispose: () => clearImmediate(handle) };
        },
        setInterval(callback, ms, ...args) {
            const handle = setInterval(callback, ms, ...args);
            return { dispose: () => clearInterval(handle) };
        }
    })
});
function RIL() {
    return _ril;
}
(function (RIL) {
    function install() {
        api_1.RAL.install(_ril);
    }
    RIL.install = install;
})(RIL || (RIL = {}));
exports["default"] = RIL;


/***/ },

/***/ 2067
(module, __unused_webpack_exports, __webpack_require__) {

"use strict";
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ----------------------------------------------------------------------------------------- */


module.exports = __webpack_require__(7123);

/***/ },

/***/ 8766
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.LSPErrorCodes = exports.createProtocolConnection = void 0;
__exportStar(__webpack_require__(7123), exports);
__exportStar(__webpack_require__(1145), exports);
__exportStar(__webpack_require__(372), exports);
__exportStar(__webpack_require__(1560), exports);
var connection_1 = __webpack_require__(1580);
Object.defineProperty(exports, "createProtocolConnection", ({ enumerable: true, get: function () { return connection_1.createProtocolConnection; } }));
var LSPErrorCodes;
(function (LSPErrorCodes) {
    /**
    * This is the start range of LSP reserved error codes.
    * It doesn't denote a real error code.
    *
    * @since 3.16.0
    */
    LSPErrorCodes.lspReservedErrorRangeStart = -32899;
    /**
     * A request failed but it was syntactically correct, e.g the
     * method name was known and the parameters were valid. The error
     * message should contain human readable information about why
     * the request failed.
     *
     * @since 3.17.0
     */
    LSPErrorCodes.RequestFailed = -32803;
    /**
     * The server cancelled the request. This error code should
     * only be used for requests that explicitly support being
     * server cancellable.
     *
     * @since 3.17.0
     */
    LSPErrorCodes.ServerCancelled = -32802;
    /**
     * The server detected that the content of a document got
     * modified outside normal conditions. A server should
     * NOT send this error code if it detects a content change
     * in it unprocessed messages. The result even computed
     * on an older state might still be useful for the client.
     *
     * If a client decides that a result is not of any use anymore
     * the client should cancel the request.
     */
    LSPErrorCodes.ContentModified = -32801;
    /**
     * The client has canceled a request and a server as detected
     * the cancel.
     */
    LSPErrorCodes.RequestCancelled = -32800;
    /**
    * This is the end range of LSP reserved error codes.
    * It doesn't denote a real error code.
    *
    * @since 3.16.0
    */
    LSPErrorCodes.lspReservedErrorRangeEnd = -32800;
})(LSPErrorCodes || (exports.LSPErrorCodes = LSPErrorCodes = {}));


/***/ },

/***/ 1580
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.createProtocolConnection = void 0;
const vscode_jsonrpc_1 = __webpack_require__(7123);
function createProtocolConnection(input, output, logger, options) {
    if (vscode_jsonrpc_1.ConnectionStrategy.is(options)) {
        options = { connectionStrategy: options };
    }
    return (0, vscode_jsonrpc_1.createMessageConnection)(input, output, logger, options);
}
exports.createProtocolConnection = createProtocolConnection;


/***/ },

/***/ 372
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ProtocolNotificationType = exports.ProtocolNotificationType0 = exports.ProtocolRequestType = exports.ProtocolRequestType0 = exports.RegistrationType = exports.MessageDirection = void 0;
const vscode_jsonrpc_1 = __webpack_require__(7123);
var MessageDirection;
(function (MessageDirection) {
    MessageDirection["clientToServer"] = "clientToServer";
    MessageDirection["serverToClient"] = "serverToClient";
    MessageDirection["both"] = "both";
})(MessageDirection || (exports.MessageDirection = MessageDirection = {}));
class RegistrationType {
    constructor(method) {
        this.method = method;
    }
}
exports.RegistrationType = RegistrationType;
class ProtocolRequestType0 extends vscode_jsonrpc_1.RequestType0 {
    constructor(method) {
        super(method);
    }
}
exports.ProtocolRequestType0 = ProtocolRequestType0;
class ProtocolRequestType extends vscode_jsonrpc_1.RequestType {
    constructor(method) {
        super(method, vscode_jsonrpc_1.ParameterStructures.byName);
    }
}
exports.ProtocolRequestType = ProtocolRequestType;
class ProtocolNotificationType0 extends vscode_jsonrpc_1.NotificationType0 {
    constructor(method) {
        super(method);
    }
}
exports.ProtocolNotificationType0 = ProtocolNotificationType0;
class ProtocolNotificationType extends vscode_jsonrpc_1.NotificationType {
    constructor(method) {
        super(method, vscode_jsonrpc_1.ParameterStructures.byName);
    }
}
exports.ProtocolNotificationType = ProtocolNotificationType;


/***/ },

/***/ 8765
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) TypeFox, Microsoft and others. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.CallHierarchyOutgoingCallsRequest = exports.CallHierarchyIncomingCallsRequest = exports.CallHierarchyPrepareRequest = void 0;
const messages_1 = __webpack_require__(372);
/**
 * A request to result a `CallHierarchyItem` in a document at a given position.
 * Can be used as an input to an incoming or outgoing call hierarchy.
 *
 * @since 3.16.0
 */
var CallHierarchyPrepareRequest;
(function (CallHierarchyPrepareRequest) {
    CallHierarchyPrepareRequest.method = 'textDocument/prepareCallHierarchy';
    CallHierarchyPrepareRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    CallHierarchyPrepareRequest.type = new messages_1.ProtocolRequestType(CallHierarchyPrepareRequest.method);
})(CallHierarchyPrepareRequest || (exports.CallHierarchyPrepareRequest = CallHierarchyPrepareRequest = {}));
/**
 * A request to resolve the incoming calls for a given `CallHierarchyItem`.
 *
 * @since 3.16.0
 */
var CallHierarchyIncomingCallsRequest;
(function (CallHierarchyIncomingCallsRequest) {
    CallHierarchyIncomingCallsRequest.method = 'callHierarchy/incomingCalls';
    CallHierarchyIncomingCallsRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    CallHierarchyIncomingCallsRequest.type = new messages_1.ProtocolRequestType(CallHierarchyIncomingCallsRequest.method);
})(CallHierarchyIncomingCallsRequest || (exports.CallHierarchyIncomingCallsRequest = CallHierarchyIncomingCallsRequest = {}));
/**
 * A request to resolve the outgoing calls for a given `CallHierarchyItem`.
 *
 * @since 3.16.0
 */
var CallHierarchyOutgoingCallsRequest;
(function (CallHierarchyOutgoingCallsRequest) {
    CallHierarchyOutgoingCallsRequest.method = 'callHierarchy/outgoingCalls';
    CallHierarchyOutgoingCallsRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    CallHierarchyOutgoingCallsRequest.type = new messages_1.ProtocolRequestType(CallHierarchyOutgoingCallsRequest.method);
})(CallHierarchyOutgoingCallsRequest || (exports.CallHierarchyOutgoingCallsRequest = CallHierarchyOutgoingCallsRequest = {}));


/***/ },

/***/ 7672
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ColorPresentationRequest = exports.DocumentColorRequest = void 0;
const messages_1 = __webpack_require__(372);
/**
 * A request to list all color symbols found in a given text document. The request's
 * parameter is of type {@link DocumentColorParams} the
 * response is of type {@link ColorInformation ColorInformation[]} or a Thenable
 * that resolves to such.
 */
var DocumentColorRequest;
(function (DocumentColorRequest) {
    DocumentColorRequest.method = 'textDocument/documentColor';
    DocumentColorRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    DocumentColorRequest.type = new messages_1.ProtocolRequestType(DocumentColorRequest.method);
})(DocumentColorRequest || (exports.DocumentColorRequest = DocumentColorRequest = {}));
/**
 * A request to list all presentation for a color. The request's
 * parameter is of type {@link ColorPresentationParams} the
 * response is of type {@link ColorInformation ColorInformation[]} or a Thenable
 * that resolves to such.
 */
var ColorPresentationRequest;
(function (ColorPresentationRequest) {
    ColorPresentationRequest.method = 'textDocument/colorPresentation';
    ColorPresentationRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    ColorPresentationRequest.type = new messages_1.ProtocolRequestType(ColorPresentationRequest.method);
})(ColorPresentationRequest || (exports.ColorPresentationRequest = ColorPresentationRequest = {}));


/***/ },

/***/ 1660
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ConfigurationRequest = void 0;
const messages_1 = __webpack_require__(372);
//---- Get Configuration request ----
/**
 * The 'workspace/configuration' request is sent from the server to the client to fetch a certain
 * configuration setting.
 *
 * This pull model replaces the old push model were the client signaled configuration change via an
 * event. If the server still needs to react to configuration changes (since the server caches the
 * result of `workspace/configuration` requests) the server should register for an empty configuration
 * change event and empty the cache if such an event is received.
 */
var ConfigurationRequest;
(function (ConfigurationRequest) {
    ConfigurationRequest.method = 'workspace/configuration';
    ConfigurationRequest.messageDirection = messages_1.MessageDirection.serverToClient;
    ConfigurationRequest.type = new messages_1.ProtocolRequestType(ConfigurationRequest.method);
})(ConfigurationRequest || (exports.ConfigurationRequest = ConfigurationRequest = {}));


/***/ },

/***/ 6914
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.DeclarationRequest = void 0;
const messages_1 = __webpack_require__(372);
// @ts-ignore: to avoid inlining LocationLink as dynamic import
let __noDynamicImport;
/**
 * A request to resolve the type definition locations of a symbol at a given text
 * document position. The request's parameter is of type {@link TextDocumentPositionParams}
 * the response is of type {@link Declaration} or a typed array of {@link DeclarationLink}
 * or a Thenable that resolves to such.
 */
var DeclarationRequest;
(function (DeclarationRequest) {
    DeclarationRequest.method = 'textDocument/declaration';
    DeclarationRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    DeclarationRequest.type = new messages_1.ProtocolRequestType(DeclarationRequest.method);
})(DeclarationRequest || (exports.DeclarationRequest = DeclarationRequest = {}));


/***/ },

/***/ 6011
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.DiagnosticRefreshRequest = exports.WorkspaceDiagnosticRequest = exports.DocumentDiagnosticRequest = exports.DocumentDiagnosticReportKind = exports.DiagnosticServerCancellationData = void 0;
const vscode_jsonrpc_1 = __webpack_require__(7123);
const Is = __webpack_require__(8598);
const messages_1 = __webpack_require__(372);
/**
 * @since 3.17.0
 */
var DiagnosticServerCancellationData;
(function (DiagnosticServerCancellationData) {
    function is(value) {
        const candidate = value;
        return candidate && Is.boolean(candidate.retriggerRequest);
    }
    DiagnosticServerCancellationData.is = is;
})(DiagnosticServerCancellationData || (exports.DiagnosticServerCancellationData = DiagnosticServerCancellationData = {}));
/**
 * The document diagnostic report kinds.
 *
 * @since 3.17.0
 */
var DocumentDiagnosticReportKind;
(function (DocumentDiagnosticReportKind) {
    /**
     * A diagnostic report with a full
     * set of problems.
     */
    DocumentDiagnosticReportKind.Full = 'full';
    /**
     * A report indicating that the last
     * returned report is still accurate.
     */
    DocumentDiagnosticReportKind.Unchanged = 'unchanged';
})(DocumentDiagnosticReportKind || (exports.DocumentDiagnosticReportKind = DocumentDiagnosticReportKind = {}));
/**
 * The document diagnostic request definition.
 *
 * @since 3.17.0
 */
var DocumentDiagnosticRequest;
(function (DocumentDiagnosticRequest) {
    DocumentDiagnosticRequest.method = 'textDocument/diagnostic';
    DocumentDiagnosticRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    DocumentDiagnosticRequest.type = new messages_1.ProtocolRequestType(DocumentDiagnosticRequest.method);
    DocumentDiagnosticRequest.partialResult = new vscode_jsonrpc_1.ProgressType();
})(DocumentDiagnosticRequest || (exports.DocumentDiagnosticRequest = DocumentDiagnosticRequest = {}));
/**
 * The workspace diagnostic request definition.
 *
 * @since 3.17.0
 */
var WorkspaceDiagnosticRequest;
(function (WorkspaceDiagnosticRequest) {
    WorkspaceDiagnosticRequest.method = 'workspace/diagnostic';
    WorkspaceDiagnosticRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    WorkspaceDiagnosticRequest.type = new messages_1.ProtocolRequestType(WorkspaceDiagnosticRequest.method);
    WorkspaceDiagnosticRequest.partialResult = new vscode_jsonrpc_1.ProgressType();
})(WorkspaceDiagnosticRequest || (exports.WorkspaceDiagnosticRequest = WorkspaceDiagnosticRequest = {}));
/**
 * The diagnostic refresh request definition.
 *
 * @since 3.17.0
 */
var DiagnosticRefreshRequest;
(function (DiagnosticRefreshRequest) {
    DiagnosticRefreshRequest.method = `workspace/diagnostic/refresh`;
    DiagnosticRefreshRequest.messageDirection = messages_1.MessageDirection.serverToClient;
    DiagnosticRefreshRequest.type = new messages_1.ProtocolRequestType0(DiagnosticRefreshRequest.method);
})(DiagnosticRefreshRequest || (exports.DiagnosticRefreshRequest = DiagnosticRefreshRequest = {}));


/***/ },

/***/ 9840
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.WillDeleteFilesRequest = exports.DidDeleteFilesNotification = exports.DidRenameFilesNotification = exports.WillRenameFilesRequest = exports.DidCreateFilesNotification = exports.WillCreateFilesRequest = exports.FileOperationPatternKind = void 0;
const messages_1 = __webpack_require__(372);
/**
 * A pattern kind describing if a glob pattern matches a file a folder or
 * both.
 *
 * @since 3.16.0
 */
var FileOperationPatternKind;
(function (FileOperationPatternKind) {
    /**
     * The pattern matches a file only.
     */
    FileOperationPatternKind.file = 'file';
    /**
     * The pattern matches a folder only.
     */
    FileOperationPatternKind.folder = 'folder';
})(FileOperationPatternKind || (exports.FileOperationPatternKind = FileOperationPatternKind = {}));
/**
 * The will create files request is sent from the client to the server before files are actually
 * created as long as the creation is triggered from within the client.
 *
 * The request can return a `WorkspaceEdit` which will be applied to workspace before the
 * files are created. Hence the `WorkspaceEdit` can not manipulate the content of the file
 * to be created.
 *
 * @since 3.16.0
 */
var WillCreateFilesRequest;
(function (WillCreateFilesRequest) {
    WillCreateFilesRequest.method = 'workspace/willCreateFiles';
    WillCreateFilesRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    WillCreateFilesRequest.type = new messages_1.ProtocolRequestType(WillCreateFilesRequest.method);
})(WillCreateFilesRequest || (exports.WillCreateFilesRequest = WillCreateFilesRequest = {}));
/**
 * The did create files notification is sent from the client to the server when
 * files were created from within the client.
 *
 * @since 3.16.0
 */
var DidCreateFilesNotification;
(function (DidCreateFilesNotification) {
    DidCreateFilesNotification.method = 'workspace/didCreateFiles';
    DidCreateFilesNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    DidCreateFilesNotification.type = new messages_1.ProtocolNotificationType(DidCreateFilesNotification.method);
})(DidCreateFilesNotification || (exports.DidCreateFilesNotification = DidCreateFilesNotification = {}));
/**
 * The will rename files request is sent from the client to the server before files are actually
 * renamed as long as the rename is triggered from within the client.
 *
 * @since 3.16.0
 */
var WillRenameFilesRequest;
(function (WillRenameFilesRequest) {
    WillRenameFilesRequest.method = 'workspace/willRenameFiles';
    WillRenameFilesRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    WillRenameFilesRequest.type = new messages_1.ProtocolRequestType(WillRenameFilesRequest.method);
})(WillRenameFilesRequest || (exports.WillRenameFilesRequest = WillRenameFilesRequest = {}));
/**
 * The did rename files notification is sent from the client to the server when
 * files were renamed from within the client.
 *
 * @since 3.16.0
 */
var DidRenameFilesNotification;
(function (DidRenameFilesNotification) {
    DidRenameFilesNotification.method = 'workspace/didRenameFiles';
    DidRenameFilesNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    DidRenameFilesNotification.type = new messages_1.ProtocolNotificationType(DidRenameFilesNotification.method);
})(DidRenameFilesNotification || (exports.DidRenameFilesNotification = DidRenameFilesNotification = {}));
/**
 * The will delete files request is sent from the client to the server before files are actually
 * deleted as long as the deletion is triggered from within the client.
 *
 * @since 3.16.0
 */
var DidDeleteFilesNotification;
(function (DidDeleteFilesNotification) {
    DidDeleteFilesNotification.method = 'workspace/didDeleteFiles';
    DidDeleteFilesNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    DidDeleteFilesNotification.type = new messages_1.ProtocolNotificationType(DidDeleteFilesNotification.method);
})(DidDeleteFilesNotification || (exports.DidDeleteFilesNotification = DidDeleteFilesNotification = {}));
/**
 * The did delete files notification is sent from the client to the server when
 * files were deleted from within the client.
 *
 * @since 3.16.0
 */
var WillDeleteFilesRequest;
(function (WillDeleteFilesRequest) {
    WillDeleteFilesRequest.method = 'workspace/willDeleteFiles';
    WillDeleteFilesRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    WillDeleteFilesRequest.type = new messages_1.ProtocolRequestType(WillDeleteFilesRequest.method);
})(WillDeleteFilesRequest || (exports.WillDeleteFilesRequest = WillDeleteFilesRequest = {}));


/***/ },

/***/ 2874
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.FoldingRangeRefreshRequest = exports.FoldingRangeRequest = void 0;
const messages_1 = __webpack_require__(372);
/**
 * A request to provide folding ranges in a document. The request's
 * parameter is of type {@link FoldingRangeParams}, the
 * response is of type {@link FoldingRangeList} or a Thenable
 * that resolves to such.
 */
var FoldingRangeRequest;
(function (FoldingRangeRequest) {
    FoldingRangeRequest.method = 'textDocument/foldingRange';
    FoldingRangeRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    FoldingRangeRequest.type = new messages_1.ProtocolRequestType(FoldingRangeRequest.method);
})(FoldingRangeRequest || (exports.FoldingRangeRequest = FoldingRangeRequest = {}));
/**
 * @since 3.18.0
 * @proposed
 */
var FoldingRangeRefreshRequest;
(function (FoldingRangeRefreshRequest) {
    FoldingRangeRefreshRequest.method = `workspace/foldingRange/refresh`;
    FoldingRangeRefreshRequest.messageDirection = messages_1.MessageDirection.serverToClient;
    FoldingRangeRefreshRequest.type = new messages_1.ProtocolRequestType0(FoldingRangeRefreshRequest.method);
})(FoldingRangeRefreshRequest || (exports.FoldingRangeRefreshRequest = FoldingRangeRefreshRequest = {}));


/***/ },

/***/ 9574
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ImplementationRequest = void 0;
const messages_1 = __webpack_require__(372);
// @ts-ignore: to avoid inlining LocationLink as dynamic import
let __noDynamicImport;
/**
 * A request to resolve the implementation locations of a symbol at a given text
 * document position. The request's parameter is of type {@link TextDocumentPositionParams}
 * the response is of type {@link Definition} or a Thenable that resolves to such.
 */
var ImplementationRequest;
(function (ImplementationRequest) {
    ImplementationRequest.method = 'textDocument/implementation';
    ImplementationRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    ImplementationRequest.type = new messages_1.ProtocolRequestType(ImplementationRequest.method);
})(ImplementationRequest || (exports.ImplementationRequest = ImplementationRequest = {}));


/***/ },

/***/ 7752
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.InlayHintRefreshRequest = exports.InlayHintResolveRequest = exports.InlayHintRequest = void 0;
const messages_1 = __webpack_require__(372);
/**
 * A request to provide inlay hints in a document. The request's parameter is of
 * type {@link InlayHintsParams}, the response is of type
 * {@link InlayHint InlayHint[]} or a Thenable that resolves to such.
 *
 * @since 3.17.0
 */
var InlayHintRequest;
(function (InlayHintRequest) {
    InlayHintRequest.method = 'textDocument/inlayHint';
    InlayHintRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    InlayHintRequest.type = new messages_1.ProtocolRequestType(InlayHintRequest.method);
})(InlayHintRequest || (exports.InlayHintRequest = InlayHintRequest = {}));
/**
 * A request to resolve additional properties for an inlay hint.
 * The request's parameter is of type {@link InlayHint}, the response is
 * of type {@link InlayHint} or a Thenable that resolves to such.
 *
 * @since 3.17.0
 */
var InlayHintResolveRequest;
(function (InlayHintResolveRequest) {
    InlayHintResolveRequest.method = 'inlayHint/resolve';
    InlayHintResolveRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    InlayHintResolveRequest.type = new messages_1.ProtocolRequestType(InlayHintResolveRequest.method);
})(InlayHintResolveRequest || (exports.InlayHintResolveRequest = InlayHintResolveRequest = {}));
/**
 * @since 3.17.0
 */
var InlayHintRefreshRequest;
(function (InlayHintRefreshRequest) {
    InlayHintRefreshRequest.method = `workspace/inlayHint/refresh`;
    InlayHintRefreshRequest.messageDirection = messages_1.MessageDirection.serverToClient;
    InlayHintRefreshRequest.type = new messages_1.ProtocolRequestType0(InlayHintRefreshRequest.method);
})(InlayHintRefreshRequest || (exports.InlayHintRefreshRequest = InlayHintRefreshRequest = {}));


/***/ },

/***/ 3307
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.InlineCompletionRequest = void 0;
const messages_1 = __webpack_require__(372);
/**
 * A request to provide inline completions in a document. The request's parameter is of
 * type {@link InlineCompletionParams}, the response is of type
 * {@link InlineCompletion InlineCompletion[]} or a Thenable that resolves to such.
 *
 * @since 3.18.0
 * @proposed
 */
var InlineCompletionRequest;
(function (InlineCompletionRequest) {
    InlineCompletionRequest.method = 'textDocument/inlineCompletion';
    InlineCompletionRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    InlineCompletionRequest.type = new messages_1.ProtocolRequestType(InlineCompletionRequest.method);
})(InlineCompletionRequest || (exports.InlineCompletionRequest = InlineCompletionRequest = {}));


/***/ },

/***/ 3124
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.InlineValueRefreshRequest = exports.InlineValueRequest = void 0;
const messages_1 = __webpack_require__(372);
/**
 * A request to provide inline values in a document. The request's parameter is of
 * type {@link InlineValueParams}, the response is of type
 * {@link InlineValue InlineValue[]} or a Thenable that resolves to such.
 *
 * @since 3.17.0
 */
var InlineValueRequest;
(function (InlineValueRequest) {
    InlineValueRequest.method = 'textDocument/inlineValue';
    InlineValueRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    InlineValueRequest.type = new messages_1.ProtocolRequestType(InlineValueRequest.method);
})(InlineValueRequest || (exports.InlineValueRequest = InlineValueRequest = {}));
/**
 * @since 3.17.0
 */
var InlineValueRefreshRequest;
(function (InlineValueRefreshRequest) {
    InlineValueRefreshRequest.method = `workspace/inlineValue/refresh`;
    InlineValueRefreshRequest.messageDirection = messages_1.MessageDirection.serverToClient;
    InlineValueRefreshRequest.type = new messages_1.ProtocolRequestType0(InlineValueRefreshRequest.method);
})(InlineValueRefreshRequest || (exports.InlineValueRefreshRequest = InlineValueRefreshRequest = {}));


/***/ },

/***/ 1560
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.WorkspaceSymbolRequest = exports.CodeActionResolveRequest = exports.CodeActionRequest = exports.DocumentSymbolRequest = exports.DocumentHighlightRequest = exports.ReferencesRequest = exports.DefinitionRequest = exports.SignatureHelpRequest = exports.SignatureHelpTriggerKind = exports.HoverRequest = exports.CompletionResolveRequest = exports.CompletionRequest = exports.CompletionTriggerKind = exports.PublishDiagnosticsNotification = exports.WatchKind = exports.RelativePattern = exports.FileChangeType = exports.DidChangeWatchedFilesNotification = exports.WillSaveTextDocumentWaitUntilRequest = exports.WillSaveTextDocumentNotification = exports.TextDocumentSaveReason = exports.DidSaveTextDocumentNotification = exports.DidCloseTextDocumentNotification = exports.DidChangeTextDocumentNotification = exports.TextDocumentContentChangeEvent = exports.DidOpenTextDocumentNotification = exports.TextDocumentSyncKind = exports.TelemetryEventNotification = exports.LogMessageNotification = exports.ShowMessageRequest = exports.ShowMessageNotification = exports.MessageType = exports.DidChangeConfigurationNotification = exports.ExitNotification = exports.ShutdownRequest = exports.InitializedNotification = exports.InitializeErrorCodes = exports.InitializeRequest = exports.WorkDoneProgressOptions = exports.TextDocumentRegistrationOptions = exports.StaticRegistrationOptions = exports.PositionEncodingKind = exports.FailureHandlingKind = exports.ResourceOperationKind = exports.UnregistrationRequest = exports.RegistrationRequest = exports.DocumentSelector = exports.NotebookCellTextDocumentFilter = exports.NotebookDocumentFilter = exports.TextDocumentFilter = void 0;
exports.MonikerRequest = exports.MonikerKind = exports.UniquenessLevel = exports.WillDeleteFilesRequest = exports.DidDeleteFilesNotification = exports.WillRenameFilesRequest = exports.DidRenameFilesNotification = exports.WillCreateFilesRequest = exports.DidCreateFilesNotification = exports.FileOperationPatternKind = exports.LinkedEditingRangeRequest = exports.ShowDocumentRequest = exports.SemanticTokensRegistrationType = exports.SemanticTokensRefreshRequest = exports.SemanticTokensRangeRequest = exports.SemanticTokensDeltaRequest = exports.SemanticTokensRequest = exports.TokenFormat = exports.CallHierarchyPrepareRequest = exports.CallHierarchyOutgoingCallsRequest = exports.CallHierarchyIncomingCallsRequest = exports.WorkDoneProgressCancelNotification = exports.WorkDoneProgressCreateRequest = exports.WorkDoneProgress = exports.SelectionRangeRequest = exports.DeclarationRequest = exports.FoldingRangeRefreshRequest = exports.FoldingRangeRequest = exports.ColorPresentationRequest = exports.DocumentColorRequest = exports.ConfigurationRequest = exports.DidChangeWorkspaceFoldersNotification = exports.WorkspaceFoldersRequest = exports.TypeDefinitionRequest = exports.ImplementationRequest = exports.ApplyWorkspaceEditRequest = exports.ExecuteCommandRequest = exports.PrepareRenameRequest = exports.RenameRequest = exports.PrepareSupportDefaultBehavior = exports.DocumentOnTypeFormattingRequest = exports.DocumentRangesFormattingRequest = exports.DocumentRangeFormattingRequest = exports.DocumentFormattingRequest = exports.DocumentLinkResolveRequest = exports.DocumentLinkRequest = exports.CodeLensRefreshRequest = exports.CodeLensResolveRequest = exports.CodeLensRequest = exports.WorkspaceSymbolResolveRequest = void 0;
exports.InlineCompletionRequest = exports.DidCloseNotebookDocumentNotification = exports.DidSaveNotebookDocumentNotification = exports.DidChangeNotebookDocumentNotification = exports.NotebookCellArrayChange = exports.DidOpenNotebookDocumentNotification = exports.NotebookDocumentSyncRegistrationType = exports.NotebookDocument = exports.NotebookCell = exports.ExecutionSummary = exports.NotebookCellKind = exports.DiagnosticRefreshRequest = exports.WorkspaceDiagnosticRequest = exports.DocumentDiagnosticRequest = exports.DocumentDiagnosticReportKind = exports.DiagnosticServerCancellationData = exports.InlayHintRefreshRequest = exports.InlayHintResolveRequest = exports.InlayHintRequest = exports.InlineValueRefreshRequest = exports.InlineValueRequest = exports.TypeHierarchySupertypesRequest = exports.TypeHierarchySubtypesRequest = exports.TypeHierarchyPrepareRequest = void 0;
const messages_1 = __webpack_require__(372);
const vscode_languageserver_types_1 = __webpack_require__(1145);
const Is = __webpack_require__(8598);
const protocol_implementation_1 = __webpack_require__(9574);
Object.defineProperty(exports, "ImplementationRequest", ({ enumerable: true, get: function () { return protocol_implementation_1.ImplementationRequest; } }));
const protocol_typeDefinition_1 = __webpack_require__(8461);
Object.defineProperty(exports, "TypeDefinitionRequest", ({ enumerable: true, get: function () { return protocol_typeDefinition_1.TypeDefinitionRequest; } }));
const protocol_workspaceFolder_1 = __webpack_require__(9935);
Object.defineProperty(exports, "WorkspaceFoldersRequest", ({ enumerable: true, get: function () { return protocol_workspaceFolder_1.WorkspaceFoldersRequest; } }));
Object.defineProperty(exports, "DidChangeWorkspaceFoldersNotification", ({ enumerable: true, get: function () { return protocol_workspaceFolder_1.DidChangeWorkspaceFoldersNotification; } }));
const protocol_configuration_1 = __webpack_require__(1660);
Object.defineProperty(exports, "ConfigurationRequest", ({ enumerable: true, get: function () { return protocol_configuration_1.ConfigurationRequest; } }));
const protocol_colorProvider_1 = __webpack_require__(7672);
Object.defineProperty(exports, "DocumentColorRequest", ({ enumerable: true, get: function () { return protocol_colorProvider_1.DocumentColorRequest; } }));
Object.defineProperty(exports, "ColorPresentationRequest", ({ enumerable: true, get: function () { return protocol_colorProvider_1.ColorPresentationRequest; } }));
const protocol_foldingRange_1 = __webpack_require__(2874);
Object.defineProperty(exports, "FoldingRangeRequest", ({ enumerable: true, get: function () { return protocol_foldingRange_1.FoldingRangeRequest; } }));
Object.defineProperty(exports, "FoldingRangeRefreshRequest", ({ enumerable: true, get: function () { return protocol_foldingRange_1.FoldingRangeRefreshRequest; } }));
const protocol_declaration_1 = __webpack_require__(6914);
Object.defineProperty(exports, "DeclarationRequest", ({ enumerable: true, get: function () { return protocol_declaration_1.DeclarationRequest; } }));
const protocol_selectionRange_1 = __webpack_require__(3487);
Object.defineProperty(exports, "SelectionRangeRequest", ({ enumerable: true, get: function () { return protocol_selectionRange_1.SelectionRangeRequest; } }));
const protocol_progress_1 = __webpack_require__(2687);
Object.defineProperty(exports, "WorkDoneProgress", ({ enumerable: true, get: function () { return protocol_progress_1.WorkDoneProgress; } }));
Object.defineProperty(exports, "WorkDoneProgressCreateRequest", ({ enumerable: true, get: function () { return protocol_progress_1.WorkDoneProgressCreateRequest; } }));
Object.defineProperty(exports, "WorkDoneProgressCancelNotification", ({ enumerable: true, get: function () { return protocol_progress_1.WorkDoneProgressCancelNotification; } }));
const protocol_callHierarchy_1 = __webpack_require__(8765);
Object.defineProperty(exports, "CallHierarchyIncomingCallsRequest", ({ enumerable: true, get: function () { return protocol_callHierarchy_1.CallHierarchyIncomingCallsRequest; } }));
Object.defineProperty(exports, "CallHierarchyOutgoingCallsRequest", ({ enumerable: true, get: function () { return protocol_callHierarchy_1.CallHierarchyOutgoingCallsRequest; } }));
Object.defineProperty(exports, "CallHierarchyPrepareRequest", ({ enumerable: true, get: function () { return protocol_callHierarchy_1.CallHierarchyPrepareRequest; } }));
const protocol_semanticTokens_1 = __webpack_require__(2478);
Object.defineProperty(exports, "TokenFormat", ({ enumerable: true, get: function () { return protocol_semanticTokens_1.TokenFormat; } }));
Object.defineProperty(exports, "SemanticTokensRequest", ({ enumerable: true, get: function () { return protocol_semanticTokens_1.SemanticTokensRequest; } }));
Object.defineProperty(exports, "SemanticTokensDeltaRequest", ({ enumerable: true, get: function () { return protocol_semanticTokens_1.SemanticTokensDeltaRequest; } }));
Object.defineProperty(exports, "SemanticTokensRangeRequest", ({ enumerable: true, get: function () { return protocol_semanticTokens_1.SemanticTokensRangeRequest; } }));
Object.defineProperty(exports, "SemanticTokensRefreshRequest", ({ enumerable: true, get: function () { return protocol_semanticTokens_1.SemanticTokensRefreshRequest; } }));
Object.defineProperty(exports, "SemanticTokensRegistrationType", ({ enumerable: true, get: function () { return protocol_semanticTokens_1.SemanticTokensRegistrationType; } }));
const protocol_showDocument_1 = __webpack_require__(908);
Object.defineProperty(exports, "ShowDocumentRequest", ({ enumerable: true, get: function () { return protocol_showDocument_1.ShowDocumentRequest; } }));
const protocol_linkedEditingRange_1 = __webpack_require__(5316);
Object.defineProperty(exports, "LinkedEditingRangeRequest", ({ enumerable: true, get: function () { return protocol_linkedEditingRange_1.LinkedEditingRangeRequest; } }));
const protocol_fileOperations_1 = __webpack_require__(9840);
Object.defineProperty(exports, "FileOperationPatternKind", ({ enumerable: true, get: function () { return protocol_fileOperations_1.FileOperationPatternKind; } }));
Object.defineProperty(exports, "DidCreateFilesNotification", ({ enumerable: true, get: function () { return protocol_fileOperations_1.DidCreateFilesNotification; } }));
Object.defineProperty(exports, "WillCreateFilesRequest", ({ enumerable: true, get: function () { return protocol_fileOperations_1.WillCreateFilesRequest; } }));
Object.defineProperty(exports, "DidRenameFilesNotification", ({ enumerable: true, get: function () { return protocol_fileOperations_1.DidRenameFilesNotification; } }));
Object.defineProperty(exports, "WillRenameFilesRequest", ({ enumerable: true, get: function () { return protocol_fileOperations_1.WillRenameFilesRequest; } }));
Object.defineProperty(exports, "DidDeleteFilesNotification", ({ enumerable: true, get: function () { return protocol_fileOperations_1.DidDeleteFilesNotification; } }));
Object.defineProperty(exports, "WillDeleteFilesRequest", ({ enumerable: true, get: function () { return protocol_fileOperations_1.WillDeleteFilesRequest; } }));
const protocol_moniker_1 = __webpack_require__(9047);
Object.defineProperty(exports, "UniquenessLevel", ({ enumerable: true, get: function () { return protocol_moniker_1.UniquenessLevel; } }));
Object.defineProperty(exports, "MonikerKind", ({ enumerable: true, get: function () { return protocol_moniker_1.MonikerKind; } }));
Object.defineProperty(exports, "MonikerRequest", ({ enumerable: true, get: function () { return protocol_moniker_1.MonikerRequest; } }));
const protocol_typeHierarchy_1 = __webpack_require__(645);
Object.defineProperty(exports, "TypeHierarchyPrepareRequest", ({ enumerable: true, get: function () { return protocol_typeHierarchy_1.TypeHierarchyPrepareRequest; } }));
Object.defineProperty(exports, "TypeHierarchySubtypesRequest", ({ enumerable: true, get: function () { return protocol_typeHierarchy_1.TypeHierarchySubtypesRequest; } }));
Object.defineProperty(exports, "TypeHierarchySupertypesRequest", ({ enumerable: true, get: function () { return protocol_typeHierarchy_1.TypeHierarchySupertypesRequest; } }));
const protocol_inlineValue_1 = __webpack_require__(3124);
Object.defineProperty(exports, "InlineValueRequest", ({ enumerable: true, get: function () { return protocol_inlineValue_1.InlineValueRequest; } }));
Object.defineProperty(exports, "InlineValueRefreshRequest", ({ enumerable: true, get: function () { return protocol_inlineValue_1.InlineValueRefreshRequest; } }));
const protocol_inlayHint_1 = __webpack_require__(7752);
Object.defineProperty(exports, "InlayHintRequest", ({ enumerable: true, get: function () { return protocol_inlayHint_1.InlayHintRequest; } }));
Object.defineProperty(exports, "InlayHintResolveRequest", ({ enumerable: true, get: function () { return protocol_inlayHint_1.InlayHintResolveRequest; } }));
Object.defineProperty(exports, "InlayHintRefreshRequest", ({ enumerable: true, get: function () { return protocol_inlayHint_1.InlayHintRefreshRequest; } }));
const protocol_diagnostic_1 = __webpack_require__(6011);
Object.defineProperty(exports, "DiagnosticServerCancellationData", ({ enumerable: true, get: function () { return protocol_diagnostic_1.DiagnosticServerCancellationData; } }));
Object.defineProperty(exports, "DocumentDiagnosticReportKind", ({ enumerable: true, get: function () { return protocol_diagnostic_1.DocumentDiagnosticReportKind; } }));
Object.defineProperty(exports, "DocumentDiagnosticRequest", ({ enumerable: true, get: function () { return protocol_diagnostic_1.DocumentDiagnosticRequest; } }));
Object.defineProperty(exports, "WorkspaceDiagnosticRequest", ({ enumerable: true, get: function () { return protocol_diagnostic_1.WorkspaceDiagnosticRequest; } }));
Object.defineProperty(exports, "DiagnosticRefreshRequest", ({ enumerable: true, get: function () { return protocol_diagnostic_1.DiagnosticRefreshRequest; } }));
const protocol_notebook_1 = __webpack_require__(3557);
Object.defineProperty(exports, "NotebookCellKind", ({ enumerable: true, get: function () { return protocol_notebook_1.NotebookCellKind; } }));
Object.defineProperty(exports, "ExecutionSummary", ({ enumerable: true, get: function () { return protocol_notebook_1.ExecutionSummary; } }));
Object.defineProperty(exports, "NotebookCell", ({ enumerable: true, get: function () { return protocol_notebook_1.NotebookCell; } }));
Object.defineProperty(exports, "NotebookDocument", ({ enumerable: true, get: function () { return protocol_notebook_1.NotebookDocument; } }));
Object.defineProperty(exports, "NotebookDocumentSyncRegistrationType", ({ enumerable: true, get: function () { return protocol_notebook_1.NotebookDocumentSyncRegistrationType; } }));
Object.defineProperty(exports, "DidOpenNotebookDocumentNotification", ({ enumerable: true, get: function () { return protocol_notebook_1.DidOpenNotebookDocumentNotification; } }));
Object.defineProperty(exports, "NotebookCellArrayChange", ({ enumerable: true, get: function () { return protocol_notebook_1.NotebookCellArrayChange; } }));
Object.defineProperty(exports, "DidChangeNotebookDocumentNotification", ({ enumerable: true, get: function () { return protocol_notebook_1.DidChangeNotebookDocumentNotification; } }));
Object.defineProperty(exports, "DidSaveNotebookDocumentNotification", ({ enumerable: true, get: function () { return protocol_notebook_1.DidSaveNotebookDocumentNotification; } }));
Object.defineProperty(exports, "DidCloseNotebookDocumentNotification", ({ enumerable: true, get: function () { return protocol_notebook_1.DidCloseNotebookDocumentNotification; } }));
const protocol_inlineCompletion_1 = __webpack_require__(3307);
Object.defineProperty(exports, "InlineCompletionRequest", ({ enumerable: true, get: function () { return protocol_inlineCompletion_1.InlineCompletionRequest; } }));
// @ts-ignore: to avoid inlining LocationLink as dynamic import
let __noDynamicImport;
/**
 * The TextDocumentFilter namespace provides helper functions to work with
 * {@link TextDocumentFilter} literals.
 *
 * @since 3.17.0
 */
var TextDocumentFilter;
(function (TextDocumentFilter) {
    function is(value) {
        const candidate = value;
        return Is.string(candidate) || (Is.string(candidate.language) || Is.string(candidate.scheme) || Is.string(candidate.pattern));
    }
    TextDocumentFilter.is = is;
})(TextDocumentFilter || (exports.TextDocumentFilter = TextDocumentFilter = {}));
/**
 * The NotebookDocumentFilter namespace provides helper functions to work with
 * {@link NotebookDocumentFilter} literals.
 *
 * @since 3.17.0
 */
var NotebookDocumentFilter;
(function (NotebookDocumentFilter) {
    function is(value) {
        const candidate = value;
        return Is.objectLiteral(candidate) && (Is.string(candidate.notebookType) || Is.string(candidate.scheme) || Is.string(candidate.pattern));
    }
    NotebookDocumentFilter.is = is;
})(NotebookDocumentFilter || (exports.NotebookDocumentFilter = NotebookDocumentFilter = {}));
/**
 * The NotebookCellTextDocumentFilter namespace provides helper functions to work with
 * {@link NotebookCellTextDocumentFilter} literals.
 *
 * @since 3.17.0
 */
var NotebookCellTextDocumentFilter;
(function (NotebookCellTextDocumentFilter) {
    function is(value) {
        const candidate = value;
        return Is.objectLiteral(candidate)
            && (Is.string(candidate.notebook) || NotebookDocumentFilter.is(candidate.notebook))
            && (candidate.language === undefined || Is.string(candidate.language));
    }
    NotebookCellTextDocumentFilter.is = is;
})(NotebookCellTextDocumentFilter || (exports.NotebookCellTextDocumentFilter = NotebookCellTextDocumentFilter = {}));
/**
 * The DocumentSelector namespace provides helper functions to work with
 * {@link DocumentSelector}s.
 */
var DocumentSelector;
(function (DocumentSelector) {
    function is(value) {
        if (!Array.isArray(value)) {
            return false;
        }
        for (let elem of value) {
            if (!Is.string(elem) && !TextDocumentFilter.is(elem) && !NotebookCellTextDocumentFilter.is(elem)) {
                return false;
            }
        }
        return true;
    }
    DocumentSelector.is = is;
})(DocumentSelector || (exports.DocumentSelector = DocumentSelector = {}));
/**
 * The `client/registerCapability` request is sent from the server to the client to register a new capability
 * handler on the client side.
 */
var RegistrationRequest;
(function (RegistrationRequest) {
    RegistrationRequest.method = 'client/registerCapability';
    RegistrationRequest.messageDirection = messages_1.MessageDirection.serverToClient;
    RegistrationRequest.type = new messages_1.ProtocolRequestType(RegistrationRequest.method);
})(RegistrationRequest || (exports.RegistrationRequest = RegistrationRequest = {}));
/**
 * The `client/unregisterCapability` request is sent from the server to the client to unregister a previously registered capability
 * handler on the client side.
 */
var UnregistrationRequest;
(function (UnregistrationRequest) {
    UnregistrationRequest.method = 'client/unregisterCapability';
    UnregistrationRequest.messageDirection = messages_1.MessageDirection.serverToClient;
    UnregistrationRequest.type = new messages_1.ProtocolRequestType(UnregistrationRequest.method);
})(UnregistrationRequest || (exports.UnregistrationRequest = UnregistrationRequest = {}));
var ResourceOperationKind;
(function (ResourceOperationKind) {
    /**
     * Supports creating new files and folders.
     */
    ResourceOperationKind.Create = 'create';
    /**
     * Supports renaming existing files and folders.
     */
    ResourceOperationKind.Rename = 'rename';
    /**
     * Supports deleting existing files and folders.
     */
    ResourceOperationKind.Delete = 'delete';
})(ResourceOperationKind || (exports.ResourceOperationKind = ResourceOperationKind = {}));
var FailureHandlingKind;
(function (FailureHandlingKind) {
    /**
     * Applying the workspace change is simply aborted if one of the changes provided
     * fails. All operations executed before the failing operation stay executed.
     */
    FailureHandlingKind.Abort = 'abort';
    /**
     * All operations are executed transactional. That means they either all
     * succeed or no changes at all are applied to the workspace.
     */
    FailureHandlingKind.Transactional = 'transactional';
    /**
     * If the workspace edit contains only textual file changes they are executed transactional.
     * If resource changes (create, rename or delete file) are part of the change the failure
     * handling strategy is abort.
     */
    FailureHandlingKind.TextOnlyTransactional = 'textOnlyTransactional';
    /**
     * The client tries to undo the operations already executed. But there is no
     * guarantee that this is succeeding.
     */
    FailureHandlingKind.Undo = 'undo';
})(FailureHandlingKind || (exports.FailureHandlingKind = FailureHandlingKind = {}));
/**
 * A set of predefined position encoding kinds.
 *
 * @since 3.17.0
 */
var PositionEncodingKind;
(function (PositionEncodingKind) {
    /**
     * Character offsets count UTF-8 code units (e.g. bytes).
     */
    PositionEncodingKind.UTF8 = 'utf-8';
    /**
     * Character offsets count UTF-16 code units.
     *
     * This is the default and must always be supported
     * by servers
     */
    PositionEncodingKind.UTF16 = 'utf-16';
    /**
     * Character offsets count UTF-32 code units.
     *
     * Implementation note: these are the same as Unicode codepoints,
     * so this `PositionEncodingKind` may also be used for an
     * encoding-agnostic representation of character offsets.
     */
    PositionEncodingKind.UTF32 = 'utf-32';
})(PositionEncodingKind || (exports.PositionEncodingKind = PositionEncodingKind = {}));
/**
 * The StaticRegistrationOptions namespace provides helper functions to work with
 * {@link StaticRegistrationOptions} literals.
 */
var StaticRegistrationOptions;
(function (StaticRegistrationOptions) {
    function hasId(value) {
        const candidate = value;
        return candidate && Is.string(candidate.id) && candidate.id.length > 0;
    }
    StaticRegistrationOptions.hasId = hasId;
})(StaticRegistrationOptions || (exports.StaticRegistrationOptions = StaticRegistrationOptions = {}));
/**
 * The TextDocumentRegistrationOptions namespace provides helper functions to work with
 * {@link TextDocumentRegistrationOptions} literals.
 */
var TextDocumentRegistrationOptions;
(function (TextDocumentRegistrationOptions) {
    function is(value) {
        const candidate = value;
        return candidate && (candidate.documentSelector === null || DocumentSelector.is(candidate.documentSelector));
    }
    TextDocumentRegistrationOptions.is = is;
})(TextDocumentRegistrationOptions || (exports.TextDocumentRegistrationOptions = TextDocumentRegistrationOptions = {}));
/**
 * The WorkDoneProgressOptions namespace provides helper functions to work with
 * {@link WorkDoneProgressOptions} literals.
 */
var WorkDoneProgressOptions;
(function (WorkDoneProgressOptions) {
    function is(value) {
        const candidate = value;
        return Is.objectLiteral(candidate) && (candidate.workDoneProgress === undefined || Is.boolean(candidate.workDoneProgress));
    }
    WorkDoneProgressOptions.is = is;
    function hasWorkDoneProgress(value) {
        const candidate = value;
        return candidate && Is.boolean(candidate.workDoneProgress);
    }
    WorkDoneProgressOptions.hasWorkDoneProgress = hasWorkDoneProgress;
})(WorkDoneProgressOptions || (exports.WorkDoneProgressOptions = WorkDoneProgressOptions = {}));
/**
 * The initialize request is sent from the client to the server.
 * It is sent once as the request after starting up the server.
 * The requests parameter is of type {@link InitializeParams}
 * the response if of type {@link InitializeResult} of a Thenable that
 * resolves to such.
 */
var InitializeRequest;
(function (InitializeRequest) {
    InitializeRequest.method = 'initialize';
    InitializeRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    InitializeRequest.type = new messages_1.ProtocolRequestType(InitializeRequest.method);
})(InitializeRequest || (exports.InitializeRequest = InitializeRequest = {}));
/**
 * Known error codes for an `InitializeErrorCodes`;
 */
var InitializeErrorCodes;
(function (InitializeErrorCodes) {
    /**
     * If the protocol version provided by the client can't be handled by the server.
     *
     * @deprecated This initialize error got replaced by client capabilities. There is
     * no version handshake in version 3.0x
     */
    InitializeErrorCodes.unknownProtocolVersion = 1;
})(InitializeErrorCodes || (exports.InitializeErrorCodes = InitializeErrorCodes = {}));
/**
 * The initialized notification is sent from the client to the
 * server after the client is fully initialized and the server
 * is allowed to send requests from the server to the client.
 */
var InitializedNotification;
(function (InitializedNotification) {
    InitializedNotification.method = 'initialized';
    InitializedNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    InitializedNotification.type = new messages_1.ProtocolNotificationType(InitializedNotification.method);
})(InitializedNotification || (exports.InitializedNotification = InitializedNotification = {}));
//---- Shutdown Method ----
/**
 * A shutdown request is sent from the client to the server.
 * It is sent once when the client decides to shutdown the
 * server. The only notification that is sent after a shutdown request
 * is the exit event.
 */
var ShutdownRequest;
(function (ShutdownRequest) {
    ShutdownRequest.method = 'shutdown';
    ShutdownRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    ShutdownRequest.type = new messages_1.ProtocolRequestType0(ShutdownRequest.method);
})(ShutdownRequest || (exports.ShutdownRequest = ShutdownRequest = {}));
//---- Exit Notification ----
/**
 * The exit event is sent from the client to the server to
 * ask the server to exit its process.
 */
var ExitNotification;
(function (ExitNotification) {
    ExitNotification.method = 'exit';
    ExitNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    ExitNotification.type = new messages_1.ProtocolNotificationType0(ExitNotification.method);
})(ExitNotification || (exports.ExitNotification = ExitNotification = {}));
/**
 * The configuration change notification is sent from the client to the server
 * when the client's configuration has changed. The notification contains
 * the changed configuration as defined by the language client.
 */
var DidChangeConfigurationNotification;
(function (DidChangeConfigurationNotification) {
    DidChangeConfigurationNotification.method = 'workspace/didChangeConfiguration';
    DidChangeConfigurationNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    DidChangeConfigurationNotification.type = new messages_1.ProtocolNotificationType(DidChangeConfigurationNotification.method);
})(DidChangeConfigurationNotification || (exports.DidChangeConfigurationNotification = DidChangeConfigurationNotification = {}));
//---- Message show and log notifications ----
/**
 * The message type
 */
var MessageType;
(function (MessageType) {
    /**
     * An error message.
     */
    MessageType.Error = 1;
    /**
     * A warning message.
     */
    MessageType.Warning = 2;
    /**
     * An information message.
     */
    MessageType.Info = 3;
    /**
     * A log message.
     */
    MessageType.Log = 4;
    /**
     * A debug message.
     *
     * @since 3.18.0
     */
    MessageType.Debug = 5;
})(MessageType || (exports.MessageType = MessageType = {}));
/**
 * The show message notification is sent from a server to a client to ask
 * the client to display a particular message in the user interface.
 */
var ShowMessageNotification;
(function (ShowMessageNotification) {
    ShowMessageNotification.method = 'window/showMessage';
    ShowMessageNotification.messageDirection = messages_1.MessageDirection.serverToClient;
    ShowMessageNotification.type = new messages_1.ProtocolNotificationType(ShowMessageNotification.method);
})(ShowMessageNotification || (exports.ShowMessageNotification = ShowMessageNotification = {}));
/**
 * The show message request is sent from the server to the client to show a message
 * and a set of options actions to the user.
 */
var ShowMessageRequest;
(function (ShowMessageRequest) {
    ShowMessageRequest.method = 'window/showMessageRequest';
    ShowMessageRequest.messageDirection = messages_1.MessageDirection.serverToClient;
    ShowMessageRequest.type = new messages_1.ProtocolRequestType(ShowMessageRequest.method);
})(ShowMessageRequest || (exports.ShowMessageRequest = ShowMessageRequest = {}));
/**
 * The log message notification is sent from the server to the client to ask
 * the client to log a particular message.
 */
var LogMessageNotification;
(function (LogMessageNotification) {
    LogMessageNotification.method = 'window/logMessage';
    LogMessageNotification.messageDirection = messages_1.MessageDirection.serverToClient;
    LogMessageNotification.type = new messages_1.ProtocolNotificationType(LogMessageNotification.method);
})(LogMessageNotification || (exports.LogMessageNotification = LogMessageNotification = {}));
//---- Telemetry notification
/**
 * The telemetry event notification is sent from the server to the client to ask
 * the client to log telemetry data.
 */
var TelemetryEventNotification;
(function (TelemetryEventNotification) {
    TelemetryEventNotification.method = 'telemetry/event';
    TelemetryEventNotification.messageDirection = messages_1.MessageDirection.serverToClient;
    TelemetryEventNotification.type = new messages_1.ProtocolNotificationType(TelemetryEventNotification.method);
})(TelemetryEventNotification || (exports.TelemetryEventNotification = TelemetryEventNotification = {}));
/**
 * Defines how the host (editor) should sync
 * document changes to the language server.
 */
var TextDocumentSyncKind;
(function (TextDocumentSyncKind) {
    /**
     * Documents should not be synced at all.
     */
    TextDocumentSyncKind.None = 0;
    /**
     * Documents are synced by always sending the full content
     * of the document.
     */
    TextDocumentSyncKind.Full = 1;
    /**
     * Documents are synced by sending the full content on open.
     * After that only incremental updates to the document are
     * send.
     */
    TextDocumentSyncKind.Incremental = 2;
})(TextDocumentSyncKind || (exports.TextDocumentSyncKind = TextDocumentSyncKind = {}));
/**
 * The document open notification is sent from the client to the server to signal
 * newly opened text documents. The document's truth is now managed by the client
 * and the server must not try to read the document's truth using the document's
 * uri. Open in this sense means it is managed by the client. It doesn't necessarily
 * mean that its content is presented in an editor. An open notification must not
 * be sent more than once without a corresponding close notification send before.
 * This means open and close notification must be balanced and the max open count
 * is one.
 */
var DidOpenTextDocumentNotification;
(function (DidOpenTextDocumentNotification) {
    DidOpenTextDocumentNotification.method = 'textDocument/didOpen';
    DidOpenTextDocumentNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    DidOpenTextDocumentNotification.type = new messages_1.ProtocolNotificationType(DidOpenTextDocumentNotification.method);
})(DidOpenTextDocumentNotification || (exports.DidOpenTextDocumentNotification = DidOpenTextDocumentNotification = {}));
var TextDocumentContentChangeEvent;
(function (TextDocumentContentChangeEvent) {
    /**
     * Checks whether the information describes a delta event.
     */
    function isIncremental(event) {
        let candidate = event;
        return candidate !== undefined && candidate !== null &&
            typeof candidate.text === 'string' && candidate.range !== undefined &&
            (candidate.rangeLength === undefined || typeof candidate.rangeLength === 'number');
    }
    TextDocumentContentChangeEvent.isIncremental = isIncremental;
    /**
     * Checks whether the information describes a full replacement event.
     */
    function isFull(event) {
        let candidate = event;
        return candidate !== undefined && candidate !== null &&
            typeof candidate.text === 'string' && candidate.range === undefined && candidate.rangeLength === undefined;
    }
    TextDocumentContentChangeEvent.isFull = isFull;
})(TextDocumentContentChangeEvent || (exports.TextDocumentContentChangeEvent = TextDocumentContentChangeEvent = {}));
/**
 * The document change notification is sent from the client to the server to signal
 * changes to a text document.
 */
var DidChangeTextDocumentNotification;
(function (DidChangeTextDocumentNotification) {
    DidChangeTextDocumentNotification.method = 'textDocument/didChange';
    DidChangeTextDocumentNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    DidChangeTextDocumentNotification.type = new messages_1.ProtocolNotificationType(DidChangeTextDocumentNotification.method);
})(DidChangeTextDocumentNotification || (exports.DidChangeTextDocumentNotification = DidChangeTextDocumentNotification = {}));
/**
 * The document close notification is sent from the client to the server when
 * the document got closed in the client. The document's truth now exists where
 * the document's uri points to (e.g. if the document's uri is a file uri the
 * truth now exists on disk). As with the open notification the close notification
 * is about managing the document's content. Receiving a close notification
 * doesn't mean that the document was open in an editor before. A close
 * notification requires a previous open notification to be sent.
 */
var DidCloseTextDocumentNotification;
(function (DidCloseTextDocumentNotification) {
    DidCloseTextDocumentNotification.method = 'textDocument/didClose';
    DidCloseTextDocumentNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    DidCloseTextDocumentNotification.type = new messages_1.ProtocolNotificationType(DidCloseTextDocumentNotification.method);
})(DidCloseTextDocumentNotification || (exports.DidCloseTextDocumentNotification = DidCloseTextDocumentNotification = {}));
/**
 * The document save notification is sent from the client to the server when
 * the document got saved in the client.
 */
var DidSaveTextDocumentNotification;
(function (DidSaveTextDocumentNotification) {
    DidSaveTextDocumentNotification.method = 'textDocument/didSave';
    DidSaveTextDocumentNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    DidSaveTextDocumentNotification.type = new messages_1.ProtocolNotificationType(DidSaveTextDocumentNotification.method);
})(DidSaveTextDocumentNotification || (exports.DidSaveTextDocumentNotification = DidSaveTextDocumentNotification = {}));
/**
 * Represents reasons why a text document is saved.
 */
var TextDocumentSaveReason;
(function (TextDocumentSaveReason) {
    /**
     * Manually triggered, e.g. by the user pressing save, by starting debugging,
     * or by an API call.
     */
    TextDocumentSaveReason.Manual = 1;
    /**
     * Automatic after a delay.
     */
    TextDocumentSaveReason.AfterDelay = 2;
    /**
     * When the editor lost focus.
     */
    TextDocumentSaveReason.FocusOut = 3;
})(TextDocumentSaveReason || (exports.TextDocumentSaveReason = TextDocumentSaveReason = {}));
/**
 * A document will save notification is sent from the client to the server before
 * the document is actually saved.
 */
var WillSaveTextDocumentNotification;
(function (WillSaveTextDocumentNotification) {
    WillSaveTextDocumentNotification.method = 'textDocument/willSave';
    WillSaveTextDocumentNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    WillSaveTextDocumentNotification.type = new messages_1.ProtocolNotificationType(WillSaveTextDocumentNotification.method);
})(WillSaveTextDocumentNotification || (exports.WillSaveTextDocumentNotification = WillSaveTextDocumentNotification = {}));
/**
 * A document will save request is sent from the client to the server before
 * the document is actually saved. The request can return an array of TextEdits
 * which will be applied to the text document before it is saved. Please note that
 * clients might drop results if computing the text edits took too long or if a
 * server constantly fails on this request. This is done to keep the save fast and
 * reliable.
 */
var WillSaveTextDocumentWaitUntilRequest;
(function (WillSaveTextDocumentWaitUntilRequest) {
    WillSaveTextDocumentWaitUntilRequest.method = 'textDocument/willSaveWaitUntil';
    WillSaveTextDocumentWaitUntilRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    WillSaveTextDocumentWaitUntilRequest.type = new messages_1.ProtocolRequestType(WillSaveTextDocumentWaitUntilRequest.method);
})(WillSaveTextDocumentWaitUntilRequest || (exports.WillSaveTextDocumentWaitUntilRequest = WillSaveTextDocumentWaitUntilRequest = {}));
/**
 * The watched files notification is sent from the client to the server when
 * the client detects changes to file watched by the language client.
 */
var DidChangeWatchedFilesNotification;
(function (DidChangeWatchedFilesNotification) {
    DidChangeWatchedFilesNotification.method = 'workspace/didChangeWatchedFiles';
    DidChangeWatchedFilesNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    DidChangeWatchedFilesNotification.type = new messages_1.ProtocolNotificationType(DidChangeWatchedFilesNotification.method);
})(DidChangeWatchedFilesNotification || (exports.DidChangeWatchedFilesNotification = DidChangeWatchedFilesNotification = {}));
/**
 * The file event type
 */
var FileChangeType;
(function (FileChangeType) {
    /**
     * The file got created.
     */
    FileChangeType.Created = 1;
    /**
     * The file got changed.
     */
    FileChangeType.Changed = 2;
    /**
     * The file got deleted.
     */
    FileChangeType.Deleted = 3;
})(FileChangeType || (exports.FileChangeType = FileChangeType = {}));
var RelativePattern;
(function (RelativePattern) {
    function is(value) {
        const candidate = value;
        return Is.objectLiteral(candidate) && (vscode_languageserver_types_1.URI.is(candidate.baseUri) || vscode_languageserver_types_1.WorkspaceFolder.is(candidate.baseUri)) && Is.string(candidate.pattern);
    }
    RelativePattern.is = is;
})(RelativePattern || (exports.RelativePattern = RelativePattern = {}));
var WatchKind;
(function (WatchKind) {
    /**
     * Interested in create events.
     */
    WatchKind.Create = 1;
    /**
     * Interested in change events
     */
    WatchKind.Change = 2;
    /**
     * Interested in delete events
     */
    WatchKind.Delete = 4;
})(WatchKind || (exports.WatchKind = WatchKind = {}));
/**
 * Diagnostics notification are sent from the server to the client to signal
 * results of validation runs.
 */
var PublishDiagnosticsNotification;
(function (PublishDiagnosticsNotification) {
    PublishDiagnosticsNotification.method = 'textDocument/publishDiagnostics';
    PublishDiagnosticsNotification.messageDirection = messages_1.MessageDirection.serverToClient;
    PublishDiagnosticsNotification.type = new messages_1.ProtocolNotificationType(PublishDiagnosticsNotification.method);
})(PublishDiagnosticsNotification || (exports.PublishDiagnosticsNotification = PublishDiagnosticsNotification = {}));
/**
 * How a completion was triggered
 */
var CompletionTriggerKind;
(function (CompletionTriggerKind) {
    /**
     * Completion was triggered by typing an identifier (24x7 code
     * complete), manual invocation (e.g Ctrl+Space) or via API.
     */
    CompletionTriggerKind.Invoked = 1;
    /**
     * Completion was triggered by a trigger character specified by
     * the `triggerCharacters` properties of the `CompletionRegistrationOptions`.
     */
    CompletionTriggerKind.TriggerCharacter = 2;
    /**
     * Completion was re-triggered as current completion list is incomplete
     */
    CompletionTriggerKind.TriggerForIncompleteCompletions = 3;
})(CompletionTriggerKind || (exports.CompletionTriggerKind = CompletionTriggerKind = {}));
/**
 * Request to request completion at a given text document position. The request's
 * parameter is of type {@link TextDocumentPosition} the response
 * is of type {@link CompletionItem CompletionItem[]} or {@link CompletionList}
 * or a Thenable that resolves to such.
 *
 * The request can delay the computation of the {@link CompletionItem.detail `detail`}
 * and {@link CompletionItem.documentation `documentation`} properties to the `completionItem/resolve`
 * request. However, properties that are needed for the initial sorting and filtering, like `sortText`,
 * `filterText`, `insertText`, and `textEdit`, must not be changed during resolve.
 */
var CompletionRequest;
(function (CompletionRequest) {
    CompletionRequest.method = 'textDocument/completion';
    CompletionRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    CompletionRequest.type = new messages_1.ProtocolRequestType(CompletionRequest.method);
})(CompletionRequest || (exports.CompletionRequest = CompletionRequest = {}));
/**
 * Request to resolve additional information for a given completion item.The request's
 * parameter is of type {@link CompletionItem} the response
 * is of type {@link CompletionItem} or a Thenable that resolves to such.
 */
var CompletionResolveRequest;
(function (CompletionResolveRequest) {
    CompletionResolveRequest.method = 'completionItem/resolve';
    CompletionResolveRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    CompletionResolveRequest.type = new messages_1.ProtocolRequestType(CompletionResolveRequest.method);
})(CompletionResolveRequest || (exports.CompletionResolveRequest = CompletionResolveRequest = {}));
/**
 * Request to request hover information at a given text document position. The request's
 * parameter is of type {@link TextDocumentPosition} the response is of
 * type {@link Hover} or a Thenable that resolves to such.
 */
var HoverRequest;
(function (HoverRequest) {
    HoverRequest.method = 'textDocument/hover';
    HoverRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    HoverRequest.type = new messages_1.ProtocolRequestType(HoverRequest.method);
})(HoverRequest || (exports.HoverRequest = HoverRequest = {}));
/**
 * How a signature help was triggered.
 *
 * @since 3.15.0
 */
var SignatureHelpTriggerKind;
(function (SignatureHelpTriggerKind) {
    /**
     * Signature help was invoked manually by the user or by a command.
     */
    SignatureHelpTriggerKind.Invoked = 1;
    /**
     * Signature help was triggered by a trigger character.
     */
    SignatureHelpTriggerKind.TriggerCharacter = 2;
    /**
     * Signature help was triggered by the cursor moving or by the document content changing.
     */
    SignatureHelpTriggerKind.ContentChange = 3;
})(SignatureHelpTriggerKind || (exports.SignatureHelpTriggerKind = SignatureHelpTriggerKind = {}));
var SignatureHelpRequest;
(function (SignatureHelpRequest) {
    SignatureHelpRequest.method = 'textDocument/signatureHelp';
    SignatureHelpRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    SignatureHelpRequest.type = new messages_1.ProtocolRequestType(SignatureHelpRequest.method);
})(SignatureHelpRequest || (exports.SignatureHelpRequest = SignatureHelpRequest = {}));
/**
 * A request to resolve the definition location of a symbol at a given text
 * document position. The request's parameter is of type {@link TextDocumentPosition}
 * the response is of either type {@link Definition} or a typed array of
 * {@link DefinitionLink} or a Thenable that resolves to such.
 */
var DefinitionRequest;
(function (DefinitionRequest) {
    DefinitionRequest.method = 'textDocument/definition';
    DefinitionRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    DefinitionRequest.type = new messages_1.ProtocolRequestType(DefinitionRequest.method);
})(DefinitionRequest || (exports.DefinitionRequest = DefinitionRequest = {}));
/**
 * A request to resolve project-wide references for the symbol denoted
 * by the given text document position. The request's parameter is of
 * type {@link ReferenceParams} the response is of type
 * {@link Location Location[]} or a Thenable that resolves to such.
 */
var ReferencesRequest;
(function (ReferencesRequest) {
    ReferencesRequest.method = 'textDocument/references';
    ReferencesRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    ReferencesRequest.type = new messages_1.ProtocolRequestType(ReferencesRequest.method);
})(ReferencesRequest || (exports.ReferencesRequest = ReferencesRequest = {}));
/**
 * Request to resolve a {@link DocumentHighlight} for a given
 * text document position. The request's parameter is of type {@link TextDocumentPosition}
 * the request response is an array of type {@link DocumentHighlight}
 * or a Thenable that resolves to such.
 */
var DocumentHighlightRequest;
(function (DocumentHighlightRequest) {
    DocumentHighlightRequest.method = 'textDocument/documentHighlight';
    DocumentHighlightRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    DocumentHighlightRequest.type = new messages_1.ProtocolRequestType(DocumentHighlightRequest.method);
})(DocumentHighlightRequest || (exports.DocumentHighlightRequest = DocumentHighlightRequest = {}));
/**
 * A request to list all symbols found in a given text document. The request's
 * parameter is of type {@link TextDocumentIdentifier} the
 * response is of type {@link SymbolInformation SymbolInformation[]} or a Thenable
 * that resolves to such.
 */
var DocumentSymbolRequest;
(function (DocumentSymbolRequest) {
    DocumentSymbolRequest.method = 'textDocument/documentSymbol';
    DocumentSymbolRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    DocumentSymbolRequest.type = new messages_1.ProtocolRequestType(DocumentSymbolRequest.method);
})(DocumentSymbolRequest || (exports.DocumentSymbolRequest = DocumentSymbolRequest = {}));
/**
 * A request to provide commands for the given text document and range.
 */
var CodeActionRequest;
(function (CodeActionRequest) {
    CodeActionRequest.method = 'textDocument/codeAction';
    CodeActionRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    CodeActionRequest.type = new messages_1.ProtocolRequestType(CodeActionRequest.method);
})(CodeActionRequest || (exports.CodeActionRequest = CodeActionRequest = {}));
/**
 * Request to resolve additional information for a given code action.The request's
 * parameter is of type {@link CodeAction} the response
 * is of type {@link CodeAction} or a Thenable that resolves to such.
 */
var CodeActionResolveRequest;
(function (CodeActionResolveRequest) {
    CodeActionResolveRequest.method = 'codeAction/resolve';
    CodeActionResolveRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    CodeActionResolveRequest.type = new messages_1.ProtocolRequestType(CodeActionResolveRequest.method);
})(CodeActionResolveRequest || (exports.CodeActionResolveRequest = CodeActionResolveRequest = {}));
/**
 * A request to list project-wide symbols matching the query string given
 * by the {@link WorkspaceSymbolParams}. The response is
 * of type {@link SymbolInformation SymbolInformation[]} or a Thenable that
 * resolves to such.
 *
 * @since 3.17.0 - support for WorkspaceSymbol in the returned data. Clients
 *  need to advertise support for WorkspaceSymbols via the client capability
 *  `workspace.symbol.resolveSupport`.
 *
 */
var WorkspaceSymbolRequest;
(function (WorkspaceSymbolRequest) {
    WorkspaceSymbolRequest.method = 'workspace/symbol';
    WorkspaceSymbolRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    WorkspaceSymbolRequest.type = new messages_1.ProtocolRequestType(WorkspaceSymbolRequest.method);
})(WorkspaceSymbolRequest || (exports.WorkspaceSymbolRequest = WorkspaceSymbolRequest = {}));
/**
 * A request to resolve the range inside the workspace
 * symbol's location.
 *
 * @since 3.17.0
 */
var WorkspaceSymbolResolveRequest;
(function (WorkspaceSymbolResolveRequest) {
    WorkspaceSymbolResolveRequest.method = 'workspaceSymbol/resolve';
    WorkspaceSymbolResolveRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    WorkspaceSymbolResolveRequest.type = new messages_1.ProtocolRequestType(WorkspaceSymbolResolveRequest.method);
})(WorkspaceSymbolResolveRequest || (exports.WorkspaceSymbolResolveRequest = WorkspaceSymbolResolveRequest = {}));
/**
 * A request to provide code lens for the given text document.
 */
var CodeLensRequest;
(function (CodeLensRequest) {
    CodeLensRequest.method = 'textDocument/codeLens';
    CodeLensRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    CodeLensRequest.type = new messages_1.ProtocolRequestType(CodeLensRequest.method);
})(CodeLensRequest || (exports.CodeLensRequest = CodeLensRequest = {}));
/**
 * A request to resolve a command for a given code lens.
 */
var CodeLensResolveRequest;
(function (CodeLensResolveRequest) {
    CodeLensResolveRequest.method = 'codeLens/resolve';
    CodeLensResolveRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    CodeLensResolveRequest.type = new messages_1.ProtocolRequestType(CodeLensResolveRequest.method);
})(CodeLensResolveRequest || (exports.CodeLensResolveRequest = CodeLensResolveRequest = {}));
/**
 * A request to refresh all code actions
 *
 * @since 3.16.0
 */
var CodeLensRefreshRequest;
(function (CodeLensRefreshRequest) {
    CodeLensRefreshRequest.method = `workspace/codeLens/refresh`;
    CodeLensRefreshRequest.messageDirection = messages_1.MessageDirection.serverToClient;
    CodeLensRefreshRequest.type = new messages_1.ProtocolRequestType0(CodeLensRefreshRequest.method);
})(CodeLensRefreshRequest || (exports.CodeLensRefreshRequest = CodeLensRefreshRequest = {}));
/**
 * A request to provide document links
 */
var DocumentLinkRequest;
(function (DocumentLinkRequest) {
    DocumentLinkRequest.method = 'textDocument/documentLink';
    DocumentLinkRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    DocumentLinkRequest.type = new messages_1.ProtocolRequestType(DocumentLinkRequest.method);
})(DocumentLinkRequest || (exports.DocumentLinkRequest = DocumentLinkRequest = {}));
/**
 * Request to resolve additional information for a given document link. The request's
 * parameter is of type {@link DocumentLink} the response
 * is of type {@link DocumentLink} or a Thenable that resolves to such.
 */
var DocumentLinkResolveRequest;
(function (DocumentLinkResolveRequest) {
    DocumentLinkResolveRequest.method = 'documentLink/resolve';
    DocumentLinkResolveRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    DocumentLinkResolveRequest.type = new messages_1.ProtocolRequestType(DocumentLinkResolveRequest.method);
})(DocumentLinkResolveRequest || (exports.DocumentLinkResolveRequest = DocumentLinkResolveRequest = {}));
/**
 * A request to format a whole document.
 */
var DocumentFormattingRequest;
(function (DocumentFormattingRequest) {
    DocumentFormattingRequest.method = 'textDocument/formatting';
    DocumentFormattingRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    DocumentFormattingRequest.type = new messages_1.ProtocolRequestType(DocumentFormattingRequest.method);
})(DocumentFormattingRequest || (exports.DocumentFormattingRequest = DocumentFormattingRequest = {}));
/**
 * A request to format a range in a document.
 */
var DocumentRangeFormattingRequest;
(function (DocumentRangeFormattingRequest) {
    DocumentRangeFormattingRequest.method = 'textDocument/rangeFormatting';
    DocumentRangeFormattingRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    DocumentRangeFormattingRequest.type = new messages_1.ProtocolRequestType(DocumentRangeFormattingRequest.method);
})(DocumentRangeFormattingRequest || (exports.DocumentRangeFormattingRequest = DocumentRangeFormattingRequest = {}));
/**
 * A request to format ranges in a document.
 *
 * @since 3.18.0
 * @proposed
 */
var DocumentRangesFormattingRequest;
(function (DocumentRangesFormattingRequest) {
    DocumentRangesFormattingRequest.method = 'textDocument/rangesFormatting';
    DocumentRangesFormattingRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    DocumentRangesFormattingRequest.type = new messages_1.ProtocolRequestType(DocumentRangesFormattingRequest.method);
})(DocumentRangesFormattingRequest || (exports.DocumentRangesFormattingRequest = DocumentRangesFormattingRequest = {}));
/**
 * A request to format a document on type.
 */
var DocumentOnTypeFormattingRequest;
(function (DocumentOnTypeFormattingRequest) {
    DocumentOnTypeFormattingRequest.method = 'textDocument/onTypeFormatting';
    DocumentOnTypeFormattingRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    DocumentOnTypeFormattingRequest.type = new messages_1.ProtocolRequestType(DocumentOnTypeFormattingRequest.method);
})(DocumentOnTypeFormattingRequest || (exports.DocumentOnTypeFormattingRequest = DocumentOnTypeFormattingRequest = {}));
//---- Rename ----------------------------------------------
var PrepareSupportDefaultBehavior;
(function (PrepareSupportDefaultBehavior) {
    /**
     * The client's default behavior is to select the identifier
     * according the to language's syntax rule.
     */
    PrepareSupportDefaultBehavior.Identifier = 1;
})(PrepareSupportDefaultBehavior || (exports.PrepareSupportDefaultBehavior = PrepareSupportDefaultBehavior = {}));
/**
 * A request to rename a symbol.
 */
var RenameRequest;
(function (RenameRequest) {
    RenameRequest.method = 'textDocument/rename';
    RenameRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    RenameRequest.type = new messages_1.ProtocolRequestType(RenameRequest.method);
})(RenameRequest || (exports.RenameRequest = RenameRequest = {}));
/**
 * A request to test and perform the setup necessary for a rename.
 *
 * @since 3.16 - support for default behavior
 */
var PrepareRenameRequest;
(function (PrepareRenameRequest) {
    PrepareRenameRequest.method = 'textDocument/prepareRename';
    PrepareRenameRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    PrepareRenameRequest.type = new messages_1.ProtocolRequestType(PrepareRenameRequest.method);
})(PrepareRenameRequest || (exports.PrepareRenameRequest = PrepareRenameRequest = {}));
/**
 * A request send from the client to the server to execute a command. The request might return
 * a workspace edit which the client will apply to the workspace.
 */
var ExecuteCommandRequest;
(function (ExecuteCommandRequest) {
    ExecuteCommandRequest.method = 'workspace/executeCommand';
    ExecuteCommandRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    ExecuteCommandRequest.type = new messages_1.ProtocolRequestType(ExecuteCommandRequest.method);
})(ExecuteCommandRequest || (exports.ExecuteCommandRequest = ExecuteCommandRequest = {}));
/**
 * A request sent from the server to the client to modified certain resources.
 */
var ApplyWorkspaceEditRequest;
(function (ApplyWorkspaceEditRequest) {
    ApplyWorkspaceEditRequest.method = 'workspace/applyEdit';
    ApplyWorkspaceEditRequest.messageDirection = messages_1.MessageDirection.serverToClient;
    ApplyWorkspaceEditRequest.type = new messages_1.ProtocolRequestType('workspace/applyEdit');
})(ApplyWorkspaceEditRequest || (exports.ApplyWorkspaceEditRequest = ApplyWorkspaceEditRequest = {}));


/***/ },

/***/ 5316
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.LinkedEditingRangeRequest = void 0;
const messages_1 = __webpack_require__(372);
/**
 * A request to provide ranges that can be edited together.
 *
 * @since 3.16.0
 */
var LinkedEditingRangeRequest;
(function (LinkedEditingRangeRequest) {
    LinkedEditingRangeRequest.method = 'textDocument/linkedEditingRange';
    LinkedEditingRangeRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    LinkedEditingRangeRequest.type = new messages_1.ProtocolRequestType(LinkedEditingRangeRequest.method);
})(LinkedEditingRangeRequest || (exports.LinkedEditingRangeRequest = LinkedEditingRangeRequest = {}));


/***/ },

/***/ 9047
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.MonikerRequest = exports.MonikerKind = exports.UniquenessLevel = void 0;
const messages_1 = __webpack_require__(372);
/**
 * Moniker uniqueness level to define scope of the moniker.
 *
 * @since 3.16.0
 */
var UniquenessLevel;
(function (UniquenessLevel) {
    /**
     * The moniker is only unique inside a document
     */
    UniquenessLevel.document = 'document';
    /**
     * The moniker is unique inside a project for which a dump got created
     */
    UniquenessLevel.project = 'project';
    /**
     * The moniker is unique inside the group to which a project belongs
     */
    UniquenessLevel.group = 'group';
    /**
     * The moniker is unique inside the moniker scheme.
     */
    UniquenessLevel.scheme = 'scheme';
    /**
     * The moniker is globally unique
     */
    UniquenessLevel.global = 'global';
})(UniquenessLevel || (exports.UniquenessLevel = UniquenessLevel = {}));
/**
 * The moniker kind.
 *
 * @since 3.16.0
 */
var MonikerKind;
(function (MonikerKind) {
    /**
     * The moniker represent a symbol that is imported into a project
     */
    MonikerKind.$import = 'import';
    /**
     * The moniker represents a symbol that is exported from a project
     */
    MonikerKind.$export = 'export';
    /**
     * The moniker represents a symbol that is local to a project (e.g. a local
     * variable of a function, a class not visible outside the project, ...)
     */
    MonikerKind.local = 'local';
})(MonikerKind || (exports.MonikerKind = MonikerKind = {}));
/**
 * A request to get the moniker of a symbol at a given text document position.
 * The request parameter is of type {@link TextDocumentPositionParams}.
 * The response is of type {@link Moniker Moniker[]} or `null`.
 */
var MonikerRequest;
(function (MonikerRequest) {
    MonikerRequest.method = 'textDocument/moniker';
    MonikerRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    MonikerRequest.type = new messages_1.ProtocolRequestType(MonikerRequest.method);
})(MonikerRequest || (exports.MonikerRequest = MonikerRequest = {}));


/***/ },

/***/ 3557
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.DidCloseNotebookDocumentNotification = exports.DidSaveNotebookDocumentNotification = exports.DidChangeNotebookDocumentNotification = exports.NotebookCellArrayChange = exports.DidOpenNotebookDocumentNotification = exports.NotebookDocumentSyncRegistrationType = exports.NotebookDocument = exports.NotebookCell = exports.ExecutionSummary = exports.NotebookCellKind = void 0;
const vscode_languageserver_types_1 = __webpack_require__(1145);
const Is = __webpack_require__(8598);
const messages_1 = __webpack_require__(372);
/**
 * A notebook cell kind.
 *
 * @since 3.17.0
 */
var NotebookCellKind;
(function (NotebookCellKind) {
    /**
     * A markup-cell is formatted source that is used for display.
     */
    NotebookCellKind.Markup = 1;
    /**
     * A code-cell is source code.
     */
    NotebookCellKind.Code = 2;
    function is(value) {
        return value === 1 || value === 2;
    }
    NotebookCellKind.is = is;
})(NotebookCellKind || (exports.NotebookCellKind = NotebookCellKind = {}));
var ExecutionSummary;
(function (ExecutionSummary) {
    function create(executionOrder, success) {
        const result = { executionOrder };
        if (success === true || success === false) {
            result.success = success;
        }
        return result;
    }
    ExecutionSummary.create = create;
    function is(value) {
        const candidate = value;
        return Is.objectLiteral(candidate) && vscode_languageserver_types_1.uinteger.is(candidate.executionOrder) && (candidate.success === undefined || Is.boolean(candidate.success));
    }
    ExecutionSummary.is = is;
    function equals(one, other) {
        if (one === other) {
            return true;
        }
        if (one === null || one === undefined || other === null || other === undefined) {
            return false;
        }
        return one.executionOrder === other.executionOrder && one.success === other.success;
    }
    ExecutionSummary.equals = equals;
})(ExecutionSummary || (exports.ExecutionSummary = ExecutionSummary = {}));
var NotebookCell;
(function (NotebookCell) {
    function create(kind, document) {
        return { kind, document };
    }
    NotebookCell.create = create;
    function is(value) {
        const candidate = value;
        return Is.objectLiteral(candidate) && NotebookCellKind.is(candidate.kind) && vscode_languageserver_types_1.DocumentUri.is(candidate.document) &&
            (candidate.metadata === undefined || Is.objectLiteral(candidate.metadata));
    }
    NotebookCell.is = is;
    function diff(one, two) {
        const result = new Set();
        if (one.document !== two.document) {
            result.add('document');
        }
        if (one.kind !== two.kind) {
            result.add('kind');
        }
        if (one.executionSummary !== two.executionSummary) {
            result.add('executionSummary');
        }
        if ((one.metadata !== undefined || two.metadata !== undefined) && !equalsMetadata(one.metadata, two.metadata)) {
            result.add('metadata');
        }
        if ((one.executionSummary !== undefined || two.executionSummary !== undefined) && !ExecutionSummary.equals(one.executionSummary, two.executionSummary)) {
            result.add('executionSummary');
        }
        return result;
    }
    NotebookCell.diff = diff;
    function equalsMetadata(one, other) {
        if (one === other) {
            return true;
        }
        if (one === null || one === undefined || other === null || other === undefined) {
            return false;
        }
        if (typeof one !== typeof other) {
            return false;
        }
        if (typeof one !== 'object') {
            return false;
        }
        const oneArray = Array.isArray(one);
        const otherArray = Array.isArray(other);
        if (oneArray !== otherArray) {
            return false;
        }
        if (oneArray && otherArray) {
            if (one.length !== other.length) {
                return false;
            }
            for (let i = 0; i < one.length; i++) {
                if (!equalsMetadata(one[i], other[i])) {
                    return false;
                }
            }
        }
        if (Is.objectLiteral(one) && Is.objectLiteral(other)) {
            const oneKeys = Object.keys(one);
            const otherKeys = Object.keys(other);
            if (oneKeys.length !== otherKeys.length) {
                return false;
            }
            oneKeys.sort();
            otherKeys.sort();
            if (!equalsMetadata(oneKeys, otherKeys)) {
                return false;
            }
            for (let i = 0; i < oneKeys.length; i++) {
                const prop = oneKeys[i];
                if (!equalsMetadata(one[prop], other[prop])) {
                    return false;
                }
            }
        }
        return true;
    }
})(NotebookCell || (exports.NotebookCell = NotebookCell = {}));
var NotebookDocument;
(function (NotebookDocument) {
    function create(uri, notebookType, version, cells) {
        return { uri, notebookType, version, cells };
    }
    NotebookDocument.create = create;
    function is(value) {
        const candidate = value;
        return Is.objectLiteral(candidate) && Is.string(candidate.uri) && vscode_languageserver_types_1.integer.is(candidate.version) && Is.typedArray(candidate.cells, NotebookCell.is);
    }
    NotebookDocument.is = is;
})(NotebookDocument || (exports.NotebookDocument = NotebookDocument = {}));
var NotebookDocumentSyncRegistrationType;
(function (NotebookDocumentSyncRegistrationType) {
    NotebookDocumentSyncRegistrationType.method = 'notebookDocument/sync';
    NotebookDocumentSyncRegistrationType.messageDirection = messages_1.MessageDirection.clientToServer;
    NotebookDocumentSyncRegistrationType.type = new messages_1.RegistrationType(NotebookDocumentSyncRegistrationType.method);
})(NotebookDocumentSyncRegistrationType || (exports.NotebookDocumentSyncRegistrationType = NotebookDocumentSyncRegistrationType = {}));
/**
 * A notification sent when a notebook opens.
 *
 * @since 3.17.0
 */
var DidOpenNotebookDocumentNotification;
(function (DidOpenNotebookDocumentNotification) {
    DidOpenNotebookDocumentNotification.method = 'notebookDocument/didOpen';
    DidOpenNotebookDocumentNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    DidOpenNotebookDocumentNotification.type = new messages_1.ProtocolNotificationType(DidOpenNotebookDocumentNotification.method);
    DidOpenNotebookDocumentNotification.registrationMethod = NotebookDocumentSyncRegistrationType.method;
})(DidOpenNotebookDocumentNotification || (exports.DidOpenNotebookDocumentNotification = DidOpenNotebookDocumentNotification = {}));
var NotebookCellArrayChange;
(function (NotebookCellArrayChange) {
    function is(value) {
        const candidate = value;
        return Is.objectLiteral(candidate) && vscode_languageserver_types_1.uinteger.is(candidate.start) && vscode_languageserver_types_1.uinteger.is(candidate.deleteCount) && (candidate.cells === undefined || Is.typedArray(candidate.cells, NotebookCell.is));
    }
    NotebookCellArrayChange.is = is;
    function create(start, deleteCount, cells) {
        const result = { start, deleteCount };
        if (cells !== undefined) {
            result.cells = cells;
        }
        return result;
    }
    NotebookCellArrayChange.create = create;
})(NotebookCellArrayChange || (exports.NotebookCellArrayChange = NotebookCellArrayChange = {}));
var DidChangeNotebookDocumentNotification;
(function (DidChangeNotebookDocumentNotification) {
    DidChangeNotebookDocumentNotification.method = 'notebookDocument/didChange';
    DidChangeNotebookDocumentNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    DidChangeNotebookDocumentNotification.type = new messages_1.ProtocolNotificationType(DidChangeNotebookDocumentNotification.method);
    DidChangeNotebookDocumentNotification.registrationMethod = NotebookDocumentSyncRegistrationType.method;
})(DidChangeNotebookDocumentNotification || (exports.DidChangeNotebookDocumentNotification = DidChangeNotebookDocumentNotification = {}));
/**
 * A notification sent when a notebook document is saved.
 *
 * @since 3.17.0
 */
var DidSaveNotebookDocumentNotification;
(function (DidSaveNotebookDocumentNotification) {
    DidSaveNotebookDocumentNotification.method = 'notebookDocument/didSave';
    DidSaveNotebookDocumentNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    DidSaveNotebookDocumentNotification.type = new messages_1.ProtocolNotificationType(DidSaveNotebookDocumentNotification.method);
    DidSaveNotebookDocumentNotification.registrationMethod = NotebookDocumentSyncRegistrationType.method;
})(DidSaveNotebookDocumentNotification || (exports.DidSaveNotebookDocumentNotification = DidSaveNotebookDocumentNotification = {}));
/**
 * A notification sent when a notebook closes.
 *
 * @since 3.17.0
 */
var DidCloseNotebookDocumentNotification;
(function (DidCloseNotebookDocumentNotification) {
    DidCloseNotebookDocumentNotification.method = 'notebookDocument/didClose';
    DidCloseNotebookDocumentNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    DidCloseNotebookDocumentNotification.type = new messages_1.ProtocolNotificationType(DidCloseNotebookDocumentNotification.method);
    DidCloseNotebookDocumentNotification.registrationMethod = NotebookDocumentSyncRegistrationType.method;
})(DidCloseNotebookDocumentNotification || (exports.DidCloseNotebookDocumentNotification = DidCloseNotebookDocumentNotification = {}));


/***/ },

/***/ 2687
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.WorkDoneProgressCancelNotification = exports.WorkDoneProgressCreateRequest = exports.WorkDoneProgress = void 0;
const vscode_jsonrpc_1 = __webpack_require__(7123);
const messages_1 = __webpack_require__(372);
var WorkDoneProgress;
(function (WorkDoneProgress) {
    WorkDoneProgress.type = new vscode_jsonrpc_1.ProgressType();
    function is(value) {
        return value === WorkDoneProgress.type;
    }
    WorkDoneProgress.is = is;
})(WorkDoneProgress || (exports.WorkDoneProgress = WorkDoneProgress = {}));
/**
 * The `window/workDoneProgress/create` request is sent from the server to the client to initiate progress
 * reporting from the server.
 */
var WorkDoneProgressCreateRequest;
(function (WorkDoneProgressCreateRequest) {
    WorkDoneProgressCreateRequest.method = 'window/workDoneProgress/create';
    WorkDoneProgressCreateRequest.messageDirection = messages_1.MessageDirection.serverToClient;
    WorkDoneProgressCreateRequest.type = new messages_1.ProtocolRequestType(WorkDoneProgressCreateRequest.method);
})(WorkDoneProgressCreateRequest || (exports.WorkDoneProgressCreateRequest = WorkDoneProgressCreateRequest = {}));
/**
 * The `window/workDoneProgress/cancel` notification is sent from  the client to the server to cancel a progress
 * initiated on the server side.
 */
var WorkDoneProgressCancelNotification;
(function (WorkDoneProgressCancelNotification) {
    WorkDoneProgressCancelNotification.method = 'window/workDoneProgress/cancel';
    WorkDoneProgressCancelNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    WorkDoneProgressCancelNotification.type = new messages_1.ProtocolNotificationType(WorkDoneProgressCancelNotification.method);
})(WorkDoneProgressCancelNotification || (exports.WorkDoneProgressCancelNotification = WorkDoneProgressCancelNotification = {}));


/***/ },

/***/ 3487
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SelectionRangeRequest = void 0;
const messages_1 = __webpack_require__(372);
/**
 * A request to provide selection ranges in a document. The request's
 * parameter is of type {@link SelectionRangeParams}, the
 * response is of type {@link SelectionRange SelectionRange[]} or a Thenable
 * that resolves to such.
 */
var SelectionRangeRequest;
(function (SelectionRangeRequest) {
    SelectionRangeRequest.method = 'textDocument/selectionRange';
    SelectionRangeRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    SelectionRangeRequest.type = new messages_1.ProtocolRequestType(SelectionRangeRequest.method);
})(SelectionRangeRequest || (exports.SelectionRangeRequest = SelectionRangeRequest = {}));


/***/ },

/***/ 2478
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SemanticTokensRefreshRequest = exports.SemanticTokensRangeRequest = exports.SemanticTokensDeltaRequest = exports.SemanticTokensRequest = exports.SemanticTokensRegistrationType = exports.TokenFormat = void 0;
const messages_1 = __webpack_require__(372);
//------- 'textDocument/semanticTokens' -----
var TokenFormat;
(function (TokenFormat) {
    TokenFormat.Relative = 'relative';
})(TokenFormat || (exports.TokenFormat = TokenFormat = {}));
var SemanticTokensRegistrationType;
(function (SemanticTokensRegistrationType) {
    SemanticTokensRegistrationType.method = 'textDocument/semanticTokens';
    SemanticTokensRegistrationType.type = new messages_1.RegistrationType(SemanticTokensRegistrationType.method);
})(SemanticTokensRegistrationType || (exports.SemanticTokensRegistrationType = SemanticTokensRegistrationType = {}));
/**
 * @since 3.16.0
 */
var SemanticTokensRequest;
(function (SemanticTokensRequest) {
    SemanticTokensRequest.method = 'textDocument/semanticTokens/full';
    SemanticTokensRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    SemanticTokensRequest.type = new messages_1.ProtocolRequestType(SemanticTokensRequest.method);
    SemanticTokensRequest.registrationMethod = SemanticTokensRegistrationType.method;
})(SemanticTokensRequest || (exports.SemanticTokensRequest = SemanticTokensRequest = {}));
/**
 * @since 3.16.0
 */
var SemanticTokensDeltaRequest;
(function (SemanticTokensDeltaRequest) {
    SemanticTokensDeltaRequest.method = 'textDocument/semanticTokens/full/delta';
    SemanticTokensDeltaRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    SemanticTokensDeltaRequest.type = new messages_1.ProtocolRequestType(SemanticTokensDeltaRequest.method);
    SemanticTokensDeltaRequest.registrationMethod = SemanticTokensRegistrationType.method;
})(SemanticTokensDeltaRequest || (exports.SemanticTokensDeltaRequest = SemanticTokensDeltaRequest = {}));
/**
 * @since 3.16.0
 */
var SemanticTokensRangeRequest;
(function (SemanticTokensRangeRequest) {
    SemanticTokensRangeRequest.method = 'textDocument/semanticTokens/range';
    SemanticTokensRangeRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    SemanticTokensRangeRequest.type = new messages_1.ProtocolRequestType(SemanticTokensRangeRequest.method);
    SemanticTokensRangeRequest.registrationMethod = SemanticTokensRegistrationType.method;
})(SemanticTokensRangeRequest || (exports.SemanticTokensRangeRequest = SemanticTokensRangeRequest = {}));
/**
 * @since 3.16.0
 */
var SemanticTokensRefreshRequest;
(function (SemanticTokensRefreshRequest) {
    SemanticTokensRefreshRequest.method = `workspace/semanticTokens/refresh`;
    SemanticTokensRefreshRequest.messageDirection = messages_1.MessageDirection.serverToClient;
    SemanticTokensRefreshRequest.type = new messages_1.ProtocolRequestType0(SemanticTokensRefreshRequest.method);
})(SemanticTokensRefreshRequest || (exports.SemanticTokensRefreshRequest = SemanticTokensRefreshRequest = {}));


/***/ },

/***/ 908
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ShowDocumentRequest = void 0;
const messages_1 = __webpack_require__(372);
/**
 * A request to show a document. This request might open an
 * external program depending on the value of the URI to open.
 * For example a request to open `https://code.visualstudio.com/`
 * will very likely open the URI in a WEB browser.
 *
 * @since 3.16.0
*/
var ShowDocumentRequest;
(function (ShowDocumentRequest) {
    ShowDocumentRequest.method = 'window/showDocument';
    ShowDocumentRequest.messageDirection = messages_1.MessageDirection.serverToClient;
    ShowDocumentRequest.type = new messages_1.ProtocolRequestType(ShowDocumentRequest.method);
})(ShowDocumentRequest || (exports.ShowDocumentRequest = ShowDocumentRequest = {}));


/***/ },

/***/ 8461
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.TypeDefinitionRequest = void 0;
const messages_1 = __webpack_require__(372);
// @ts-ignore: to avoid inlining LocatioLink as dynamic import
let __noDynamicImport;
/**
 * A request to resolve the type definition locations of a symbol at a given text
 * document position. The request's parameter is of type {@link TextDocumentPositionParams}
 * the response is of type {@link Definition} or a Thenable that resolves to such.
 */
var TypeDefinitionRequest;
(function (TypeDefinitionRequest) {
    TypeDefinitionRequest.method = 'textDocument/typeDefinition';
    TypeDefinitionRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    TypeDefinitionRequest.type = new messages_1.ProtocolRequestType(TypeDefinitionRequest.method);
})(TypeDefinitionRequest || (exports.TypeDefinitionRequest = TypeDefinitionRequest = {}));


/***/ },

/***/ 645
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) TypeFox, Microsoft and others. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.TypeHierarchySubtypesRequest = exports.TypeHierarchySupertypesRequest = exports.TypeHierarchyPrepareRequest = void 0;
const messages_1 = __webpack_require__(372);
/**
 * A request to result a `TypeHierarchyItem` in a document at a given position.
 * Can be used as an input to a subtypes or supertypes type hierarchy.
 *
 * @since 3.17.0
 */
var TypeHierarchyPrepareRequest;
(function (TypeHierarchyPrepareRequest) {
    TypeHierarchyPrepareRequest.method = 'textDocument/prepareTypeHierarchy';
    TypeHierarchyPrepareRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    TypeHierarchyPrepareRequest.type = new messages_1.ProtocolRequestType(TypeHierarchyPrepareRequest.method);
})(TypeHierarchyPrepareRequest || (exports.TypeHierarchyPrepareRequest = TypeHierarchyPrepareRequest = {}));
/**
 * A request to resolve the supertypes for a given `TypeHierarchyItem`.
 *
 * @since 3.17.0
 */
var TypeHierarchySupertypesRequest;
(function (TypeHierarchySupertypesRequest) {
    TypeHierarchySupertypesRequest.method = 'typeHierarchy/supertypes';
    TypeHierarchySupertypesRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    TypeHierarchySupertypesRequest.type = new messages_1.ProtocolRequestType(TypeHierarchySupertypesRequest.method);
})(TypeHierarchySupertypesRequest || (exports.TypeHierarchySupertypesRequest = TypeHierarchySupertypesRequest = {}));
/**
 * A request to resolve the subtypes for a given `TypeHierarchyItem`.
 *
 * @since 3.17.0
 */
var TypeHierarchySubtypesRequest;
(function (TypeHierarchySubtypesRequest) {
    TypeHierarchySubtypesRequest.method = 'typeHierarchy/subtypes';
    TypeHierarchySubtypesRequest.messageDirection = messages_1.MessageDirection.clientToServer;
    TypeHierarchySubtypesRequest.type = new messages_1.ProtocolRequestType(TypeHierarchySubtypesRequest.method);
})(TypeHierarchySubtypesRequest || (exports.TypeHierarchySubtypesRequest = TypeHierarchySubtypesRequest = {}));


/***/ },

/***/ 9935
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.DidChangeWorkspaceFoldersNotification = exports.WorkspaceFoldersRequest = void 0;
const messages_1 = __webpack_require__(372);
/**
 * The `workspace/workspaceFolders` is sent from the server to the client to fetch the open workspace folders.
 */
var WorkspaceFoldersRequest;
(function (WorkspaceFoldersRequest) {
    WorkspaceFoldersRequest.method = 'workspace/workspaceFolders';
    WorkspaceFoldersRequest.messageDirection = messages_1.MessageDirection.serverToClient;
    WorkspaceFoldersRequest.type = new messages_1.ProtocolRequestType0(WorkspaceFoldersRequest.method);
})(WorkspaceFoldersRequest || (exports.WorkspaceFoldersRequest = WorkspaceFoldersRequest = {}));
/**
 * The `workspace/didChangeWorkspaceFolders` notification is sent from the client to the server when the workspace
 * folder configuration changes.
 */
var DidChangeWorkspaceFoldersNotification;
(function (DidChangeWorkspaceFoldersNotification) {
    DidChangeWorkspaceFoldersNotification.method = 'workspace/didChangeWorkspaceFolders';
    DidChangeWorkspaceFoldersNotification.messageDirection = messages_1.MessageDirection.clientToServer;
    DidChangeWorkspaceFoldersNotification.type = new messages_1.ProtocolNotificationType(DidChangeWorkspaceFoldersNotification.method);
})(DidChangeWorkspaceFoldersNotification || (exports.DidChangeWorkspaceFoldersNotification = DidChangeWorkspaceFoldersNotification = {}));


/***/ },

/***/ 8598
(__unused_webpack_module, exports) {

"use strict";
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.objectLiteral = exports.typedArray = exports.stringArray = exports.array = exports.func = exports.error = exports.number = exports.string = exports.boolean = void 0;
function boolean(value) {
    return value === true || value === false;
}
exports.boolean = boolean;
function string(value) {
    return typeof value === 'string' || value instanceof String;
}
exports.string = string;
function number(value) {
    return typeof value === 'number' || value instanceof Number;
}
exports.number = number;
function error(value) {
    return value instanceof Error;
}
exports.error = error;
function func(value) {
    return typeof value === 'function';
}
exports.func = func;
function array(value) {
    return Array.isArray(value);
}
exports.array = array;
function stringArray(value) {
    return array(value) && value.every(elem => string(elem));
}
exports.stringArray = stringArray;
function typedArray(value, check) {
    return Array.isArray(value) && value.every(check);
}
exports.typedArray = typedArray;
function objectLiteral(value) {
    // Strictly speaking class instances pass this check as well. Since the LSP
    // doesn't use classes we ignore this for now. If we do we need to add something
    // like this: `Object.getPrototypeOf(Object.getPrototypeOf(x)) === null`
    return value !== null && typeof value === 'object';
}
exports.objectLiteral = objectLiteral;


/***/ },

/***/ 7354
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.createProtocolConnection = void 0;
const node_1 = __webpack_require__(2067);
__exportStar(__webpack_require__(2067), exports);
__exportStar(__webpack_require__(8766), exports);
function createProtocolConnection(input, output, logger, options) {
    return (0, node_1.createMessageConnection)(input, output, logger, options);
}
exports.createProtocolConnection = createProtocolConnection;


/***/ },

/***/ 948
(module, __unused_webpack_exports, __webpack_require__) {

"use strict";
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ----------------------------------------------------------------------------------------- */


module.exports = __webpack_require__(7354);

/***/ },

/***/ 1145
(module, exports, __webpack_require__) {

(function (factory) {
    if ( true && typeof module.exports === "object") {
        var v = factory(__webpack_require__(3655), exports);
        if (v !== undefined) module.exports = v;
    }
    else if (typeof define === "function" && define.amd) {
        define(["require", "exports"], factory);
    }
})(function (require, exports) {
    /* --------------------------------------------------------------------------------------------
     * Copyright (c) Microsoft Corporation. All rights reserved.
     * Licensed under the MIT License. See License.txt in the project root for license information.
     * ------------------------------------------------------------------------------------------ */
    'use strict';
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TextDocument = exports.EOL = exports.WorkspaceFolder = exports.InlineCompletionContext = exports.SelectedCompletionInfo = exports.InlineCompletionTriggerKind = exports.InlineCompletionList = exports.InlineCompletionItem = exports.StringValue = exports.InlayHint = exports.InlayHintLabelPart = exports.InlayHintKind = exports.InlineValueContext = exports.InlineValueEvaluatableExpression = exports.InlineValueVariableLookup = exports.InlineValueText = exports.SemanticTokens = exports.SemanticTokenModifiers = exports.SemanticTokenTypes = exports.SelectionRange = exports.DocumentLink = exports.FormattingOptions = exports.CodeLens = exports.CodeAction = exports.CodeActionContext = exports.CodeActionTriggerKind = exports.CodeActionKind = exports.DocumentSymbol = exports.WorkspaceSymbol = exports.SymbolInformation = exports.SymbolTag = exports.SymbolKind = exports.DocumentHighlight = exports.DocumentHighlightKind = exports.SignatureInformation = exports.ParameterInformation = exports.Hover = exports.MarkedString = exports.CompletionList = exports.CompletionItem = exports.CompletionItemLabelDetails = exports.InsertTextMode = exports.InsertReplaceEdit = exports.CompletionItemTag = exports.InsertTextFormat = exports.CompletionItemKind = exports.MarkupContent = exports.MarkupKind = exports.TextDocumentItem = exports.OptionalVersionedTextDocumentIdentifier = exports.VersionedTextDocumentIdentifier = exports.TextDocumentIdentifier = exports.WorkspaceChange = exports.WorkspaceEdit = exports.DeleteFile = exports.RenameFile = exports.CreateFile = exports.TextDocumentEdit = exports.AnnotatedTextEdit = exports.ChangeAnnotationIdentifier = exports.ChangeAnnotation = exports.TextEdit = exports.Command = exports.Diagnostic = exports.CodeDescription = exports.DiagnosticTag = exports.DiagnosticSeverity = exports.DiagnosticRelatedInformation = exports.FoldingRange = exports.FoldingRangeKind = exports.ColorPresentation = exports.ColorInformation = exports.Color = exports.LocationLink = exports.Location = exports.Range = exports.Position = exports.uinteger = exports.integer = exports.URI = exports.DocumentUri = void 0;
    var DocumentUri;
    (function (DocumentUri) {
        function is(value) {
            return typeof value === 'string';
        }
        DocumentUri.is = is;
    })(DocumentUri || (exports.DocumentUri = DocumentUri = {}));
    var URI;
    (function (URI) {
        function is(value) {
            return typeof value === 'string';
        }
        URI.is = is;
    })(URI || (exports.URI = URI = {}));
    var integer;
    (function (integer) {
        integer.MIN_VALUE = -2147483648;
        integer.MAX_VALUE = 2147483647;
        function is(value) {
            return typeof value === 'number' && integer.MIN_VALUE <= value && value <= integer.MAX_VALUE;
        }
        integer.is = is;
    })(integer || (exports.integer = integer = {}));
    var uinteger;
    (function (uinteger) {
        uinteger.MIN_VALUE = 0;
        uinteger.MAX_VALUE = 2147483647;
        function is(value) {
            return typeof value === 'number' && uinteger.MIN_VALUE <= value && value <= uinteger.MAX_VALUE;
        }
        uinteger.is = is;
    })(uinteger || (exports.uinteger = uinteger = {}));
    /**
     * The Position namespace provides helper functions to work with
     * {@link Position} literals.
     */
    var Position;
    (function (Position) {
        /**
         * Creates a new Position literal from the given line and character.
         * @param line The position's line.
         * @param character The position's character.
         */
        function create(line, character) {
            if (line === Number.MAX_VALUE) {
                line = uinteger.MAX_VALUE;
            }
            if (character === Number.MAX_VALUE) {
                character = uinteger.MAX_VALUE;
            }
            return { line: line, character: character };
        }
        Position.create = create;
        /**
         * Checks whether the given literal conforms to the {@link Position} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(candidate) && Is.uinteger(candidate.line) && Is.uinteger(candidate.character);
        }
        Position.is = is;
    })(Position || (exports.Position = Position = {}));
    /**
     * The Range namespace provides helper functions to work with
     * {@link Range} literals.
     */
    var Range;
    (function (Range) {
        function create(one, two, three, four) {
            if (Is.uinteger(one) && Is.uinteger(two) && Is.uinteger(three) && Is.uinteger(four)) {
                return { start: Position.create(one, two), end: Position.create(three, four) };
            }
            else if (Position.is(one) && Position.is(two)) {
                return { start: one, end: two };
            }
            else {
                throw new Error("Range#create called with invalid arguments[".concat(one, ", ").concat(two, ", ").concat(three, ", ").concat(four, "]"));
            }
        }
        Range.create = create;
        /**
         * Checks whether the given literal conforms to the {@link Range} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(candidate) && Position.is(candidate.start) && Position.is(candidate.end);
        }
        Range.is = is;
    })(Range || (exports.Range = Range = {}));
    /**
     * The Location namespace provides helper functions to work with
     * {@link Location} literals.
     */
    var Location;
    (function (Location) {
        /**
         * Creates a Location literal.
         * @param uri The location's uri.
         * @param range The location's range.
         */
        function create(uri, range) {
            return { uri: uri, range: range };
        }
        Location.create = create;
        /**
         * Checks whether the given literal conforms to the {@link Location} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(candidate) && Range.is(candidate.range) && (Is.string(candidate.uri) || Is.undefined(candidate.uri));
        }
        Location.is = is;
    })(Location || (exports.Location = Location = {}));
    /**
     * The LocationLink namespace provides helper functions to work with
     * {@link LocationLink} literals.
     */
    var LocationLink;
    (function (LocationLink) {
        /**
         * Creates a LocationLink literal.
         * @param targetUri The definition's uri.
         * @param targetRange The full range of the definition.
         * @param targetSelectionRange The span of the symbol definition at the target.
         * @param originSelectionRange The span of the symbol being defined in the originating source file.
         */
        function create(targetUri, targetRange, targetSelectionRange, originSelectionRange) {
            return { targetUri: targetUri, targetRange: targetRange, targetSelectionRange: targetSelectionRange, originSelectionRange: originSelectionRange };
        }
        LocationLink.create = create;
        /**
         * Checks whether the given literal conforms to the {@link LocationLink} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(candidate) && Range.is(candidate.targetRange) && Is.string(candidate.targetUri)
                && Range.is(candidate.targetSelectionRange)
                && (Range.is(candidate.originSelectionRange) || Is.undefined(candidate.originSelectionRange));
        }
        LocationLink.is = is;
    })(LocationLink || (exports.LocationLink = LocationLink = {}));
    /**
     * The Color namespace provides helper functions to work with
     * {@link Color} literals.
     */
    var Color;
    (function (Color) {
        /**
         * Creates a new Color literal.
         */
        function create(red, green, blue, alpha) {
            return {
                red: red,
                green: green,
                blue: blue,
                alpha: alpha,
            };
        }
        Color.create = create;
        /**
         * Checks whether the given literal conforms to the {@link Color} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(candidate) && Is.numberRange(candidate.red, 0, 1)
                && Is.numberRange(candidate.green, 0, 1)
                && Is.numberRange(candidate.blue, 0, 1)
                && Is.numberRange(candidate.alpha, 0, 1);
        }
        Color.is = is;
    })(Color || (exports.Color = Color = {}));
    /**
     * The ColorInformation namespace provides helper functions to work with
     * {@link ColorInformation} literals.
     */
    var ColorInformation;
    (function (ColorInformation) {
        /**
         * Creates a new ColorInformation literal.
         */
        function create(range, color) {
            return {
                range: range,
                color: color,
            };
        }
        ColorInformation.create = create;
        /**
         * Checks whether the given literal conforms to the {@link ColorInformation} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(candidate) && Range.is(candidate.range) && Color.is(candidate.color);
        }
        ColorInformation.is = is;
    })(ColorInformation || (exports.ColorInformation = ColorInformation = {}));
    /**
     * The Color namespace provides helper functions to work with
     * {@link ColorPresentation} literals.
     */
    var ColorPresentation;
    (function (ColorPresentation) {
        /**
         * Creates a new ColorInformation literal.
         */
        function create(label, textEdit, additionalTextEdits) {
            return {
                label: label,
                textEdit: textEdit,
                additionalTextEdits: additionalTextEdits,
            };
        }
        ColorPresentation.create = create;
        /**
         * Checks whether the given literal conforms to the {@link ColorInformation} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(candidate) && Is.string(candidate.label)
                && (Is.undefined(candidate.textEdit) || TextEdit.is(candidate))
                && (Is.undefined(candidate.additionalTextEdits) || Is.typedArray(candidate.additionalTextEdits, TextEdit.is));
        }
        ColorPresentation.is = is;
    })(ColorPresentation || (exports.ColorPresentation = ColorPresentation = {}));
    /**
     * A set of predefined range kinds.
     */
    var FoldingRangeKind;
    (function (FoldingRangeKind) {
        /**
         * Folding range for a comment
         */
        FoldingRangeKind.Comment = 'comment';
        /**
         * Folding range for an import or include
         */
        FoldingRangeKind.Imports = 'imports';
        /**
         * Folding range for a region (e.g. `#region`)
         */
        FoldingRangeKind.Region = 'region';
    })(FoldingRangeKind || (exports.FoldingRangeKind = FoldingRangeKind = {}));
    /**
     * The folding range namespace provides helper functions to work with
     * {@link FoldingRange} literals.
     */
    var FoldingRange;
    (function (FoldingRange) {
        /**
         * Creates a new FoldingRange literal.
         */
        function create(startLine, endLine, startCharacter, endCharacter, kind, collapsedText) {
            var result = {
                startLine: startLine,
                endLine: endLine
            };
            if (Is.defined(startCharacter)) {
                result.startCharacter = startCharacter;
            }
            if (Is.defined(endCharacter)) {
                result.endCharacter = endCharacter;
            }
            if (Is.defined(kind)) {
                result.kind = kind;
            }
            if (Is.defined(collapsedText)) {
                result.collapsedText = collapsedText;
            }
            return result;
        }
        FoldingRange.create = create;
        /**
         * Checks whether the given literal conforms to the {@link FoldingRange} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(candidate) && Is.uinteger(candidate.startLine) && Is.uinteger(candidate.startLine)
                && (Is.undefined(candidate.startCharacter) || Is.uinteger(candidate.startCharacter))
                && (Is.undefined(candidate.endCharacter) || Is.uinteger(candidate.endCharacter))
                && (Is.undefined(candidate.kind) || Is.string(candidate.kind));
        }
        FoldingRange.is = is;
    })(FoldingRange || (exports.FoldingRange = FoldingRange = {}));
    /**
     * The DiagnosticRelatedInformation namespace provides helper functions to work with
     * {@link DiagnosticRelatedInformation} literals.
     */
    var DiagnosticRelatedInformation;
    (function (DiagnosticRelatedInformation) {
        /**
         * Creates a new DiagnosticRelatedInformation literal.
         */
        function create(location, message) {
            return {
                location: location,
                message: message
            };
        }
        DiagnosticRelatedInformation.create = create;
        /**
         * Checks whether the given literal conforms to the {@link DiagnosticRelatedInformation} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.defined(candidate) && Location.is(candidate.location) && Is.string(candidate.message);
        }
        DiagnosticRelatedInformation.is = is;
    })(DiagnosticRelatedInformation || (exports.DiagnosticRelatedInformation = DiagnosticRelatedInformation = {}));
    /**
     * The diagnostic's severity.
     */
    var DiagnosticSeverity;
    (function (DiagnosticSeverity) {
        /**
         * Reports an error.
         */
        DiagnosticSeverity.Error = 1;
        /**
         * Reports a warning.
         */
        DiagnosticSeverity.Warning = 2;
        /**
         * Reports an information.
         */
        DiagnosticSeverity.Information = 3;
        /**
         * Reports a hint.
         */
        DiagnosticSeverity.Hint = 4;
    })(DiagnosticSeverity || (exports.DiagnosticSeverity = DiagnosticSeverity = {}));
    /**
     * The diagnostic tags.
     *
     * @since 3.15.0
     */
    var DiagnosticTag;
    (function (DiagnosticTag) {
        /**
         * Unused or unnecessary code.
         *
         * Clients are allowed to render diagnostics with this tag faded out instead of having
         * an error squiggle.
         */
        DiagnosticTag.Unnecessary = 1;
        /**
         * Deprecated or obsolete code.
         *
         * Clients are allowed to rendered diagnostics with this tag strike through.
         */
        DiagnosticTag.Deprecated = 2;
    })(DiagnosticTag || (exports.DiagnosticTag = DiagnosticTag = {}));
    /**
     * The CodeDescription namespace provides functions to deal with descriptions for diagnostic codes.
     *
     * @since 3.16.0
     */
    var CodeDescription;
    (function (CodeDescription) {
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(candidate) && Is.string(candidate.href);
        }
        CodeDescription.is = is;
    })(CodeDescription || (exports.CodeDescription = CodeDescription = {}));
    /**
     * The Diagnostic namespace provides helper functions to work with
     * {@link Diagnostic} literals.
     */
    var Diagnostic;
    (function (Diagnostic) {
        /**
         * Creates a new Diagnostic literal.
         */
        function create(range, message, severity, code, source, relatedInformation) {
            var result = { range: range, message: message };
            if (Is.defined(severity)) {
                result.severity = severity;
            }
            if (Is.defined(code)) {
                result.code = code;
            }
            if (Is.defined(source)) {
                result.source = source;
            }
            if (Is.defined(relatedInformation)) {
                result.relatedInformation = relatedInformation;
            }
            return result;
        }
        Diagnostic.create = create;
        /**
         * Checks whether the given literal conforms to the {@link Diagnostic} interface.
         */
        function is(value) {
            var _a;
            var candidate = value;
            return Is.defined(candidate)
                && Range.is(candidate.range)
                && Is.string(candidate.message)
                && (Is.number(candidate.severity) || Is.undefined(candidate.severity))
                && (Is.integer(candidate.code) || Is.string(candidate.code) || Is.undefined(candidate.code))
                && (Is.undefined(candidate.codeDescription) || (Is.string((_a = candidate.codeDescription) === null || _a === void 0 ? void 0 : _a.href)))
                && (Is.string(candidate.source) || Is.undefined(candidate.source))
                && (Is.undefined(candidate.relatedInformation) || Is.typedArray(candidate.relatedInformation, DiagnosticRelatedInformation.is));
        }
        Diagnostic.is = is;
    })(Diagnostic || (exports.Diagnostic = Diagnostic = {}));
    /**
     * The Command namespace provides helper functions to work with
     * {@link Command} literals.
     */
    var Command;
    (function (Command) {
        /**
         * Creates a new Command literal.
         */
        function create(title, command) {
            var args = [];
            for (var _i = 2; _i < arguments.length; _i++) {
                args[_i - 2] = arguments[_i];
            }
            var result = { title: title, command: command };
            if (Is.defined(args) && args.length > 0) {
                result.arguments = args;
            }
            return result;
        }
        Command.create = create;
        /**
         * Checks whether the given literal conforms to the {@link Command} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.defined(candidate) && Is.string(candidate.title) && Is.string(candidate.command);
        }
        Command.is = is;
    })(Command || (exports.Command = Command = {}));
    /**
     * The TextEdit namespace provides helper function to create replace,
     * insert and delete edits more easily.
     */
    var TextEdit;
    (function (TextEdit) {
        /**
         * Creates a replace text edit.
         * @param range The range of text to be replaced.
         * @param newText The new text.
         */
        function replace(range, newText) {
            return { range: range, newText: newText };
        }
        TextEdit.replace = replace;
        /**
         * Creates an insert text edit.
         * @param position The position to insert the text at.
         * @param newText The text to be inserted.
         */
        function insert(position, newText) {
            return { range: { start: position, end: position }, newText: newText };
        }
        TextEdit.insert = insert;
        /**
         * Creates a delete text edit.
         * @param range The range of text to be deleted.
         */
        function del(range) {
            return { range: range, newText: '' };
        }
        TextEdit.del = del;
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(candidate)
                && Is.string(candidate.newText)
                && Range.is(candidate.range);
        }
        TextEdit.is = is;
    })(TextEdit || (exports.TextEdit = TextEdit = {}));
    var ChangeAnnotation;
    (function (ChangeAnnotation) {
        function create(label, needsConfirmation, description) {
            var result = { label: label };
            if (needsConfirmation !== undefined) {
                result.needsConfirmation = needsConfirmation;
            }
            if (description !== undefined) {
                result.description = description;
            }
            return result;
        }
        ChangeAnnotation.create = create;
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(candidate) && Is.string(candidate.label) &&
                (Is.boolean(candidate.needsConfirmation) || candidate.needsConfirmation === undefined) &&
                (Is.string(candidate.description) || candidate.description === undefined);
        }
        ChangeAnnotation.is = is;
    })(ChangeAnnotation || (exports.ChangeAnnotation = ChangeAnnotation = {}));
    var ChangeAnnotationIdentifier;
    (function (ChangeAnnotationIdentifier) {
        function is(value) {
            var candidate = value;
            return Is.string(candidate);
        }
        ChangeAnnotationIdentifier.is = is;
    })(ChangeAnnotationIdentifier || (exports.ChangeAnnotationIdentifier = ChangeAnnotationIdentifier = {}));
    var AnnotatedTextEdit;
    (function (AnnotatedTextEdit) {
        /**
         * Creates an annotated replace text edit.
         *
         * @param range The range of text to be replaced.
         * @param newText The new text.
         * @param annotation The annotation.
         */
        function replace(range, newText, annotation) {
            return { range: range, newText: newText, annotationId: annotation };
        }
        AnnotatedTextEdit.replace = replace;
        /**
         * Creates an annotated insert text edit.
         *
         * @param position The position to insert the text at.
         * @param newText The text to be inserted.
         * @param annotation The annotation.
         */
        function insert(position, newText, annotation) {
            return { range: { start: position, end: position }, newText: newText, annotationId: annotation };
        }
        AnnotatedTextEdit.insert = insert;
        /**
         * Creates an annotated delete text edit.
         *
         * @param range The range of text to be deleted.
         * @param annotation The annotation.
         */
        function del(range, annotation) {
            return { range: range, newText: '', annotationId: annotation };
        }
        AnnotatedTextEdit.del = del;
        function is(value) {
            var candidate = value;
            return TextEdit.is(candidate) && (ChangeAnnotation.is(candidate.annotationId) || ChangeAnnotationIdentifier.is(candidate.annotationId));
        }
        AnnotatedTextEdit.is = is;
    })(AnnotatedTextEdit || (exports.AnnotatedTextEdit = AnnotatedTextEdit = {}));
    /**
     * The TextDocumentEdit namespace provides helper function to create
     * an edit that manipulates a text document.
     */
    var TextDocumentEdit;
    (function (TextDocumentEdit) {
        /**
         * Creates a new `TextDocumentEdit`
         */
        function create(textDocument, edits) {
            return { textDocument: textDocument, edits: edits };
        }
        TextDocumentEdit.create = create;
        function is(value) {
            var candidate = value;
            return Is.defined(candidate)
                && OptionalVersionedTextDocumentIdentifier.is(candidate.textDocument)
                && Array.isArray(candidate.edits);
        }
        TextDocumentEdit.is = is;
    })(TextDocumentEdit || (exports.TextDocumentEdit = TextDocumentEdit = {}));
    var CreateFile;
    (function (CreateFile) {
        function create(uri, options, annotation) {
            var result = {
                kind: 'create',
                uri: uri
            };
            if (options !== undefined && (options.overwrite !== undefined || options.ignoreIfExists !== undefined)) {
                result.options = options;
            }
            if (annotation !== undefined) {
                result.annotationId = annotation;
            }
            return result;
        }
        CreateFile.create = create;
        function is(value) {
            var candidate = value;
            return candidate && candidate.kind === 'create' && Is.string(candidate.uri) && (candidate.options === undefined ||
                ((candidate.options.overwrite === undefined || Is.boolean(candidate.options.overwrite)) && (candidate.options.ignoreIfExists === undefined || Is.boolean(candidate.options.ignoreIfExists)))) && (candidate.annotationId === undefined || ChangeAnnotationIdentifier.is(candidate.annotationId));
        }
        CreateFile.is = is;
    })(CreateFile || (exports.CreateFile = CreateFile = {}));
    var RenameFile;
    (function (RenameFile) {
        function create(oldUri, newUri, options, annotation) {
            var result = {
                kind: 'rename',
                oldUri: oldUri,
                newUri: newUri
            };
            if (options !== undefined && (options.overwrite !== undefined || options.ignoreIfExists !== undefined)) {
                result.options = options;
            }
            if (annotation !== undefined) {
                result.annotationId = annotation;
            }
            return result;
        }
        RenameFile.create = create;
        function is(value) {
            var candidate = value;
            return candidate && candidate.kind === 'rename' && Is.string(candidate.oldUri) && Is.string(candidate.newUri) && (candidate.options === undefined ||
                ((candidate.options.overwrite === undefined || Is.boolean(candidate.options.overwrite)) && (candidate.options.ignoreIfExists === undefined || Is.boolean(candidate.options.ignoreIfExists)))) && (candidate.annotationId === undefined || ChangeAnnotationIdentifier.is(candidate.annotationId));
        }
        RenameFile.is = is;
    })(RenameFile || (exports.RenameFile = RenameFile = {}));
    var DeleteFile;
    (function (DeleteFile) {
        function create(uri, options, annotation) {
            var result = {
                kind: 'delete',
                uri: uri
            };
            if (options !== undefined && (options.recursive !== undefined || options.ignoreIfNotExists !== undefined)) {
                result.options = options;
            }
            if (annotation !== undefined) {
                result.annotationId = annotation;
            }
            return result;
        }
        DeleteFile.create = create;
        function is(value) {
            var candidate = value;
            return candidate && candidate.kind === 'delete' && Is.string(candidate.uri) && (candidate.options === undefined ||
                ((candidate.options.recursive === undefined || Is.boolean(candidate.options.recursive)) && (candidate.options.ignoreIfNotExists === undefined || Is.boolean(candidate.options.ignoreIfNotExists)))) && (candidate.annotationId === undefined || ChangeAnnotationIdentifier.is(candidate.annotationId));
        }
        DeleteFile.is = is;
    })(DeleteFile || (exports.DeleteFile = DeleteFile = {}));
    var WorkspaceEdit;
    (function (WorkspaceEdit) {
        function is(value) {
            var candidate = value;
            return candidate &&
                (candidate.changes !== undefined || candidate.documentChanges !== undefined) &&
                (candidate.documentChanges === undefined || candidate.documentChanges.every(function (change) {
                    if (Is.string(change.kind)) {
                        return CreateFile.is(change) || RenameFile.is(change) || DeleteFile.is(change);
                    }
                    else {
                        return TextDocumentEdit.is(change);
                    }
                }));
        }
        WorkspaceEdit.is = is;
    })(WorkspaceEdit || (exports.WorkspaceEdit = WorkspaceEdit = {}));
    var TextEditChangeImpl = /** @class */ (function () {
        function TextEditChangeImpl(edits, changeAnnotations) {
            this.edits = edits;
            this.changeAnnotations = changeAnnotations;
        }
        TextEditChangeImpl.prototype.insert = function (position, newText, annotation) {
            var edit;
            var id;
            if (annotation === undefined) {
                edit = TextEdit.insert(position, newText);
            }
            else if (ChangeAnnotationIdentifier.is(annotation)) {
                id = annotation;
                edit = AnnotatedTextEdit.insert(position, newText, annotation);
            }
            else {
                this.assertChangeAnnotations(this.changeAnnotations);
                id = this.changeAnnotations.manage(annotation);
                edit = AnnotatedTextEdit.insert(position, newText, id);
            }
            this.edits.push(edit);
            if (id !== undefined) {
                return id;
            }
        };
        TextEditChangeImpl.prototype.replace = function (range, newText, annotation) {
            var edit;
            var id;
            if (annotation === undefined) {
                edit = TextEdit.replace(range, newText);
            }
            else if (ChangeAnnotationIdentifier.is(annotation)) {
                id = annotation;
                edit = AnnotatedTextEdit.replace(range, newText, annotation);
            }
            else {
                this.assertChangeAnnotations(this.changeAnnotations);
                id = this.changeAnnotations.manage(annotation);
                edit = AnnotatedTextEdit.replace(range, newText, id);
            }
            this.edits.push(edit);
            if (id !== undefined) {
                return id;
            }
        };
        TextEditChangeImpl.prototype.delete = function (range, annotation) {
            var edit;
            var id;
            if (annotation === undefined) {
                edit = TextEdit.del(range);
            }
            else if (ChangeAnnotationIdentifier.is(annotation)) {
                id = annotation;
                edit = AnnotatedTextEdit.del(range, annotation);
            }
            else {
                this.assertChangeAnnotations(this.changeAnnotations);
                id = this.changeAnnotations.manage(annotation);
                edit = AnnotatedTextEdit.del(range, id);
            }
            this.edits.push(edit);
            if (id !== undefined) {
                return id;
            }
        };
        TextEditChangeImpl.prototype.add = function (edit) {
            this.edits.push(edit);
        };
        TextEditChangeImpl.prototype.all = function () {
            return this.edits;
        };
        TextEditChangeImpl.prototype.clear = function () {
            this.edits.splice(0, this.edits.length);
        };
        TextEditChangeImpl.prototype.assertChangeAnnotations = function (value) {
            if (value === undefined) {
                throw new Error("Text edit change is not configured to manage change annotations.");
            }
        };
        return TextEditChangeImpl;
    }());
    /**
     * A helper class
     */
    var ChangeAnnotations = /** @class */ (function () {
        function ChangeAnnotations(annotations) {
            this._annotations = annotations === undefined ? Object.create(null) : annotations;
            this._counter = 0;
            this._size = 0;
        }
        ChangeAnnotations.prototype.all = function () {
            return this._annotations;
        };
        Object.defineProperty(ChangeAnnotations.prototype, "size", {
            get: function () {
                return this._size;
            },
            enumerable: false,
            configurable: true
        });
        ChangeAnnotations.prototype.manage = function (idOrAnnotation, annotation) {
            var id;
            if (ChangeAnnotationIdentifier.is(idOrAnnotation)) {
                id = idOrAnnotation;
            }
            else {
                id = this.nextId();
                annotation = idOrAnnotation;
            }
            if (this._annotations[id] !== undefined) {
                throw new Error("Id ".concat(id, " is already in use."));
            }
            if (annotation === undefined) {
                throw new Error("No annotation provided for id ".concat(id));
            }
            this._annotations[id] = annotation;
            this._size++;
            return id;
        };
        ChangeAnnotations.prototype.nextId = function () {
            this._counter++;
            return this._counter.toString();
        };
        return ChangeAnnotations;
    }());
    /**
     * A workspace change helps constructing changes to a workspace.
     */
    var WorkspaceChange = /** @class */ (function () {
        function WorkspaceChange(workspaceEdit) {
            var _this = this;
            this._textEditChanges = Object.create(null);
            if (workspaceEdit !== undefined) {
                this._workspaceEdit = workspaceEdit;
                if (workspaceEdit.documentChanges) {
                    this._changeAnnotations = new ChangeAnnotations(workspaceEdit.changeAnnotations);
                    workspaceEdit.changeAnnotations = this._changeAnnotations.all();
                    workspaceEdit.documentChanges.forEach(function (change) {
                        if (TextDocumentEdit.is(change)) {
                            var textEditChange = new TextEditChangeImpl(change.edits, _this._changeAnnotations);
                            _this._textEditChanges[change.textDocument.uri] = textEditChange;
                        }
                    });
                }
                else if (workspaceEdit.changes) {
                    Object.keys(workspaceEdit.changes).forEach(function (key) {
                        var textEditChange = new TextEditChangeImpl(workspaceEdit.changes[key]);
                        _this._textEditChanges[key] = textEditChange;
                    });
                }
            }
            else {
                this._workspaceEdit = {};
            }
        }
        Object.defineProperty(WorkspaceChange.prototype, "edit", {
            /**
             * Returns the underlying {@link WorkspaceEdit} literal
             * use to be returned from a workspace edit operation like rename.
             */
            get: function () {
                this.initDocumentChanges();
                if (this._changeAnnotations !== undefined) {
                    if (this._changeAnnotations.size === 0) {
                        this._workspaceEdit.changeAnnotations = undefined;
                    }
                    else {
                        this._workspaceEdit.changeAnnotations = this._changeAnnotations.all();
                    }
                }
                return this._workspaceEdit;
            },
            enumerable: false,
            configurable: true
        });
        WorkspaceChange.prototype.getTextEditChange = function (key) {
            if (OptionalVersionedTextDocumentIdentifier.is(key)) {
                this.initDocumentChanges();
                if (this._workspaceEdit.documentChanges === undefined) {
                    throw new Error('Workspace edit is not configured for document changes.');
                }
                var textDocument = { uri: key.uri, version: key.version };
                var result = this._textEditChanges[textDocument.uri];
                if (!result) {
                    var edits = [];
                    var textDocumentEdit = {
                        textDocument: textDocument,
                        edits: edits
                    };
                    this._workspaceEdit.documentChanges.push(textDocumentEdit);
                    result = new TextEditChangeImpl(edits, this._changeAnnotations);
                    this._textEditChanges[textDocument.uri] = result;
                }
                return result;
            }
            else {
                this.initChanges();
                if (this._workspaceEdit.changes === undefined) {
                    throw new Error('Workspace edit is not configured for normal text edit changes.');
                }
                var result = this._textEditChanges[key];
                if (!result) {
                    var edits = [];
                    this._workspaceEdit.changes[key] = edits;
                    result = new TextEditChangeImpl(edits);
                    this._textEditChanges[key] = result;
                }
                return result;
            }
        };
        WorkspaceChange.prototype.initDocumentChanges = function () {
            if (this._workspaceEdit.documentChanges === undefined && this._workspaceEdit.changes === undefined) {
                this._changeAnnotations = new ChangeAnnotations();
                this._workspaceEdit.documentChanges = [];
                this._workspaceEdit.changeAnnotations = this._changeAnnotations.all();
            }
        };
        WorkspaceChange.prototype.initChanges = function () {
            if (this._workspaceEdit.documentChanges === undefined && this._workspaceEdit.changes === undefined) {
                this._workspaceEdit.changes = Object.create(null);
            }
        };
        WorkspaceChange.prototype.createFile = function (uri, optionsOrAnnotation, options) {
            this.initDocumentChanges();
            if (this._workspaceEdit.documentChanges === undefined) {
                throw new Error('Workspace edit is not configured for document changes.');
            }
            var annotation;
            if (ChangeAnnotation.is(optionsOrAnnotation) || ChangeAnnotationIdentifier.is(optionsOrAnnotation)) {
                annotation = optionsOrAnnotation;
            }
            else {
                options = optionsOrAnnotation;
            }
            var operation;
            var id;
            if (annotation === undefined) {
                operation = CreateFile.create(uri, options);
            }
            else {
                id = ChangeAnnotationIdentifier.is(annotation) ? annotation : this._changeAnnotations.manage(annotation);
                operation = CreateFile.create(uri, options, id);
            }
            this._workspaceEdit.documentChanges.push(operation);
            if (id !== undefined) {
                return id;
            }
        };
        WorkspaceChange.prototype.renameFile = function (oldUri, newUri, optionsOrAnnotation, options) {
            this.initDocumentChanges();
            if (this._workspaceEdit.documentChanges === undefined) {
                throw new Error('Workspace edit is not configured for document changes.');
            }
            var annotation;
            if (ChangeAnnotation.is(optionsOrAnnotation) || ChangeAnnotationIdentifier.is(optionsOrAnnotation)) {
                annotation = optionsOrAnnotation;
            }
            else {
                options = optionsOrAnnotation;
            }
            var operation;
            var id;
            if (annotation === undefined) {
                operation = RenameFile.create(oldUri, newUri, options);
            }
            else {
                id = ChangeAnnotationIdentifier.is(annotation) ? annotation : this._changeAnnotations.manage(annotation);
                operation = RenameFile.create(oldUri, newUri, options, id);
            }
            this._workspaceEdit.documentChanges.push(operation);
            if (id !== undefined) {
                return id;
            }
        };
        WorkspaceChange.prototype.deleteFile = function (uri, optionsOrAnnotation, options) {
            this.initDocumentChanges();
            if (this._workspaceEdit.documentChanges === undefined) {
                throw new Error('Workspace edit is not configured for document changes.');
            }
            var annotation;
            if (ChangeAnnotation.is(optionsOrAnnotation) || ChangeAnnotationIdentifier.is(optionsOrAnnotation)) {
                annotation = optionsOrAnnotation;
            }
            else {
                options = optionsOrAnnotation;
            }
            var operation;
            var id;
            if (annotation === undefined) {
                operation = DeleteFile.create(uri, options);
            }
            else {
                id = ChangeAnnotationIdentifier.is(annotation) ? annotation : this._changeAnnotations.manage(annotation);
                operation = DeleteFile.create(uri, options, id);
            }
            this._workspaceEdit.documentChanges.push(operation);
            if (id !== undefined) {
                return id;
            }
        };
        return WorkspaceChange;
    }());
    exports.WorkspaceChange = WorkspaceChange;
    /**
     * The TextDocumentIdentifier namespace provides helper functions to work with
     * {@link TextDocumentIdentifier} literals.
     */
    var TextDocumentIdentifier;
    (function (TextDocumentIdentifier) {
        /**
         * Creates a new TextDocumentIdentifier literal.
         * @param uri The document's uri.
         */
        function create(uri) {
            return { uri: uri };
        }
        TextDocumentIdentifier.create = create;
        /**
         * Checks whether the given literal conforms to the {@link TextDocumentIdentifier} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.defined(candidate) && Is.string(candidate.uri);
        }
        TextDocumentIdentifier.is = is;
    })(TextDocumentIdentifier || (exports.TextDocumentIdentifier = TextDocumentIdentifier = {}));
    /**
     * The VersionedTextDocumentIdentifier namespace provides helper functions to work with
     * {@link VersionedTextDocumentIdentifier} literals.
     */
    var VersionedTextDocumentIdentifier;
    (function (VersionedTextDocumentIdentifier) {
        /**
         * Creates a new VersionedTextDocumentIdentifier literal.
         * @param uri The document's uri.
         * @param version The document's version.
         */
        function create(uri, version) {
            return { uri: uri, version: version };
        }
        VersionedTextDocumentIdentifier.create = create;
        /**
         * Checks whether the given literal conforms to the {@link VersionedTextDocumentIdentifier} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.defined(candidate) && Is.string(candidate.uri) && Is.integer(candidate.version);
        }
        VersionedTextDocumentIdentifier.is = is;
    })(VersionedTextDocumentIdentifier || (exports.VersionedTextDocumentIdentifier = VersionedTextDocumentIdentifier = {}));
    /**
     * The OptionalVersionedTextDocumentIdentifier namespace provides helper functions to work with
     * {@link OptionalVersionedTextDocumentIdentifier} literals.
     */
    var OptionalVersionedTextDocumentIdentifier;
    (function (OptionalVersionedTextDocumentIdentifier) {
        /**
         * Creates a new OptionalVersionedTextDocumentIdentifier literal.
         * @param uri The document's uri.
         * @param version The document's version.
         */
        function create(uri, version) {
            return { uri: uri, version: version };
        }
        OptionalVersionedTextDocumentIdentifier.create = create;
        /**
         * Checks whether the given literal conforms to the {@link OptionalVersionedTextDocumentIdentifier} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.defined(candidate) && Is.string(candidate.uri) && (candidate.version === null || Is.integer(candidate.version));
        }
        OptionalVersionedTextDocumentIdentifier.is = is;
    })(OptionalVersionedTextDocumentIdentifier || (exports.OptionalVersionedTextDocumentIdentifier = OptionalVersionedTextDocumentIdentifier = {}));
    /**
     * The TextDocumentItem namespace provides helper functions to work with
     * {@link TextDocumentItem} literals.
     */
    var TextDocumentItem;
    (function (TextDocumentItem) {
        /**
         * Creates a new TextDocumentItem literal.
         * @param uri The document's uri.
         * @param languageId The document's language identifier.
         * @param version The document's version number.
         * @param text The document's text.
         */
        function create(uri, languageId, version, text) {
            return { uri: uri, languageId: languageId, version: version, text: text };
        }
        TextDocumentItem.create = create;
        /**
         * Checks whether the given literal conforms to the {@link TextDocumentItem} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.defined(candidate) && Is.string(candidate.uri) && Is.string(candidate.languageId) && Is.integer(candidate.version) && Is.string(candidate.text);
        }
        TextDocumentItem.is = is;
    })(TextDocumentItem || (exports.TextDocumentItem = TextDocumentItem = {}));
    /**
     * Describes the content type that a client supports in various
     * result literals like `Hover`, `ParameterInfo` or `CompletionItem`.
     *
     * Please note that `MarkupKinds` must not start with a `$`. This kinds
     * are reserved for internal usage.
     */
    var MarkupKind;
    (function (MarkupKind) {
        /**
         * Plain text is supported as a content format
         */
        MarkupKind.PlainText = 'plaintext';
        /**
         * Markdown is supported as a content format
         */
        MarkupKind.Markdown = 'markdown';
        /**
         * Checks whether the given value is a value of the {@link MarkupKind} type.
         */
        function is(value) {
            var candidate = value;
            return candidate === MarkupKind.PlainText || candidate === MarkupKind.Markdown;
        }
        MarkupKind.is = is;
    })(MarkupKind || (exports.MarkupKind = MarkupKind = {}));
    var MarkupContent;
    (function (MarkupContent) {
        /**
         * Checks whether the given value conforms to the {@link MarkupContent} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(value) && MarkupKind.is(candidate.kind) && Is.string(candidate.value);
        }
        MarkupContent.is = is;
    })(MarkupContent || (exports.MarkupContent = MarkupContent = {}));
    /**
     * The kind of a completion entry.
     */
    var CompletionItemKind;
    (function (CompletionItemKind) {
        CompletionItemKind.Text = 1;
        CompletionItemKind.Method = 2;
        CompletionItemKind.Function = 3;
        CompletionItemKind.Constructor = 4;
        CompletionItemKind.Field = 5;
        CompletionItemKind.Variable = 6;
        CompletionItemKind.Class = 7;
        CompletionItemKind.Interface = 8;
        CompletionItemKind.Module = 9;
        CompletionItemKind.Property = 10;
        CompletionItemKind.Unit = 11;
        CompletionItemKind.Value = 12;
        CompletionItemKind.Enum = 13;
        CompletionItemKind.Keyword = 14;
        CompletionItemKind.Snippet = 15;
        CompletionItemKind.Color = 16;
        CompletionItemKind.File = 17;
        CompletionItemKind.Reference = 18;
        CompletionItemKind.Folder = 19;
        CompletionItemKind.EnumMember = 20;
        CompletionItemKind.Constant = 21;
        CompletionItemKind.Struct = 22;
        CompletionItemKind.Event = 23;
        CompletionItemKind.Operator = 24;
        CompletionItemKind.TypeParameter = 25;
    })(CompletionItemKind || (exports.CompletionItemKind = CompletionItemKind = {}));
    /**
     * Defines whether the insert text in a completion item should be interpreted as
     * plain text or a snippet.
     */
    var InsertTextFormat;
    (function (InsertTextFormat) {
        /**
         * The primary text to be inserted is treated as a plain string.
         */
        InsertTextFormat.PlainText = 1;
        /**
         * The primary text to be inserted is treated as a snippet.
         *
         * A snippet can define tab stops and placeholders with `$1`, `$2`
         * and `${3:foo}`. `$0` defines the final tab stop, it defaults to
         * the end of the snippet. Placeholders with equal identifiers are linked,
         * that is typing in one will update others too.
         *
         * See also: https://microsoft.github.io/language-server-protocol/specifications/specification-current/#snippet_syntax
         */
        InsertTextFormat.Snippet = 2;
    })(InsertTextFormat || (exports.InsertTextFormat = InsertTextFormat = {}));
    /**
     * Completion item tags are extra annotations that tweak the rendering of a completion
     * item.
     *
     * @since 3.15.0
     */
    var CompletionItemTag;
    (function (CompletionItemTag) {
        /**
         * Render a completion as obsolete, usually using a strike-out.
         */
        CompletionItemTag.Deprecated = 1;
    })(CompletionItemTag || (exports.CompletionItemTag = CompletionItemTag = {}));
    /**
     * The InsertReplaceEdit namespace provides functions to deal with insert / replace edits.
     *
     * @since 3.16.0
     */
    var InsertReplaceEdit;
    (function (InsertReplaceEdit) {
        /**
         * Creates a new insert / replace edit
         */
        function create(newText, insert, replace) {
            return { newText: newText, insert: insert, replace: replace };
        }
        InsertReplaceEdit.create = create;
        /**
         * Checks whether the given literal conforms to the {@link InsertReplaceEdit} interface.
         */
        function is(value) {
            var candidate = value;
            return candidate && Is.string(candidate.newText) && Range.is(candidate.insert) && Range.is(candidate.replace);
        }
        InsertReplaceEdit.is = is;
    })(InsertReplaceEdit || (exports.InsertReplaceEdit = InsertReplaceEdit = {}));
    /**
     * How whitespace and indentation is handled during completion
     * item insertion.
     *
     * @since 3.16.0
     */
    var InsertTextMode;
    (function (InsertTextMode) {
        /**
         * The insertion or replace strings is taken as it is. If the
         * value is multi line the lines below the cursor will be
         * inserted using the indentation defined in the string value.
         * The client will not apply any kind of adjustments to the
         * string.
         */
        InsertTextMode.asIs = 1;
        /**
         * The editor adjusts leading whitespace of new lines so that
         * they match the indentation up to the cursor of the line for
         * which the item is accepted.
         *
         * Consider a line like this: <2tabs><cursor><3tabs>foo. Accepting a
         * multi line completion item is indented using 2 tabs and all
         * following lines inserted will be indented using 2 tabs as well.
         */
        InsertTextMode.adjustIndentation = 2;
    })(InsertTextMode || (exports.InsertTextMode = InsertTextMode = {}));
    var CompletionItemLabelDetails;
    (function (CompletionItemLabelDetails) {
        function is(value) {
            var candidate = value;
            return candidate && (Is.string(candidate.detail) || candidate.detail === undefined) &&
                (Is.string(candidate.description) || candidate.description === undefined);
        }
        CompletionItemLabelDetails.is = is;
    })(CompletionItemLabelDetails || (exports.CompletionItemLabelDetails = CompletionItemLabelDetails = {}));
    /**
     * The CompletionItem namespace provides functions to deal with
     * completion items.
     */
    var CompletionItem;
    (function (CompletionItem) {
        /**
         * Create a completion item and seed it with a label.
         * @param label The completion item's label
         */
        function create(label) {
            return { label: label };
        }
        CompletionItem.create = create;
    })(CompletionItem || (exports.CompletionItem = CompletionItem = {}));
    /**
     * The CompletionList namespace provides functions to deal with
     * completion lists.
     */
    var CompletionList;
    (function (CompletionList) {
        /**
         * Creates a new completion list.
         *
         * @param items The completion items.
         * @param isIncomplete The list is not complete.
         */
        function create(items, isIncomplete) {
            return { items: items ? items : [], isIncomplete: !!isIncomplete };
        }
        CompletionList.create = create;
    })(CompletionList || (exports.CompletionList = CompletionList = {}));
    var MarkedString;
    (function (MarkedString) {
        /**
         * Creates a marked string from plain text.
         *
         * @param plainText The plain text.
         */
        function fromPlainText(plainText) {
            return plainText.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&'); // escape markdown syntax tokens: http://daringfireball.net/projects/markdown/syntax#backslash
        }
        MarkedString.fromPlainText = fromPlainText;
        /**
         * Checks whether the given value conforms to the {@link MarkedString} type.
         */
        function is(value) {
            var candidate = value;
            return Is.string(candidate) || (Is.objectLiteral(candidate) && Is.string(candidate.language) && Is.string(candidate.value));
        }
        MarkedString.is = is;
    })(MarkedString || (exports.MarkedString = MarkedString = {}));
    var Hover;
    (function (Hover) {
        /**
         * Checks whether the given value conforms to the {@link Hover} interface.
         */
        function is(value) {
            var candidate = value;
            return !!candidate && Is.objectLiteral(candidate) && (MarkupContent.is(candidate.contents) ||
                MarkedString.is(candidate.contents) ||
                Is.typedArray(candidate.contents, MarkedString.is)) && (value.range === undefined || Range.is(value.range));
        }
        Hover.is = is;
    })(Hover || (exports.Hover = Hover = {}));
    /**
     * The ParameterInformation namespace provides helper functions to work with
     * {@link ParameterInformation} literals.
     */
    var ParameterInformation;
    (function (ParameterInformation) {
        /**
         * Creates a new parameter information literal.
         *
         * @param label A label string.
         * @param documentation A doc string.
         */
        function create(label, documentation) {
            return documentation ? { label: label, documentation: documentation } : { label: label };
        }
        ParameterInformation.create = create;
    })(ParameterInformation || (exports.ParameterInformation = ParameterInformation = {}));
    /**
     * The SignatureInformation namespace provides helper functions to work with
     * {@link SignatureInformation} literals.
     */
    var SignatureInformation;
    (function (SignatureInformation) {
        function create(label, documentation) {
            var parameters = [];
            for (var _i = 2; _i < arguments.length; _i++) {
                parameters[_i - 2] = arguments[_i];
            }
            var result = { label: label };
            if (Is.defined(documentation)) {
                result.documentation = documentation;
            }
            if (Is.defined(parameters)) {
                result.parameters = parameters;
            }
            else {
                result.parameters = [];
            }
            return result;
        }
        SignatureInformation.create = create;
    })(SignatureInformation || (exports.SignatureInformation = SignatureInformation = {}));
    /**
     * A document highlight kind.
     */
    var DocumentHighlightKind;
    (function (DocumentHighlightKind) {
        /**
         * A textual occurrence.
         */
        DocumentHighlightKind.Text = 1;
        /**
         * Read-access of a symbol, like reading a variable.
         */
        DocumentHighlightKind.Read = 2;
        /**
         * Write-access of a symbol, like writing to a variable.
         */
        DocumentHighlightKind.Write = 3;
    })(DocumentHighlightKind || (exports.DocumentHighlightKind = DocumentHighlightKind = {}));
    /**
     * DocumentHighlight namespace to provide helper functions to work with
     * {@link DocumentHighlight} literals.
     */
    var DocumentHighlight;
    (function (DocumentHighlight) {
        /**
         * Create a DocumentHighlight object.
         * @param range The range the highlight applies to.
         * @param kind The highlight kind
         */
        function create(range, kind) {
            var result = { range: range };
            if (Is.number(kind)) {
                result.kind = kind;
            }
            return result;
        }
        DocumentHighlight.create = create;
    })(DocumentHighlight || (exports.DocumentHighlight = DocumentHighlight = {}));
    /**
     * A symbol kind.
     */
    var SymbolKind;
    (function (SymbolKind) {
        SymbolKind.File = 1;
        SymbolKind.Module = 2;
        SymbolKind.Namespace = 3;
        SymbolKind.Package = 4;
        SymbolKind.Class = 5;
        SymbolKind.Method = 6;
        SymbolKind.Property = 7;
        SymbolKind.Field = 8;
        SymbolKind.Constructor = 9;
        SymbolKind.Enum = 10;
        SymbolKind.Interface = 11;
        SymbolKind.Function = 12;
        SymbolKind.Variable = 13;
        SymbolKind.Constant = 14;
        SymbolKind.String = 15;
        SymbolKind.Number = 16;
        SymbolKind.Boolean = 17;
        SymbolKind.Array = 18;
        SymbolKind.Object = 19;
        SymbolKind.Key = 20;
        SymbolKind.Null = 21;
        SymbolKind.EnumMember = 22;
        SymbolKind.Struct = 23;
        SymbolKind.Event = 24;
        SymbolKind.Operator = 25;
        SymbolKind.TypeParameter = 26;
    })(SymbolKind || (exports.SymbolKind = SymbolKind = {}));
    /**
     * Symbol tags are extra annotations that tweak the rendering of a symbol.
     *
     * @since 3.16
     */
    var SymbolTag;
    (function (SymbolTag) {
        /**
         * Render a symbol as obsolete, usually using a strike-out.
         */
        SymbolTag.Deprecated = 1;
    })(SymbolTag || (exports.SymbolTag = SymbolTag = {}));
    var SymbolInformation;
    (function (SymbolInformation) {
        /**
         * Creates a new symbol information literal.
         *
         * @param name The name of the symbol.
         * @param kind The kind of the symbol.
         * @param range The range of the location of the symbol.
         * @param uri The resource of the location of symbol.
         * @param containerName The name of the symbol containing the symbol.
         */
        function create(name, kind, range, uri, containerName) {
            var result = {
                name: name,
                kind: kind,
                location: { uri: uri, range: range }
            };
            if (containerName) {
                result.containerName = containerName;
            }
            return result;
        }
        SymbolInformation.create = create;
    })(SymbolInformation || (exports.SymbolInformation = SymbolInformation = {}));
    var WorkspaceSymbol;
    (function (WorkspaceSymbol) {
        /**
         * Create a new workspace symbol.
         *
         * @param name The name of the symbol.
         * @param kind The kind of the symbol.
         * @param uri The resource of the location of the symbol.
         * @param range An options range of the location.
         * @returns A WorkspaceSymbol.
         */
        function create(name, kind, uri, range) {
            return range !== undefined
                ? { name: name, kind: kind, location: { uri: uri, range: range } }
                : { name: name, kind: kind, location: { uri: uri } };
        }
        WorkspaceSymbol.create = create;
    })(WorkspaceSymbol || (exports.WorkspaceSymbol = WorkspaceSymbol = {}));
    var DocumentSymbol;
    (function (DocumentSymbol) {
        /**
         * Creates a new symbol information literal.
         *
         * @param name The name of the symbol.
         * @param detail The detail of the symbol.
         * @param kind The kind of the symbol.
         * @param range The range of the symbol.
         * @param selectionRange The selectionRange of the symbol.
         * @param children Children of the symbol.
         */
        function create(name, detail, kind, range, selectionRange, children) {
            var result = {
                name: name,
                detail: detail,
                kind: kind,
                range: range,
                selectionRange: selectionRange
            };
            if (children !== undefined) {
                result.children = children;
            }
            return result;
        }
        DocumentSymbol.create = create;
        /**
         * Checks whether the given literal conforms to the {@link DocumentSymbol} interface.
         */
        function is(value) {
            var candidate = value;
            return candidate &&
                Is.string(candidate.name) && Is.number(candidate.kind) &&
                Range.is(candidate.range) && Range.is(candidate.selectionRange) &&
                (candidate.detail === undefined || Is.string(candidate.detail)) &&
                (candidate.deprecated === undefined || Is.boolean(candidate.deprecated)) &&
                (candidate.children === undefined || Array.isArray(candidate.children)) &&
                (candidate.tags === undefined || Array.isArray(candidate.tags));
        }
        DocumentSymbol.is = is;
    })(DocumentSymbol || (exports.DocumentSymbol = DocumentSymbol = {}));
    /**
     * A set of predefined code action kinds
     */
    var CodeActionKind;
    (function (CodeActionKind) {
        /**
         * Empty kind.
         */
        CodeActionKind.Empty = '';
        /**
         * Base kind for quickfix actions: 'quickfix'
         */
        CodeActionKind.QuickFix = 'quickfix';
        /**
         * Base kind for refactoring actions: 'refactor'
         */
        CodeActionKind.Refactor = 'refactor';
        /**
         * Base kind for refactoring extraction actions: 'refactor.extract'
         *
         * Example extract actions:
         *
         * - Extract method
         * - Extract function
         * - Extract variable
         * - Extract interface from class
         * - ...
         */
        CodeActionKind.RefactorExtract = 'refactor.extract';
        /**
         * Base kind for refactoring inline actions: 'refactor.inline'
         *
         * Example inline actions:
         *
         * - Inline function
         * - Inline variable
         * - Inline constant
         * - ...
         */
        CodeActionKind.RefactorInline = 'refactor.inline';
        /**
         * Base kind for refactoring rewrite actions: 'refactor.rewrite'
         *
         * Example rewrite actions:
         *
         * - Convert JavaScript function to class
         * - Add or remove parameter
         * - Encapsulate field
         * - Make method static
         * - Move method to base class
         * - ...
         */
        CodeActionKind.RefactorRewrite = 'refactor.rewrite';
        /**
         * Base kind for source actions: `source`
         *
         * Source code actions apply to the entire file.
         */
        CodeActionKind.Source = 'source';
        /**
         * Base kind for an organize imports source action: `source.organizeImports`
         */
        CodeActionKind.SourceOrganizeImports = 'source.organizeImports';
        /**
         * Base kind for auto-fix source actions: `source.fixAll`.
         *
         * Fix all actions automatically fix errors that have a clear fix that do not require user input.
         * They should not suppress errors or perform unsafe fixes such as generating new types or classes.
         *
         * @since 3.15.0
         */
        CodeActionKind.SourceFixAll = 'source.fixAll';
    })(CodeActionKind || (exports.CodeActionKind = CodeActionKind = {}));
    /**
     * The reason why code actions were requested.
     *
     * @since 3.17.0
     */
    var CodeActionTriggerKind;
    (function (CodeActionTriggerKind) {
        /**
         * Code actions were explicitly requested by the user or by an extension.
         */
        CodeActionTriggerKind.Invoked = 1;
        /**
         * Code actions were requested automatically.
         *
         * This typically happens when current selection in a file changes, but can
         * also be triggered when file content changes.
         */
        CodeActionTriggerKind.Automatic = 2;
    })(CodeActionTriggerKind || (exports.CodeActionTriggerKind = CodeActionTriggerKind = {}));
    /**
     * The CodeActionContext namespace provides helper functions to work with
     * {@link CodeActionContext} literals.
     */
    var CodeActionContext;
    (function (CodeActionContext) {
        /**
         * Creates a new CodeActionContext literal.
         */
        function create(diagnostics, only, triggerKind) {
            var result = { diagnostics: diagnostics };
            if (only !== undefined && only !== null) {
                result.only = only;
            }
            if (triggerKind !== undefined && triggerKind !== null) {
                result.triggerKind = triggerKind;
            }
            return result;
        }
        CodeActionContext.create = create;
        /**
         * Checks whether the given literal conforms to the {@link CodeActionContext} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.defined(candidate) && Is.typedArray(candidate.diagnostics, Diagnostic.is)
                && (candidate.only === undefined || Is.typedArray(candidate.only, Is.string))
                && (candidate.triggerKind === undefined || candidate.triggerKind === CodeActionTriggerKind.Invoked || candidate.triggerKind === CodeActionTriggerKind.Automatic);
        }
        CodeActionContext.is = is;
    })(CodeActionContext || (exports.CodeActionContext = CodeActionContext = {}));
    var CodeAction;
    (function (CodeAction) {
        function create(title, kindOrCommandOrEdit, kind) {
            var result = { title: title };
            var checkKind = true;
            if (typeof kindOrCommandOrEdit === 'string') {
                checkKind = false;
                result.kind = kindOrCommandOrEdit;
            }
            else if (Command.is(kindOrCommandOrEdit)) {
                result.command = kindOrCommandOrEdit;
            }
            else {
                result.edit = kindOrCommandOrEdit;
            }
            if (checkKind && kind !== undefined) {
                result.kind = kind;
            }
            return result;
        }
        CodeAction.create = create;
        function is(value) {
            var candidate = value;
            return candidate && Is.string(candidate.title) &&
                (candidate.diagnostics === undefined || Is.typedArray(candidate.diagnostics, Diagnostic.is)) &&
                (candidate.kind === undefined || Is.string(candidate.kind)) &&
                (candidate.edit !== undefined || candidate.command !== undefined) &&
                (candidate.command === undefined || Command.is(candidate.command)) &&
                (candidate.isPreferred === undefined || Is.boolean(candidate.isPreferred)) &&
                (candidate.edit === undefined || WorkspaceEdit.is(candidate.edit));
        }
        CodeAction.is = is;
    })(CodeAction || (exports.CodeAction = CodeAction = {}));
    /**
     * The CodeLens namespace provides helper functions to work with
     * {@link CodeLens} literals.
     */
    var CodeLens;
    (function (CodeLens) {
        /**
         * Creates a new CodeLens literal.
         */
        function create(range, data) {
            var result = { range: range };
            if (Is.defined(data)) {
                result.data = data;
            }
            return result;
        }
        CodeLens.create = create;
        /**
         * Checks whether the given literal conforms to the {@link CodeLens} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.defined(candidate) && Range.is(candidate.range) && (Is.undefined(candidate.command) || Command.is(candidate.command));
        }
        CodeLens.is = is;
    })(CodeLens || (exports.CodeLens = CodeLens = {}));
    /**
     * The FormattingOptions namespace provides helper functions to work with
     * {@link FormattingOptions} literals.
     */
    var FormattingOptions;
    (function (FormattingOptions) {
        /**
         * Creates a new FormattingOptions literal.
         */
        function create(tabSize, insertSpaces) {
            return { tabSize: tabSize, insertSpaces: insertSpaces };
        }
        FormattingOptions.create = create;
        /**
         * Checks whether the given literal conforms to the {@link FormattingOptions} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.defined(candidate) && Is.uinteger(candidate.tabSize) && Is.boolean(candidate.insertSpaces);
        }
        FormattingOptions.is = is;
    })(FormattingOptions || (exports.FormattingOptions = FormattingOptions = {}));
    /**
     * The DocumentLink namespace provides helper functions to work with
     * {@link DocumentLink} literals.
     */
    var DocumentLink;
    (function (DocumentLink) {
        /**
         * Creates a new DocumentLink literal.
         */
        function create(range, target, data) {
            return { range: range, target: target, data: data };
        }
        DocumentLink.create = create;
        /**
         * Checks whether the given literal conforms to the {@link DocumentLink} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.defined(candidate) && Range.is(candidate.range) && (Is.undefined(candidate.target) || Is.string(candidate.target));
        }
        DocumentLink.is = is;
    })(DocumentLink || (exports.DocumentLink = DocumentLink = {}));
    /**
     * The SelectionRange namespace provides helper function to work with
     * SelectionRange literals.
     */
    var SelectionRange;
    (function (SelectionRange) {
        /**
         * Creates a new SelectionRange
         * @param range the range.
         * @param parent an optional parent.
         */
        function create(range, parent) {
            return { range: range, parent: parent };
        }
        SelectionRange.create = create;
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(candidate) && Range.is(candidate.range) && (candidate.parent === undefined || SelectionRange.is(candidate.parent));
        }
        SelectionRange.is = is;
    })(SelectionRange || (exports.SelectionRange = SelectionRange = {}));
    /**
     * A set of predefined token types. This set is not fixed
     * an clients can specify additional token types via the
     * corresponding client capabilities.
     *
     * @since 3.16.0
     */
    var SemanticTokenTypes;
    (function (SemanticTokenTypes) {
        SemanticTokenTypes["namespace"] = "namespace";
        /**
         * Represents a generic type. Acts as a fallback for types which can't be mapped to
         * a specific type like class or enum.
         */
        SemanticTokenTypes["type"] = "type";
        SemanticTokenTypes["class"] = "class";
        SemanticTokenTypes["enum"] = "enum";
        SemanticTokenTypes["interface"] = "interface";
        SemanticTokenTypes["struct"] = "struct";
        SemanticTokenTypes["typeParameter"] = "typeParameter";
        SemanticTokenTypes["parameter"] = "parameter";
        SemanticTokenTypes["variable"] = "variable";
        SemanticTokenTypes["property"] = "property";
        SemanticTokenTypes["enumMember"] = "enumMember";
        SemanticTokenTypes["event"] = "event";
        SemanticTokenTypes["function"] = "function";
        SemanticTokenTypes["method"] = "method";
        SemanticTokenTypes["macro"] = "macro";
        SemanticTokenTypes["keyword"] = "keyword";
        SemanticTokenTypes["modifier"] = "modifier";
        SemanticTokenTypes["comment"] = "comment";
        SemanticTokenTypes["string"] = "string";
        SemanticTokenTypes["number"] = "number";
        SemanticTokenTypes["regexp"] = "regexp";
        SemanticTokenTypes["operator"] = "operator";
        /**
         * @since 3.17.0
         */
        SemanticTokenTypes["decorator"] = "decorator";
    })(SemanticTokenTypes || (exports.SemanticTokenTypes = SemanticTokenTypes = {}));
    /**
     * A set of predefined token modifiers. This set is not fixed
     * an clients can specify additional token types via the
     * corresponding client capabilities.
     *
     * @since 3.16.0
     */
    var SemanticTokenModifiers;
    (function (SemanticTokenModifiers) {
        SemanticTokenModifiers["declaration"] = "declaration";
        SemanticTokenModifiers["definition"] = "definition";
        SemanticTokenModifiers["readonly"] = "readonly";
        SemanticTokenModifiers["static"] = "static";
        SemanticTokenModifiers["deprecated"] = "deprecated";
        SemanticTokenModifiers["abstract"] = "abstract";
        SemanticTokenModifiers["async"] = "async";
        SemanticTokenModifiers["modification"] = "modification";
        SemanticTokenModifiers["documentation"] = "documentation";
        SemanticTokenModifiers["defaultLibrary"] = "defaultLibrary";
    })(SemanticTokenModifiers || (exports.SemanticTokenModifiers = SemanticTokenModifiers = {}));
    /**
     * @since 3.16.0
     */
    var SemanticTokens;
    (function (SemanticTokens) {
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(candidate) && (candidate.resultId === undefined || typeof candidate.resultId === 'string') &&
                Array.isArray(candidate.data) && (candidate.data.length === 0 || typeof candidate.data[0] === 'number');
        }
        SemanticTokens.is = is;
    })(SemanticTokens || (exports.SemanticTokens = SemanticTokens = {}));
    /**
     * The InlineValueText namespace provides functions to deal with InlineValueTexts.
     *
     * @since 3.17.0
     */
    var InlineValueText;
    (function (InlineValueText) {
        /**
         * Creates a new InlineValueText literal.
         */
        function create(range, text) {
            return { range: range, text: text };
        }
        InlineValueText.create = create;
        function is(value) {
            var candidate = value;
            return candidate !== undefined && candidate !== null && Range.is(candidate.range) && Is.string(candidate.text);
        }
        InlineValueText.is = is;
    })(InlineValueText || (exports.InlineValueText = InlineValueText = {}));
    /**
     * The InlineValueVariableLookup namespace provides functions to deal with InlineValueVariableLookups.
     *
     * @since 3.17.0
     */
    var InlineValueVariableLookup;
    (function (InlineValueVariableLookup) {
        /**
         * Creates a new InlineValueText literal.
         */
        function create(range, variableName, caseSensitiveLookup) {
            return { range: range, variableName: variableName, caseSensitiveLookup: caseSensitiveLookup };
        }
        InlineValueVariableLookup.create = create;
        function is(value) {
            var candidate = value;
            return candidate !== undefined && candidate !== null && Range.is(candidate.range) && Is.boolean(candidate.caseSensitiveLookup)
                && (Is.string(candidate.variableName) || candidate.variableName === undefined);
        }
        InlineValueVariableLookup.is = is;
    })(InlineValueVariableLookup || (exports.InlineValueVariableLookup = InlineValueVariableLookup = {}));
    /**
     * The InlineValueEvaluatableExpression namespace provides functions to deal with InlineValueEvaluatableExpression.
     *
     * @since 3.17.0
     */
    var InlineValueEvaluatableExpression;
    (function (InlineValueEvaluatableExpression) {
        /**
         * Creates a new InlineValueEvaluatableExpression literal.
         */
        function create(range, expression) {
            return { range: range, expression: expression };
        }
        InlineValueEvaluatableExpression.create = create;
        function is(value) {
            var candidate = value;
            return candidate !== undefined && candidate !== null && Range.is(candidate.range)
                && (Is.string(candidate.expression) || candidate.expression === undefined);
        }
        InlineValueEvaluatableExpression.is = is;
    })(InlineValueEvaluatableExpression || (exports.InlineValueEvaluatableExpression = InlineValueEvaluatableExpression = {}));
    /**
     * The InlineValueContext namespace provides helper functions to work with
     * {@link InlineValueContext} literals.
     *
     * @since 3.17.0
     */
    var InlineValueContext;
    (function (InlineValueContext) {
        /**
         * Creates a new InlineValueContext literal.
         */
        function create(frameId, stoppedLocation) {
            return { frameId: frameId, stoppedLocation: stoppedLocation };
        }
        InlineValueContext.create = create;
        /**
         * Checks whether the given literal conforms to the {@link InlineValueContext} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.defined(candidate) && Range.is(value.stoppedLocation);
        }
        InlineValueContext.is = is;
    })(InlineValueContext || (exports.InlineValueContext = InlineValueContext = {}));
    /**
     * Inlay hint kinds.
     *
     * @since 3.17.0
     */
    var InlayHintKind;
    (function (InlayHintKind) {
        /**
         * An inlay hint that for a type annotation.
         */
        InlayHintKind.Type = 1;
        /**
         * An inlay hint that is for a parameter.
         */
        InlayHintKind.Parameter = 2;
        function is(value) {
            return value === 1 || value === 2;
        }
        InlayHintKind.is = is;
    })(InlayHintKind || (exports.InlayHintKind = InlayHintKind = {}));
    var InlayHintLabelPart;
    (function (InlayHintLabelPart) {
        function create(value) {
            return { value: value };
        }
        InlayHintLabelPart.create = create;
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(candidate)
                && (candidate.tooltip === undefined || Is.string(candidate.tooltip) || MarkupContent.is(candidate.tooltip))
                && (candidate.location === undefined || Location.is(candidate.location))
                && (candidate.command === undefined || Command.is(candidate.command));
        }
        InlayHintLabelPart.is = is;
    })(InlayHintLabelPart || (exports.InlayHintLabelPart = InlayHintLabelPart = {}));
    var InlayHint;
    (function (InlayHint) {
        function create(position, label, kind) {
            var result = { position: position, label: label };
            if (kind !== undefined) {
                result.kind = kind;
            }
            return result;
        }
        InlayHint.create = create;
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(candidate) && Position.is(candidate.position)
                && (Is.string(candidate.label) || Is.typedArray(candidate.label, InlayHintLabelPart.is))
                && (candidate.kind === undefined || InlayHintKind.is(candidate.kind))
                && (candidate.textEdits === undefined) || Is.typedArray(candidate.textEdits, TextEdit.is)
                && (candidate.tooltip === undefined || Is.string(candidate.tooltip) || MarkupContent.is(candidate.tooltip))
                && (candidate.paddingLeft === undefined || Is.boolean(candidate.paddingLeft))
                && (candidate.paddingRight === undefined || Is.boolean(candidate.paddingRight));
        }
        InlayHint.is = is;
    })(InlayHint || (exports.InlayHint = InlayHint = {}));
    var StringValue;
    (function (StringValue) {
        function createSnippet(value) {
            return { kind: 'snippet', value: value };
        }
        StringValue.createSnippet = createSnippet;
    })(StringValue || (exports.StringValue = StringValue = {}));
    var InlineCompletionItem;
    (function (InlineCompletionItem) {
        function create(insertText, filterText, range, command) {
            return { insertText: insertText, filterText: filterText, range: range, command: command };
        }
        InlineCompletionItem.create = create;
    })(InlineCompletionItem || (exports.InlineCompletionItem = InlineCompletionItem = {}));
    var InlineCompletionList;
    (function (InlineCompletionList) {
        function create(items) {
            return { items: items };
        }
        InlineCompletionList.create = create;
    })(InlineCompletionList || (exports.InlineCompletionList = InlineCompletionList = {}));
    /**
     * Describes how an {@link InlineCompletionItemProvider inline completion provider} was triggered.
     *
     * @since 3.18.0
     * @proposed
     */
    var InlineCompletionTriggerKind;
    (function (InlineCompletionTriggerKind) {
        /**
         * Completion was triggered explicitly by a user gesture.
         */
        InlineCompletionTriggerKind.Invoked = 0;
        /**
         * Completion was triggered automatically while editing.
         */
        InlineCompletionTriggerKind.Automatic = 1;
    })(InlineCompletionTriggerKind || (exports.InlineCompletionTriggerKind = InlineCompletionTriggerKind = {}));
    var SelectedCompletionInfo;
    (function (SelectedCompletionInfo) {
        function create(range, text) {
            return { range: range, text: text };
        }
        SelectedCompletionInfo.create = create;
    })(SelectedCompletionInfo || (exports.SelectedCompletionInfo = SelectedCompletionInfo = {}));
    var InlineCompletionContext;
    (function (InlineCompletionContext) {
        function create(triggerKind, selectedCompletionInfo) {
            return { triggerKind: triggerKind, selectedCompletionInfo: selectedCompletionInfo };
        }
        InlineCompletionContext.create = create;
    })(InlineCompletionContext || (exports.InlineCompletionContext = InlineCompletionContext = {}));
    var WorkspaceFolder;
    (function (WorkspaceFolder) {
        function is(value) {
            var candidate = value;
            return Is.objectLiteral(candidate) && URI.is(candidate.uri) && Is.string(candidate.name);
        }
        WorkspaceFolder.is = is;
    })(WorkspaceFolder || (exports.WorkspaceFolder = WorkspaceFolder = {}));
    exports.EOL = ['\n', '\r\n', '\r'];
    /**
     * @deprecated Use the text document from the new vscode-languageserver-textdocument package.
     */
    var TextDocument;
    (function (TextDocument) {
        /**
         * Creates a new ITextDocument literal from the given uri and content.
         * @param uri The document's uri.
         * @param languageId The document's language Id.
         * @param version The document's version.
         * @param content The document's content.
         */
        function create(uri, languageId, version, content) {
            return new FullTextDocument(uri, languageId, version, content);
        }
        TextDocument.create = create;
        /**
         * Checks whether the given literal conforms to the {@link ITextDocument} interface.
         */
        function is(value) {
            var candidate = value;
            return Is.defined(candidate) && Is.string(candidate.uri) && (Is.undefined(candidate.languageId) || Is.string(candidate.languageId)) && Is.uinteger(candidate.lineCount)
                && Is.func(candidate.getText) && Is.func(candidate.positionAt) && Is.func(candidate.offsetAt) ? true : false;
        }
        TextDocument.is = is;
        function applyEdits(document, edits) {
            var text = document.getText();
            var sortedEdits = mergeSort(edits, function (a, b) {
                var diff = a.range.start.line - b.range.start.line;
                if (diff === 0) {
                    return a.range.start.character - b.range.start.character;
                }
                return diff;
            });
            var lastModifiedOffset = text.length;
            for (var i = sortedEdits.length - 1; i >= 0; i--) {
                var e = sortedEdits[i];
                var startOffset = document.offsetAt(e.range.start);
                var endOffset = document.offsetAt(e.range.end);
                if (endOffset <= lastModifiedOffset) {
                    text = text.substring(0, startOffset) + e.newText + text.substring(endOffset, text.length);
                }
                else {
                    throw new Error('Overlapping edit');
                }
                lastModifiedOffset = startOffset;
            }
            return text;
        }
        TextDocument.applyEdits = applyEdits;
        function mergeSort(data, compare) {
            if (data.length <= 1) {
                // sorted
                return data;
            }
            var p = (data.length / 2) | 0;
            var left = data.slice(0, p);
            var right = data.slice(p);
            mergeSort(left, compare);
            mergeSort(right, compare);
            var leftIdx = 0;
            var rightIdx = 0;
            var i = 0;
            while (leftIdx < left.length && rightIdx < right.length) {
                var ret = compare(left[leftIdx], right[rightIdx]);
                if (ret <= 0) {
                    // smaller_equal -> take left to preserve order
                    data[i++] = left[leftIdx++];
                }
                else {
                    // greater -> take right
                    data[i++] = right[rightIdx++];
                }
            }
            while (leftIdx < left.length) {
                data[i++] = left[leftIdx++];
            }
            while (rightIdx < right.length) {
                data[i++] = right[rightIdx++];
            }
            return data;
        }
    })(TextDocument || (exports.TextDocument = TextDocument = {}));
    /**
     * @deprecated Use the text document from the new vscode-languageserver-textdocument package.
     */
    var FullTextDocument = /** @class */ (function () {
        function FullTextDocument(uri, languageId, version, content) {
            this._uri = uri;
            this._languageId = languageId;
            this._version = version;
            this._content = content;
            this._lineOffsets = undefined;
        }
        Object.defineProperty(FullTextDocument.prototype, "uri", {
            get: function () {
                return this._uri;
            },
            enumerable: false,
            configurable: true
        });
        Object.defineProperty(FullTextDocument.prototype, "languageId", {
            get: function () {
                return this._languageId;
            },
            enumerable: false,
            configurable: true
        });
        Object.defineProperty(FullTextDocument.prototype, "version", {
            get: function () {
                return this._version;
            },
            enumerable: false,
            configurable: true
        });
        FullTextDocument.prototype.getText = function (range) {
            if (range) {
                var start = this.offsetAt(range.start);
                var end = this.offsetAt(range.end);
                return this._content.substring(start, end);
            }
            return this._content;
        };
        FullTextDocument.prototype.update = function (event, version) {
            this._content = event.text;
            this._version = version;
            this._lineOffsets = undefined;
        };
        FullTextDocument.prototype.getLineOffsets = function () {
            if (this._lineOffsets === undefined) {
                var lineOffsets = [];
                var text = this._content;
                var isLineStart = true;
                for (var i = 0; i < text.length; i++) {
                    if (isLineStart) {
                        lineOffsets.push(i);
                        isLineStart = false;
                    }
                    var ch = text.charAt(i);
                    isLineStart = (ch === '\r' || ch === '\n');
                    if (ch === '\r' && i + 1 < text.length && text.charAt(i + 1) === '\n') {
                        i++;
                    }
                }
                if (isLineStart && text.length > 0) {
                    lineOffsets.push(text.length);
                }
                this._lineOffsets = lineOffsets;
            }
            return this._lineOffsets;
        };
        FullTextDocument.prototype.positionAt = function (offset) {
            offset = Math.max(Math.min(offset, this._content.length), 0);
            var lineOffsets = this.getLineOffsets();
            var low = 0, high = lineOffsets.length;
            if (high === 0) {
                return Position.create(0, offset);
            }
            while (low < high) {
                var mid = Math.floor((low + high) / 2);
                if (lineOffsets[mid] > offset) {
                    high = mid;
                }
                else {
                    low = mid + 1;
                }
            }
            // low is the least x for which the line offset is larger than the current offset
            // or array.length if no line offset is larger than the current offset
            var line = low - 1;
            return Position.create(line, offset - lineOffsets[line]);
        };
        FullTextDocument.prototype.offsetAt = function (position) {
            var lineOffsets = this.getLineOffsets();
            if (position.line >= lineOffsets.length) {
                return this._content.length;
            }
            else if (position.line < 0) {
                return 0;
            }
            var lineOffset = lineOffsets[position.line];
            var nextLineOffset = (position.line + 1 < lineOffsets.length) ? lineOffsets[position.line + 1] : this._content.length;
            return Math.max(Math.min(lineOffset + position.character, nextLineOffset), lineOffset);
        };
        Object.defineProperty(FullTextDocument.prototype, "lineCount", {
            get: function () {
                return this.getLineOffsets().length;
            },
            enumerable: false,
            configurable: true
        });
        return FullTextDocument;
    }());
    var Is;
    (function (Is) {
        var toString = Object.prototype.toString;
        function defined(value) {
            return typeof value !== 'undefined';
        }
        Is.defined = defined;
        function undefined(value) {
            return typeof value === 'undefined';
        }
        Is.undefined = undefined;
        function boolean(value) {
            return value === true || value === false;
        }
        Is.boolean = boolean;
        function string(value) {
            return toString.call(value) === '[object String]';
        }
        Is.string = string;
        function number(value) {
            return toString.call(value) === '[object Number]';
        }
        Is.number = number;
        function numberRange(value, min, max) {
            return toString.call(value) === '[object Number]' && min <= value && value <= max;
        }
        Is.numberRange = numberRange;
        function integer(value) {
            return toString.call(value) === '[object Number]' && -2147483648 <= value && value <= 2147483647;
        }
        Is.integer = integer;
        function uinteger(value) {
            return toString.call(value) === '[object Number]' && 0 <= value && value <= 2147483647;
        }
        Is.uinteger = uinteger;
        function func(value) {
            return toString.call(value) === '[object Function]';
        }
        Is.func = func;
        function objectLiteral(value) {
            // Strictly speaking class instances pass this check as well. Since the LSP
            // doesn't use classes we ignore this for now. If we do we need to add something
            // like this: `Object.getPrototypeOf(Object.getPrototypeOf(x)) === null`
            return value !== null && typeof value === 'object';
        }
        Is.objectLiteral = objectLiteral;
        function typedArray(value, check) {
            return Array.isArray(value) && value.every(check);
        }
        Is.typedArray = typedArray;
    })(Is || (Is = {}));
});


/***/ },

/***/ 3655
(module) {

function webpackEmptyContext(req) {
	var e = new Error("Cannot find module '" + req + "'");
	e.code = 'MODULE_NOT_FOUND';
	throw e;
}
webpackEmptyContext.keys = () => ([]);
webpackEmptyContext.resolve = webpackEmptyContext;
webpackEmptyContext.id = 3655;
module.exports = webpackEmptyContext;

/***/ },

/***/ 2861
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ProposedFeatures = exports.NotebookDocuments = exports.TextDocuments = exports.SemanticTokensBuilder = void 0;
const semanticTokens_1 = __webpack_require__(2655);
Object.defineProperty(exports, "SemanticTokensBuilder", ({ enumerable: true, get: function () { return semanticTokens_1.SemanticTokensBuilder; } }));
const ic = __webpack_require__(1276);
__exportStar(__webpack_require__(7354), exports);
const textDocuments_1 = __webpack_require__(1662);
Object.defineProperty(exports, "TextDocuments", ({ enumerable: true, get: function () { return textDocuments_1.TextDocuments; } }));
const notebook_1 = __webpack_require__(20);
Object.defineProperty(exports, "NotebookDocuments", ({ enumerable: true, get: function () { return notebook_1.NotebookDocuments; } }));
__exportStar(__webpack_require__(7874), exports);
var ProposedFeatures;
(function (ProposedFeatures) {
    ProposedFeatures.all = {
        __brand: 'features',
        languages: ic.InlineCompletionFeature
    };
})(ProposedFeatures || (exports.ProposedFeatures = ProposedFeatures = {}));


/***/ },

/***/ 3918
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.CallHierarchyFeature = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const CallHierarchyFeature = (Base) => {
    return class extends Base {
        get callHierarchy() {
            return {
                onPrepare: (handler) => {
                    return this.connection.onRequest(vscode_languageserver_protocol_1.CallHierarchyPrepareRequest.type, (params, cancel) => {
                        return handler(params, cancel, this.attachWorkDoneProgress(params), undefined);
                    });
                },
                onIncomingCalls: (handler) => {
                    const type = vscode_languageserver_protocol_1.CallHierarchyIncomingCallsRequest.type;
                    return this.connection.onRequest(type, (params, cancel) => {
                        return handler(params, cancel, this.attachWorkDoneProgress(params), this.attachPartialResultProgress(type, params));
                    });
                },
                onOutgoingCalls: (handler) => {
                    const type = vscode_languageserver_protocol_1.CallHierarchyOutgoingCallsRequest.type;
                    return this.connection.onRequest(type, (params, cancel) => {
                        return handler(params, cancel, this.attachWorkDoneProgress(params), this.attachPartialResultProgress(type, params));
                    });
                }
            };
        }
    };
};
exports.CallHierarchyFeature = CallHierarchyFeature;


/***/ },

/***/ 8491
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ConfigurationFeature = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const Is = __webpack_require__(8867);
const ConfigurationFeature = (Base) => {
    return class extends Base {
        getConfiguration(arg) {
            if (!arg) {
                return this._getConfiguration({});
            }
            else if (Is.string(arg)) {
                return this._getConfiguration({ section: arg });
            }
            else {
                return this._getConfiguration(arg);
            }
        }
        _getConfiguration(arg) {
            let params = {
                items: Array.isArray(arg) ? arg : [arg]
            };
            return this.connection.sendRequest(vscode_languageserver_protocol_1.ConfigurationRequest.type, params).then((result) => {
                if (Array.isArray(result)) {
                    return Array.isArray(arg) ? result : result[0];
                }
                else {
                    return Array.isArray(arg) ? [] : null;
                }
            });
        }
    };
};
exports.ConfigurationFeature = ConfigurationFeature;


/***/ },

/***/ 493
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.DiagnosticFeature = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const DiagnosticFeature = (Base) => {
    return class extends Base {
        get diagnostics() {
            return {
                refresh: () => {
                    return this.connection.sendRequest(vscode_languageserver_protocol_1.DiagnosticRefreshRequest.type);
                },
                on: (handler) => {
                    return this.connection.onRequest(vscode_languageserver_protocol_1.DocumentDiagnosticRequest.type, (params, cancel) => {
                        return handler(params, cancel, this.attachWorkDoneProgress(params), this.attachPartialResultProgress(vscode_languageserver_protocol_1.DocumentDiagnosticRequest.partialResult, params));
                    });
                },
                onWorkspace: (handler) => {
                    return this.connection.onRequest(vscode_languageserver_protocol_1.WorkspaceDiagnosticRequest.type, (params, cancel) => {
                        return handler(params, cancel, this.attachWorkDoneProgress(params), this.attachPartialResultProgress(vscode_languageserver_protocol_1.WorkspaceDiagnosticRequest.partialResult, params));
                    });
                }
            };
        }
    };
};
exports.DiagnosticFeature = DiagnosticFeature;


/***/ },

/***/ 2697
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.FileOperationsFeature = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const FileOperationsFeature = (Base) => {
    return class extends Base {
        onDidCreateFiles(handler) {
            return this.connection.onNotification(vscode_languageserver_protocol_1.DidCreateFilesNotification.type, (params) => {
                handler(params);
            });
        }
        onDidRenameFiles(handler) {
            return this.connection.onNotification(vscode_languageserver_protocol_1.DidRenameFilesNotification.type, (params) => {
                handler(params);
            });
        }
        onDidDeleteFiles(handler) {
            return this.connection.onNotification(vscode_languageserver_protocol_1.DidDeleteFilesNotification.type, (params) => {
                handler(params);
            });
        }
        onWillCreateFiles(handler) {
            return this.connection.onRequest(vscode_languageserver_protocol_1.WillCreateFilesRequest.type, (params, cancel) => {
                return handler(params, cancel);
            });
        }
        onWillRenameFiles(handler) {
            return this.connection.onRequest(vscode_languageserver_protocol_1.WillRenameFilesRequest.type, (params, cancel) => {
                return handler(params, cancel);
            });
        }
        onWillDeleteFiles(handler) {
            return this.connection.onRequest(vscode_languageserver_protocol_1.WillDeleteFilesRequest.type, (params, cancel) => {
                return handler(params, cancel);
            });
        }
    };
};
exports.FileOperationsFeature = FileOperationsFeature;


/***/ },

/***/ 6007
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.FoldingRangeFeature = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const FoldingRangeFeature = (Base) => {
    return class extends Base {
        get foldingRange() {
            return {
                refresh: () => {
                    return this.connection.sendRequest(vscode_languageserver_protocol_1.FoldingRangeRefreshRequest.type);
                },
                on: (handler) => {
                    const type = vscode_languageserver_protocol_1.FoldingRangeRequest.type;
                    return this.connection.onRequest(type, (params, cancel) => {
                        return handler(params, cancel, this.attachWorkDoneProgress(params), this.attachPartialResultProgress(type, params));
                    });
                }
            };
        }
    };
};
exports.FoldingRangeFeature = FoldingRangeFeature;


/***/ },

/***/ 4635
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.InlayHintFeature = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const InlayHintFeature = (Base) => {
    return class extends Base {
        get inlayHint() {
            return {
                refresh: () => {
                    return this.connection.sendRequest(vscode_languageserver_protocol_1.InlayHintRefreshRequest.type);
                },
                on: (handler) => {
                    return this.connection.onRequest(vscode_languageserver_protocol_1.InlayHintRequest.type, (params, cancel) => {
                        return handler(params, cancel, this.attachWorkDoneProgress(params));
                    });
                },
                resolve: (handler) => {
                    return this.connection.onRequest(vscode_languageserver_protocol_1.InlayHintResolveRequest.type, (params, cancel) => {
                        return handler(params, cancel);
                    });
                }
            };
        }
    };
};
exports.InlayHintFeature = InlayHintFeature;


/***/ },

/***/ 1276
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.InlineCompletionFeature = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const InlineCompletionFeature = (Base) => {
    return class extends Base {
        get inlineCompletion() {
            return {
                on: (handler) => {
                    return this.connection.onRequest(vscode_languageserver_protocol_1.InlineCompletionRequest.type, (params, cancel) => {
                        return handler(params, cancel, this.attachWorkDoneProgress(params));
                    });
                }
            };
        }
    };
};
exports.InlineCompletionFeature = InlineCompletionFeature;


/***/ },

/***/ 1815
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.InlineValueFeature = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const InlineValueFeature = (Base) => {
    return class extends Base {
        get inlineValue() {
            return {
                refresh: () => {
                    return this.connection.sendRequest(vscode_languageserver_protocol_1.InlineValueRefreshRequest.type);
                },
                on: (handler) => {
                    return this.connection.onRequest(vscode_languageserver_protocol_1.InlineValueRequest.type, (params, cancel) => {
                        return handler(params, cancel, this.attachWorkDoneProgress(params));
                    });
                }
            };
        }
    };
};
exports.InlineValueFeature = InlineValueFeature;


/***/ },

/***/ 8517
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.LinkedEditingRangeFeature = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const LinkedEditingRangeFeature = (Base) => {
    return class extends Base {
        onLinkedEditingRange(handler) {
            return this.connection.onRequest(vscode_languageserver_protocol_1.LinkedEditingRangeRequest.type, (params, cancel) => {
                return handler(params, cancel, this.attachWorkDoneProgress(params), undefined);
            });
        }
    };
};
exports.LinkedEditingRangeFeature = LinkedEditingRangeFeature;


/***/ },

/***/ 2936
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.MonikerFeature = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const MonikerFeature = (Base) => {
    return class extends Base {
        get moniker() {
            return {
                on: (handler) => {
                    const type = vscode_languageserver_protocol_1.MonikerRequest.type;
                    return this.connection.onRequest(type, (params, cancel) => {
                        return handler(params, cancel, this.attachWorkDoneProgress(params), this.attachPartialResultProgress(type, params));
                    });
                },
            };
        }
    };
};
exports.MonikerFeature = MonikerFeature;


/***/ },

/***/ 20
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.NotebookDocuments = exports.NotebookSyncFeature = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const textDocuments_1 = __webpack_require__(1662);
const NotebookSyncFeature = (Base) => {
    return class extends Base {
        get synchronization() {
            return {
                onDidOpenNotebookDocument: (handler) => {
                    return this.connection.onNotification(vscode_languageserver_protocol_1.DidOpenNotebookDocumentNotification.type, (params) => {
                        handler(params);
                    });
                },
                onDidChangeNotebookDocument: (handler) => {
                    return this.connection.onNotification(vscode_languageserver_protocol_1.DidChangeNotebookDocumentNotification.type, (params) => {
                        handler(params);
                    });
                },
                onDidSaveNotebookDocument: (handler) => {
                    return this.connection.onNotification(vscode_languageserver_protocol_1.DidSaveNotebookDocumentNotification.type, (params) => {
                        handler(params);
                    });
                },
                onDidCloseNotebookDocument: (handler) => {
                    return this.connection.onNotification(vscode_languageserver_protocol_1.DidCloseNotebookDocumentNotification.type, (params) => {
                        handler(params);
                    });
                }
            };
        }
    };
};
exports.NotebookSyncFeature = NotebookSyncFeature;
class CellTextDocumentConnection {
    onDidOpenTextDocument(handler) {
        this.openHandler = handler;
        return vscode_languageserver_protocol_1.Disposable.create(() => { this.openHandler = undefined; });
    }
    openTextDocument(params) {
        this.openHandler && this.openHandler(params);
    }
    onDidChangeTextDocument(handler) {
        this.changeHandler = handler;
        return vscode_languageserver_protocol_1.Disposable.create(() => { this.changeHandler = handler; });
    }
    changeTextDocument(params) {
        this.changeHandler && this.changeHandler(params);
    }
    onDidCloseTextDocument(handler) {
        this.closeHandler = handler;
        return vscode_languageserver_protocol_1.Disposable.create(() => { this.closeHandler = undefined; });
    }
    closeTextDocument(params) {
        this.closeHandler && this.closeHandler(params);
    }
    onWillSaveTextDocument() {
        return CellTextDocumentConnection.NULL_DISPOSE;
    }
    onWillSaveTextDocumentWaitUntil() {
        return CellTextDocumentConnection.NULL_DISPOSE;
    }
    onDidSaveTextDocument() {
        return CellTextDocumentConnection.NULL_DISPOSE;
    }
}
CellTextDocumentConnection.NULL_DISPOSE = Object.freeze({ dispose: () => { } });
class NotebookDocuments {
    constructor(configurationOrTextDocuments) {
        if (configurationOrTextDocuments instanceof textDocuments_1.TextDocuments) {
            this._cellTextDocuments = configurationOrTextDocuments;
        }
        else {
            this._cellTextDocuments = new textDocuments_1.TextDocuments(configurationOrTextDocuments);
        }
        this.notebookDocuments = new Map();
        this.notebookCellMap = new Map();
        this._onDidOpen = new vscode_languageserver_protocol_1.Emitter();
        this._onDidChange = new vscode_languageserver_protocol_1.Emitter();
        this._onDidSave = new vscode_languageserver_protocol_1.Emitter();
        this._onDidClose = new vscode_languageserver_protocol_1.Emitter();
    }
    get cellTextDocuments() {
        return this._cellTextDocuments;
    }
    getCellTextDocument(cell) {
        return this._cellTextDocuments.get(cell.document);
    }
    getNotebookDocument(uri) {
        return this.notebookDocuments.get(uri);
    }
    getNotebookCell(uri) {
        const value = this.notebookCellMap.get(uri);
        return value && value[0];
    }
    findNotebookDocumentForCell(cell) {
        const key = typeof cell === 'string' ? cell : cell.document;
        const value = this.notebookCellMap.get(key);
        return value && value[1];
    }
    get onDidOpen() {
        return this._onDidOpen.event;
    }
    get onDidSave() {
        return this._onDidSave.event;
    }
    get onDidChange() {
        return this._onDidChange.event;
    }
    get onDidClose() {
        return this._onDidClose.event;
    }
    /**
     * Listens for `low level` notification on the given connection to
     * update the notebook documents managed by this instance.
     *
     * Please note that the connection only provides handlers not an event model. Therefore
     * listening on a connection will overwrite the following handlers on a connection:
     * `onDidOpenNotebookDocument`, `onDidChangeNotebookDocument`, `onDidSaveNotebookDocument`,
     *  and `onDidCloseNotebookDocument`.
     *
     * @param connection The connection to listen on.
     */
    listen(connection) {
        const cellTextDocumentConnection = new CellTextDocumentConnection();
        const disposables = [];
        disposables.push(this.cellTextDocuments.listen(cellTextDocumentConnection));
        disposables.push(connection.notebooks.synchronization.onDidOpenNotebookDocument((params) => {
            this.notebookDocuments.set(params.notebookDocument.uri, params.notebookDocument);
            for (const cellTextDocument of params.cellTextDocuments) {
                cellTextDocumentConnection.openTextDocument({ textDocument: cellTextDocument });
            }
            this.updateCellMap(params.notebookDocument);
            this._onDidOpen.fire(params.notebookDocument);
        }));
        disposables.push(connection.notebooks.synchronization.onDidChangeNotebookDocument((params) => {
            const notebookDocument = this.notebookDocuments.get(params.notebookDocument.uri);
            if (notebookDocument === undefined) {
                return;
            }
            notebookDocument.version = params.notebookDocument.version;
            const oldMetadata = notebookDocument.metadata;
            let metadataChanged = false;
            const change = params.change;
            if (change.metadata !== undefined) {
                metadataChanged = true;
                notebookDocument.metadata = change.metadata;
            }
            const opened = [];
            const closed = [];
            const data = [];
            const text = [];
            if (change.cells !== undefined) {
                const changedCells = change.cells;
                if (changedCells.structure !== undefined) {
                    const array = changedCells.structure.array;
                    notebookDocument.cells.splice(array.start, array.deleteCount, ...(array.cells !== undefined ? array.cells : []));
                    // Additional open cell text documents.
                    if (changedCells.structure.didOpen !== undefined) {
                        for (const open of changedCells.structure.didOpen) {
                            cellTextDocumentConnection.openTextDocument({ textDocument: open });
                            opened.push(open.uri);
                        }
                    }
                    // Additional closed cell test documents.
                    if (changedCells.structure.didClose) {
                        for (const close of changedCells.structure.didClose) {
                            cellTextDocumentConnection.closeTextDocument({ textDocument: close });
                            closed.push(close.uri);
                        }
                    }
                }
                if (changedCells.data !== undefined) {
                    const cellUpdates = new Map(changedCells.data.map(cell => [cell.document, cell]));
                    for (let i = 0; i <= notebookDocument.cells.length; i++) {
                        const change = cellUpdates.get(notebookDocument.cells[i].document);
                        if (change !== undefined) {
                            const old = notebookDocument.cells.splice(i, 1, change);
                            data.push({ old: old[0], new: change });
                            cellUpdates.delete(change.document);
                            if (cellUpdates.size === 0) {
                                break;
                            }
                        }
                    }
                }
                if (changedCells.textContent !== undefined) {
                    for (const cellTextDocument of changedCells.textContent) {
                        cellTextDocumentConnection.changeTextDocument({ textDocument: cellTextDocument.document, contentChanges: cellTextDocument.changes });
                        text.push(cellTextDocument.document.uri);
                    }
                }
            }
            // Update internal data structure.
            this.updateCellMap(notebookDocument);
            const changeEvent = { notebookDocument };
            if (metadataChanged) {
                changeEvent.metadata = { old: oldMetadata, new: notebookDocument.metadata };
            }
            const added = [];
            for (const open of opened) {
                added.push(this.getNotebookCell(open));
            }
            const removed = [];
            for (const close of closed) {
                removed.push(this.getNotebookCell(close));
            }
            const textContent = [];
            for (const change of text) {
                textContent.push(this.getNotebookCell(change));
            }
            if (added.length > 0 || removed.length > 0 || data.length > 0 || textContent.length > 0) {
                changeEvent.cells = { added, removed, changed: { data, textContent } };
            }
            if (changeEvent.metadata !== undefined || changeEvent.cells !== undefined) {
                this._onDidChange.fire(changeEvent);
            }
        }));
        disposables.push(connection.notebooks.synchronization.onDidSaveNotebookDocument((params) => {
            const notebookDocument = this.notebookDocuments.get(params.notebookDocument.uri);
            if (notebookDocument === undefined) {
                return;
            }
            this._onDidSave.fire(notebookDocument);
        }));
        disposables.push(connection.notebooks.synchronization.onDidCloseNotebookDocument((params) => {
            const notebookDocument = this.notebookDocuments.get(params.notebookDocument.uri);
            if (notebookDocument === undefined) {
                return;
            }
            this._onDidClose.fire(notebookDocument);
            for (const cellTextDocument of params.cellTextDocuments) {
                cellTextDocumentConnection.closeTextDocument({ textDocument: cellTextDocument });
            }
            this.notebookDocuments.delete(params.notebookDocument.uri);
            for (const cell of notebookDocument.cells) {
                this.notebookCellMap.delete(cell.document);
            }
        }));
        return vscode_languageserver_protocol_1.Disposable.create(() => { disposables.forEach(disposable => disposable.dispose()); });
    }
    updateCellMap(notebookDocument) {
        for (const cell of notebookDocument.cells) {
            this.notebookCellMap.set(cell.document, [cell, notebookDocument]);
        }
    }
}
exports.NotebookDocuments = NotebookDocuments;


/***/ },

/***/ 2938
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.attachPartialResult = exports.ProgressFeature = exports.attachWorkDone = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const uuid_1 = __webpack_require__(6116);
class WorkDoneProgressReporterImpl {
    constructor(_connection, _token) {
        this._connection = _connection;
        this._token = _token;
        WorkDoneProgressReporterImpl.Instances.set(this._token, this);
    }
    begin(title, percentage, message, cancellable) {
        let param = {
            kind: 'begin',
            title,
            percentage,
            message,
            cancellable
        };
        this._connection.sendProgress(vscode_languageserver_protocol_1.WorkDoneProgress.type, this._token, param);
    }
    report(arg0, arg1) {
        let param = {
            kind: 'report'
        };
        if (typeof arg0 === 'number') {
            param.percentage = arg0;
            if (arg1 !== undefined) {
                param.message = arg1;
            }
        }
        else {
            param.message = arg0;
        }
        this._connection.sendProgress(vscode_languageserver_protocol_1.WorkDoneProgress.type, this._token, param);
    }
    done() {
        WorkDoneProgressReporterImpl.Instances.delete(this._token);
        this._connection.sendProgress(vscode_languageserver_protocol_1.WorkDoneProgress.type, this._token, { kind: 'end' });
    }
}
WorkDoneProgressReporterImpl.Instances = new Map();
class WorkDoneProgressServerReporterImpl extends WorkDoneProgressReporterImpl {
    constructor(connection, token) {
        super(connection, token);
        this._source = new vscode_languageserver_protocol_1.CancellationTokenSource();
    }
    get token() {
        return this._source.token;
    }
    done() {
        this._source.dispose();
        super.done();
    }
    cancel() {
        this._source.cancel();
    }
}
class NullProgressReporter {
    constructor() {
    }
    begin() {
    }
    report() {
    }
    done() {
    }
}
class NullProgressServerReporter extends NullProgressReporter {
    constructor() {
        super();
        this._source = new vscode_languageserver_protocol_1.CancellationTokenSource();
    }
    get token() {
        return this._source.token;
    }
    done() {
        this._source.dispose();
    }
    cancel() {
        this._source.cancel();
    }
}
function attachWorkDone(connection, params) {
    if (params === undefined || params.workDoneToken === undefined) {
        return new NullProgressReporter();
    }
    const token = params.workDoneToken;
    delete params.workDoneToken;
    return new WorkDoneProgressReporterImpl(connection, token);
}
exports.attachWorkDone = attachWorkDone;
const ProgressFeature = (Base) => {
    return class extends Base {
        constructor() {
            super();
            this._progressSupported = false;
        }
        initialize(capabilities) {
            super.initialize(capabilities);
            if (capabilities?.window?.workDoneProgress === true) {
                this._progressSupported = true;
                this.connection.onNotification(vscode_languageserver_protocol_1.WorkDoneProgressCancelNotification.type, (params) => {
                    let progress = WorkDoneProgressReporterImpl.Instances.get(params.token);
                    if (progress instanceof WorkDoneProgressServerReporterImpl || progress instanceof NullProgressServerReporter) {
                        progress.cancel();
                    }
                });
            }
        }
        attachWorkDoneProgress(token) {
            if (token === undefined) {
                return new NullProgressReporter();
            }
            else {
                return new WorkDoneProgressReporterImpl(this.connection, token);
            }
        }
        createWorkDoneProgress() {
            if (this._progressSupported) {
                const token = (0, uuid_1.generateUuid)();
                return this.connection.sendRequest(vscode_languageserver_protocol_1.WorkDoneProgressCreateRequest.type, { token }).then(() => {
                    const result = new WorkDoneProgressServerReporterImpl(this.connection, token);
                    return result;
                });
            }
            else {
                return Promise.resolve(new NullProgressServerReporter());
            }
        }
    };
};
exports.ProgressFeature = ProgressFeature;
var ResultProgress;
(function (ResultProgress) {
    ResultProgress.type = new vscode_languageserver_protocol_1.ProgressType();
})(ResultProgress || (ResultProgress = {}));
class ResultProgressReporterImpl {
    constructor(_connection, _token) {
        this._connection = _connection;
        this._token = _token;
    }
    report(data) {
        this._connection.sendProgress(ResultProgress.type, this._token, data);
    }
}
function attachPartialResult(connection, params) {
    if (params === undefined || params.partialResultToken === undefined) {
        return undefined;
    }
    const token = params.partialResultToken;
    delete params.partialResultToken;
    return new ResultProgressReporterImpl(connection, token);
}
exports.attachPartialResult = attachPartialResult;


/***/ },

/***/ 2655
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.SemanticTokensBuilder = exports.SemanticTokensDiff = exports.SemanticTokensFeature = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const SemanticTokensFeature = (Base) => {
    return class extends Base {
        get semanticTokens() {
            return {
                refresh: () => {
                    return this.connection.sendRequest(vscode_languageserver_protocol_1.SemanticTokensRefreshRequest.type);
                },
                on: (handler) => {
                    const type = vscode_languageserver_protocol_1.SemanticTokensRequest.type;
                    return this.connection.onRequest(type, (params, cancel) => {
                        return handler(params, cancel, this.attachWorkDoneProgress(params), this.attachPartialResultProgress(type, params));
                    });
                },
                onDelta: (handler) => {
                    const type = vscode_languageserver_protocol_1.SemanticTokensDeltaRequest.type;
                    return this.connection.onRequest(type, (params, cancel) => {
                        return handler(params, cancel, this.attachWorkDoneProgress(params), this.attachPartialResultProgress(type, params));
                    });
                },
                onRange: (handler) => {
                    const type = vscode_languageserver_protocol_1.SemanticTokensRangeRequest.type;
                    return this.connection.onRequest(type, (params, cancel) => {
                        return handler(params, cancel, this.attachWorkDoneProgress(params), this.attachPartialResultProgress(type, params));
                    });
                }
            };
        }
    };
};
exports.SemanticTokensFeature = SemanticTokensFeature;
class SemanticTokensDiff {
    constructor(originalSequence, modifiedSequence) {
        this.originalSequence = originalSequence;
        this.modifiedSequence = modifiedSequence;
    }
    computeDiff() {
        const originalLength = this.originalSequence.length;
        const modifiedLength = this.modifiedSequence.length;
        let startIndex = 0;
        while (startIndex < modifiedLength && startIndex < originalLength && this.originalSequence[startIndex] === this.modifiedSequence[startIndex]) {
            startIndex++;
        }
        if (startIndex < modifiedLength && startIndex < originalLength) {
            let originalEndIndex = originalLength - 1;
            let modifiedEndIndex = modifiedLength - 1;
            while (originalEndIndex >= startIndex && modifiedEndIndex >= startIndex && this.originalSequence[originalEndIndex] === this.modifiedSequence[modifiedEndIndex]) {
                originalEndIndex--;
                modifiedEndIndex--;
            }
            // if one moved behind the start index move them forward again
            if (originalEndIndex < startIndex || modifiedEndIndex < startIndex) {
                originalEndIndex++;
                modifiedEndIndex++;
            }
            const deleteCount = originalEndIndex - startIndex + 1;
            const newData = this.modifiedSequence.slice(startIndex, modifiedEndIndex + 1);
            // If we moved behind the start index we could have missed a simple delete.
            if (newData.length === 1 && newData[0] === this.originalSequence[originalEndIndex]) {
                return [
                    { start: startIndex, deleteCount: deleteCount - 1 }
                ];
            }
            else {
                return [
                    { start: startIndex, deleteCount, data: newData }
                ];
            }
        }
        else if (startIndex < modifiedLength) {
            return [
                { start: startIndex, deleteCount: 0, data: this.modifiedSequence.slice(startIndex) }
            ];
        }
        else if (startIndex < originalLength) {
            return [
                { start: startIndex, deleteCount: originalLength - startIndex }
            ];
        }
        else {
            // The two arrays are the same.
            return [];
        }
    }
}
exports.SemanticTokensDiff = SemanticTokensDiff;
class SemanticTokensBuilder {
    constructor() {
        this._prevData = undefined;
        this.initialize();
    }
    initialize() {
        this._id = Date.now();
        this._prevLine = 0;
        this._prevChar = 0;
        this._data = [];
        this._dataLen = 0;
    }
    push(line, char, length, tokenType, tokenModifiers) {
        let pushLine = line;
        let pushChar = char;
        if (this._dataLen > 0) {
            pushLine -= this._prevLine;
            if (pushLine === 0) {
                pushChar -= this._prevChar;
            }
        }
        this._data[this._dataLen++] = pushLine;
        this._data[this._dataLen++] = pushChar;
        this._data[this._dataLen++] = length;
        this._data[this._dataLen++] = tokenType;
        this._data[this._dataLen++] = tokenModifiers;
        this._prevLine = line;
        this._prevChar = char;
    }
    get id() {
        return this._id.toString();
    }
    previousResult(id) {
        if (this.id === id) {
            this._prevData = this._data;
        }
        this.initialize();
    }
    build() {
        this._prevData = undefined;
        return {
            resultId: this.id,
            data: this._data
        };
    }
    canBuildEdits() {
        return this._prevData !== undefined;
    }
    buildEdits() {
        if (this._prevData !== undefined) {
            return {
                resultId: this.id,
                edits: (new SemanticTokensDiff(this._prevData, this._data)).computeDiff()
            };
        }
        else {
            return this.build();
        }
    }
}
exports.SemanticTokensBuilder = SemanticTokensBuilder;


/***/ },

/***/ 7874
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.createConnection = exports.combineFeatures = exports.combineNotebooksFeatures = exports.combineLanguagesFeatures = exports.combineWorkspaceFeatures = exports.combineWindowFeatures = exports.combineClientFeatures = exports.combineTracerFeatures = exports.combineTelemetryFeatures = exports.combineConsoleFeatures = exports._NotebooksImpl = exports._LanguagesImpl = exports.BulkUnregistration = exports.BulkRegistration = exports.ErrorMessageTracker = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const Is = __webpack_require__(8867);
const UUID = __webpack_require__(6116);
const progress_1 = __webpack_require__(2938);
const configuration_1 = __webpack_require__(8491);
const workspaceFolder_1 = __webpack_require__(2112);
const callHierarchy_1 = __webpack_require__(3918);
const semanticTokens_1 = __webpack_require__(2655);
const showDocument_1 = __webpack_require__(8817);
const fileOperations_1 = __webpack_require__(2697);
const linkedEditingRange_1 = __webpack_require__(8517);
const typeHierarchy_1 = __webpack_require__(5026);
const inlineValue_1 = __webpack_require__(1815);
const foldingRange_1 = __webpack_require__(6007);
// import { InlineCompletionFeatureShape, InlineCompletionFeature } from './inlineCompletion.proposed';
const inlayHint_1 = __webpack_require__(4635);
const diagnostic_1 = __webpack_require__(493);
const notebook_1 = __webpack_require__(20);
const moniker_1 = __webpack_require__(2936);
function null2Undefined(value) {
    if (value === null) {
        return undefined;
    }
    return value;
}
/**
 * Helps tracking error message. Equal occurrences of the same
 * message are only stored once. This class is for example
 * useful if text documents are validated in a loop and equal
 * error message should be folded into one.
 */
class ErrorMessageTracker {
    constructor() {
        this._messages = Object.create(null);
    }
    /**
     * Add a message to the tracker.
     *
     * @param message The message to add.
     */
    add(message) {
        let count = this._messages[message];
        if (!count) {
            count = 0;
        }
        count++;
        this._messages[message] = count;
    }
    /**
     * Send all tracked messages to the connection's window.
     *
     * @param connection The connection established between client and server.
     */
    sendErrors(connection) {
        Object.keys(this._messages).forEach(message => {
            connection.window.showErrorMessage(message);
        });
    }
}
exports.ErrorMessageTracker = ErrorMessageTracker;
class RemoteConsoleImpl {
    constructor() {
    }
    rawAttach(connection) {
        this._rawConnection = connection;
    }
    attach(connection) {
        this._connection = connection;
    }
    get connection() {
        if (!this._connection) {
            throw new Error('Remote is not attached to a connection yet.');
        }
        return this._connection;
    }
    fillServerCapabilities(_capabilities) {
    }
    initialize(_capabilities) {
    }
    error(message) {
        this.send(vscode_languageserver_protocol_1.MessageType.Error, message);
    }
    warn(message) {
        this.send(vscode_languageserver_protocol_1.MessageType.Warning, message);
    }
    info(message) {
        this.send(vscode_languageserver_protocol_1.MessageType.Info, message);
    }
    log(message) {
        this.send(vscode_languageserver_protocol_1.MessageType.Log, message);
    }
    debug(message) {
        this.send(vscode_languageserver_protocol_1.MessageType.Debug, message);
    }
    send(type, message) {
        if (this._rawConnection) {
            this._rawConnection.sendNotification(vscode_languageserver_protocol_1.LogMessageNotification.type, { type, message }).catch(() => {
                (0, vscode_languageserver_protocol_1.RAL)().console.error(`Sending log message failed`);
            });
        }
    }
}
class _RemoteWindowImpl {
    constructor() {
    }
    attach(connection) {
        this._connection = connection;
    }
    get connection() {
        if (!this._connection) {
            throw new Error('Remote is not attached to a connection yet.');
        }
        return this._connection;
    }
    initialize(_capabilities) {
    }
    fillServerCapabilities(_capabilities) {
    }
    showErrorMessage(message, ...actions) {
        let params = { type: vscode_languageserver_protocol_1.MessageType.Error, message, actions };
        return this.connection.sendRequest(vscode_languageserver_protocol_1.ShowMessageRequest.type, params).then(null2Undefined);
    }
    showWarningMessage(message, ...actions) {
        let params = { type: vscode_languageserver_protocol_1.MessageType.Warning, message, actions };
        return this.connection.sendRequest(vscode_languageserver_protocol_1.ShowMessageRequest.type, params).then(null2Undefined);
    }
    showInformationMessage(message, ...actions) {
        let params = { type: vscode_languageserver_protocol_1.MessageType.Info, message, actions };
        return this.connection.sendRequest(vscode_languageserver_protocol_1.ShowMessageRequest.type, params).then(null2Undefined);
    }
}
const RemoteWindowImpl = (0, showDocument_1.ShowDocumentFeature)((0, progress_1.ProgressFeature)(_RemoteWindowImpl));
var BulkRegistration;
(function (BulkRegistration) {
    /**
     * Creates a new bulk registration.
     * @return an empty bulk registration.
     */
    function create() {
        return new BulkRegistrationImpl();
    }
    BulkRegistration.create = create;
})(BulkRegistration || (exports.BulkRegistration = BulkRegistration = {}));
class BulkRegistrationImpl {
    constructor() {
        this._registrations = [];
        this._registered = new Set();
    }
    add(type, registerOptions) {
        const method = Is.string(type) ? type : type.method;
        if (this._registered.has(method)) {
            throw new Error(`${method} is already added to this registration`);
        }
        const id = UUID.generateUuid();
        this._registrations.push({
            id: id,
            method: method,
            registerOptions: registerOptions || {}
        });
        this._registered.add(method);
    }
    asRegistrationParams() {
        return {
            registrations: this._registrations
        };
    }
}
var BulkUnregistration;
(function (BulkUnregistration) {
    function create() {
        return new BulkUnregistrationImpl(undefined, []);
    }
    BulkUnregistration.create = create;
})(BulkUnregistration || (exports.BulkUnregistration = BulkUnregistration = {}));
class BulkUnregistrationImpl {
    constructor(_connection, unregistrations) {
        this._connection = _connection;
        this._unregistrations = new Map();
        unregistrations.forEach(unregistration => {
            this._unregistrations.set(unregistration.method, unregistration);
        });
    }
    get isAttached() {
        return !!this._connection;
    }
    attach(connection) {
        this._connection = connection;
    }
    add(unregistration) {
        this._unregistrations.set(unregistration.method, unregistration);
    }
    dispose() {
        let unregistrations = [];
        for (let unregistration of this._unregistrations.values()) {
            unregistrations.push(unregistration);
        }
        let params = {
            unregisterations: unregistrations
        };
        this._connection.sendRequest(vscode_languageserver_protocol_1.UnregistrationRequest.type, params).catch(() => {
            this._connection.console.info(`Bulk unregistration failed.`);
        });
    }
    disposeSingle(arg) {
        const method = Is.string(arg) ? arg : arg.method;
        const unregistration = this._unregistrations.get(method);
        if (!unregistration) {
            return false;
        }
        let params = {
            unregisterations: [unregistration]
        };
        this._connection.sendRequest(vscode_languageserver_protocol_1.UnregistrationRequest.type, params).then(() => {
            this._unregistrations.delete(method);
        }, (_error) => {
            this._connection.console.info(`Un-registering request handler for ${unregistration.id} failed.`);
        });
        return true;
    }
}
class RemoteClientImpl {
    attach(connection) {
        this._connection = connection;
    }
    get connection() {
        if (!this._connection) {
            throw new Error('Remote is not attached to a connection yet.');
        }
        return this._connection;
    }
    initialize(_capabilities) {
    }
    fillServerCapabilities(_capabilities) {
    }
    register(typeOrRegistrations, registerOptionsOrType, registerOptions) {
        if (typeOrRegistrations instanceof BulkRegistrationImpl) {
            return this.registerMany(typeOrRegistrations);
        }
        else if (typeOrRegistrations instanceof BulkUnregistrationImpl) {
            return this.registerSingle1(typeOrRegistrations, registerOptionsOrType, registerOptions);
        }
        else {
            return this.registerSingle2(typeOrRegistrations, registerOptionsOrType);
        }
    }
    registerSingle1(unregistration, type, registerOptions) {
        const method = Is.string(type) ? type : type.method;
        const id = UUID.generateUuid();
        let params = {
            registrations: [{ id, method, registerOptions: registerOptions || {} }]
        };
        if (!unregistration.isAttached) {
            unregistration.attach(this.connection);
        }
        return this.connection.sendRequest(vscode_languageserver_protocol_1.RegistrationRequest.type, params).then((_result) => {
            unregistration.add({ id: id, method: method });
            return unregistration;
        }, (_error) => {
            this.connection.console.info(`Registering request handler for ${method} failed.`);
            return Promise.reject(_error);
        });
    }
    registerSingle2(type, registerOptions) {
        const method = Is.string(type) ? type : type.method;
        const id = UUID.generateUuid();
        let params = {
            registrations: [{ id, method, registerOptions: registerOptions || {} }]
        };
        return this.connection.sendRequest(vscode_languageserver_protocol_1.RegistrationRequest.type, params).then((_result) => {
            return vscode_languageserver_protocol_1.Disposable.create(() => {
                this.unregisterSingle(id, method).catch(() => { this.connection.console.info(`Un-registering capability with id ${id} failed.`); });
            });
        }, (_error) => {
            this.connection.console.info(`Registering request handler for ${method} failed.`);
            return Promise.reject(_error);
        });
    }
    unregisterSingle(id, method) {
        let params = {
            unregisterations: [{ id, method }]
        };
        return this.connection.sendRequest(vscode_languageserver_protocol_1.UnregistrationRequest.type, params).catch(() => {
            this.connection.console.info(`Un-registering request handler for ${id} failed.`);
        });
    }
    registerMany(registrations) {
        let params = registrations.asRegistrationParams();
        return this.connection.sendRequest(vscode_languageserver_protocol_1.RegistrationRequest.type, params).then(() => {
            return new BulkUnregistrationImpl(this._connection, params.registrations.map(registration => { return { id: registration.id, method: registration.method }; }));
        }, (_error) => {
            this.connection.console.info(`Bulk registration failed.`);
            return Promise.reject(_error);
        });
    }
}
class _RemoteWorkspaceImpl {
    constructor() {
    }
    attach(connection) {
        this._connection = connection;
    }
    get connection() {
        if (!this._connection) {
            throw new Error('Remote is not attached to a connection yet.');
        }
        return this._connection;
    }
    initialize(_capabilities) {
    }
    fillServerCapabilities(_capabilities) {
    }
    applyEdit(paramOrEdit) {
        function isApplyWorkspaceEditParams(value) {
            return value && !!value.edit;
        }
        let params = isApplyWorkspaceEditParams(paramOrEdit) ? paramOrEdit : { edit: paramOrEdit };
        return this.connection.sendRequest(vscode_languageserver_protocol_1.ApplyWorkspaceEditRequest.type, params);
    }
}
const RemoteWorkspaceImpl = (0, fileOperations_1.FileOperationsFeature)((0, workspaceFolder_1.WorkspaceFoldersFeature)((0, configuration_1.ConfigurationFeature)(_RemoteWorkspaceImpl)));
class TracerImpl {
    constructor() {
        this._trace = vscode_languageserver_protocol_1.Trace.Off;
    }
    attach(connection) {
        this._connection = connection;
    }
    get connection() {
        if (!this._connection) {
            throw new Error('Remote is not attached to a connection yet.');
        }
        return this._connection;
    }
    initialize(_capabilities) {
    }
    fillServerCapabilities(_capabilities) {
    }
    set trace(value) {
        this._trace = value;
    }
    log(message, verbose) {
        if (this._trace === vscode_languageserver_protocol_1.Trace.Off) {
            return;
        }
        this.connection.sendNotification(vscode_languageserver_protocol_1.LogTraceNotification.type, {
            message: message,
            verbose: this._trace === vscode_languageserver_protocol_1.Trace.Verbose ? verbose : undefined
        }).catch(() => {
            // Very hard to decide what to do. We tried to send a log
            // message which failed so we can't simply send another :-(.
        });
    }
}
class TelemetryImpl {
    constructor() {
    }
    attach(connection) {
        this._connection = connection;
    }
    get connection() {
        if (!this._connection) {
            throw new Error('Remote is not attached to a connection yet.');
        }
        return this._connection;
    }
    initialize(_capabilities) {
    }
    fillServerCapabilities(_capabilities) {
    }
    logEvent(data) {
        this.connection.sendNotification(vscode_languageserver_protocol_1.TelemetryEventNotification.type, data).catch(() => {
            this.connection.console.log(`Sending TelemetryEventNotification failed`);
        });
    }
}
class _LanguagesImpl {
    constructor() {
    }
    attach(connection) {
        this._connection = connection;
    }
    get connection() {
        if (!this._connection) {
            throw new Error('Remote is not attached to a connection yet.');
        }
        return this._connection;
    }
    initialize(_capabilities) {
    }
    fillServerCapabilities(_capabilities) {
    }
    attachWorkDoneProgress(params) {
        return (0, progress_1.attachWorkDone)(this.connection, params);
    }
    attachPartialResultProgress(_type, params) {
        return (0, progress_1.attachPartialResult)(this.connection, params);
    }
}
exports._LanguagesImpl = _LanguagesImpl;
const LanguagesImpl = (0, foldingRange_1.FoldingRangeFeature)((0, moniker_1.MonikerFeature)((0, diagnostic_1.DiagnosticFeature)((0, inlayHint_1.InlayHintFeature)((0, inlineValue_1.InlineValueFeature)((0, typeHierarchy_1.TypeHierarchyFeature)((0, linkedEditingRange_1.LinkedEditingRangeFeature)((0, semanticTokens_1.SemanticTokensFeature)((0, callHierarchy_1.CallHierarchyFeature)(_LanguagesImpl)))))))));
class _NotebooksImpl {
    constructor() {
    }
    attach(connection) {
        this._connection = connection;
    }
    get connection() {
        if (!this._connection) {
            throw new Error('Remote is not attached to a connection yet.');
        }
        return this._connection;
    }
    initialize(_capabilities) {
    }
    fillServerCapabilities(_capabilities) {
    }
    attachWorkDoneProgress(params) {
        return (0, progress_1.attachWorkDone)(this.connection, params);
    }
    attachPartialResultProgress(_type, params) {
        return (0, progress_1.attachPartialResult)(this.connection, params);
    }
}
exports._NotebooksImpl = _NotebooksImpl;
const NotebooksImpl = (0, notebook_1.NotebookSyncFeature)(_NotebooksImpl);
function combineConsoleFeatures(one, two) {
    return function (Base) {
        return two(one(Base));
    };
}
exports.combineConsoleFeatures = combineConsoleFeatures;
function combineTelemetryFeatures(one, two) {
    return function (Base) {
        return two(one(Base));
    };
}
exports.combineTelemetryFeatures = combineTelemetryFeatures;
function combineTracerFeatures(one, two) {
    return function (Base) {
        return two(one(Base));
    };
}
exports.combineTracerFeatures = combineTracerFeatures;
function combineClientFeatures(one, two) {
    return function (Base) {
        return two(one(Base));
    };
}
exports.combineClientFeatures = combineClientFeatures;
function combineWindowFeatures(one, two) {
    return function (Base) {
        return two(one(Base));
    };
}
exports.combineWindowFeatures = combineWindowFeatures;
function combineWorkspaceFeatures(one, two) {
    return function (Base) {
        return two(one(Base));
    };
}
exports.combineWorkspaceFeatures = combineWorkspaceFeatures;
function combineLanguagesFeatures(one, two) {
    return function (Base) {
        return two(one(Base));
    };
}
exports.combineLanguagesFeatures = combineLanguagesFeatures;
function combineNotebooksFeatures(one, two) {
    return function (Base) {
        return two(one(Base));
    };
}
exports.combineNotebooksFeatures = combineNotebooksFeatures;
function combineFeatures(one, two) {
    function combine(one, two, func) {
        if (one && two) {
            return func(one, two);
        }
        else if (one) {
            return one;
        }
        else {
            return two;
        }
    }
    let result = {
        __brand: 'features',
        console: combine(one.console, two.console, combineConsoleFeatures),
        tracer: combine(one.tracer, two.tracer, combineTracerFeatures),
        telemetry: combine(one.telemetry, two.telemetry, combineTelemetryFeatures),
        client: combine(one.client, two.client, combineClientFeatures),
        window: combine(one.window, two.window, combineWindowFeatures),
        workspace: combine(one.workspace, two.workspace, combineWorkspaceFeatures),
        languages: combine(one.languages, two.languages, combineLanguagesFeatures),
        notebooks: combine(one.notebooks, two.notebooks, combineNotebooksFeatures)
    };
    return result;
}
exports.combineFeatures = combineFeatures;
function createConnection(connectionFactory, watchDog, factories) {
    const logger = (factories && factories.console ? new (factories.console(RemoteConsoleImpl))() : new RemoteConsoleImpl());
    const connection = connectionFactory(logger);
    logger.rawAttach(connection);
    const tracer = (factories && factories.tracer ? new (factories.tracer(TracerImpl))() : new TracerImpl());
    const telemetry = (factories && factories.telemetry ? new (factories.telemetry(TelemetryImpl))() : new TelemetryImpl());
    const client = (factories && factories.client ? new (factories.client(RemoteClientImpl))() : new RemoteClientImpl());
    const remoteWindow = (factories && factories.window ? new (factories.window(RemoteWindowImpl))() : new RemoteWindowImpl());
    const workspace = (factories && factories.workspace ? new (factories.workspace(RemoteWorkspaceImpl))() : new RemoteWorkspaceImpl());
    const languages = (factories && factories.languages ? new (factories.languages(LanguagesImpl))() : new LanguagesImpl());
    const notebooks = (factories && factories.notebooks ? new (factories.notebooks(NotebooksImpl))() : new NotebooksImpl());
    const allRemotes = [logger, tracer, telemetry, client, remoteWindow, workspace, languages, notebooks];
    function asPromise(value) {
        if (value instanceof Promise) {
            return value;
        }
        else if (Is.thenable(value)) {
            return new Promise((resolve, reject) => {
                value.then((resolved) => resolve(resolved), (error) => reject(error));
            });
        }
        else {
            return Promise.resolve(value);
        }
    }
    let shutdownHandler = undefined;
    let initializeHandler = undefined;
    let exitHandler = undefined;
    let protocolConnection = {
        listen: () => connection.listen(),
        sendRequest: (type, ...params) => connection.sendRequest(Is.string(type) ? type : type.method, ...params),
        onRequest: (type, handler) => connection.onRequest(type, handler),
        sendNotification: (type, param) => {
            const method = Is.string(type) ? type : type.method;
            return connection.sendNotification(method, param);
        },
        onNotification: (type, handler) => connection.onNotification(type, handler),
        onProgress: connection.onProgress,
        sendProgress: connection.sendProgress,
        onInitialize: (handler) => {
            initializeHandler = handler;
            return {
                dispose: () => {
                    initializeHandler = undefined;
                }
            };
        },
        onInitialized: (handler) => connection.onNotification(vscode_languageserver_protocol_1.InitializedNotification.type, handler),
        onShutdown: (handler) => {
            shutdownHandler = handler;
            return {
                dispose: () => {
                    shutdownHandler = undefined;
                }
            };
        },
        onExit: (handler) => {
            exitHandler = handler;
            return {
                dispose: () => {
                    exitHandler = undefined;
                }
            };
        },
        get console() { return logger; },
        get telemetry() { return telemetry; },
        get tracer() { return tracer; },
        get client() { return client; },
        get window() { return remoteWindow; },
        get workspace() { return workspace; },
        get languages() { return languages; },
        get notebooks() { return notebooks; },
        onDidChangeConfiguration: (handler) => connection.onNotification(vscode_languageserver_protocol_1.DidChangeConfigurationNotification.type, handler),
        onDidChangeWatchedFiles: (handler) => connection.onNotification(vscode_languageserver_protocol_1.DidChangeWatchedFilesNotification.type, handler),
        __textDocumentSync: undefined,
        onDidOpenTextDocument: (handler) => connection.onNotification(vscode_languageserver_protocol_1.DidOpenTextDocumentNotification.type, handler),
        onDidChangeTextDocument: (handler) => connection.onNotification(vscode_languageserver_protocol_1.DidChangeTextDocumentNotification.type, handler),
        onDidCloseTextDocument: (handler) => connection.onNotification(vscode_languageserver_protocol_1.DidCloseTextDocumentNotification.type, handler),
        onWillSaveTextDocument: (handler) => connection.onNotification(vscode_languageserver_protocol_1.WillSaveTextDocumentNotification.type, handler),
        onWillSaveTextDocumentWaitUntil: (handler) => connection.onRequest(vscode_languageserver_protocol_1.WillSaveTextDocumentWaitUntilRequest.type, handler),
        onDidSaveTextDocument: (handler) => connection.onNotification(vscode_languageserver_protocol_1.DidSaveTextDocumentNotification.type, handler),
        sendDiagnostics: (params) => connection.sendNotification(vscode_languageserver_protocol_1.PublishDiagnosticsNotification.type, params),
        onHover: (handler) => connection.onRequest(vscode_languageserver_protocol_1.HoverRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), undefined);
        }),
        onCompletion: (handler) => connection.onRequest(vscode_languageserver_protocol_1.CompletionRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), (0, progress_1.attachPartialResult)(connection, params));
        }),
        onCompletionResolve: (handler) => connection.onRequest(vscode_languageserver_protocol_1.CompletionResolveRequest.type, handler),
        onSignatureHelp: (handler) => connection.onRequest(vscode_languageserver_protocol_1.SignatureHelpRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), undefined);
        }),
        onDeclaration: (handler) => connection.onRequest(vscode_languageserver_protocol_1.DeclarationRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), (0, progress_1.attachPartialResult)(connection, params));
        }),
        onDefinition: (handler) => connection.onRequest(vscode_languageserver_protocol_1.DefinitionRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), (0, progress_1.attachPartialResult)(connection, params));
        }),
        onTypeDefinition: (handler) => connection.onRequest(vscode_languageserver_protocol_1.TypeDefinitionRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), (0, progress_1.attachPartialResult)(connection, params));
        }),
        onImplementation: (handler) => connection.onRequest(vscode_languageserver_protocol_1.ImplementationRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), (0, progress_1.attachPartialResult)(connection, params));
        }),
        onReferences: (handler) => connection.onRequest(vscode_languageserver_protocol_1.ReferencesRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), (0, progress_1.attachPartialResult)(connection, params));
        }),
        onDocumentHighlight: (handler) => connection.onRequest(vscode_languageserver_protocol_1.DocumentHighlightRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), (0, progress_1.attachPartialResult)(connection, params));
        }),
        onDocumentSymbol: (handler) => connection.onRequest(vscode_languageserver_protocol_1.DocumentSymbolRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), (0, progress_1.attachPartialResult)(connection, params));
        }),
        onWorkspaceSymbol: (handler) => connection.onRequest(vscode_languageserver_protocol_1.WorkspaceSymbolRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), (0, progress_1.attachPartialResult)(connection, params));
        }),
        onWorkspaceSymbolResolve: (handler) => connection.onRequest(vscode_languageserver_protocol_1.WorkspaceSymbolResolveRequest.type, handler),
        onCodeAction: (handler) => connection.onRequest(vscode_languageserver_protocol_1.CodeActionRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), (0, progress_1.attachPartialResult)(connection, params));
        }),
        onCodeActionResolve: (handler) => connection.onRequest(vscode_languageserver_protocol_1.CodeActionResolveRequest.type, (params, cancel) => {
            return handler(params, cancel);
        }),
        onCodeLens: (handler) => connection.onRequest(vscode_languageserver_protocol_1.CodeLensRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), (0, progress_1.attachPartialResult)(connection, params));
        }),
        onCodeLensResolve: (handler) => connection.onRequest(vscode_languageserver_protocol_1.CodeLensResolveRequest.type, (params, cancel) => {
            return handler(params, cancel);
        }),
        onDocumentFormatting: (handler) => connection.onRequest(vscode_languageserver_protocol_1.DocumentFormattingRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), undefined);
        }),
        onDocumentRangeFormatting: (handler) => connection.onRequest(vscode_languageserver_protocol_1.DocumentRangeFormattingRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), undefined);
        }),
        onDocumentOnTypeFormatting: (handler) => connection.onRequest(vscode_languageserver_protocol_1.DocumentOnTypeFormattingRequest.type, (params, cancel) => {
            return handler(params, cancel);
        }),
        onRenameRequest: (handler) => connection.onRequest(vscode_languageserver_protocol_1.RenameRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), undefined);
        }),
        onPrepareRename: (handler) => connection.onRequest(vscode_languageserver_protocol_1.PrepareRenameRequest.type, (params, cancel) => {
            return handler(params, cancel);
        }),
        onDocumentLinks: (handler) => connection.onRequest(vscode_languageserver_protocol_1.DocumentLinkRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), (0, progress_1.attachPartialResult)(connection, params));
        }),
        onDocumentLinkResolve: (handler) => connection.onRequest(vscode_languageserver_protocol_1.DocumentLinkResolveRequest.type, (params, cancel) => {
            return handler(params, cancel);
        }),
        onDocumentColor: (handler) => connection.onRequest(vscode_languageserver_protocol_1.DocumentColorRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), (0, progress_1.attachPartialResult)(connection, params));
        }),
        onColorPresentation: (handler) => connection.onRequest(vscode_languageserver_protocol_1.ColorPresentationRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), (0, progress_1.attachPartialResult)(connection, params));
        }),
        onFoldingRanges: (handler) => connection.onRequest(vscode_languageserver_protocol_1.FoldingRangeRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), (0, progress_1.attachPartialResult)(connection, params));
        }),
        onSelectionRanges: (handler) => connection.onRequest(vscode_languageserver_protocol_1.SelectionRangeRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), (0, progress_1.attachPartialResult)(connection, params));
        }),
        onExecuteCommand: (handler) => connection.onRequest(vscode_languageserver_protocol_1.ExecuteCommandRequest.type, (params, cancel) => {
            return handler(params, cancel, (0, progress_1.attachWorkDone)(connection, params), undefined);
        }),
        dispose: () => connection.dispose()
    };
    for (let remote of allRemotes) {
        remote.attach(protocolConnection);
    }
    connection.onRequest(vscode_languageserver_protocol_1.InitializeRequest.type, (params) => {
        watchDog.initialize(params);
        if (Is.string(params.trace)) {
            tracer.trace = vscode_languageserver_protocol_1.Trace.fromString(params.trace);
        }
        for (let remote of allRemotes) {
            remote.initialize(params.capabilities);
        }
        if (initializeHandler) {
            let result = initializeHandler(params, new vscode_languageserver_protocol_1.CancellationTokenSource().token, (0, progress_1.attachWorkDone)(connection, params), undefined);
            return asPromise(result).then((value) => {
                if (value instanceof vscode_languageserver_protocol_1.ResponseError) {
                    return value;
                }
                let result = value;
                if (!result) {
                    result = { capabilities: {} };
                }
                let capabilities = result.capabilities;
                if (!capabilities) {
                    capabilities = {};
                    result.capabilities = capabilities;
                }
                if (capabilities.textDocumentSync === undefined || capabilities.textDocumentSync === null) {
                    capabilities.textDocumentSync = Is.number(protocolConnection.__textDocumentSync) ? protocolConnection.__textDocumentSync : vscode_languageserver_protocol_1.TextDocumentSyncKind.None;
                }
                else if (!Is.number(capabilities.textDocumentSync) && !Is.number(capabilities.textDocumentSync.change)) {
                    capabilities.textDocumentSync.change = Is.number(protocolConnection.__textDocumentSync) ? protocolConnection.__textDocumentSync : vscode_languageserver_protocol_1.TextDocumentSyncKind.None;
                }
                for (let remote of allRemotes) {
                    remote.fillServerCapabilities(capabilities);
                }
                return result;
            });
        }
        else {
            let result = { capabilities: { textDocumentSync: vscode_languageserver_protocol_1.TextDocumentSyncKind.None } };
            for (let remote of allRemotes) {
                remote.fillServerCapabilities(result.capabilities);
            }
            return result;
        }
    });
    connection.onRequest(vscode_languageserver_protocol_1.ShutdownRequest.type, () => {
        watchDog.shutdownReceived = true;
        if (shutdownHandler) {
            return shutdownHandler(new vscode_languageserver_protocol_1.CancellationTokenSource().token);
        }
        else {
            return undefined;
        }
    });
    connection.onNotification(vscode_languageserver_protocol_1.ExitNotification.type, () => {
        try {
            if (exitHandler) {
                exitHandler();
            }
        }
        finally {
            if (watchDog.shutdownReceived) {
                watchDog.exit(0);
            }
            else {
                watchDog.exit(1);
            }
        }
    });
    connection.onNotification(vscode_languageserver_protocol_1.SetTraceNotification.type, (params) => {
        tracer.trace = vscode_languageserver_protocol_1.Trace.fromString(params.value);
    });
    return protocolConnection;
}
exports.createConnection = createConnection;


/***/ },

/***/ 8817
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.ShowDocumentFeature = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const ShowDocumentFeature = (Base) => {
    return class extends Base {
        showDocument(params) {
            return this.connection.sendRequest(vscode_languageserver_protocol_1.ShowDocumentRequest.type, params);
        }
    };
};
exports.ShowDocumentFeature = ShowDocumentFeature;


/***/ },

/***/ 1662
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.TextDocuments = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
/**
 * A manager for simple text documents. The manager requires at a minimum that
 * the server registered for the following text document sync events in the
 * initialize handler or via dynamic registration:
 *
 * - open and close events.
 * - change events.
 *
 * Registering for save and will save events is optional.
 */
class TextDocuments {
    /**
     * Create a new text document manager.
     */
    constructor(configuration) {
        this._configuration = configuration;
        this._syncedDocuments = new Map();
        this._onDidChangeContent = new vscode_languageserver_protocol_1.Emitter();
        this._onDidOpen = new vscode_languageserver_protocol_1.Emitter();
        this._onDidClose = new vscode_languageserver_protocol_1.Emitter();
        this._onDidSave = new vscode_languageserver_protocol_1.Emitter();
        this._onWillSave = new vscode_languageserver_protocol_1.Emitter();
    }
    /**
     * An event that fires when a text document managed by this manager
     * has been opened.
     */
    get onDidOpen() {
        return this._onDidOpen.event;
    }
    /**
     * An event that fires when a text document managed by this manager
     * has been opened or the content changes.
     */
    get onDidChangeContent() {
        return this._onDidChangeContent.event;
    }
    /**
     * An event that fires when a text document managed by this manager
     * will be saved.
     */
    get onWillSave() {
        return this._onWillSave.event;
    }
    /**
     * Sets a handler that will be called if a participant wants to provide
     * edits during a text document save.
     */
    onWillSaveWaitUntil(handler) {
        this._willSaveWaitUntil = handler;
    }
    /**
     * An event that fires when a text document managed by this manager
     * has been saved.
     */
    get onDidSave() {
        return this._onDidSave.event;
    }
    /**
     * An event that fires when a text document managed by this manager
     * has been closed.
     */
    get onDidClose() {
        return this._onDidClose.event;
    }
    /**
     * Returns the document for the given URI. Returns undefined if
     * the document is not managed by this instance.
     *
     * @param uri The text document's URI to retrieve.
     * @return the text document or `undefined`.
     */
    get(uri) {
        return this._syncedDocuments.get(uri);
    }
    /**
     * Returns all text documents managed by this instance.
     *
     * @return all text documents.
     */
    all() {
        return Array.from(this._syncedDocuments.values());
    }
    /**
     * Returns the URIs of all text documents managed by this instance.
     *
     * @return the URI's of all text documents.
     */
    keys() {
        return Array.from(this._syncedDocuments.keys());
    }
    /**
     * Listens for `low level` notification on the given connection to
     * update the text documents managed by this instance.
     *
     * Please note that the connection only provides handlers not an event model. Therefore
     * listening on a connection will overwrite the following handlers on a connection:
     * `onDidOpenTextDocument`, `onDidChangeTextDocument`, `onDidCloseTextDocument`,
     * `onWillSaveTextDocument`, `onWillSaveTextDocumentWaitUntil` and `onDidSaveTextDocument`.
     *
     * Use the corresponding events on the TextDocuments instance instead.
     *
     * @param connection The connection to listen on.
     */
    listen(connection) {
        connection.__textDocumentSync = vscode_languageserver_protocol_1.TextDocumentSyncKind.Incremental;
        const disposables = [];
        disposables.push(connection.onDidOpenTextDocument((event) => {
            const td = event.textDocument;
            const document = this._configuration.create(td.uri, td.languageId, td.version, td.text);
            this._syncedDocuments.set(td.uri, document);
            const toFire = Object.freeze({ document });
            this._onDidOpen.fire(toFire);
            this._onDidChangeContent.fire(toFire);
        }));
        disposables.push(connection.onDidChangeTextDocument((event) => {
            const td = event.textDocument;
            const changes = event.contentChanges;
            if (changes.length === 0) {
                return;
            }
            const { version } = td;
            if (version === null || version === undefined) {
                throw new Error(`Received document change event for ${td.uri} without valid version identifier`);
            }
            let syncedDocument = this._syncedDocuments.get(td.uri);
            if (syncedDocument !== undefined) {
                syncedDocument = this._configuration.update(syncedDocument, changes, version);
                this._syncedDocuments.set(td.uri, syncedDocument);
                this._onDidChangeContent.fire(Object.freeze({ document: syncedDocument }));
            }
        }));
        disposables.push(connection.onDidCloseTextDocument((event) => {
            let syncedDocument = this._syncedDocuments.get(event.textDocument.uri);
            if (syncedDocument !== undefined) {
                this._syncedDocuments.delete(event.textDocument.uri);
                this._onDidClose.fire(Object.freeze({ document: syncedDocument }));
            }
        }));
        disposables.push(connection.onWillSaveTextDocument((event) => {
            let syncedDocument = this._syncedDocuments.get(event.textDocument.uri);
            if (syncedDocument !== undefined) {
                this._onWillSave.fire(Object.freeze({ document: syncedDocument, reason: event.reason }));
            }
        }));
        disposables.push(connection.onWillSaveTextDocumentWaitUntil((event, token) => {
            let syncedDocument = this._syncedDocuments.get(event.textDocument.uri);
            if (syncedDocument !== undefined && this._willSaveWaitUntil) {
                return this._willSaveWaitUntil(Object.freeze({ document: syncedDocument, reason: event.reason }), token);
            }
            else {
                return [];
            }
        }));
        disposables.push(connection.onDidSaveTextDocument((event) => {
            let syncedDocument = this._syncedDocuments.get(event.textDocument.uri);
            if (syncedDocument !== undefined) {
                this._onDidSave.fire(Object.freeze({ document: syncedDocument }));
            }
        }));
        return vscode_languageserver_protocol_1.Disposable.create(() => { disposables.forEach(disposable => disposable.dispose()); });
    }
}
exports.TextDocuments = TextDocuments;


/***/ },

/***/ 5026
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.TypeHierarchyFeature = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const TypeHierarchyFeature = (Base) => {
    return class extends Base {
        get typeHierarchy() {
            return {
                onPrepare: (handler) => {
                    return this.connection.onRequest(vscode_languageserver_protocol_1.TypeHierarchyPrepareRequest.type, (params, cancel) => {
                        return handler(params, cancel, this.attachWorkDoneProgress(params), undefined);
                    });
                },
                onSupertypes: (handler) => {
                    const type = vscode_languageserver_protocol_1.TypeHierarchySupertypesRequest.type;
                    return this.connection.onRequest(type, (params, cancel) => {
                        return handler(params, cancel, this.attachWorkDoneProgress(params), this.attachPartialResultProgress(type, params));
                    });
                },
                onSubtypes: (handler) => {
                    const type = vscode_languageserver_protocol_1.TypeHierarchySubtypesRequest.type;
                    return this.connection.onRequest(type, (params, cancel) => {
                        return handler(params, cancel, this.attachWorkDoneProgress(params), this.attachPartialResultProgress(type, params));
                    });
                }
            };
        }
    };
};
exports.TypeHierarchyFeature = TypeHierarchyFeature;


/***/ },

/***/ 8867
(__unused_webpack_module, exports) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.thenable = exports.typedArray = exports.stringArray = exports.array = exports.func = exports.error = exports.number = exports.string = exports.boolean = void 0;
function boolean(value) {
    return value === true || value === false;
}
exports.boolean = boolean;
function string(value) {
    return typeof value === 'string' || value instanceof String;
}
exports.string = string;
function number(value) {
    return typeof value === 'number' || value instanceof Number;
}
exports.number = number;
function error(value) {
    return value instanceof Error;
}
exports.error = error;
function func(value) {
    return typeof value === 'function';
}
exports.func = func;
function array(value) {
    return Array.isArray(value);
}
exports.array = array;
function stringArray(value) {
    return array(value) && value.every(elem => string(elem));
}
exports.stringArray = stringArray;
function typedArray(value, check) {
    return Array.isArray(value) && value.every(check);
}
exports.typedArray = typedArray;
function thenable(value) {
    return value && func(value.then);
}
exports.thenable = thenable;


/***/ },

/***/ 6116
(__unused_webpack_module, exports) {

"use strict";

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.generateUuid = exports.parse = exports.isUUID = exports.v4 = exports.empty = void 0;
class ValueUUID {
    constructor(_value) {
        this._value = _value;
        // empty
    }
    asHex() {
        return this._value;
    }
    equals(other) {
        return this.asHex() === other.asHex();
    }
}
class V4UUID extends ValueUUID {
    static _oneOf(array) {
        return array[Math.floor(array.length * Math.random())];
    }
    static _randomHex() {
        return V4UUID._oneOf(V4UUID._chars);
    }
    constructor() {
        super([
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            '-',
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            '-',
            '4',
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            '-',
            V4UUID._oneOf(V4UUID._timeHighBits),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            '-',
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
            V4UUID._randomHex(),
        ].join(''));
    }
}
V4UUID._chars = ['0', '1', '2', '3', '4', '5', '6', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
V4UUID._timeHighBits = ['8', '9', 'a', 'b'];
/**
 * An empty UUID that contains only zeros.
 */
exports.empty = new ValueUUID('00000000-0000-0000-0000-000000000000');
function v4() {
    return new V4UUID();
}
exports.v4 = v4;
const _UUIDPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUUID(value) {
    return _UUIDPattern.test(value);
}
exports.isUUID = isUUID;
/**
 * Parses a UUID that is of the format xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.
 * @param value A uuid string.
 */
function parse(value) {
    if (!isUUID(value)) {
        throw new Error('invalid uuid');
    }
    return new ValueUUID(value);
}
exports.parse = parse;
function generateUuid() {
    return v4().asHex();
}
exports.generateUuid = generateUuid;


/***/ },

/***/ 2112
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.WorkspaceFoldersFeature = void 0;
const vscode_languageserver_protocol_1 = __webpack_require__(7354);
const WorkspaceFoldersFeature = (Base) => {
    return class extends Base {
        constructor() {
            super();
            this._notificationIsAutoRegistered = false;
        }
        initialize(capabilities) {
            super.initialize(capabilities);
            let workspaceCapabilities = capabilities.workspace;
            if (workspaceCapabilities && workspaceCapabilities.workspaceFolders) {
                this._onDidChangeWorkspaceFolders = new vscode_languageserver_protocol_1.Emitter();
                this.connection.onNotification(vscode_languageserver_protocol_1.DidChangeWorkspaceFoldersNotification.type, (params) => {
                    this._onDidChangeWorkspaceFolders.fire(params.event);
                });
            }
        }
        fillServerCapabilities(capabilities) {
            super.fillServerCapabilities(capabilities);
            const changeNotifications = capabilities.workspace?.workspaceFolders?.changeNotifications;
            this._notificationIsAutoRegistered = changeNotifications === true || typeof changeNotifications === 'string';
        }
        getWorkspaceFolders() {
            return this.connection.sendRequest(vscode_languageserver_protocol_1.WorkspaceFoldersRequest.type);
        }
        get onDidChangeWorkspaceFolders() {
            if (!this._onDidChangeWorkspaceFolders) {
                throw new Error('Client doesn\'t support sending workspace folder change events.');
            }
            if (!this._notificationIsAutoRegistered && !this._unregistration) {
                this._unregistration = this.connection.client.register(vscode_languageserver_protocol_1.DidChangeWorkspaceFoldersNotification.type);
            }
            return this._onDidChangeWorkspaceFolders.event;
        }
    };
};
exports.WorkspaceFoldersFeature = WorkspaceFoldersFeature;


/***/ },

/***/ 3911
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.resolveModulePath = exports.FileSystem = exports.resolveGlobalYarnPath = exports.resolveGlobalNodePath = exports.resolve = exports.uriToFilePath = void 0;
const url = __webpack_require__(6857);
const path = __webpack_require__(2003);
const fs = __webpack_require__(4383);
const child_process_1 = __webpack_require__(3200);
/**
 * @deprecated Use the `vscode-uri` npm module which provides a more
 * complete implementation of handling VS Code URIs.
 */
function uriToFilePath(uri) {
    let parsed = url.parse(uri);
    if (parsed.protocol !== 'file:' || !parsed.path) {
        return undefined;
    }
    let segments = parsed.path.split('/');
    for (var i = 0, len = segments.length; i < len; i++) {
        segments[i] = decodeURIComponent(segments[i]);
    }
    if (process.platform === 'win32' && segments.length > 1) {
        let first = segments[0];
        let second = segments[1];
        // Do we have a drive letter and we started with a / which is the
        // case if the first segement is empty (see split above)
        if (first.length === 0 && second.length > 1 && second[1] === ':') {
            // Remove first slash
            segments.shift();
        }
    }
    return path.normalize(segments.join('/'));
}
exports.uriToFilePath = uriToFilePath;
function isWindows() {
    return process.platform === 'win32';
}
function resolve(moduleName, nodePath, cwd, tracer) {
    const nodePathKey = 'NODE_PATH';
    const app = [
        'var p = process;',
        'p.on(\'message\',function(m){',
        'if(m.c===\'e\'){',
        'p.exit(0);',
        '}',
        'else if(m.c===\'rs\'){',
        'try{',
        'var r=require.resolve(m.a);',
        'p.send({c:\'r\',s:true,r:r});',
        '}',
        'catch(err){',
        'p.send({c:\'r\',s:false});',
        '}',
        '}',
        '});'
    ].join('');
    return new Promise((resolve, reject) => {
        let env = process.env;
        let newEnv = Object.create(null);
        Object.keys(env).forEach(key => newEnv[key] = env[key]);
        if (nodePath && fs.existsSync(nodePath) /* see issue 545 */) {
            if (newEnv[nodePathKey]) {
                newEnv[nodePathKey] = nodePath + path.delimiter + newEnv[nodePathKey];
            }
            else {
                newEnv[nodePathKey] = nodePath;
            }
            if (tracer) {
                tracer(`NODE_PATH value is: ${newEnv[nodePathKey]}`);
            }
        }
        newEnv['ELECTRON_RUN_AS_NODE'] = '1';
        try {
            let cp = (0, child_process_1.fork)('', [], {
                cwd: cwd,
                env: newEnv,
                execArgv: ['-e', app]
            });
            if (cp.pid === void 0) {
                reject(new Error(`Starting process to resolve node module  ${moduleName} failed`));
                return;
            }
            cp.on('error', (error) => {
                reject(error);
            });
            cp.on('message', (message) => {
                if (message.c === 'r') {
                    cp.send({ c: 'e' });
                    if (message.s) {
                        resolve(message.r);
                    }
                    else {
                        reject(new Error(`Failed to resolve module: ${moduleName}`));
                    }
                }
            });
            let message = {
                c: 'rs',
                a: moduleName
            };
            cp.send(message);
        }
        catch (error) {
            reject(error);
        }
    });
}
exports.resolve = resolve;
/**
 * Resolve the global npm package path.
 * @deprecated Since this depends on the used package manager and their version the best is that servers
 * implement this themselves since they know best what kind of package managers to support.
 * @param tracer the tracer to use
 */
function resolveGlobalNodePath(tracer) {
    let npmCommand = 'npm';
    const env = Object.create(null);
    Object.keys(process.env).forEach(key => env[key] = process.env[key]);
    env['NO_UPDATE_NOTIFIER'] = 'true';
    const options = {
        encoding: 'utf8',
        env
    };
    if (isWindows()) {
        npmCommand = 'npm.cmd';
        options.shell = true;
    }
    let handler = () => { };
    try {
        process.on('SIGPIPE', handler);
        let stdout = (0, child_process_1.spawnSync)(npmCommand, ['config', 'get', 'prefix'], options).stdout;
        if (!stdout) {
            if (tracer) {
                tracer(`'npm config get prefix' didn't return a value.`);
            }
            return undefined;
        }
        let prefix = stdout.trim();
        if (tracer) {
            tracer(`'npm config get prefix' value is: ${prefix}`);
        }
        if (prefix.length > 0) {
            if (isWindows()) {
                return path.join(prefix, 'node_modules');
            }
            else {
                return path.join(prefix, 'lib', 'node_modules');
            }
        }
        return undefined;
    }
    catch (err) {
        return undefined;
    }
    finally {
        process.removeListener('SIGPIPE', handler);
    }
}
exports.resolveGlobalNodePath = resolveGlobalNodePath;
/*
 * Resolve the global yarn pakage path.
 * @deprecated Since this depends on the used package manager and their version the best is that servers
 * implement this themselves since they know best what kind of package managers to support.
 * @param tracer the tracer to use
 */
function resolveGlobalYarnPath(tracer) {
    let yarnCommand = 'yarn';
    let options = {
        encoding: 'utf8'
    };
    if (isWindows()) {
        yarnCommand = 'yarn.cmd';
        options.shell = true;
    }
    let handler = () => { };
    try {
        process.on('SIGPIPE', handler);
        let results = (0, child_process_1.spawnSync)(yarnCommand, ['global', 'dir', '--json'], options);
        let stdout = results.stdout;
        if (!stdout) {
            if (tracer) {
                tracer(`'yarn global dir' didn't return a value.`);
                if (results.stderr) {
                    tracer(results.stderr);
                }
            }
            return undefined;
        }
        let lines = stdout.trim().split(/\r?\n/);
        for (let line of lines) {
            try {
                let yarn = JSON.parse(line);
                if (yarn.type === 'log') {
                    return path.join(yarn.data, 'node_modules');
                }
            }
            catch (e) {
                // Do nothing. Ignore the line
            }
        }
        return undefined;
    }
    catch (err) {
        return undefined;
    }
    finally {
        process.removeListener('SIGPIPE', handler);
    }
}
exports.resolveGlobalYarnPath = resolveGlobalYarnPath;
var FileSystem;
(function (FileSystem) {
    let _isCaseSensitive = undefined;
    function isCaseSensitive() {
        if (_isCaseSensitive !== void 0) {
            return _isCaseSensitive;
        }
        if (process.platform === 'win32') {
            _isCaseSensitive = false;
        }
        else {
            // convert current file name to upper case / lower case and check if file exists
            // (guards against cases when name is already all uppercase or lowercase)
            _isCaseSensitive = !fs.existsSync(__filename.toUpperCase()) || !fs.existsSync(__filename.toLowerCase());
        }
        return _isCaseSensitive;
    }
    FileSystem.isCaseSensitive = isCaseSensitive;
    function isParent(parent, child) {
        if (isCaseSensitive()) {
            return path.normalize(child).indexOf(path.normalize(parent)) === 0;
        }
        else {
            return path.normalize(child).toLowerCase().indexOf(path.normalize(parent).toLowerCase()) === 0;
        }
    }
    FileSystem.isParent = isParent;
})(FileSystem || (exports.FileSystem = FileSystem = {}));
function resolveModulePath(workspaceRoot, moduleName, nodePath, tracer) {
    if (nodePath) {
        if (!path.isAbsolute(nodePath)) {
            nodePath = path.join(workspaceRoot, nodePath);
        }
        return resolve(moduleName, nodePath, nodePath, tracer).then((value) => {
            if (FileSystem.isParent(nodePath, value)) {
                return value;
            }
            else {
                return Promise.reject(new Error(`Failed to load ${moduleName} from node path location.`));
            }
        }).then(undefined, (_error) => {
            return resolve(moduleName, resolveGlobalNodePath(tracer), workspaceRoot, tracer);
        });
    }
    else {
        return resolve(moduleName, resolveGlobalNodePath(tracer), workspaceRoot, tracer);
    }
}
exports.resolveModulePath = resolveModulePath;


/***/ },

/***/ 1327
(__unused_webpack_module, exports, __webpack_require__) {

"use strict";

/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
/// <reference path="../../typings/thenable.d.ts" />
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.createConnection = exports.Files = void 0;
const node_util_1 = __webpack_require__(7975);
const Is = __webpack_require__(8867);
const server_1 = __webpack_require__(7874);
const fm = __webpack_require__(3911);
const node_1 = __webpack_require__(948);
__exportStar(__webpack_require__(948), exports);
__exportStar(__webpack_require__(2861), exports);
var Files;
(function (Files) {
    Files.uriToFilePath = fm.uriToFilePath;
    Files.resolveGlobalNodePath = fm.resolveGlobalNodePath;
    Files.resolveGlobalYarnPath = fm.resolveGlobalYarnPath;
    Files.resolve = fm.resolve;
    Files.resolveModulePath = fm.resolveModulePath;
})(Files || (exports.Files = Files = {}));
let _protocolConnection;
function endProtocolConnection() {
    if (_protocolConnection === undefined) {
        return;
    }
    try {
        _protocolConnection.end();
    }
    catch (_err) {
        // Ignore. The client process could have already
        // did and we can't send an end into the connection.
    }
}
let _shutdownReceived = false;
let exitTimer = undefined;
function setupExitTimer() {
    const argName = '--clientProcessId';
    function runTimer(value) {
        try {
            let processId = parseInt(value);
            if (!isNaN(processId)) {
                exitTimer = setInterval(() => {
                    try {
                        process.kill(processId, 0);
                    }
                    catch (ex) {
                        // Parent process doesn't exist anymore. Exit the server.
                        endProtocolConnection();
                        process.exit(_shutdownReceived ? 0 : 1);
                    }
                }, 3000);
            }
        }
        catch (e) {
            // Ignore errors;
        }
    }
    for (let i = 2; i < process.argv.length; i++) {
        let arg = process.argv[i];
        if (arg === argName && i + 1 < process.argv.length) {
            runTimer(process.argv[i + 1]);
            return;
        }
        else {
            let args = arg.split('=');
            if (args[0] === argName) {
                runTimer(args[1]);
            }
        }
    }
}
setupExitTimer();
const watchDog = {
    initialize: (params) => {
        const processId = params.processId;
        if (Is.number(processId) && exitTimer === undefined) {
            // We received a parent process id. Set up a timer to periodically check
            // if the parent is still alive.
            setInterval(() => {
                try {
                    process.kill(processId, 0);
                }
                catch (ex) {
                    // Parent process doesn't exist anymore. Exit the server.
                    process.exit(_shutdownReceived ? 0 : 1);
                }
            }, 3000);
        }
    },
    get shutdownReceived() {
        return _shutdownReceived;
    },
    set shutdownReceived(value) {
        _shutdownReceived = value;
    },
    exit: (code) => {
        endProtocolConnection();
        process.exit(code);
    }
};
function createConnection(arg1, arg2, arg3, arg4) {
    let factories;
    let input;
    let output;
    let options;
    if (arg1 !== void 0 && arg1.__brand === 'features') {
        factories = arg1;
        arg1 = arg2;
        arg2 = arg3;
        arg3 = arg4;
    }
    if (node_1.ConnectionStrategy.is(arg1) || node_1.ConnectionOptions.is(arg1)) {
        options = arg1;
    }
    else {
        input = arg1;
        output = arg2;
        options = arg3;
    }
    return _createConnection(input, output, options, factories);
}
exports.createConnection = createConnection;
function _createConnection(input, output, options, factories) {
    let stdio = false;
    if (!input && !output && process.argv.length > 2) {
        let port = void 0;
        let pipeName = void 0;
        let argv = process.argv.slice(2);
        for (let i = 0; i < argv.length; i++) {
            let arg = argv[i];
            if (arg === '--node-ipc') {
                input = new node_1.IPCMessageReader(process);
                output = new node_1.IPCMessageWriter(process);
                break;
            }
            else if (arg === '--stdio') {
                stdio = true;
                input = process.stdin;
                output = process.stdout;
                break;
            }
            else if (arg === '--socket') {
                port = parseInt(argv[i + 1]);
                break;
            }
            else if (arg === '--pipe') {
                pipeName = argv[i + 1];
                break;
            }
            else {
                var args = arg.split('=');
                if (args[0] === '--socket') {
                    port = parseInt(args[1]);
                    break;
                }
                else if (args[0] === '--pipe') {
                    pipeName = args[1];
                    break;
                }
            }
        }
        if (port) {
            let transport = (0, node_1.createServerSocketTransport)(port);
            input = transport[0];
            output = transport[1];
        }
        else if (pipeName) {
            let transport = (0, node_1.createServerPipeTransport)(pipeName);
            input = transport[0];
            output = transport[1];
        }
    }
    var commandLineMessage = 'Use arguments of createConnection or set command line parameters: \'--node-ipc\', \'--stdio\' or \'--socket={number}\'';
    if (!input) {
        throw new Error('Connection input stream is not set. ' + commandLineMessage);
    }
    if (!output) {
        throw new Error('Connection output stream is not set. ' + commandLineMessage);
    }
    // Backwards compatibility
    if (Is.func(input.read) && Is.func(input.on)) {
        let inputStream = input;
        inputStream.on('end', () => {
            endProtocolConnection();
            process.exit(_shutdownReceived ? 0 : 1);
        });
        inputStream.on('close', () => {
            endProtocolConnection();
            process.exit(_shutdownReceived ? 0 : 1);
        });
    }
    const connectionFactory = (logger) => {
        const result = (0, node_1.createProtocolConnection)(input, output, logger, options);
        if (stdio) {
            patchConsole(logger);
        }
        return result;
    };
    return (0, server_1.createConnection)(connectionFactory, watchDog, factories);
}
function patchConsole(logger) {
    function serialize(args) {
        return args.map(arg => typeof arg === 'string' ? arg : (0, node_util_1.inspect)(arg)).join(' ');
    }
    const counters = new Map();
    console.assert = function assert(assertion, ...args) {
        if (assertion) {
            return;
        }
        if (args.length === 0) {
            logger.error('Assertion failed');
        }
        else {
            const [message, ...rest] = args;
            logger.error(`Assertion failed: ${message} ${serialize(rest)}`);
        }
    };
    console.count = function count(label = 'default') {
        const message = String(label);
        let counter = counters.get(message) ?? 0;
        counter += 1;
        counters.set(message, counter);
        logger.log(`${message}: ${message}`);
    };
    console.countReset = function countReset(label) {
        if (label === undefined) {
            counters.clear();
        }
        else {
            counters.delete(String(label));
        }
    };
    console.debug = function debug(...args) {
        logger.log(serialize(args));
    };
    console.dir = function dir(arg, options) {
        // @ts-expect-error https://github.com/DefinitelyTyped/DefinitelyTyped/pull/66626
        logger.log((0, node_util_1.inspect)(arg, options));
    };
    console.log = function log(...args) {
        logger.log(serialize(args));
    };
    console.error = function error(...args) {
        logger.error(serialize(args));
    };
    console.trace = function trace(...args) {
        const stack = new Error().stack.replace(/(.+\n){2}/, '');
        let message = 'Trace';
        if (args.length !== 0) {
            message += `: ${serialize(args)}`;
        }
        logger.log(`${message}\n${stack}`);
    };
    console.warn = function warn(...args) {
        logger.warn(serialize(args));
    };
}


/***/ },

/***/ 5663
(module, __unused_webpack_exports, __webpack_require__) {

"use strict";
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ----------------------------------------------------------------------------------------- */


module.exports = __webpack_require__(1327);

/***/ },

/***/ 3200
(module) {

"use strict";
module.exports = require("child_process");

/***/ },

/***/ 8749
(module) {

"use strict";
module.exports = require("crypto");

/***/ },

/***/ 4383
(module) {

"use strict";
module.exports = require("fs");

/***/ },

/***/ 2057
(module) {

"use strict";
module.exports = require("https");

/***/ },

/***/ 2135
(module) {

"use strict";
module.exports = require("net");

/***/ },

/***/ 9366
(module) {

"use strict";
module.exports = require("os");

/***/ },

/***/ 2003
(module) {

"use strict";
module.exports = require("path");

/***/ },

/***/ 6857
(module) {

"use strict";
module.exports = require("url");

/***/ },

/***/ 2460
(module) {

"use strict";
module.exports = require("util");

/***/ },

/***/ 7975
(module) {

"use strict";
module.exports = require("node:util");

/***/ },

/***/ 5172
(__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) {

"use strict";
__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   TextDocument: () => (/* binding */ TextDocument)
/* harmony export */ });
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

class FullTextDocument {
    constructor(uri, languageId, version, content) {
        this._uri = uri;
        this._languageId = languageId;
        this._version = version;
        this._content = content;
        this._lineOffsets = undefined;
    }
    get uri() {
        return this._uri;
    }
    get languageId() {
        return this._languageId;
    }
    get version() {
        return this._version;
    }
    getText(range) {
        if (range) {
            const start = this.offsetAt(range.start);
            const end = this.offsetAt(range.end);
            return this._content.substring(start, end);
        }
        return this._content;
    }
    update(changes, version) {
        for (const change of changes) {
            if (FullTextDocument.isIncremental(change)) {
                // makes sure start is before end
                const range = getWellformedRange(change.range);
                // update content
                const startOffset = this.offsetAt(range.start);
                const endOffset = this.offsetAt(range.end);
                this._content = this._content.substring(0, startOffset) + change.text + this._content.substring(endOffset, this._content.length);
                // update the offsets
                const startLine = Math.max(range.start.line, 0);
                const endLine = Math.max(range.end.line, 0);
                let lineOffsets = this._lineOffsets;
                const addedLineOffsets = computeLineOffsets(change.text, false, startOffset);
                if (endLine - startLine === addedLineOffsets.length) {
                    for (let i = 0, len = addedLineOffsets.length; i < len; i++) {
                        lineOffsets[i + startLine + 1] = addedLineOffsets[i];
                    }
                }
                else {
                    if (addedLineOffsets.length < 10000) {
                        lineOffsets.splice(startLine + 1, endLine - startLine, ...addedLineOffsets);
                    }
                    else { // avoid too many arguments for splice
                        this._lineOffsets = lineOffsets = lineOffsets.slice(0, startLine + 1).concat(addedLineOffsets, lineOffsets.slice(endLine + 1));
                    }
                }
                const diff = change.text.length - (endOffset - startOffset);
                if (diff !== 0) {
                    for (let i = startLine + 1 + addedLineOffsets.length, len = lineOffsets.length; i < len; i++) {
                        lineOffsets[i] = lineOffsets[i] + diff;
                    }
                }
            }
            else if (FullTextDocument.isFull(change)) {
                this._content = change.text;
                this._lineOffsets = undefined;
            }
            else {
                throw new Error('Unknown change event received');
            }
        }
        this._version = version;
    }
    getLineOffsets() {
        if (this._lineOffsets === undefined) {
            this._lineOffsets = computeLineOffsets(this._content, true);
        }
        return this._lineOffsets;
    }
    positionAt(offset) {
        offset = Math.max(Math.min(offset, this._content.length), 0);
        const lineOffsets = this.getLineOffsets();
        let low = 0, high = lineOffsets.length;
        if (high === 0) {
            return { line: 0, character: offset };
        }
        while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (lineOffsets[mid] > offset) {
                high = mid;
            }
            else {
                low = mid + 1;
            }
        }
        // low is the least x for which the line offset is larger than the current offset
        // or array.length if no line offset is larger than the current offset
        const line = low - 1;
        offset = this.ensureBeforeEOL(offset, lineOffsets[line]);
        return { line, character: offset - lineOffsets[line] };
    }
    offsetAt(position) {
        const lineOffsets = this.getLineOffsets();
        if (position.line >= lineOffsets.length) {
            return this._content.length;
        }
        else if (position.line < 0) {
            return 0;
        }
        const lineOffset = lineOffsets[position.line];
        if (position.character <= 0) {
            return lineOffset;
        }
        const nextLineOffset = (position.line + 1 < lineOffsets.length) ? lineOffsets[position.line + 1] : this._content.length;
        const offset = Math.min(lineOffset + position.character, nextLineOffset);
        return this.ensureBeforeEOL(offset, lineOffset);
    }
    ensureBeforeEOL(offset, lineOffset) {
        while (offset > lineOffset && isEOL(this._content.charCodeAt(offset - 1))) {
            offset--;
        }
        return offset;
    }
    get lineCount() {
        return this.getLineOffsets().length;
    }
    static isIncremental(event) {
        const candidate = event;
        return candidate !== undefined && candidate !== null &&
            typeof candidate.text === 'string' && candidate.range !== undefined &&
            (candidate.rangeLength === undefined || typeof candidate.rangeLength === 'number');
    }
    static isFull(event) {
        const candidate = event;
        return candidate !== undefined && candidate !== null &&
            typeof candidate.text === 'string' && candidate.range === undefined && candidate.rangeLength === undefined;
    }
}
var TextDocument;
(function (TextDocument) {
    /**
     * Creates a new text document.
     *
     * @param uri The document's uri.
     * @param languageId  The document's language Id.
     * @param version The document's initial version number.
     * @param content The document's content.
     */
    function create(uri, languageId, version, content) {
        return new FullTextDocument(uri, languageId, version, content);
    }
    TextDocument.create = create;
    /**
     * Updates a TextDocument by modifying its content.
     *
     * @param document the document to update. Only documents created by TextDocument.create are valid inputs.
     * @param changes the changes to apply to the document.
     * @param version the changes version for the document.
     * @returns The updated TextDocument. Note: That's the same document instance passed in as first parameter.
     *
     */
    function update(document, changes, version) {
        if (document instanceof FullTextDocument) {
            document.update(changes, version);
            return document;
        }
        else {
            throw new Error('TextDocument.update: document must be created by TextDocument.create');
        }
    }
    TextDocument.update = update;
    function applyEdits(document, edits) {
        const text = document.getText();
        const sortedEdits = mergeSort(edits.map(getWellformedEdit), (a, b) => {
            const diff = a.range.start.line - b.range.start.line;
            if (diff === 0) {
                return a.range.start.character - b.range.start.character;
            }
            return diff;
        });
        let lastModifiedOffset = 0;
        const spans = [];
        for (const e of sortedEdits) {
            const startOffset = document.offsetAt(e.range.start);
            if (startOffset < lastModifiedOffset) {
                throw new Error('Overlapping edit');
            }
            else if (startOffset > lastModifiedOffset) {
                spans.push(text.substring(lastModifiedOffset, startOffset));
            }
            if (e.newText.length) {
                spans.push(e.newText);
            }
            lastModifiedOffset = document.offsetAt(e.range.end);
        }
        spans.push(text.substr(lastModifiedOffset));
        return spans.join('');
    }
    TextDocument.applyEdits = applyEdits;
})(TextDocument || (TextDocument = {}));
function mergeSort(data, compare) {
    if (data.length <= 1) {
        // sorted
        return data;
    }
    const p = (data.length / 2) | 0;
    const left = data.slice(0, p);
    const right = data.slice(p);
    mergeSort(left, compare);
    mergeSort(right, compare);
    let leftIdx = 0;
    let rightIdx = 0;
    let i = 0;
    while (leftIdx < left.length && rightIdx < right.length) {
        const ret = compare(left[leftIdx], right[rightIdx]);
        if (ret <= 0) {
            // smaller_equal -> take left to preserve order
            data[i++] = left[leftIdx++];
        }
        else {
            // greater -> take right
            data[i++] = right[rightIdx++];
        }
    }
    while (leftIdx < left.length) {
        data[i++] = left[leftIdx++];
    }
    while (rightIdx < right.length) {
        data[i++] = right[rightIdx++];
    }
    return data;
}
function computeLineOffsets(text, isAtLineStart, textOffset = 0) {
    const result = isAtLineStart ? [textOffset] : [];
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        if (isEOL(ch)) {
            if (ch === 13 /* CharCode.CarriageReturn */ && i + 1 < text.length && text.charCodeAt(i + 1) === 10 /* CharCode.LineFeed */) {
                i++;
            }
            result.push(textOffset + i + 1);
        }
    }
    return result;
}
function isEOL(char) {
    return char === 13 /* CharCode.CarriageReturn */ || char === 10 /* CharCode.LineFeed */;
}
function getWellformedRange(range) {
    const start = range.start;
    const end = range.end;
    if (start.line > end.line || (start.line === end.line && start.character > end.character)) {
        return { start: end, end: start };
    }
    return range;
}
function getWellformedEdit(textEdit) {
    const range = getWellformedRange(textEdit.range);
    if (range !== textEdit.range) {
        return { newText: textEdit.newText, range };
    }
    return textEdit;
}


/***/ }

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter functions for harmony exports
/******/ 		__webpack_require__.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/make namespace object */
/******/ 	(() => {
/******/ 		// define __esModule on exports
/******/ 		__webpack_require__.r = (exports) => {
/******/ 			if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 				Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 			}
/******/ 			Object.defineProperty(exports, '__esModule', { value: true });
/******/ 		};
/******/ 	})();
/******/ 	
/************************************************************************/
var __webpack_exports__ = {};
//#!/usr/bin/env node

/**
 * Arturo Language Server
 * 
 * Provides comprehensive Language Server Protocol (LSP) features for Arturo including:
 * - Type checking based on Arturo's type system
 * - Go-to-definition for functions and variables
 * - Hover information with examples for built-in functions
 * - Intelligent code completion with 500+ built-ins
 * - Signature help with active parameter tracking
 * - Find all references (scope-aware)
 * - Rename symbol with validation
 * - Document formatting
 * - Folding ranges
 * - Document symbols
 * - Inlay hints (parameter names and type information)
 * - Semantic tokens (enhanced syntax highlighting)
 * - Workspace symbols (global symbol search)
 * - Document highlights (highlight symbol occurrences)
 * - Code actions (quick fixes and refactorings)
 * - Proper single-line comment handling (;)
 * - Recognition of multiline strings and code blocks
 * - Support for attribute parameters (.else, .string, etc.)
 * 
 * Note: Arturo doesn't have dedicated multi-line comments. Developers use
 * unassigned string blocks {...} or {:...:} as workarounds, but these are
 * technically strings, not comments, so the LSP treats them as such.
 * 
 * @module arturo-language-server
 */

const {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    DefinitionParams,
    Location,
    Range,
    Position,
    Hover,
    MarkupKind,
    SignatureHelp,
    SignatureInformation,
    ParameterInformation,
    ReferenceParams,
    RenameParams,
    WorkspaceEdit,
    TextEdit,
    DocumentFormattingParams,
    FoldingRangeParams,
    FoldingRange,
    FoldingRangeKind,
    DocumentSymbolParams,
    DocumentSymbol,
    SymbolKind,
    InlayHint,
    InlayHintKind,
    SemanticTokensBuilder,
    DocumentHighlight,
    DocumentHighlightKind,
    CodeAction,
    CodeActionKind,
} = __webpack_require__(5663);

const { TextDocument } = __webpack_require__(5172);
const SignatureIndexer = __webpack_require__(2701);
const CompletionRanker = __webpack_require__(5093);

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all);

// Create a text document manager
const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

// Feature settings from Zed config
let enableCompletions = true;
let enableSignatures = true;
let enableFormatting = true;
let enableHighlights = true;

// Initialize signature indexer (stale-while-revalidate, offline-first)
console.log('[arturo-lsp] bundle.js build date: ' + new Date().toISOString().slice(0,10) + ' — DSG active');
const signatureIndexer = new SignatureIndexer(console);

// Completion ranker — stateless, one instance reused for all requests
const completionRanker = new CompletionRanker();
signatureIndexer.initialize().catch(err => {
    console.error('[SignatureIndexer] Initialization error:', err);
});

// Convenience alias — the workspace indexer lives inside SignatureIndexer
const workspaceIndexer = signatureIndexer.workspaceIndexer;

/**
 * Helper: Get function info from indexer first, then fall back to BUILTIN_FUNCTIONS.
 * This ensures the 80 seed functions always work even if the indexer fails.
 */
function getFunctionInfo(functionName) {
    const indexedSig = signatureIndexer.getSignature(functionName);
    if (indexedSig) return indexedSig;
    return BUILTIN_FUNCTIONS[functionName] || null;
}

/**
 * Helper: Check if a word is a known attribute name.
 * Checks the static ATTRIBUTE_NAMES set first (instant), then the live
 * indexer attrs derived from fetched signatures (covers md5, sha256, etc.).
 */
function isKnownAttribute(word) {
    if (ATTRIBUTE_NAMES.has(word)) return true;
    return signatureIndexer.getAllAttrNames().has(word);
}

/**
 * Initialize the language server
 */
connection.onInitialize((params) => {
    const capabilities = params.capabilities;

    hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
    );
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );
    hasDiagnosticRelatedInformationCapability = !!(
        capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation
    );

    // Read initial settings from initialization options
    connection.console.log('=== INITIALIZATION ===');
    connection.console.log(`Full initializationOptions: ${JSON.stringify(params.initializationOptions, null, 2)}`);
    
    if (params.initializationOptions && params.initializationOptions.settings) {
        const settings = params.initializationOptions.settings;
        connection.console.log(`Settings from initializationOptions: ${JSON.stringify(settings, null, 2)}`);
        enableCompletions = settings.completions !== 'off';
        enableSignatures = settings.signatures !== 'off';
        enableFormatting = settings.formatting !== 'off';
        enableHighlights = settings.highlights !== 'off';
        connection.console.log(`Initial feature flags: completions=${enableCompletions}, signatures=${enableSignatures}, formatting=${enableFormatting}, highlights=${enableHighlights}`);
    } else {
        connection.console.log('No settings found in initializationOptions');
    }

    const result = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            renameProvider: {
                prepareProvider: true
            },
            foldingRangeProvider: true,
            documentSymbolProvider: true,
            inlayHintProvider: true,
            semanticTokensProvider: {
                legend: {
                    tokenTypes: [
                        'function', 'variable', 'parameter', 'property', 'keyword',
                        'comment', 'string', 'number', 'operator', 'type'
                    ],
                    tokenModifiers: ['declaration', 'readonly', 'defaultLibrary']
                },
                full: true
            },
            workspaceSymbolProvider: true,
            codeActionProvider: {
                codeActionKinds: [
                    CodeActionKind.QuickFix,
                    CodeActionKind.Refactor
                ]
            },
        }
    };

    // Add conditional capabilities based on settings
    if (enableCompletions) {
        result.capabilities.completionProvider = {
            resolveProvider: true,
            triggerCharacters: ['.', ':', '`', '#', "'"]
        };
    }

    if (enableSignatures) {
        result.capabilities.signatureHelpProvider = {
            triggerCharacters: ['[', ' ', ','],
            retriggerCharacters: [' ', ',']
        };
    }

    if (enableFormatting) {
        result.capabilities.documentFormattingProvider = true;
    }

    if (enableHighlights) {
        result.capabilities.documentHighlightProvider = true;
    }

    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true
            }
        };
    }

    return result;
});

connection.onInitialized(async () => {
    if (hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }

    // Register for file change notifications on .art files
    connection.client.register({
        id: 'artFileWatcher',
        method: 'workspace/didChangeWatchedFiles',
        registerOptions: {
            watchers: [{ globPattern: '**/*.art' }]
        }
    });

    // Scan workspace folders for user-defined functions
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(async event => {
            connection.console.log('Workspace folder change event received.');
            // Re-index added folders
            for (const added of event.added) {
                const folderPath = decodeURIComponent(
                    added.uri.replace(/^file:\/\//, '').replace(/^\/([A-Z]:)/, '$1')
                );
                await workspaceIndexer.indexWorkspace([folderPath]);
            }
        });

        const folders = await connection.workspace.getWorkspaceFolders();
        if (folders && folders.length > 0) {
            const rootPaths = folders.map(f =>
                decodeURIComponent(f.uri.replace(/^file:\/\//, '').replace(/^\/([A-Z]:)/, '$1'))
            );
            // Non-blocking: index workspace in background
            workspaceIndexer.indexWorkspace(rootPaths).catch(err =>
                connection.console.log(`[WorkspaceIndexer] Error: ${err.message}`)
            );
        }
    }
});

// Re-index .art files when they are saved or created/deleted
connection.onNotification('workspace/didChangeWatchedFiles', (params) => {
    for (const change of params.changes) {
        if (change.type === 3) {   // FileChangeType.Deleted = 3
            workspaceIndexer.removeFile(change.uri);
        } else {                   // Created = 1, Changed = 2
            workspaceIndexer.indexFile(change.uri);
        }
    }
});

/**
 * Configuration change handler
 */
connection.onDidChangeConfiguration(async (change) => {
    connection.console.log('=== CONFIGURATION CHANGE ===');
    connection.console.log(`Full change object: ${JSON.stringify(change, null, 2)}`);
    connection.console.log(`change.settings: ${JSON.stringify(change.settings, null, 2)}`);
    
    if (hasConfigurationCapability) {
        // Read configuration from Zed settings
        const settings = change.settings;
        
        // Check for settings in various possible paths
        let arturoSettings = null;
        
        // Path 1: lsp.arturo-lsp (language server ID)
        if (settings.lsp && settings.lsp['arturo-lsp']) {
            connection.console.log('Found settings at path: settings.lsp[arturo-lsp]');
            arturoSettings = settings.lsp['arturo-lsp'];
        }
        // Path 2: direct settings object
        else if (settings.completions !== undefined) {
            connection.console.log('Found settings at path: settings (direct)');
            arturoSettings = settings;
        }
        // Path 3: Check if settings are nested under arturo-lsp directly
        else if (settings['arturo-lsp']) {
            connection.console.log('Found settings at path: settings[arturo-lsp]');
            arturoSettings = settings['arturo-lsp'];
        }
        
        if (!arturoSettings) {
            // Empty settings object is normal when Zed sends a config change
            // with no arturo-specific keys — silently ignore it.
            if (Object.keys(settings).length > 0) {
                connection.console.log('WARNING: Could not find arturo settings in any expected path.');
                connection.console.log(`Available keys in settings: ${Object.keys(settings).join(', ')}`);
            }
        }
        
        if (arturoSettings) {
            connection.console.log(`Arturo settings found: ${JSON.stringify(arturoSettings, null, 2)}`);
            
            // Store old values
            const oldCompletions = enableCompletions;
            const oldSignatures = enableSignatures;
            const oldFormatting = enableFormatting;
            const oldHighlights = enableHighlights;
            
            connection.console.log(`Old values: completions=${oldCompletions}, signatures=${oldSignatures}, formatting=${oldFormatting}, highlights=${oldHighlights}`);
            
            // Update feature flags (default to true if not specified)
            enableCompletions = arturoSettings.completions !== 'off';
            enableSignatures = arturoSettings.signatures !== 'off';
            enableFormatting = arturoSettings.formatting !== 'off';
            enableHighlights = arturoSettings.highlights !== 'off';
            
            connection.console.log(`New values: completions=${enableCompletions}, signatures=${enableSignatures}, formatting=${enableFormatting}, highlights=${enableHighlights}`);
            connection.console.log(`Changes: completions=${oldCompletions !== enableCompletions}, signatures=${oldSignatures !== enableSignatures}, formatting=${oldFormatting !== enableFormatting}, highlights=${oldHighlights !== enableHighlights}`);
            
            // Re-register/unregister capabilities as needed
            try {
                // Completion provider
                if (enableCompletions !== oldCompletions) {
                    connection.console.log(`Attempting to ${enableCompletions ? 'register' : 'unregister'} completion provider`);
                    if (enableCompletions) {
                        await connection.client.register({
                            id: 'completion',
                            method: 'textDocument/completion',
                            registerOptions: {
                                resolveProvider: true,
                                triggerCharacters: ['.', ':', '`', '#', "'"]
                            }
                        });
                        connection.console.log('Successfully registered completion provider');
                    } else {
                        await connection.client.unregister({ id: 'completion', method: 'textDocument/completion' });
                        connection.console.log('Successfully unregistered completion provider');
                    }
                }
                
                // Signature help provider
                if (enableSignatures !== oldSignatures) {
                    if (enableSignatures) {
                        await connection.client.register({
                            id: 'signatureHelp',
                            method: 'textDocument/signatureHelp',
                            registerOptions: {
                                triggerCharacters: ['[', ' ', ','],
                                retriggerCharacters: [' ', ',']
                            }
                        });
                    } else {
                        await connection.client.unregister({ id: 'signatureHelp', method: 'textDocument/signatureHelp' });
                    }
                }
                
                // Document formatting provider
                if (enableFormatting !== oldFormatting) {
                    if (enableFormatting) {
                        await connection.client.register({
                            id: 'documentFormatting',
                            method: 'textDocument/formatting'
                        });
                    } else {
                        await connection.client.unregister({ id: 'documentFormatting', method: 'textDocument/formatting' });
                    }
                }
                
                // Document highlight provider
                if (enableHighlights !== oldHighlights) {
                    if (enableHighlights) {
                        await connection.client.register({
                            id: 'documentHighlight',
                            method: 'textDocument/documentHighlight'
                        });
                    } else {
                        await connection.client.unregister({ id: 'documentHighlight', method: 'textDocument/documentHighlight' });
                    }
                }
            } catch (error) {
                connection.console.log(`Error re-registering capabilities: ${error}`);
            }
        }
    }
    
    // Revalidate all open documents
    documents.all().forEach(validateTextDocument);
});

/**
 * Arturo type system definitions
 */
const ARTURO_TYPES = {
    'null': { description: 'Null value' },
    'logical': { description: 'Boolean value (true, false, maybe)' },
    'integer': { description: 'Integer number' },
    'floating': { description: 'Floating-point number' },
    'complex': { description: 'Complex number' },
    'rational': { description: 'Rational number (ratio)' },
    'version': { description: 'SemVer version number' },
    'type': { description: 'Type value' },
    'char': { description: 'Single character' },
    'string': { description: 'String of characters' },
    'regex': { description: 'Regular expression' },
    'literal': { description: 'Literal value (unevaluated word)' },
    'block': { description: 'Block of code' },
    'dictionary': { description: 'Dictionary/hash table' },
    'function': { description: 'Function value' },
    'method': { description: 'Method (function with this context)' },
    'object': { description: 'Custom type instance' },
    'module': { description: 'Encapsulated namespace' },
    'path': { description: 'Path to nested value' },
    'inline': { description: 'Inline expression (parentheses)' },
    'range': { description: 'Lazy range of values' },
    'date': { description: 'Date/time value' },
    'unit': { description: 'Physical unit' },
    'quantity': { description: 'Numeric value with unit' },
    'color': { description: 'Color value' },
    'binary': { description: 'Binary data' },
    'database': { description: 'Database connection' },
    'socket': { description: 'Network socket' },
    'error': { description: 'Error value' },
    'any': { description: 'Any type' },
};

/**
 * Comprehensive set of all Arturo built-in functions
 */
const BUILTIN_NAMES = new Set([
    "abs", "absolute", "absolute?", "acceleration?", "accept", "acos", "acosh", "acsec", "acsech", 
    "actan", "actanh", "action?", "add", "after", "alert", "alias", "all?", "alphaParticleMass", 
    "alphabet", "and", "and?", "angle", "angle?", "angstromStar", "angularVelocity?", "any", "any?", 
    "append", "area?", "areaDensity?", "arg", "args", "arithmeticError", "arity", "arrange", "array", 
    "ascii?", "asec", "asech", "asin", "asinh", "assertionError", "atan", "atan2", "atanh", 
    "atomicMass", "attr", "attr?", "attribute?", "attributeLabel?", "attrs", "average", 
    "avogadroConstant", "before", "benchmark", "between?", "binary?", "blend", "block?", "bohrRadius", 
    "boltzmannConstant", "break", "browse", "bytecode?", "call", "capacitance?", "capitalize", "case", 
    "ceil", "char?", "charge?", "chop", "chunk", "clamp", "classicalElectronRadius", "clear", "clip", 
    "close", "cluster", "coalesce", "collect", "color", "color?", "combine", "compare", "complex?", 
    "conductance?", "conductanceQuantum", "config", "conforms?", "conj", "connect", "constructor", 
    "contains?", "continue", "conversionError", "convert", "copy", "cos", "cosh", "couple", "crc", 
    "csec", "csech", "ctan", "ctanh", "currency?", "current?", "currentDensity?", "cursor", "darken", 
    "dataTransferRate?", "database?", "date?", "dec", "decode", "decouple", "define", "defined?", 
    "delete", "denominator", "density?", "desaturate", "deuteronMass", "deviation", "dialog", 
    "dictionary", "dictionary?", "difference", "digest", "digits", "directory?", "discard", "disjoint?", 
    "div", "divmod", "do", "download", "drop", "dup", "elastance?", "electricField?", "electricityPrice?", 
    "electronCharge", "electronMass", "electronMassEnergy", "empty", "empty?", "encode", "energy?", 
    "ensure", "entropy?", "enumerate", "env", "epsilon", "equal?", "error?", "errorKind?", "escape", 
    "even?", "every?", "execute", "exists?", "exit", "exp", "export", "express", "extend", "extract", 
    "factorial", "factors", "false", "false?", "fdiv", "file?", "filter", "first", "flatten", 
    "floating?", "floor", "fold", "force?", "frequency?", "friday?", "function", "function?", "future?", 
    "gamma", "gather", "gcd", "get", "goto", "gravitationalConstant", "grayscale", "greater?", 
    "greaterOrEqual?", "hartreeEnergy", "hash", "heatFlux?", "helionMass", "hidden?", "hypot", "if", 
    "illuminance?", "impedanceOfVacuum", "import", "in", "in?", "inc", "indent", "index", "indexError", 
    "inductance?", "infinite", "infinite?", "info", "information?", "inline?", "input", "insert", 
    "inspect", "integer?", "intersect?", "intersection", "inverseConductanceQuantum", "invert", "is", 
    "is?", "jaro", "jerk?", "join", "josephsonConstant", "key?", "keys", "kinematicViscosity?", 
    "kurtosis", "label?", "last", "lcm", "leap?", "length?", "less?", "lessOrEqual?", "let", 
    "levenshtein", "libraryError", "lighten", "list", "listen", "literal?", "ln", "log", "logical?", 
    "loop", "lower", "lower?", "luminosity?", "luminousFlux?", "magneticFieldStrength?", "magneticFlux?", 
    "magneticFluxDensity?", "magneticFluxQuantum", "mail", "map", "mass?", "massFlowRate?", "match", 
    "match?", "max", "maximum", "maybe", "median", "method", "method?", "methods", "min", "minimum", 
    "mod", "module", "molarConcentration?", "molarGasConstant", "moleFlowRate?", "momentofInertia?", 
    "momentum?", "monday?", "move", "mul", "muonMass", "nameError", "nand", "nand?", "neg", "negative?", 
    "neutronMass", "new", "nor", "nor?", "normalize", "not", "not?", "notEqual?", "now", "null", 
    "null?", "numerator", "numeric?", "object?", "odd?", "one?", "open", "or", "or?", "outdent", 
    "packageError", "pad", "palette", "panic", "parse", "past?", "path", "path?", "pathLabel?", 
    "pathLiteral?", "pause", "permeability?", "permissions", "permittivity?", "permutate", "pi", 
    "planckConstant", "planckLength", "planckMass", "planckTemperature", "planckTime", "pop", "popup", 
    "positive?", "potential?", "pow", "power?", "powerset", "powmod", "prefix?", "prepend", "pressure?", 
    "prime?", "print", "prints", "process", "product", "property", "protonMass", "protonMassEnergy", 
    "quantity?", "query", "radiation?", "radiationExposure?", "random", "range", "range?", "rational?", 
    "read", "receive", "reciprocal", "reducedPlanckConstant", "regex?", "relative", "remove", "rename", 
    "render", "repeat", "replace", "request", "resistance?", "resistivity?", "return", "reverse", "rotate", 
    "round", "runtimeError", "rydbergConstant", "salary?", "same?", "sample", "saturate", 
    "saturday?", "scalar", "script", "sec", "sech", "select", "send", "send?", "serve", "set", "set?", 
    "shl", "shr", "shuffle", "sin", "sinh", "size", "skewness", "slice", "snap?", "socket?", 
    "solidAngle?", "some?", "sort", "sortable", "sorted?", "specificVolume?", "specify", "speed?", 
    "speedOfLight", "spin", "split", "sqrt", "squeeze", "stack", "standalone?", "standardGasVolume", 
    "standardPressure", "standardTemperature", "store", "store?", "string?", "strip", "sub", "subset?", 
    "substance?", "suffix?", "sum", "sunday?", "superset?", "superuser?", "surfaceTension?", "switch", 
    "symbol?", "symbolLiteral?", "symbols", "symlink", "symlink?", "syntaxError", "sys", "systemError", 
    "take", "tally", "tan", "tanh", "tau", "tauMass", "temperature?", "terminal", "terminate", 
    "thermalConductivity?", "thermalInsulance?", "thomsonCrossSection", "throw", "throws?", "thursday?", 
    "time?", "timestamp", "to", "today?", "translate", "tritonMass", "true", "true?", "truncate", 
    "try", "tuesday?", "type", "type?", "typeError", "uiError", "unclip", "union", "unique", "unit?", 
    "unitless?", "units", "unless", "unplug", "unset", "unstack", "until", "unzip", "upper", "upper?", 
    "using", "vacuumPermeability", "vacuumPermittivity", "valueError", "values", "var", "variance", 
    "version?", "viscosity?", "vmError", "volume", "volume?", "volumetricFlow?", "vonKlitzingConstant", 
    "waveNumber?", "webview", "wednesday?", "when", "while", "whitespace?", "window", "with", "word?", 
    "wordwrap", "write", "xnor", "xnor?", "xor", "xor?", "zero?", "zip"
]);

/**
 * Common attribute names used in Arturo (prefixed with .)
 * These are valid identifiers when preceded by a dot
 * Comprehensive list from Arturo standard library
 */
const ATTRIBUTE_NAMES = new Set([
    // Control flow attributes
    "else", "when", "unless", "do", "while", "until", "step", "from", "to", "by",
    
    // Import/export attributes
    "as", "with", "without", "import", "export", "local", "global", "public", "private",
    
    // Type attributes
    "string", "integer", "floating", "logical", "block", "dictionary", "function", "method",
    "numeric", "literal", "type", "char", "word", "attribute", "path", "inline",
    "action", "any", "nothing", "module", "object", "error", "quantity", "unit",
    "complex", "rational", "version", "date", "binary", "null", "range", "color",
    "database", "socket", "bytecode", "symbol", "label", "attributeLabel", "pathLabel",
    
    // String operations attributes
    "prefix", "suffix", "contains", "sorted", "unique", "reverse", "upper", "lower",
    "capitalize", "truncate", "pad", "strip", "split", "join", "repeat", "replace",
    "lines", "words", "dent", "indent", "outdent", "escape", "unescape", 
    
    // Collection attributes
    "in", "at", "every", "some", "all", "first", "last", "empty", "single",
    "sort", "sorted", "descending", "ascending", "values", "keys", "size",
    
    // Function definition attributes
    "external", "expect", "infix", "postfix", "binary", "unary", "variadic", "alias",
    "pure", "inline",
    
    // String format attributes
    "raw", "safe", "regex", "verbatim", "template", "print", "silent", "hidden",
    
    // Iteration attributes
    "once", "times", "infinite", "deep", "shallow", "copy", "reference", "mutable",
    
    // Case conversion attributes
    "kebab-case", "snake_case", "camelCase", "PascalCase", "UPPER_CASE",
    
    // Path attributes
    "relative", "absolute", "normalize", "expand", "compact", "pretty", "minimal",
    
    // Rendering attributes  
    "color", "grayscale", "alpha", "format", "parse", "encode", "decode", "digest",
    
    // Protocol attributes
    "mail", "http", "https", "ftp", "file", "data", "base64", "hex", "binary",
    
    // Data format attributes
    "json", "yaml", "xml", "html", "csv", "tsv", "sql", "markdown", "text",

    // Hash/digest algorithm attributes
    "md5", "sha1", "sha256", "sha384", "sha512", "sha3", "blake2", "crc32",

    // Encoding format attributes
    "base64", "base58", "hex", "url", "utf8", "ascii", "binary",
    
    // HTTP method attributes
    "get", "post", "put", "delete", "patch", "head", "options", "trace",
    
    // Execution attributes
    "async", "sync", "parallel", "sequential", "lazy", "eager", "cached",
    
    // Collection operation attributes
    "key", "value", "index", "range", "slice", "take", "drop", "filter", "map",
    "fold", "reduce", "scan", "zip", "unzip", "flatten", "chunk", "window",
    
    // Comparison and validation
    "case", "sensitive", "insensitive", "trim", "exact", "fuzzy",
    
    // Loop attributes
    "reverse", "forever", "n", "times", "count", "enumerate",
    
    // Additional common attributes
    "random", "shuffle", "sample", "seed", "min", "max", "sum", "product",
    "mean", "median", "mode", "variance", "deviation"
]);

/**
 * Named colors supported in Arturo
 */
const ARTURO_COLORS = new Set([
    'red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white', 'black',
    'gray', 'grey', 'orange', 'purple', 'pink', 'brown', 'lime', 'navy',
    'teal', 'aqua', 'maroon', 'olive', 'silver', 'fuchsia'
]);

/**
 * Physical units supported in Arturo
 */
const ARTURO_UNITS = new Set([
    // Length
    'm', 'mm', 'cm', 'km', 'in', 'ft', 'yd', 'mi',
    // Mass
    'g', 'kg', 'mg', 'lb', 'oz', 'ton',
    // Time
    's', 'ms', 'min', 'h', 'hr', 'day', 'week', 'month', 'year',
    // Temperature
    'K', 'C', 'F',
    // Area
    'm2', 'cm2', 'km2', 'ft2', 'yd2', 'mi2', 'acre', 'hectare',
    // Volume
    'm3', 'cm3', 'km3', 'L', 'mL', 'gal', 'qt', 'pt', 'cup', 'fl_oz',
    // Speed
    'mps', 'kph', 'mph', 'knot',
    // Force
    'N', 'kN', 'lbf',
    // Pressure
    'Pa', 'kPa', 'MPa', 'bar', 'psi', 'atm', 'torr',
    // Energy
    'J', 'kJ', 'MJ', 'cal', 'kcal', 'Wh', 'kWh', 'eV',
    // Power
    'W', 'kW', 'MW', 'hp',
    // Angle
    'rad', 'deg', 'grad',
    // Frequency
    'Hz', 'kHz', 'MHz', 'GHz',
    // Data
    'bit', 'byte', 'KB', 'MB', 'GB', 'TB', 'PB',
    'Kb', 'Mb', 'Gb', 'Tb', 'Pb',
    // Currency (common)
    'USD', 'EUR', 'GBP', 'JPY', 'CNY',
]);

/**
 * Built-in function signatures - comprehensive collection
 */
const BUILTIN_FUNCTIONS = {
    // Control flow
    'return': {
        signature: 'return value :any -> :nothing',
        description: 'Returns a value from a function',
        params: [{ name: 'value', type: ':any' }],
        returns: ':nothing'
    },
    'if': {
        signature: 'if condition :logical action :block -> :any',
        description: 'Executes action if condition is true',
        params: [{ name: 'condition', type: ':logical' }, { name: 'action', type: ':block' }],
        returns: ':any'
    },
    'unless': {
        signature: 'unless condition :logical action :block -> :any',
        description: 'Executes action if condition is false',
        params: [{ name: 'condition', type: ':logical' }, { name: 'action', type: ':block' }],
        returns: ':any'
    },
    'when': {
        signature: 'when condition :logical action :block -> :any',
        description: 'Executes action when condition is true (alias for if)',
        params: [{ name: 'condition', type: ':logical' }, { name: 'action', type: ':block' }],
        returns: ':any'
    },
    'switch': {
        signature: 'switch value :any cases :block -> :any',
        description: 'Performs multi-way conditional branching',
        params: [{ name: 'value', type: ':any' }, { name: 'cases', type: ':block' }],
        returns: ':any'
    },
    'case': {
        signature: 'case value :any condition :block -> :any',
        description: 'Defines a case in a switch statement',
        params: [{ name: 'value', type: ':any' }, { name: 'condition', type: ':block' }],
        returns: ':any'
    },
    'do': {
        signature: 'do block :block -> :any',
        description: 'Executes a block and returns its result',
        params: [{ name: 'block', type: ':block' }],
        returns: ':any'
    },
    'try': {
        signature: 'try block :block -> :any',
        description: 'Executes a block and catches errors',
        params: [{ name: 'block', type: ':block' }],
        returns: ':any'
    },
    'break': {
        signature: 'break -> :nothing',
        description: 'Exits from a loop',
        params: [],
        returns: ':nothing'
    },
    'continue': {
        signature: 'continue -> :nothing',
        description: 'Skips to next iteration of a loop',
        params: [],
        returns: ':nothing'
    },
    
    // Loops
    'loop': {
        signature: 'loop collection :block/:range action :block -> :null',
        description: 'Iterates over a collection',
        params: [{ name: 'collection', type: ':block/:range' }, { name: 'action', type: ':block' }],
        returns: ':null'
    },
    'while': {
        signature: 'while condition :block action :block -> :null',
        description: 'Executes action while condition is true',
        params: [{ name: 'condition', type: ':block' }, { name: 'action', type: ':block' }],
        returns: ':null'
    },
    'until': {
        signature: 'until condition :block action :block -> :null',
        description: 'Executes action until condition is true',
        params: [{ name: 'condition', type: ':block' }, { name: 'action', type: ':block' }],
        returns: ':null'
    },
    
    // Functions
    'function': {
        signature: 'function params :block/:literal body :block -> :function',
        description: 'Creates a function',
        params: [{ name: 'params', type: ':block/:literal' }, { name: 'body', type: ':block' }],
        returns: ':function'
    },
    'method': {
        signature: 'method params :block body :block -> :method',
        description: 'Creates a method with this context',
        params: [{ name: 'params', type: ':block' }, { name: 'body', type: ':block' }],
        returns: ':method'
    },
    'call': {
        signature: 'call fn :function args :block -> :any',
        description: 'Calls a function with arguments',
        params: [{ name: 'fn', type: ':function' }, { name: 'args', type: ':block' }],
        returns: ':any'
    },
    
    // I/O
    'print': {
        signature: 'print value :any -> :null',
        description: 'Prints a value to stdout with newline',
        params: [{ name: 'value', type: ':any' }],
        returns: ':null'
    },
    'prints': {
        signature: 'prints value :any -> :null',
        description: 'Prints a value to stdout without newline',
        params: [{ name: 'value', type: ':any' }],
        returns: ':null'
    },
    'input': {
        signature: 'input prompt :string -> :string',
        description: 'Reads a line from stdin',
        params: [{ name: 'prompt', type: ':string' }],
        returns: ':string'
    },
    'read': {
        signature: 'read path :string -> :string',
        description: 'Reads contents from a file',
        params: [{ name: 'path', type: ':string' }],
        returns: ':string'
    },
    'write': {
        signature: 'write path :string content :string -> :null',
        description: 'Writes content to a file',
        params: [{ name: 'path', type: ':string' }, { name: 'content', type: ':string' }],
        returns: ':null'
    },
    
    // Type operations
    'to': {
        signature: 'to type :type value :any -> :any',
        description: 'Converts a value to a specified type',
        params: [{ name: 'type', type: ':type' }, { name: 'value', type: ':any' }],
        returns: ':any'
    },
    'type': {
        signature: 'type value :any -> :type',
        description: 'Returns the type of a value',
        params: [{ name: 'value', type: ':any' }],
        returns: ':type'
    },
    'define': {
        signature: 'define name :literal/:type body :block -> :type',
        description: 'Defines a custom type',
        params: [{ name: 'name', type: ':literal/:type' }, { name: 'body', type: ':block' }],
        returns: ':type'
    },
    'is': {
        signature: 'is value :any type :type -> :logical',
        description: 'Checks if value is of given type',
        params: [{ name: 'value', type: ':any' }, { name: 'type', type: ':type' }],
        returns: ':logical'
    },
    
    // String operations
    'size': {
        signature: 'size value :string/:block -> :integer',
        description: 'Returns the size/length of a collection',
        params: [{ name: 'value', type: ':string/:block' }],
        returns: ':integer'
    },
    'upper': {
        signature: 'upper str :string -> :string',
        description: 'Converts string to uppercase',
        params: [{ name: 'str', type: ':string' }],
        returns: ':string'
    },
    'lower': {
        signature: 'lower str :string -> :string',
        description: 'Converts string to lowercase',
        params: [{ name: 'str', type: ':string' }],
        returns: ':string'
    },
    'capitalize': {
        signature: 'capitalize str :string -> :string',
        description: 'Capitalizes first letter of string',
        params: [{ name: 'str', type: ':string' }],
        returns: ':string'
    },
    'split': {
        signature: 'split str :string delimiter :string -> :block',
        description: 'Splits string by delimiter',
        params: [{ name: 'str', type: ':string' }, { name: 'delimiter', type: ':string' }],
        returns: ':block'
    },
    'join': {
        signature: 'join collection :block separator :string -> :string',
        description: 'Joins collection elements with separator',
        params: [{ name: 'collection', type: ':block' }, { name: 'separator', type: ':string' }],
        returns: ':string'
    },
    'replace': {
        signature: 'replace str :string pattern :string replacement :string -> :string',
        description: 'Replaces pattern with replacement in string',
        params: [{ name: 'str', type: ':string' }, { name: 'pattern', type: ':string' }, { name: 'replacement', type: ':string' }],
        returns: ':string'
    },
    'strip': {
        signature: 'strip str :string -> :string',
        description: 'Removes leading and trailing whitespace',
        params: [{ name: 'str', type: ':string' }],
        returns: ':string'
    },
    
    // Collection operations
    'append': {
        signature: 'append collection :block value :any -> :block',
        description: 'Appends value to collection',
        params: [{ name: 'collection', type: ':block' }, { name: 'value', type: ':any' }],
        returns: ':block'
    },
    'prepend': {
        signature: 'prepend collection :block value :any -> :block',
        description: 'Prepends value to collection',
        params: [{ name: 'collection', type: ':block' }, { name: 'value', type: ':any' }],
        returns: ':block'
    },
    'first': {
        signature: 'first collection :block -> :any',
        description: 'Returns first element of collection',
        params: [{ name: 'collection', type: ':block' }],
        returns: ':any'
    },
    'last': {
        signature: 'last collection :block -> :any',
        description: 'Returns last element of collection',
        params: [{ name: 'collection', type: ':block' }],
        returns: ':any'
    },
    'get': {
        signature: 'get collection :block/:dictionary index :integer/:string -> :any',
        description: 'Gets element at index from collection',
        params: [{ name: 'collection', type: ':block/:dictionary' }, { name: 'index', type: ':integer/:string' }],
        returns: ':any'
    },
    'set': {
        signature: 'set collection :block/:dictionary index :integer/:string value :any -> :null',
        description: 'Sets element at index in collection',
        params: [{ name: 'collection', type: ':block/:dictionary' }, { name: 'index', type: ':integer/:string' }, { name: 'value', type: ':any' }],
        returns: ':null'
    },
    'map': {
        signature: 'map collection :block action :block -> :block',
        description: 'Maps function over collection',
        params: [{ name: 'collection', type: ':block' }, { name: 'action', type: ':block' }],
        returns: ':block'
    },
    'filter': {
        signature: 'filter collection :block predicate :block -> :block',
        description: 'Filters collection by predicate',
        params: [{ name: 'collection', type: ':block' }, { name: 'predicate', type: ':block' }],
        returns: ':block'
    },
    'fold': {
        signature: 'fold collection :block initial :any action :block -> :any',
        description: 'Folds collection with accumulator',
        params: [{ name: 'collection', type: ':block' }, { name: 'initial', type: ':any' }, { name: 'action', type: ':block' }],
        returns: ':any'
    },
    'select': {
        signature: 'select collection :block predicate :block -> :block',
        description: 'Selects elements matching predicate',
        params: [{ name: 'collection', type: ':block' }, { name: 'predicate', type: ':block' }],
        returns: ':block'
    },
    'sort': {
        signature: 'sort collection :block -> :block',
        description: 'Sorts collection in ascending order',
        params: [{ name: 'collection', type: ':block' }],
        returns: ':block'
    },
    'reverse': {
        signature: 'reverse collection :block/:string -> :block/:string',
        description: 'Reverses a collection or string',
        params: [{ name: 'collection', type: ':block/:string' }],
        returns: ':block/:string'
    },
    'unique': {
        signature: 'unique collection :block -> :block',
        description: 'Returns unique elements from collection',
        params: [{ name: 'collection', type: ':block' }],
        returns: ':block'
    },
    'flatten': {
        signature: 'flatten collection :block -> :block',
        description: 'Flattens nested collection',
        params: [{ name: 'collection', type: ':block' }],
        returns: ':block'
    },
    'empty': {
        signature: 'empty collection :block/:string -> :block/:string',
        description: 'Returns an empty collection of same type',
        params: [{ name: 'collection', type: ':block/:string' }],
        returns: ':block/:string'
    },
    'take': {
        signature: 'take collection :block n :integer -> :block',
        description: 'Takes first n elements from collection',
        params: [{ name: 'collection', type: ':block' }, { name: 'n', type: ':integer' }],
        returns: ':block'
    },
    'drop': {
        signature: 'drop collection :block n :integer -> :block',
        description: 'Drops first n elements from collection',
        params: [{ name: 'collection', type: ':block' }, { name: 'n', type: ':integer' }],
        returns: ':block'
    },
    'slice': {
        signature: 'slice collection :block start :integer end :integer -> :block',
        description: 'Returns slice of collection from start to end',
        params: [{ name: 'collection', type: ':block' }, { name: 'start', type: ':integer' }, { name: 'end', type: ':integer' }],
        returns: ':block'
    },
    
    // Math operations
    'add': {
        signature: 'add a :numeric b :numeric -> :numeric',
        description: 'Adds two numbers',
        params: [{ name: 'a', type: ':numeric' }, { name: 'b', type: ':numeric' }],
        returns: ':numeric'
    },
    'sub': {
        signature: 'sub a :numeric b :numeric -> :numeric',
        description: 'Subtracts b from a',
        params: [{ name: 'a', type: ':numeric' }, { name: 'b', type: ':numeric' }],
        returns: ':numeric'
    },
    'mul': {
        signature: 'mul a :numeric b :numeric -> :numeric',
        description: 'Multiplies two numbers',
        params: [{ name: 'a', type: ':numeric' }, { name: 'b', type: ':numeric' }],
        returns: ':numeric'
    },
    'div': {
        signature: 'div a :numeric b :numeric -> :numeric',
        description: 'Divides a by b',
        params: [{ name: 'a', type: ':numeric' }, { name: 'b', type: ':numeric' }],
        returns: ':numeric'
    },
    'mod': {
        signature: 'mod a :integer b :integer -> :integer',
        description: 'Returns remainder of a divided by b',
        params: [{ name: 'a', type: ':integer' }, { name: 'b', type: ':integer' }],
        returns: ':integer'
    },
    'pow': {
        signature: 'pow base :numeric exponent :numeric -> :numeric',
        description: 'Raises base to exponent',
        params: [{ name: 'base', type: ':numeric' }, { name: 'exponent', type: ':numeric' }],
        returns: ':numeric'
    },
    'sqrt': {
        signature: 'sqrt n :numeric -> :floating',
        description: 'Returns square root of n',
        params: [{ name: 'n', type: ':numeric' }],
        returns: ':floating'
    },
    'abs': {
        signature: 'abs n :numeric -> :numeric',
        description: 'Returns absolute value of n',
        params: [{ name: 'n', type: ':numeric' }],
        returns: ':numeric'
    },
    'neg': {
        signature: 'neg n :numeric -> :numeric',
        description: 'Returns negative of n',
        params: [{ name: 'n', type: ':numeric' }],
        returns: ':numeric'
    },
    'inc': {
        signature: 'inc n :numeric -> :numeric',
        description: 'Increments n by 1',
        params: [{ name: 'n', type: ':numeric' }],
        returns: ':numeric'
    },
    'dec': {
        signature: 'dec n :numeric -> :numeric',
        description: 'Decrements n by 1',
        params: [{ name: 'n', type: ':numeric' }],
        returns: ':numeric'
    },
    'max': {
        signature: 'max a :numeric b :numeric -> :numeric',
        description: 'Returns maximum of two numbers',
        params: [{ name: 'a', type: ':numeric' }, { name: 'b', type: ':numeric' }],
        returns: ':numeric'
    },
    'min': {
        signature: 'min a :numeric b :numeric -> :numeric',
        description: 'Returns minimum of two numbers',
        params: [{ name: 'a', type: ':numeric' }, { name: 'b', type: ':numeric' }],
        returns: ':numeric'
    },
    'sum': {
        signature: 'sum collection :block -> :numeric',
        description: 'Returns sum of all numbers in collection',
        params: [{ name: 'collection', type: ':block' }],
        returns: ':numeric'
    },
    'product': {
        signature: 'product collection :block -> :numeric',
        description: 'Returns product of all numbers in collection',
        params: [{ name: 'collection', type: ':block' }],
        returns: ':numeric'
    },
    'average': {
        signature: 'average collection :block -> :floating',
        description: 'Returns average of numbers in collection',
        params: [{ name: 'collection', type: ':block' }],
        returns: ':floating'
    },
    'median': {
        signature: 'median collection :block -> :numeric',
        description: 'Returns median of numbers in collection',
        params: [{ name: 'collection', type: ':block' }],
        returns: ':numeric'
    },
    'random': {
        signature: 'random max :integer -> :integer',
        description: 'Returns random integer from 0 to max-1',
        params: [{ name: 'max', type: ':integer' }],
        returns: ':integer'
    },
    
    // Trigonometry
    'sin': {
        signature: 'sin angle :numeric -> :floating',
        description: 'Returns sine of angle (in radians)',
        params: [{ name: 'angle', type: ':numeric' }],
        returns: ':floating'
    },
    'cos': {
        signature: 'cos angle :numeric -> :floating',
        description: 'Returns cosine of angle (in radians)',
        params: [{ name: 'angle', type: ':numeric' }],
        returns: ':floating'
    },
    'tan': {
        signature: 'tan angle :numeric -> :floating',
        description: 'Returns tangent of angle (in radians)',
        params: [{ name: 'angle', type: ':numeric' }],
        returns: ':floating'
    },
    
    // Logic operations
    'and': {
        signature: 'and a :logical b :logical -> :logical',
        description: 'Logical AND of two boolean values',
        params: [{ name: 'a', type: ':logical' }, { name: 'b', type: ':logical' }],
        returns: ':logical'
    },
    'or': {
        signature: 'or a :logical b :logical -> :logical',
        description: 'Logical OR of two boolean values',
        params: [{ name: 'a', type: ':logical' }, { name: 'b', type: ':logical' }],
        returns: ':logical'
    },
    'not': {
        signature: 'not value :logical -> :logical',
        description: 'Logical NOT of boolean value',
        params: [{ name: 'value', type: ':logical' }],
        returns: ':logical'
    },
    
    // Comparison
    'equal?': {
        signature: 'equal? a :any b :any -> :logical',
        description: 'Checks if two values are equal',
        params: [{ name: 'a', type: ':any' }, { name: 'b', type: ':any' }],
        returns: ':logical'
    },
    'greater?': {
        signature: 'greater? a :any b :any -> :logical',
        description: 'Checks if a is greater than b',
        params: [{ name: 'a', type: ':any' }, { name: 'b', type: ':any' }],
        returns: ':logical'
    },
    'less?': {
        signature: 'less? a :any b :any -> :logical',
        description: 'Checks if a is less than b',
        params: [{ name: 'a', type: ':any' }, { name: 'b', type: ':any' }],
        returns: ':logical'
    },
    
    // Dictionary operations
    'keys': {
        signature: 'keys dict :dictionary -> :block',
        description: 'Returns all keys from dictionary',
        params: [{ name: 'dict', type: ':dictionary' }],
        returns: ':block'
    },
    'values': {
        signature: 'values dict :dictionary -> :block',
        description: 'Returns all values from dictionary',
        params: [{ name: 'dict', type: ':dictionary' }],
        returns: ':block'
    },
    'has': {
        signature: 'has dict :dictionary key :string -> :logical',
        description: 'Checks if dictionary has key',
        params: [{ name: 'dict', type: ':dictionary' }, { name: 'key', type: ':string' }],
        returns: ':logical'
    },
};

/**
 * Document symbol table
 */
const documentSymbols = new Map();

/**
 * Custom types defined in the document
 */
const customTypes = new Map();

/**
 * Strip single-line comments from text
 * Note: Arturo only has single-line comments (;). Multi-line "comments" 
 * are actually unassigned string literals {...} which are valid syntax.
 */
function stripComments(text) {
    const lines = text.split('\n');
    const cleanedLines = lines.map(line => {
        const commentIndex = line.indexOf(';');
        if (commentIndex !== -1) {
            // Check if the semicolon is inside a string
            let inString = false;
            let stringChar = null;
            for (let i = 0; i < commentIndex; i++) {
                const char = line[i];
                if ((char === '"' || char === '{') && !inString) {
                    inString = true;
                    stringChar = char;
                } else if (inString) {
                    if ((stringChar === '"' && char === '"' && line[i-1] !== '\\') ||
                        (stringChar === '{' && char === '}')) {
                        inString = false;
                        stringChar = null;
                    }
                }
            }
            
            // If not in string, it's a comment
            if (!inString) {
                return line.substring(0, commentIndex);
            }
        }
        return line;
    });
    
    return cleanedLines.join('\n');
}

/**
 * Parse document and extract symbols
 */
function parseDocument(document) {
    const text = document.getText();
    const cleanText = stripComments(text);
    const lines = cleanText.split('\n');
    const symbols = {
        variables: new Map(),
        functions: new Map(),
    };
    
    // Extract custom type definitions
    customTypes.set(document.uri, new Set());
    const docTypes = customTypes.get(document.uri);

    lines.forEach((line, lineIndex) => {
        // Match custom type definitions: define :typename [...]
        const defineMatch = line.match(/define\s+:(\w+)/);
        if (defineMatch) {
            const typeName = defineMatch[1];
            docTypes.add(typeName);
        }
        
        // Match variable assignments: name: value
        const assignmentMatch = line.match(/(\w+)\s*:\s*(.+)/);
        if (assignmentMatch) {
            const name = assignmentMatch[1];
            const value = assignmentMatch[2].trim();
            const column = line.indexOf(name);
            
            // Check if it's a function definition
            if (value.startsWith('function') || value.startsWith('$') || value.startsWith('method')) {
                symbols.functions.set(name, {
                    line: lineIndex,
                    column: column,
                    type: ':function',
                    definition: value,
                });
            } else {
                symbols.variables.set(name, {
                    line: lineIndex,
                    column: column,
                    type: inferType(value),
                });
            }
        }
    });

    documentSymbols.set(document.uri, symbols);
    return symbols;
}

/**
 * Infer type from value
 */
function inferType(value) {
    value = value.trim();

    if (/^-?\d+$/.test(value)) return ':integer';
    if (/^-?\d+\.\d+$/.test(value)) return ':floating';
    if (/^-?\d+(\.\d+)?i$/.test(value)) return ':complex';
    if (/^-?\d+(\.\d+)?[+\-]\d+(\.\d+)?i$/.test(value)) return ':complex';
    if (/^\d+:\d+$/.test(value)) return ':rational';
    if (/^(true|false|maybe)$/.test(value)) return ':logical';
    if (value === 'null') return ':null';
    if (value.startsWith('"') || value.startsWith('{') || value.startsWith('«')) return ':string';
    if (/^`.$/.test(value)) return ':char';
    if (value.startsWith('[')) return ':block';
    if (value.startsWith('#[')) return ':dictionary';
    if (value.startsWith(':')) return ':type';
    if (value.startsWith("'")) return ':literal';
    if (value.startsWith('function') || value.startsWith('$')) return ':function';
    if (value.startsWith('method')) return ':method';
    if (/^#([0-9a-fA-F]{6}|[a-z]+)$/.test(value)) return ':color';
    if (value.includes('..')) return ':range';

    return ':any';
}

/**
 * Check if a word is a literal value that doesn't need to be defined
 */
function isLiteral(word) {
    // Number literals
    if (/^-?\d+$/.test(word)) return true; // integer
    if (/^-?\d+\.\d+$/.test(word)) return true; // floating point
    if (/^0x[0-9a-fA-F]+$/.test(word)) return true; // hex
    if (/^0b[01]+$/.test(word)) return true; // binary
    
    // Boolean/null literals
    if (/^(true|false|maybe|null)$/.test(word)) return true;
    
    // Version literals (SemVer) - e.g., 10-beta, 1.2.3, 2.0.0-alpha
    // Also handle partial versions like "10-beta" (from 3.2.10-beta)
    if (/^\d+(-[a-zA-Z][a-zA-Z0-9]*)?$/.test(word)) return true;
    if (/^\d+(\.\d+)*(-[a-zA-Z][a-zA-Z0-9]*)?$/.test(word)) return true;
    
    // Color hex values (without #) - both 6 and 3 digits
    if (/^[0-9a-fA-F]{6}$/.test(word)) return true;
    if (/^[0-9a-fA-F]{3}$/.test(word)) return true;
    
    // Unit names
    if (ARTURO_UNITS.has(word)) return true;
    
    // Named colors (when used after #)
    if (ARTURO_COLORS.has(word)) return true;
    
    // Single letter literals (for 'c' in char literal context)
    if (/^[a-z]$/.test(word)) return true;

    // Complex number imaginary parts: 2i, 3.14i, 0i
    if (/^-?\d+(\.\d+)?i$/.test(word)) return true;

    return false;
}

/**
 * Extract function parameters from a function definition
 * Returns array of parameter names
 */
function extractFunctionParams(functionDef) {
    const params = [];
    // Match: function [param1 param2] or function 'param or $[param1 param2]
    const match = functionDef.match(/(?:function|method|\$)\s*\[([^\]]*)\]/);
    if (match) {
        const paramStr = match[1].trim();
        if (paramStr) {
            // Parameters are space-separated words in the brackets
            const words = paramStr.split(/\s+/);
            words.forEach(word => {
                // Clean parameter name (remove type annotations if present)
                const cleanParam = word.replace(/:[a-z]+/g, '').trim();
                if (cleanParam && !cleanParam.startsWith(':')) {
                    params.push(cleanParam);
                }
            });
        }
    }
    return params;
}

/**
 * Extract loop variables from loop statements
 * Returns array of variable names
 */
function extractLoopVariables(text) {
    const loopVars = [];
    // Match: loop collection 'var or loop collection 'var1 'var2
    const matches = text.matchAll(/loop\s+\S+\s+'(\w+)/g);
    for (const match of matches) {
        loopVars.push(match[1]);
    }
    return loopVars;
}

/**
 * Extract dictionary key-value pairs from a line
 * Returns set of keys defined in the dictionary
 */
function extractDictionaryKeys(text) {
    const keys = new Set();
    // Match: key: value patterns within #[...] or standalone
    const keyMatches = text.matchAll(/(\w+):\s+/g);
    for (const match of keyMatches) {
        keys.add(match[1]);
    }
    return keys;
}

/**
 * Check if a word is inside a block literal (e.g., [pizza spaghetti])
 * Words inside block literals are implicitly literal and don't need definition
 */
function isInBlockLiteral(line, wordIndex) {
    let bracketDepth = 0;
    let inString = false;
    let stringChar = null;
    
    for (let i = 0; i < wordIndex; i++) {
        const char = line[i];
        const prevChar = i > 0 ? line[i - 1] : '';
        
        if (!inString) {
            if (char === '"' || char === '{' || char === '«') {
                inString = true;
                stringChar = char;
            } else if (char === '[') {
                bracketDepth++;
            } else if (char === ']') {
                bracketDepth--;
            }
        } else {
            if (stringChar === '"' && char === '"' && prevChar !== '\\') {
                inString = false;
                stringChar = null;
            } else if (stringChar === '{' && char === '}') {
                inString = false;
                stringChar = null;
            } else if (stringChar === '«') {
                if (char === '»') {
                    inString = false;
                    stringChar = null;
                }
            }
        }
    }
    
    return !inString && bracketDepth > 0;
}

/**
 * Check if a word is inside a string literal or code block
 * Handles: "...", {...}, {:...:}, ««...»», {!css:...:}, {!html...}, etc.
 */
function isInString(line, wordIndex) {
    let inString = false;
    let stringChar = null;
    let isCodeBlock = false;
    let isVerbatim = false;
    
    for (let i = 0; i < wordIndex; i++) {
        const char = line[i];
        const prevChar = i > 0 ? line[i - 1] : '';
        const nextChar = i < line.length - 1 ? line[i + 1] : '';
        
        if (!inString) {
            // Check for code blocks: {!css:, {!html:, {!js:, {!sql:, etc.
            if (char === '{' && nextChar === '!') {
                inString = true;
                stringChar = '{';
                isCodeBlock = true;
                continue;
            }
            // Check for verbatim strings: {:
            if (char === '{' && nextChar === ':') {
                inString = true;
                stringChar = '{';
                isVerbatim = true;
                continue;
            }
            // Regular string delimiters
            if (char === '"' || char === '{' || char === '«') {
                inString = true;
                stringChar = char;
            }
        } else {
            // Check for end of string
            if (stringChar === '"' && char === '"' && prevChar !== '\\') {
                inString = false;
                stringChar = null;
            } else if (stringChar === '{' && char === '}') {
                // For code blocks, check if it's :}
                if (isCodeBlock || isVerbatim) {
                    if (isVerbatim && prevChar === ':') {
                        inString = false;
                        stringChar = null;
                        isVerbatim = false;
                    } else if (isCodeBlock && prevChar === ':') {
                        inString = false;
                        stringChar = null;
                        isCodeBlock = false;
                    } else if (isCodeBlock && prevChar !== ':') {
                        // Alternative code block syntax {!css ... }
                        inString = false;
                        stringChar = null;
                        isCodeBlock = false;
                    }
                } else {
                    inString = false;
                    stringChar = null;
                }
            } else if (stringChar === '«') {
                if (char === '»') {
                    if (nextChar === '»') {
                        inString = false;
                        stringChar = null;
                        i++; // Skip the second »
                    } else {
                        // Single » in ««...»» context
                        continue;
                    }
                }
            }
        }
    }
    
    return inString;
}

/**
 * Check if we're inside a multiline string across lines
 * Returns {inString: boolean, stringType: string|null}
 */
function isInMultilineString(lines, lineIndex, charIndex) {
    let inString = false;
    let stringType = null;
    
    // Check all previous lines
    for (let li = 0; li <= lineIndex; li++) {
        const line = lines[li];
        const endPos = li === lineIndex ? charIndex : line.length;
        
        for (let i = 0; i < endPos; i++) {
            const char = line[i];
            const nextChar = i < line.length - 1 ? line[i + 1] : '';
            const prevChar = i > 0 ? line[i - 1] : '';
            
            if (!inString) {
                // Check for multiline string starts
                if (char === '{') {
                    if (nextChar === '!') {
                        // Code block: {!css: or {!html etc
                        inString = true;
                        stringType = 'code_block';
                    } else if (nextChar === ':') {
                        // Verbatim string: {:
                        inString = true;
                        stringType = 'verbatim';
                    } else {
                        // Regular curly string: {
                        inString = true;
                        stringType = 'curly';
                    }
                } else if (char === '«' && nextChar === '«') {
                    inString = true;
                    stringType = 'safe';
                }
            } else {
                // Check for string ends
                if (stringType === 'code_block' && prevChar === ':' && char === '}') {
                    inString = false;
                    stringType = null;
                } else if (stringType === 'code_block' && char === '}') {
                    // Alternative syntax {!css ... }
                    inString = false;
                    stringType = null;
                } else if (stringType === 'verbatim' && prevChar === ':' && char === '}') {
                    inString = false;
                    stringType = null;
                } else if (stringType === 'curly' && char === '}') {
                    inString = false;
                    stringType = null;
                } else if (stringType === 'safe' && prevChar === '»' && char === '»') {
                    inString = false;
                    stringType = null;
                }
            }
        }
    }
    
    return { inString, stringType };
}

/**
 * Validate document with improved literal and scope detection
 */
async function validateTextDocument(document) {
    const text = document.getText();
    const cleanText = stripComments(text);
    const diagnostics = [];
    const symbols = parseDocument(document);

    const lines = text.split('\n');
    const cleanLines = cleanText.split('\n');
    
    // Extract all function parameters and loop variables from the entire document
    const allFunctionParams = new Set();
    const allLoopVars = new Set();
    const allDictKeys = new Set();
    
    cleanLines.forEach(line => {
        // Extract function parameters
        if (line.includes('function') || line.includes('method') || line.includes('$')) {
            const params = extractFunctionParams(line);
            params.forEach(p => allFunctionParams.add(p));
        }
        
        // Extract loop variables
        const loopVars = extractLoopVariables(line);
        loopVars.forEach(v => allLoopVars.add(v));
        
        // Extract dictionary keys
        const dictKeys = extractDictionaryKeys(line);
        dictKeys.forEach(k => allDictKeys.add(k));
    });
    
    // Get custom types for this document
    const docTypes = customTypes.get(document.uri) || new Set();
    
    lines.forEach((line, lineIndex) => {
        const cleanLine = cleanLines[lineIndex];
        
        // Skip if entire line is a comment
        if (line.trim().startsWith(';')) {
            return;
        }
        
        // Check if we're inside a multiline string
        const multilineCheck = isInMultilineString(lines, lineIndex, line.length);
        if (multilineCheck.inString) {
            // Skip validation for lines inside multiline strings
            return;
        }
        
        // Check for unmatched brackets across the entire file
        const textUpToLine = cleanLines.slice(0, lineIndex + 1).join('\n');
        const openBrackets = (textUpToLine.match(/\[/g) || []).length;
        const closeBrackets = (textUpToLine.match(/\]/g) || []).length;
        
        // Only report on lines with brackets
        if (line.includes('[') || line.includes(']')) {
            if (lineIndex === lines.length - 1 && openBrackets !== closeBrackets) {
                const diagnostic = {
                    severity: DiagnosticSeverity.Error,
                    range: {
                        start: { line: lineIndex, character: 0 },
                        end: { line: lineIndex, character: line.length }
                    },
                    message: 'Unmatched brackets in file',
                    source: 'arturo-lsp'
                };
                diagnostics.push(diagnostic);
            }
        }
        
        // Check for undefined variables (only in non-comment parts)
        // Match words including hyphens and question marks (for predicates like prime?, odd?)
        const words = cleanLine.match(/\b[\w-]+\??\b/g) || [];
        words.forEach(word => {
            // Skip literals (numbers, booleans, null, colors, units)
            if (isLiteral(word)) {
                return;
            }
            
            // Skip if it's a builtin or defined symbol.
            // Also check the live signature indexer — functions like sha256, md5,
            // cumSum, transpose are only known after a successful GitHub fetch
            // and are not in the static BUILTIN_NAMES set.
            if (BUILTIN_NAMES.has(word) || 
                signatureIndexer.hasFunction(word) ||
                symbols.variables.has(word) || 
                symbols.functions.has(word)) {
                return;
            }
            
            // Skip if it's a function parameter or loop variable
            if (allFunctionParams.has(word) || allLoopVars.has(word)) {
                return;
            }
            
            // Skip if it's a dictionary key
            if (allDictKeys.has(word)) {
                return;
            }
            
            // Skip custom types
            if (docTypes.has(word)) {
                return;
            }

            const wordIndex = line.indexOf(word);
            
            // Don't flag if this is part of an assignment (word:)
            if (wordIndex + word.length < line.length && line[wordIndex + word.length] === ':') {
                return;
            }
            
            // Check if word is in a comment
            if (isInComment(line, wordIndex)) {
                return;
            }
            
            // Check if word is inside a string literal
            if (isInString(line, wordIndex)) {
                return;
            }
            
            // Check if word is inside a block literal [...]
            if (isInBlockLiteral(line, wordIndex)) {
                return;
            }

            // Check if word is a base name of a builtin predicate:
            // e.g. 'some' in 'some?' — the regex also matches the bare
            // stem because '?' is not a \w character.
            if (BUILTIN_NAMES.has(word + '?') || signatureIndexer.hasFunction(word + '?')) {
                return;
            }
            
            // Check if word is preceded by a quote (literal/symbol)
            if (wordIndex > 0 && line[wordIndex - 1] === "'") {
                return;
            }
            
            // Check if word is preceded by a backtick (unit literal)
            if (wordIndex > 0 && line[wordIndex - 1] === '`') {
                return;
            }
            
            // Check if word is preceded by a hash (color literal)
            if (wordIndex > 0 && line[wordIndex - 1] === '#') {
                return;
            }
            
            // Check if word is preceded by a colon (type annotation)
            if (wordIndex > 0 && line[wordIndex - 1] === ':') {
                // Type annotations are valid if they're standard types or custom types
                if (ARTURO_TYPES[word] || docTypes.has(word)) {
                    return;
                }
            }
            
            // Check if word is preceded by a dot (attribute)
            if (wordIndex > 0 && line[wordIndex - 1] === '.') {
                // This is an attribute - check static list or live indexer attrs
                if (isKnownAttribute(word)) {
                    return; // Valid attribute
                }
                // Otherwise continue to check if it's defined
            }
            
            // Only warn if it looks like it's being used as a value
            const diagnostic = {
                severity: DiagnosticSeverity.Warning,
                range: {
                    start: { line: lineIndex, character: wordIndex },
                    end: { line: lineIndex, character: wordIndex + word.length }
                },
                message: `'${word}' may be undefined`,
                source: 'arturo-lsp'
            };
            diagnostics.push(diagnostic);
        });
    });

    // Type checking: Check for type mismatches in operations
    cleanLines.forEach((line, lineIndex) => {
        // Skip comments
        if (line.trim().startsWith(';')) return;
        
        // Check for type mismatches in binary operations
        // Match patterns like: var: expr1 op expr2
        const binaryOpMatch = line.match(/(\w+)\s*:\s*([^;\n]+?)\s*([+\-*\/])\s*([^;\n]+)/);
        if (binaryOpMatch) {
            const varName = binaryOpMatch[1];
            const leftOperand = binaryOpMatch[2].trim();
            const operator = binaryOpMatch[3];
            const rightOperand = binaryOpMatch[4].trim();
            
            // Check if we're mixing numeric and string types
            const leftType = inferType(leftOperand);
            const rightType = inferType(rightOperand);
            
            // If one is numeric and the other is string, that's an error
            const numericTypes = new Set([':integer', ':floating', ':complex', ':rational']);
            const leftIsNumeric = numericTypes.has(leftType) || symbols.variables.has(leftOperand) && numericTypes.has(symbols.variables.get(leftOperand).type);
            const rightIsNumeric = numericTypes.has(rightType);
            const leftIsString = leftType === ':string';
            const rightIsString = rightType === ':string';
            
            if ((leftIsNumeric && rightIsString) || (leftIsString && rightIsNumeric)) {
                const opIndex = line.indexOf(operator, line.indexOf(':'));
                const diagnostic = {
                    severity: DiagnosticSeverity.Error,
                    range: {
                        start: { line: lineIndex, character: opIndex },
                        end: { line: lineIndex, character: line.length }
                    },
                    message: `Type error: Cannot ${operator === '+' ? 'add' : operator === '-' ? 'subtract' : operator === '*' ? 'multiply' : 'divide'} ${leftIsString ? 'string' : 'number'} and ${rightIsString ? 'string' : 'number'}`,
                    source: 'arturo-lsp'
                };
                diagnostics.push(diagnostic);
            }
        }
    });

    return diagnostics;
}

// Debounce map: uri -> timeout handle
const validateDebounceMap = new Map();

documents.onDidChangeContent(change => {
    const uri = change.document.uri;
    // Cancel any pending validation for this document
    if (validateDebounceMap.has(uri)) {
        clearTimeout(validateDebounceMap.get(uri));
    }
    // Schedule validation after 500ms of inactivity
    validateDebounceMap.set(uri, setTimeout(() => {
        validateDebounceMap.delete(uri);
        validateTextDocument(change.document).then(diagnostics => {
            connection.sendDiagnostics({ uri, diagnostics });
        });
    }, 500));
});

// Completion resolve handler — required because resolveProvider: true is advertised
connection.onCompletionResolve((item) => {
    // Items are already fully populated; nothing more to resolve
    return item;
});

connection.onDefinition((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        connection.console.log('Definition: No document found');
        return null;
    }

    const position = params.position;
    const text = document.getText();
    const lines = text.split('\n');
    
    if (position.line >= lines.length) {
        connection.console.log('Definition: Line out of range');
        return null;
    }
    
    const line = lines[position.line];
    
    // Check if we're in a comment
    if (isInComment(line, position.character)) {
        connection.console.log('Definition: Inside comment');
        return null;
    }
    
    // Extract the word at the cursor position
    const beforeCursor = line.substring(0, position.character);
    const afterCursor = line.substring(position.character);
    
    const wordBeforeMatch = beforeCursor.match(/([\w-]+\??)$/);
    const wordAfterMatch = afterCursor.match(/^([\w-]*\??)/);
    
    if (!wordBeforeMatch) {
        connection.console.log('Definition: No word found');
        return null;
    }
    
    const wordBefore = wordBeforeMatch[1];
    const wordAfter = wordAfterMatch ? wordAfterMatch[1] : '';
    const word = wordBefore + wordAfter;
    
    connection.console.log(`Definition: Looking for '${word}'`);
    
    const symbols = documentSymbols.get(params.textDocument.uri);
    
    if (!symbols) {
        connection.console.log('Definition: No symbols found');
        return null;
    }

    if (symbols.variables.has(word)) {
        const varInfo = symbols.variables.get(word);
        connection.console.log(`Definition: Found variable '${word}' at line ${varInfo.line}`);
        return {
            uri: params.textDocument.uri,
            range: {
                start: { line: varInfo.line, character: varInfo.column },
                end: { line: varInfo.line, character: varInfo.column + word.length }
            }
        };
    }

    if (symbols.functions.has(word)) {
        const funcInfo = symbols.functions.get(word);
        if (funcInfo.builtin) {
            connection.console.log(`Definition: '${word}' is a builtin, no definition`);
            return null;
        }
        connection.console.log(`Definition: Found function '${word}' at line ${funcInfo.line}`);
        return {
            uri: params.textDocument.uri,
            range: {
                start: { line: funcInfo.line, character: funcInfo.column },
                end: { line: funcInfo.line, character: funcInfo.column + word.length }
            }
        };
    }

    // Cross-file definition via workspace indexer
    const wsLoc = workspaceIndexer.getDefinitionLocation(word);
    if (wsLoc) {
        const targetUri = 'file:///' + wsLoc.filePath.replace(/\\/g, '/').replace(/^\//, '');
        connection.console.log(`Definition: Found '${word}' in workspace at ${wsLoc.filePath}:${wsLoc.line}`);
        return {
            uri: targetUri,
            range: {
                start: { line: wsLoc.line, character: wsLoc.column },
                end:   { line: wsLoc.line, character: wsLoc.column + word.length }
            }
        };
    }

    connection.console.log(`Definition: No definition found for '${word}'`);
    return null;
});

connection.onHover((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        connection.console.log('Hover: No document found');
        return null;
    }

    const position = params.position;
    const text = document.getText();
    const lines = text.split('\n');
    
    if (position.line >= lines.length) {
        connection.console.log('Hover: Line out of range');
        return null;
    }
    
    const line = lines[position.line];
    
    // Check if we're in a comment (use single-line version)
    const commentIndex = line.indexOf(';');
    let inCommentCheck = false;
    if (commentIndex !== -1 && commentIndex <= position.character) {
        // Check if semicolon is in a string
        let inString = false;
        let stringChar = null;
        for (let i = 0; i < commentIndex; i++) {
            const char = line[i];
            if ((char === '"' || char === '{') && !inString) {
                inString = true;
                stringChar = char;
            } else if (inString) {
                if ((stringChar === '"' && char === '"' && line[i-1] !== '\\') ||
                    (stringChar === '{' && char === '}')) {
                    inString = false;
                    stringChar = null;
                }
            }
        }
        if (!inString) {
            inCommentCheck = true;
        }
    }
    
    if (inCommentCheck) {
        connection.console.log('Hover: Inside comment');
        return null;
    }
    
    // Check if we're in a multiline string
    const multilineCheck = isInMultilineString(lines, position.line, position.character);
    if (multilineCheck.inString) {
        connection.console.log('Hover: Inside multiline string');
        return null;
    }
    
    // Extract the word at the cursor position with more flexible matching
    // Match words that may contain hyphens (like kebab-case)
    const beforeCursor = line.substring(0, position.character);
    const afterCursor = line.substring(position.character);
    
    // Match word before cursor (including hyphens and question marks)
    const wordBeforeMatch = beforeCursor.match(/([\w-]+\??)$/);
    // Match word after cursor (including hyphens and question marks)
    const wordAfterMatch = afterCursor.match(/^([\w-]*\??)/);
    
    if (!wordBeforeMatch) {
        connection.console.log('Hover: No word found before cursor');
        return null;
    }
    
    const wordBefore = wordBeforeMatch[1];
    const wordAfter = wordAfterMatch ? wordAfterMatch[1] : '';
    const word = wordBefore + wordAfter;
    
    connection.console.log(`Hover: Found word '${word}'`);
    
    // Check if preceded by a dot (attribute)
    const charBeforeWord = beforeCursor[beforeCursor.length - wordBefore.length - 1];
    if (charBeforeWord === '.') {
        // Check static list or live indexer attrs
        if (isKnownAttribute(word)) {
            return {
                contents: {
                    kind: MarkupKind.Markdown,
                    value: `**\.${word}** (attribute)\n\nFunction attribute parameter`
                }
            };
        }
    }

    // Check if it's a builtin function
    if (BUILTIN_NAMES.has(word)) {
        const funcInfo = getFunctionInfo(word);
        if (funcInfo) {
            return {
                contents: {
                    kind: MarkupKind.Markdown,
                    value: `**${word}** (builtin)\n\n${funcInfo.description}\n\n\`\`\`arturo\n${funcInfo.signature}\n\`\`\``
                }
            };
        } else {
            return {
                contents: {
                    kind: MarkupKind.Markdown,
                    value: `**${word}** (builtin function)`
                }
            };
        }
    }

    // Check if it's a type annotation
    if (word.startsWith(':') || (charBeforeWord === ':' && ARTURO_TYPES[word])) {
        const typeName = word.startsWith(':') ? word.substring(1) : word;
        if (ARTURO_TYPES[typeName]) {
            const typeInfo = ARTURO_TYPES[typeName];
            return {
                contents: {
                    kind: MarkupKind.Markdown,
                    value: `**:${typeName}** (type)\n\n${typeInfo.description}`
                }
            };
        }
    }

    // Check user-defined symbols
    const symbols = documentSymbols.get(params.textDocument.uri);
    if (symbols) {
        if (symbols.variables.has(word)) {
            const varInfo = symbols.variables.get(word);
            return {
                contents: {
                    kind: MarkupKind.Markdown,
                    value: `**${word}** (variable)\n\nType: \`${varInfo.type}\``
                }
            };
        }

        if (symbols.functions.has(word)) {
            const funcInfo = symbols.functions.get(word);
            return {
                contents: {
                    kind: MarkupKind.Markdown,
                    value: `**${word}** (function)\n\nType: \`${funcInfo.type}\``
                }
            };
        }
    }

    // Check the signature indexer directly (catches functions not in BUILTIN_NAMES
    // but known to the indexer after a successful GitHub fetch)
    const indexedInfo = signatureIndexer.getSignature(word);
    if (indexedInfo) {
        return {
            contents: {
                kind: MarkupKind.Markdown,
                value: `**${word}** (builtin)\n\n${indexedInfo.description}\n\n\`\`\`arturo\n${indexedInfo.signature}\n\`\`\``
            }
        };
    }

    // Check workspace indexer for user-defined functions across all project files
    const userFunc = workspaceIndexer.getFunctionInfo(word);
    if (userFunc) {
        const location = `*${userFunc.filePath.split(/[\\/]/).pop()}* line ${userFunc.line + 1}`;
        return {
            contents: {
                kind: MarkupKind.Markdown,
                value: `**${word}** (user function) — ${location}\n\n${userFunc.description}\n\n\`\`\`arturo\n${userFunc.signature}\n\`\`\``
            }
        };
    }

    // Last chance: check if the word is a known attribute name.
    // In Arturo some builtins (sha256, md5, sha1, etc.) surface as
    // attribute selectors on functions like `digest`. Show useful info
    // rather than nothing when hovering them standalone.
    if (isKnownAttribute(word)) {
        // Try to find which function(s) expose this attribute
        const hostFunctions = [];
        for (const [fname, sig] of signatureIndexer.signatures) {
            if (Array.isArray(sig.attrs) && sig.attrs.some(a => a.name === word)) {
                const attrInfo = sig.attrs.find(a => a.name === word);
                hostFunctions.push({ fname, attrInfo });
            }
        }
        if (hostFunctions.length > 0) {
            const { fname, attrInfo } = hostFunctions[0];
            const attrDesc = attrInfo.description ? `\n\n${attrInfo.description}` : '';
            return {
                contents: {
                    kind: MarkupKind.Markdown,
                    value: `**\.${word}** (attribute of \`${fname}\`)${attrDesc}\n\nType: \`${attrInfo.type || ':any'}\``
                }
            };
        }
        // Attribute is in the static set but no indexer entry found
        return {
            contents: {
                kind: MarkupKind.Markdown,
                value: `**\.${word}** (attribute)\n\nFunction attribute parameter`
            }
        };
    }

    connection.console.log(`Hover: No info found for '${word}'`);
    return null;
});

connection.onCompletion((params) => {
    const document = documents.get(params.textDocument.uri);
    const items = [];

    // ── Context-specific completions (dot / colon / backtick / hash) ──────────
    // These are exact-context triggers — return immediately after building the
    // context-specific list so the ranker operates on a focused candidate set.
    if (document) {
        const position = params.position;
        const text = document.getText();
        const lines = text.split('\n');

        if (position.line < lines.length) {
            const line = lines[position.line];
            const beforeCursor = line.substring(0, position.character);

            if (beforeCursor.endsWith('.')) {
                // Attribute completion — no further ranking needed, set uniform sortText
                ATTRIBUTE_NAMES.forEach(attrName => {
                    items.push({
                        label: attrName,
                        kind: CompletionItemKind.Property,
                        detail: 'Attribute',
                        documentation: `Function attribute: .${attrName}`,
                    });
                });
                signatureIndexer.getAllAttrNames().forEach(attrName => {
                    if (!ATTRIBUTE_NAMES.has(attrName)) {
                        items.push({
                            label: attrName,
                            kind: CompletionItemKind.Property,
                            detail: 'Attribute',
                            documentation: `Function attribute: .${attrName}`,
                        });
                    }
                });
                // Rank by the partial word after the dot, if any
                const afterDot = beforeCursor.match(/\.([\w-]*)$/);
                const attrQuery = afterDot ? afterDot[1] : '';
                const ctx = completionRanker.buildContext(
                    document, position,
                    documentSymbols.get(params.textDocument.uri),
                    workspaceIndexer
                );
                return completionRanker.rank(items, attrQuery, ctx);
            }

            if (beforeCursor.endsWith(':')) {
                Object.keys(ARTURO_TYPES).forEach(typeName => {
                    const typeInfo = ARTURO_TYPES[typeName];
                    items.push({
                        label: typeName,
                        kind: CompletionItemKind.Class,
                        detail: 'Type',
                        documentation: typeInfo.description,
                    });
                });
                const docTypes = customTypes.get(document.uri);
                if (docTypes) {
                    docTypes.forEach(typeName => {
                        items.push({
                            label: typeName,
                            kind: CompletionItemKind.Class,
                            detail: 'Custom Type',
                            documentation: `User-defined type: ${typeName}`,
                        });
                    });
                }
                const ctx = completionRanker.buildContext(
                    document, position,
                    documentSymbols.get(params.textDocument.uri),
                    workspaceIndexer
                );
                return completionRanker.rank(items, '', ctx);
            }

            if (beforeCursor.endsWith('`')) {
                ARTURO_UNITS.forEach(unitName => {
                    items.push({
                        label: unitName,
                        kind: CompletionItemKind.Unit,
                        detail: 'Unit',
                        documentation: `Physical unit: \`${unitName}`,
                    });
                });
                const ctx = completionRanker.buildContext(
                    document, position,
                    documentSymbols.get(params.textDocument.uri),
                    workspaceIndexer
                );
                return completionRanker.rank(items, '', ctx);
            }

            if (beforeCursor.endsWith('#')) {
                ARTURO_COLORS.forEach(colorName => {
                    items.push({
                        label: colorName,
                        kind: CompletionItemKind.Color,
                        detail: 'Color',
                        documentation: `Named color: #${colorName}`,
                    });
                });
                const ctx = completionRanker.buildContext(
                    document, position,
                    documentSymbols.get(params.textDocument.uri),
                    workspaceIndexer
                );
                return completionRanker.rank(items, '', ctx);
            }
        }
    }

    // ── General completions ───────────────────────────────────────────────────

    // Extract the query (word being typed before the cursor)
    let query = '';
    if (document) {
        const line = document.getText().split('\n')[params.position.line] || '';
        const beforeCursor = line.substring(0, params.position.character);
        const m = beforeCursor.match(/[\w-]*$/);
        query = m ? m[0] : '';
    }

    // Built-in functions — from indexer first, seed-cache fallback
    signatureIndexer.getAllFunctionNames().forEach(funcName => {
        const funcInfo = signatureIndexer.getSignature(funcName);
        items.push({
            label: funcName,
            kind: CompletionItemKind.Function,
            detail: funcInfo ? funcInfo.signature : 'Builtin function',
            documentation: funcInfo ? funcInfo.description : 'Arturo builtin function',
        });
    });
    BUILTIN_NAMES.forEach(funcName => {
        if (!signatureIndexer.hasFunction(funcName)) {
            const funcInfo = BUILTIN_FUNCTIONS[funcName];
            items.push({
                label: funcName,
                kind: CompletionItemKind.Function,
                detail: funcInfo ? funcInfo.signature : 'Builtin function',
                documentation: funcInfo ? funcInfo.description : 'Arturo builtin function',
            });
        }
    });

    // Type annotations
    Object.keys(ARTURO_TYPES).forEach(typeName => {
        const typeInfo = ARTURO_TYPES[typeName];
        items.push({
            label: ':' + typeName,
            kind: CompletionItemKind.Class,
            detail: 'Type',
            documentation: typeInfo.description,
        });
    });

    // Workspace-indexed user symbols
    workspaceIndexer.getAllFunctionNames().forEach(name => {
        const info = workspaceIndexer.getFunctionInfo(name);
        items.push({
            label: name,
            kind: CompletionItemKind.Function,
            detail: info.signature,
            documentation: `${info.description}\n\n*${info.filePath.split(/[\\/]/).pop()}*`,
        });
    });
    workspaceIndexer.getAllVariableNames().forEach(name => {
        const vr = workspaceIndexer.variables.get(name);
        items.push({
            label: name,
            kind: CompletionItemKind.Variable,
            detail: vr ? vr.type : ':any',
            documentation: `User-defined variable in *${vr ? vr.filePath.split(/[\\/]/).pop() : '?'}*`,
        });
    });

    // Current-document symbols not yet saved to the workspace index
    if (document) {
        const symbols = documentSymbols.get(params.textDocument.uri);
        if (symbols) {
            symbols.variables.forEach((info, name) => {
                if (!workspaceIndexer.hasVariable(name)) {
                    items.push({
                        label: name,
                        kind: CompletionItemKind.Variable,
                        detail: info.type,
                        documentation: 'User-defined variable',
                    });
                }
            });
            symbols.functions.forEach((info, name) => {
                if (!info.builtin && !workspaceIndexer.hasFunction(name)) {
                    items.push({
                        label: name,
                        kind: CompletionItemKind.Function,
                        detail: info.type,
                        documentation: 'User-defined function',
                    });
                }
            });
        }

        // Custom types
        const docTypes = customTypes.get(document.uri);
        if (docTypes) {
            docTypes.forEach(typeName => {
                items.push({
                    label: ':' + typeName,
                    kind: CompletionItemKind.Class,
                    detail: 'Custom Type',
                    documentation: `User-defined type: ${typeName}`,
                });
            });
        }
    }

    // ── Rank and return ───────────────────────────────────────────────────────
    const ctx = completionRanker.buildContext(
        document,
        params.position,
        document ? documentSymbols.get(params.textDocument.uri) : null,
        workspaceIndexer
    );
    return completionRanker.rank(items, query, ctx);
});

/**
 * Signature Help - shows parameter hints as you type
 */
connection.onSignatureHelp((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const text = document.getText();
    const offset = document.offsetAt(params.position);
    const textUpToCursor = text.substring(0, offset);

    // Find the function call we're currently in
    // Match pattern: funcName[args or funcName.attr[args
    const funcMatch = textUpToCursor.match(/(\w+(?:\.\w+)*)\s*\[([^\]]*)?$/);
    if (!funcMatch) return null;

    const fullFuncName = funcMatch[1];
    const paramsText = funcMatch[2] || '';
    
    // Extract base function name (ignore attributes like .with, .else)
    const baseFuncName = fullFuncName.split('.')[0];

    // Look up function info — builtins first, then user-defined
    const funcInfo = getFunctionInfo(baseFuncName) || workspaceIndexer.getFunctionInfo(baseFuncName);
    if (!funcInfo || !funcInfo.params) return null;

    // Count how many parameters have been typed
    const args = paramsText.trim().split(/\s+/).filter(s => s.length > 0);
    let activeParameter = args.length;
    
    // If cursor is at a space, we're starting the next parameter
    if (textUpToCursor.endsWith(' ')) {
        activeParameter = Math.max(0, args.length);
    }

    // Build signature
    const paramLabels = funcInfo.params.map(p => p.name);
    const signatureLabel = `${baseFuncName} ${paramLabels.join(' ')}`;
    
    const signature = SignatureInformation.create(
        signatureLabel,
        funcInfo.description
    );

    // Add parameter information
    signature.parameters = funcInfo.params.map(param => {
        return ParameterInformation.create(
            param.name,
            param.description || ''
        );
    });

    return {
        signatures: [signature],
        activeSignature: 0,
        activeParameter: Math.min(activeParameter, funcInfo.params.length - 1)
    };
});

/**
 * Find All References - finds all usages of a symbol
 */
connection.onReferences((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];

    const position = params.position;
    const text = document.getText();
    const lines = text.split('\n');
    const currentLine = lines[position.line];

    // Get the word at cursor position
    const wordInfo = getWordAtPosition(currentLine, position.character);
    if (!wordInfo) return [];

    const targetWord = wordInfo.word;
    
    // Don't find references for builtins
    if (BUILTIN_NAMES.has(targetWord)) return [];

    const references = [];
    const regex = new RegExp(`\\b${escapeRegex(targetWord)}\\b`, 'g');

    lines.forEach((line, lineIndex) => {
        let match;
        while ((match = regex.exec(line)) !== null) {
            const col = match.index;

            // Skip if in comment or string (using helper functions)
            if (isInComment(line, col) || isInString(line, col)) {
                continue;
            }

            // Skip if it's a literal marker ('word or `unit)
            if (col > 0) {
                const prevChar = line[col - 1];
                if (prevChar === "'" || prevChar === '`') {
                    continue;
                }
            }

            references.push(Location.create(
                params.textDocument.uri,
                Range.create(lineIndex, col, lineIndex, col + targetWord.length)
            ));
        }
    });

    return references;
});

/**
 * Document Highlights - highlights all occurrences of symbol in current document
 */
connection.onDocumentHighlight((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];

    const position = params.position;
    const text = document.getText();
    const lines = text.split('\n');
    const currentLine = lines[position.line];

    // Get the word at cursor position
    const wordInfo = getWordAtPosition(currentLine, position.character);
    if (!wordInfo) return [];

    const targetWord = wordInfo.word;
    
    // Don't highlight builtins
    if (BUILTIN_NAMES.has(targetWord)) return [];

    const highlights = [];
    const regex = new RegExp(`\\b${escapeRegex(targetWord)}\\b`, 'g');

    lines.forEach((line, lineIndex) => {
        let match;
        while ((match = regex.exec(line)) !== null) {
            const col = match.index;

            // Skip if in comment or string (using helper functions)
            if (isInComment(line, col) || isInString(line, col)) {
                continue;
            }

            // Skip if it's a literal marker ('word or `unit)
            if (col > 0) {
                const prevChar = line[col - 1];
                if (prevChar === "'" || prevChar === '`') {
                    continue;
                }
            }

            highlights.push(DocumentHighlight.create(
                Range.create(lineIndex, col, lineIndex, col + targetWord.length),
                DocumentHighlightKind.Text
            ));
        }
    });

    return highlights;
});

/**
 * Prepare Rename - validates that rename is possible
 */
connection.onPrepareRename((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const position = params.position;
    const lines = document.getText().split('\n');
    const currentLine = lines[position.line];

    // Get the word at cursor position  
    const wordInfo = getWordAtPosition(currentLine, position.character);
    if (!wordInfo) return null;

    const word = wordInfo.word;

    // Check if cursor is inside comment or string (using helper functions)
    if (isInComment(currentLine, position.character) || isInString(currentLine, position.character)) {
        return null;
    }

    // Don't allow renaming built-in functions
    if (BUILTIN_NAMES.has(word)) {
        return null;
    }

    // Don't allow renaming type names
    if (word.startsWith(':') || ARTURO_TYPES.hasOwnProperty(word.replace(':', ''))) {
        return null;
    }

    // Return the range and placeholder
    return {
        range: Range.create(
            position.line,
            wordInfo.start,
            position.line,
            wordInfo.end
        ),
        placeholder: word
    };
});

/**
 * Rename - renames a symbol throughout the document
 */
connection.onRequest('textDocument/rename', (params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const newName = params.newName;
    const position = params.position;
    const text = document.getText();
    const lines = text.split('\n');
    const currentLine = lines[position.line];

    // Validate new name
    if (!isValidIdentifier(newName)) {
        connection.window.showErrorMessage(
            `Invalid identifier: "${newName}". Must start with letter/underscore and contain only letters, numbers, hyphens, underscores, and optional '?' at end.`
        );
        return null;
    }

    // Get the word at cursor position
    const wordInfo = getWordAtPosition(currentLine, position.character);
    if (!wordInfo) return null;

    const oldName = wordInfo.word;

    // Check if new name conflicts with builtins
    if (BUILTIN_NAMES.has(newName)) {
        connection.window.showWarningMessage(
            `Warning: "${newName}" conflicts with a built-in function.`
        );
    }

    // Find all occurrences (same logic as references)
    const edits = [];
    const regex = new RegExp(`\\b${escapeRegex(oldName)}\\b`, 'g');

    lines.forEach((line, lineIndex) => {
        let match;
        while ((match = regex.exec(line)) !== null) {
            const col = match.index;

            // Skip if in comment or string (using helper functions)
            if (isInComment(line, col) || isInString(line, col)) {
                continue;
            }

            // Skip if it's a literal marker
            if (col > 0) {
                const prevChar = line[col - 1];
                if (prevChar === "'" || prevChar === '`') {
                    continue;
                }
            }

            edits.push(TextEdit.replace(
                Range.create(lineIndex, col, lineIndex, col + oldName.length),
                newName
            ));
        }
    });

    return {
        changes: {
            [params.textDocument.uri]: edits
        }
    };
});

/**
 * Document Formatting - formats the entire document
 */
connection.onDocumentFormatting((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];

    const text = document.getText();
    const lines = text.split('\n');
    const edits = [];
    let currentIndent = 0;
    const indentSize = 4; // Use 4 spaces

    lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(';')) {
            // Empty lines and comments don't affect indentation
            return;
        }

        // Normalize spacing around colons for assignments
        // Pattern: identifier : value or identifier: value or identifier :value
        let formattedLine = trimmed.replace(/(\w+)\s*:\s*/, '$1: ');
        
        // Normalize spacing around operators
        formattedLine = formattedLine.replace(/\s*([+\-*\/=<>])\s*/g, ' $1 ');
        
        // Fix double spaces
        formattedLine = formattedLine.replace(/\s{2,}/g, ' ');

        // Count opening/closing brackets
        const openBrackets = (formattedLine.match(/[\[{(]/g) || []).length;
        const closeBrackets = (formattedLine.match(/[\]\})]|\)/g) || []).length;

        // Decrease indent for closing brackets at start of line
        if (formattedLine.startsWith(']') || formattedLine.startsWith('}') || formattedLine.startsWith(')')) {
            currentIndent = Math.max(0, currentIndent - indentSize);
        }

        // Apply indentation
        const newLine = ' '.repeat(currentIndent) + formattedLine;
        if (newLine !== line) {
            edits.push(TextEdit.replace(
                Range.create(index, 0, index, line.length),
                newLine
            ));
        }

        // Increase indent for lines with more opens than closes
        const netBrackets = openBrackets - closeBrackets;
        if (netBrackets > 0) {
            currentIndent += indentSize * netBrackets;
        } else if (netBrackets < 0 && !formattedLine.startsWith(']') && !formattedLine.startsWith('}')) {
            currentIndent = Math.max(0, currentIndent + (indentSize * netBrackets));
        }
    });

    return edits;
});

/**
 * Folding Ranges - defines code folding regions
 */
connection.onFoldingRanges((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];

    const text = document.getText();
    const lines = text.split('\n');
    const foldingRanges = [];
    const stack = []; // Stack to track opening brackets

    lines.forEach((line, lineIndex) => {
        const trimmed = line.trim();

        // Track bracket depth
        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            // Skip if in comment or string
            if (isInComment(line, i) || isInString(line, i)) continue;

            // Opening brackets
            if (char === '[' || char === '{' || (char === '#' && i + 1 < line.length && line[i + 1] === '[')) {
                stack.push({ char: char, line: lineIndex });
                if (char === '#') i++; // Skip the '[' in '#['
            }

            // Closing brackets
            if (char === ']' || char === '}') {
                if (stack.length > 0) {
                    const opener = stack.pop();
                    const openerChar = opener.char === '#' ? '[' : opener.char;
                    const matchingClose = char === ']' ? '[' : '{';

                    if (openerChar === matchingClose) {
                        // Only create fold if it spans multiple lines
                        if (lineIndex > opener.line) {
                            foldingRanges.push(FoldingRange.create(
                                opener.line,
                                lineIndex,
                                undefined,
                                undefined,
                                FoldingRangeKind.Region
                            ));
                        }
                    }
                }
            }
        }
    });

    return foldingRanges;
});

/**
 * Document Symbols - provides document outline
 */
connection.onRequest('textDocument/documentSymbol', (params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        connection.console.log('DocumentSymbol: No document found');
        return [];
    }

    const symbols = parseDocument(document);
    const result = [];
    const text = document.getText();
    const lines = text.split('\n');

    connection.console.log(`DocumentSymbol: Found ${symbols.functions.size} functions and ${symbols.variables.size} variables`);

    // Add functions
    symbols.functions.forEach((info, name) => {
        // Calculate the actual end of the line for the range
        const line = lines[info.line] || '';
        const lineLength = line.length;
        
        const symbol = {
            name: name,
            detail: info.type || ':function',
            kind: SymbolKind.Function,
            range: {
                start: { line: info.line, character: 0 },
                end: { line: info.line, character: lineLength }
            },
            selectionRange: {
                start: { line: info.line, character: info.column },
                end: { line: info.line, character: info.column + name.length }
            },
            children: []
        };
        
        result.push(symbol);
        connection.console.log(`DocumentSymbol: Added function ${name} at line ${info.line}`);
    });

    // Add variables
    symbols.variables.forEach((info, name) => {
        const line = lines[info.line] || '';
        const lineLength = line.length;
        
        const symbol = {
            name: name,
            detail: info.type || ':any',
            kind: SymbolKind.Variable,
            range: {
                start: { line: info.line, character: 0 },
                end: { line: info.line, character: lineLength }
            },
            selectionRange: {
                start: { line: info.line, character: info.column },
                end: { line: info.line, character: info.column + name.length }
            },
            children: []
        };
        
        result.push(symbol);
        connection.console.log(`DocumentSymbol: Added variable ${name} at line ${info.line}`);
    });

    // Sort by line number for better outline ordering
    result.sort((a, b) => a.range.start.line - b.range.start.line);

    connection.console.log(`DocumentSymbol: Returning ${result.length} symbols`);
    return result;
});

/**
 * Inlay Hints - shows inline parameter names and type information
 */
connection.onRequest('textDocument/inlayHint', (params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];

    const text = document.getText();
    const lines = text.split('\n');
    const hints = [];

    // Get document symbols for type information
    const symbols = documentSymbols.get(params.textDocument.uri) || { variables: new Map(), functions: new Map() };

    lines.forEach((line, lineIndex) => {
        // Skip comments
        if (line.trim().startsWith(';')) return;

        // Find function calls with parameters: funcName[param1 param2 ...]
        const funcCallRegex = /(\w+)\s*\[([^\]]+)\]/g;
        let match;

        while ((match = funcCallRegex.exec(line)) !== null) {
            const funcName = match[1];
            const argsText = match[2].trim();
            const argsStartCol = match.index + match[1].length + 1; // After 'funcName['

            // Skip if function is not a builtin with known signature
            const funcInfo = BUILTIN_FUNCTIONS[funcName];
            if (!funcInfo || !funcInfo.params) continue;

            // Parse arguments (space-separated)
            const args = argsText.split(/\s+/).filter(a => a.length > 0);
            let currentCol = argsStartCol;

            // Add parameter name hints for each argument
            args.forEach((arg, argIndex) => {
                if (argIndex < funcInfo.params.length) {
                    const param = funcInfo.params[argIndex];
                    
                    // Find the actual position of this argument in the line
                    const argPos = line.indexOf(arg, currentCol);
                    if (argPos !== -1) {
                        // Add hint before the argument
                        hints.push(InlayHint.create(
                            Position.create(lineIndex, argPos),
                            `${param.name}:`,
                            InlayHintKind.Parameter
                        ));
                        currentCol = argPos + arg.length;
                    }
                }
            });
        }

        // Find variable assignments without type annotations: name: value
        const assignmentRegex = /(\w+)\s*:\s*([^;\n]+)/g;
        
        while ((match = assignmentRegex.exec(line)) !== null) {
            const varName = match[1];
            const value = match[2].trim();
            const colonPos = match.index + varName.length;

            // Skip if it's inside a function call or has explicit type
            if (line.substring(0, match.index).includes('[')) continue;
            if (value.startsWith(':')) continue; // Already has type annotation

            // Check if variable is in our symbols
            if (symbols.variables.has(varName)) {
                const varInfo = symbols.variables.get(varName);
                const inferredType = varInfo.type;

                // Only show hint if type is interesting (not :any)
                if (inferredType && inferredType !== ':any') {
                    // Add type hint after the colon
                    hints.push(InlayHint.create(
                        Position.create(lineIndex, colonPos + 1),
                        ` ${inferredType}`,
                        InlayHintKind.Type
                    ));
                }
            }
        }
    });

    return hints;
});

/**
 * Semantic Tokens - provides enhanced syntax highlighting
 */
connection.onRequest('textDocument/semanticTokens/full', (params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return { data: [] };

    const text = document.getText();
    const lines = text.split('\n');
    const builder = new SemanticTokensBuilder();
    
    // Token type indices (must match legend order)
    const tokenTypes = {
        function: 0,
        variable: 1,
        parameter: 2,
        property: 3,
        keyword: 4,
        comment: 5,
        string: 6,
        number: 7,
        operator: 8,
        type: 9
    };
    
    // Token modifier indices
    const tokenModifiers = {
        declaration: 0,
        readonly: 1,
        defaultLibrary: 2
    };

    const symbols = documentSymbols.get(params.textDocument.uri) || { variables: new Map(), functions: new Map() };
    
    lines.forEach((line, lineIndex) => {
        // Skip if entire line is a comment
        if (line.trim().startsWith(';')) {
            builder.push(lineIndex, 0, line.length, tokenTypes.comment, 0);
            return;
        }
        
        // Find all words in the line
        const words = line.matchAll(/\b[\w-]+\??\b/g);
        
        for (const match of words) {
            const word = match[0];
            const col = match.index;
            
            // Skip if in comment or string
            if (isInComment(line, col) || isInString(line, col)) continue;
            
            let tokenType = null;
            let tokenMod = 0;
            
            // Check if it's a builtin function
            if (BUILTIN_NAMES.has(word)) {
                tokenType = tokenTypes.function;
                tokenMod = 1 << tokenModifiers.defaultLibrary | 1 << tokenModifiers.readonly;
            }
            // Check if it's a user-defined function
            else if (symbols.functions.has(word)) {
                tokenType = tokenTypes.function;
            }
            // Check if it's a user-defined variable
            else if (symbols.variables.has(word)) {
                tokenType = tokenTypes.variable;
            }
            // Check if it's a type
            else if (word.startsWith(':') || (col > 0 && line[col - 1] === ':')) {
                const typeName = word.startsWith(':') ? word.substring(1) : word;
                if (ARTURO_TYPES[typeName]) {
                    tokenType = tokenTypes.type;
                    tokenMod = 1 << tokenModifiers.readonly;
                }
            }
            // Check if it's an attribute
            else if (col > 0 && line[col - 1] === '.') {
                if (ATTRIBUTE_NAMES.has(word)) {
                    tokenType = tokenTypes.property;
                }
            }
            // Check for keywords
            else if (['if', 'loop', 'while', 'until', 'when', 'unless', 'switch', 'case', 'do', 'function', 'method', 'return', 'break', 'continue'].includes(word)) {
                tokenType = tokenTypes.keyword;
            }
            // Check for number literals
            else if (/^-?\d+(\.\d+)?$/.test(word)) {
                tokenType = tokenTypes.number;
            }
            
            if (tokenType !== null) {
                builder.push(lineIndex, col, word.length, tokenType, tokenMod);
            }
        }
    });
    
    return builder.build();
});

/**
 * Workspace Symbols - provides global symbol search
 */
connection.onWorkspaceSymbol((params) => {
    const query = params.query.toLowerCase();
    const symbols = [];
    
    // Search through all document symbols
    documentSymbols.forEach((docSymbols, uri) => {
        // Add matching functions
        docSymbols.functions.forEach((info, name) => {
            if (name.toLowerCase().includes(query)) {
                symbols.push({
                    name: name,
                    kind: SymbolKind.Function,
                    location: Location.create(
                        uri,
                        Range.create(info.line, info.column, info.line, info.column + name.length)
                    ),
                    containerName: uri.split('/').pop()
                });
            }
        });
        
        // Add matching variables
        docSymbols.variables.forEach((info, name) => {
            if (name.toLowerCase().includes(query)) {
                symbols.push({
                    name: name,
                    kind: SymbolKind.Variable,
                    location: Location.create(
                        uri,
                        Range.create(info.line, info.column, info.line, info.column + name.length)
                    ),
                    containerName: uri.split('/').pop()
                });
            }
        });
    });
    
    return symbols;
});

/**
 * Code Actions - provides quick fixes and refactorings
 */
connection.onCodeAction((params) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];

    const text = document.getText();
    const lines = text.split('\n');
    const codeActions = [];
    const diagnostics = params.context.diagnostics;

    // Process each diagnostic to provide quick fixes
    diagnostics.forEach(diagnostic => {
        const line = lines[diagnostic.range.start.line];
        const message = diagnostic.message;

        // Quick fix for undefined variables: Add type annotation
        if (message.includes('may be undefined')) {
            const match = message.match(/'([^']+)' may be undefined/);
            if (match) {
                const varName = match[1];
                const lineText = lines[diagnostic.range.start.line];
                
                // Check if this looks like it should be a variable assignment
                const assignmentPattern = new RegExp(`${varName}\s*:`);
                if (!assignmentPattern.test(lineText)) {
                    // Suggest defining the variable
                    const action = CodeAction.create(
                        `Define '${varName}' as a variable`,
                        {
                            changes: {
                                [params.textDocument.uri]: [
                                    TextEdit.insert(
                                        Position.create(diagnostic.range.start.line, 0),
                                        `${varName}: null\n`
                                    )
                                ]
                            }
                        },
                        CodeActionKind.QuickFix
                    );
                    action.diagnostics = [diagnostic];
                    codeActions.push(action);
                }
            }
        }

        // Quick fix for type errors: Convert to string
        if (message.includes('Cannot add') || message.includes('Cannot subtract') || 
            message.includes('Cannot multiply') || message.includes('Cannot divide')) {
            const action = CodeAction.create(
                'Convert operands to same type',
                {
                    changes: {
                        [params.textDocument.uri]: [
                            // This is a placeholder - in a real implementation,
                            // we would analyze the operation and suggest specific conversions
                            TextEdit.insert(
                                diagnostic.range.start,
                                '; TODO: Fix type mismatch - '
                            )
                        ]
                    }
                },
                CodeActionKind.QuickFix
            );
            action.diagnostics = [diagnostic];
            codeActions.push(action);
        }
    });

    // Refactoring: Extract to function (when text is selected)
    if (params.range && params.range.start.line !== params.range.end.line) {
        const startLine = params.range.start.line;
        const endLine = params.range.end.line;
        const selectedLines = lines.slice(startLine, endLine + 1);
        const selectedText = selectedLines.join('\n');
        
        if (selectedText.trim()) {
            const action = CodeAction.create(
                'Extract to function',
                {
                    changes: {
                        [params.textDocument.uri]: [
                            // Replace selected text with function call
                            TextEdit.replace(
                                Range.create(
                                    Position.create(startLine, 0),
                                    Position.create(endLine, lines[endLine].length)
                                ),
                                'extracted []'
                            ),
                            // Add function definition at start of file
                            TextEdit.insert(
                                Position.create(0, 0),
                                `extracted: function [] [\n    ${selectedText.split('\n').join('\n    ')}\n]\n\n`
                            )
                        ]
                    }
                },
                CodeActionKind.Refactor
            );
            codeActions.push(action);
        }
    }

    // Refactoring: Add type annotation to variable
    const lineIndex = params.range.start.line;
    const currentLine = lines[lineIndex];
    const assignmentMatch = currentLine.match(/(\w+)\s*:\s*([^;\n]+)/);
    
    if (assignmentMatch && !assignmentMatch[2].trim().startsWith(':')) {
        const varName = assignmentMatch[1];
        const value = assignmentMatch[2].trim();
        const inferredType = inferType(value);
        
        if (inferredType !== ':any') {
            const colonIndex = currentLine.indexOf(':');
            const action = CodeAction.create(
                `Add type annotation (${inferredType})`,
                {
                    changes: {
                        [params.textDocument.uri]: [
                            TextEdit.insert(
                                Position.create(lineIndex, colonIndex + 1),
                                ` ${inferredType}`
                            )
                        ]
                    }
                },
                CodeActionKind.Refactor
            );
            codeActions.push(action);
        }
    }

    return codeActions;
});

/**
 * Helper function: Get word at position
 */
function getWordAtPosition(line, character) {
    // Match word characters, including hyphens and optional '?'
    const beforeCursor = line.substring(0, character);
    const afterCursor = line.substring(character);

    const beforeMatch = beforeCursor.match(/[\w-]+$/);
    const afterMatch = afterCursor.match(/^[\w-]*/);

    // Handle case where cursor is at the start of a word
    if (!beforeMatch && afterMatch && afterMatch[0].length > 0) {
        const word = afterMatch[0];
        return { word, start: character, end: character + word.length };
    }

    if (!beforeMatch) return null;

    const word = beforeMatch[0] + (afterMatch ? afterMatch[0] : '');
    const start = character - beforeMatch[0].length;
    const end = start + word.length;

    return { word, start, end };
}

/**
 * Helper function: Check if position is in a string
 */
function isInString(line, position) {
    let inString = false;
    let stringChar = null;

    for (let i = 0; i < position; i++) {
        const char = line[i];
        const prevChar = i > 0 ? line[i - 1] : '';

        if (!inString) {
            if (char === '"' || char === '{' || char === '«') {
                inString = true;
                stringChar = char;
            }
        } else {
            if (stringChar === '"' && char === '"' && prevChar !== '\\') {
                inString = false;
                stringChar = null;
            } else if (stringChar === '{' && char === '}') {
                inString = false;
                stringChar = null;
            } else if (stringChar === '«' && char === '»') {
                inString = false;
                stringChar = null;
            }
        }
    }

    return inString;
}

/**
 * Helper function: Check if position is in a comment
 */
function isInComment(line, position) {
    const commentIndex = line.indexOf(';');
    if (commentIndex === -1) return false;
    
    // Check if the ; is inside a string before position
    if (!isInString(line, commentIndex)) {
        return position >= commentIndex;
    }
    
    return false;
}

/**
 * Helper function: Escape regex special characters
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Helper function: Validate identifier name
 */
function isValidIdentifier(name) {
    return /^[a-zA-Z_][\w-]*\??$/.test(name);
}

documents.listen(connection);
connection.listen();

module.exports = __webpack_exports__;
/******/ })()
;