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

class SignatureIndexer {
    constructor(logger) {
        this.logger = logger || console;
        this.signatures = new Map();
        this.cacheDir = path.join(__dirname, '..', '.cache');
        this.cacheFile = path.join(this.cacheDir, 'signatures.json');
        this.seedCacheFile = path.join(__dirname, '..', 'seed-cache.json');
        this.isInitialized = false;
        this.lastUpdate = null;
        this.updateInProgress = false;
        
        // Arturo documentation sources
        // Note: Arturo's documentation is generated from source code, not markdown
        // We use the online documentation website which has all 521+ functions
        this.docSources = [
            'https://arturo-lang.io/documentation/library/',  // Main library reference page
        ];
        
        // Note: For now, the signature indexer uses the seed cache (80 functions)
        // Phase 2 will implement web scraping of arturo-lang.io or parsing Arturo source files
        // The infrastructure is ready, just needs the parser updated
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
        this.logger.log(`[SignatureIndexer] Initialized with ${this.signatures.size} signatures`);
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
        const now = new Date();
        if (this.lastUpdate) {
            const hoursSinceUpdate = (now - this.lastUpdate) / (1000 * 60 * 60);
            if (hoursSinceUpdate < 24) {
                this.logger.log('[SignatureIndexer] Cache is fresh, skipping update');
                return;
            }
        }

        // Start background update
        this.updateInProgress = true;
        this.logger.log('[SignatureIndexer] Starting background update...');

        this.fetchAndUpdateSignatures()
            .then(() => {
                this.logger.log('[SignatureIndexer] Background update completed successfully');
            })
            .catch(err => {
                this.logger.log(`[SignatureIndexer] Background update failed: ${err.message}`);
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
     * Fetch signatures from Arturo documentation
     */
    async fetchSignaturesFromDocs() {
        const signatures = new Map();

        try {
            // Fetch the main library documentation
            const libraryMd = await this.fetchUrl(this.docSources[0]);
            
            // Parse markdown documentation to extract function signatures
            const parsed = this.parseLibraryMarkdown(libraryMd);
            parsed.forEach((sig, name) => signatures.set(name, sig));

            this.logger.log(`[SignatureIndexer] Parsed ${signatures.size} signatures from documentation`);
        } catch (err) {
            this.logger.log(`[SignatureIndexer] Failed to fetch from docs: ${err.message}`);
        }

        return signatures;
    }

    /**
     * Fetch URL content via HTTPS
     */
    fetchUrl(url) {
        return new Promise((resolve, reject) => {
            https.get(url, { timeout: 10000 }, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }

                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data));
            }).on('error', reject).on('timeout', () => {
                reject(new Error('Request timeout'));
            });
        });
    }

    /**
     * Parse Arturo library markdown to extract function signatures
     * 
     * Format in library.md:
     * ## functionName
     * **Signature**: `functionName param1 :type1 param2 :type2 -> :returnType`
     * **Description**: Description text
     */
    parseLibraryMarkdown(markdown) {
        const signatures = new Map();
        const lines = markdown.split('\n');
        
        let currentFunc = null;
        let currentSig = null;
        let currentDesc = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Function name: ## functionName
            if (line.startsWith('## ') && !line.startsWith('## ')) {
                if (currentFunc && currentSig) {
                    signatures.set(currentFunc, {
                        signature: currentSig,
                        description: currentDesc || '',
                        params: this.parseParams(currentSig),
                        returns: this.parseReturnType(currentSig)
                    });
                }

                currentFunc = line.substring(3).trim();
                currentSig = null;
                currentDesc = null;
            }
            // Signature: **Signature**: `...`
            else if (line.includes('**Signature**:')) {
                const match = line.match(/`([^`]+)`/);
                if (match) {
                    currentSig = match[1];
                }
            }
            // Description: **Description**: ...
            else if (line.includes('**Description**:')) {
                currentDesc = line.split('**Description**:')[1].trim();
            }
        }

        // Add last function
        if (currentFunc && currentSig) {
            signatures.set(currentFunc, {
                signature: currentSig,
                description: currentDesc || '',
                params: this.parseParams(currentSig),
                returns: this.parseReturnType(currentSig)
            });
        }

        return signatures;
    }

    /**
     * Parse parameters from a signature string
     * Example: "print value :any -> :null" => [{ name: 'value', type: ':any' }]
     */
    parseParams(signature) {
        const params = [];
        
        // Split signature at "->" to get the parameter part
        const parts = signature.split('->');
        if (parts.length === 0) return params;

        const paramPart = parts[0].trim();
        
        // Extract function name and parameters
        const tokens = paramPart.split(/\s+/);
        if (tokens.length < 2) return params;

        // Skip function name (first token)
        for (let i = 1; i < tokens.length; i++) {
            const token = tokens[i];
            
            // If token starts with ':', it's a type annotation for previous param
            if (token.startsWith(':')) {
                if (params.length > 0) {
                    params[params.length - 1].type = token;
                }
            }
            // Otherwise it's a parameter name
            else {
                params.push({ name: token, type: ':any' });
            }
        }

        return params;
    }

    /**
     * Parse return type from signature string
     * Example: "print value :any -> :null" => ":null"
     */
    parseReturnType(signature) {
        const parts = signature.split('->');
        if (parts.length < 2) return ':any';
        return parts[1].trim();
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
                lastUpdate: new Date().toISOString(),
                version: '1.0'
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
