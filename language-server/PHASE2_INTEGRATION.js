// Phase 2 implementation notes for integrating SignatureIndexer with handlers
// 
// This file documents where to make changes in server.js to complete Phase 2
// The changes are minimal and straightforward:

/**
 * Helper function to get function signature info
 * Uses signature indexer first, falls back to BUILTIN_FUNCTIONS
 */
function getFunctionInfo(functionName) {
    // Try signature indexer first
    const indexedSig = signatureIndexer.getSignature(functionName);
    if (indexedSig) {
        return indexedSig;
    }
    
    // Fall back to BUILTIN_FUNCTIONS
    return BUILTIN_FUNCTIONS[functionName] || null;
}

// CHANGES NEEDED:
// 
// 1. Add helper function above after BUILTIN_FUNCTIONS definition
//
// 2. In connection.onHover() handler:
//    FIND: const funcInfo = BUILTIN_FUNCTIONS[baseFuncName];
//    REPLACE: const funcInfo = getFunctionInfo(baseFuncName);
//
// 3. In connection.onSignatureHelp() handler:
//    FIND: const funcInfo = BUILTIN_FUNCTIONS[baseFuncName];
//    REPLACE: const funcInfo = getFunctionInfo(baseFuncName);
//
// 4. In connection.onCompletion() handler:
//    FIND: BUILTIN_NAMES.forEach(funcName => {
//          const funcInfo = BUILTIN_FUNCTIONS[funcName];
//    REPLACE: 
//          // Add all indexed functions first
//          signatureIndexer.getAllFunctionNames().forEach(funcName => {
//              const funcInfo = signatureIndexer.getSignature(funcName);
//              items.push({
//                  label: funcName,
//                  kind: CompletionItemKind.Function,
//                  detail: funcInfo ? funcInfo.signature : 'Builtin function',
//                  documentation: funcInfo ? funcInfo.description : 'Arturo builtin function'
//              });
//          });
//          
//          // Also add any from BUILTIN_NAMES not already added
//          BUILTIN_NAMES.forEach(funcName => {
//              if (!signatureIndexer.hasFunction(funcName)) {
//                  const funcInfo = BUILTIN_FUNCTIONS[funcName];
//                  items.push({
//                      label: funcName,
//                      kind: CompletionItemKind.Function,
//                      detail: funcInfo ? funcInfo.signature : 'Builtin function',
//                      documentation: funcInfo ? funcInfo.description : 'Arturo builtin function'
//                  });
//              }
//          });

// That's it! These 3 small changes will make the handlers use the indexer.
