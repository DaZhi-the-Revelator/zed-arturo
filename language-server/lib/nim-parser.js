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

'use strict';

const https = require('https');

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
function parseNimFile(source, moduleName) {
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

            // ── description ─────────────────────────────────────────────
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
        }

        // Returns
        const returns = rawReturns ? parseTypeSet(rawReturns) : ':any';

        // Skip if we got no description (probably a malformed/internal entry)
        if (!description) {
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
            const funcs  = parseNimFile(source, moduleName);

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
function parseNimSource(source, moduleName = 'unknown') {
    const funcs = parseNimFile(source, moduleName);
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
