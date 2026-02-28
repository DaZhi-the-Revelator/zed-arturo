'use strict';

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
