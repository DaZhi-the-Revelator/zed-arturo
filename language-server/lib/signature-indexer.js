/**
 * Signature Indexer for Arturo LSP
 * 
 * Implements dynamic signature generation with:
 * - Standard library indexing via tree-sitter parsing
 * - Stale-While-Revalidate caching pattern
 * - Offline-first design with seed cache
 * - Automatic background updates
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { parseLibraryFromGitHub } = require('./nim-parser');
const WorkspaceIndexer = require('./workspace-indexer');

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
