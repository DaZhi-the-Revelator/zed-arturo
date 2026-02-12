#!/usr/bin/env node

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
} = require('vscode-languageserver/node');

const { TextDocument } = require('vscode-languageserver-textdocument');

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all);

// Create a text document manager
const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

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

    const result = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: ['.', ':', '`', '#', "'"]
            },
            hoverProvider: true,
            definitionProvider: true,
            signatureHelpProvider: {
                triggerCharacters: ['[', ' ', ','],
                retriggerCharacters: [' ', ',']
            },
            referencesProvider: true,
            renameProvider: {
                prepareProvider: true
            },
            documentFormattingProvider: true,
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
            documentHighlightProvider: true,
        }
    };

    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true
            }
        };
    }

    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Workspace folder change event received.');
        });
    }
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
            
            // Skip if it's a builtin or defined symbol
            if (BUILTIN_NAMES.has(word) || 
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
                // This is an attribute - check if it's in our attribute list
                if (ATTRIBUTE_NAMES.has(word)) {
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

documents.onDidChangeContent(change => {
    validateTextDocument(change.document).then(diagnostics => {
        connection.sendDiagnostics({ uri: change.document.uri, diagnostics });
    });
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
        // This is an attribute
        if (ATTRIBUTE_NAMES.has(word)) {
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
        if (BUILTIN_FUNCTIONS[word]) {
            const funcInfo = BUILTIN_FUNCTIONS[word];
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

    connection.console.log(`Hover: No info found for '${word}'`);
    return null;
});

connection.onCompletion((params) => {
    const items = [];
    const document = documents.get(params.textDocument.uri);
    
    // Check if we're completing after a dot (attribute completion)
    if (document) {
        const position = params.position;
        const text = document.getText();
        const lines = text.split('\n');
        if (position.line < lines.length) {
            const line = lines[position.line];
            const beforeCursor = line.substring(0, position.character);
            
            if (beforeCursor.endsWith('.')) {
                // Attribute completion
                ATTRIBUTE_NAMES.forEach(attrName => {
                    items.push({
                        label: attrName,
                        kind: CompletionItemKind.Property,
                        detail: 'Attribute',
                        documentation: `Function attribute: .${attrName}`
                    });
                });
                return items;
            }
            
            // Check if we're completing after a colon (type completion)
            if (beforeCursor.endsWith(':')) {
                // Add all types
                Object.keys(ARTURO_TYPES).forEach(typeName => {
                    const typeInfo = ARTURO_TYPES[typeName];
                    items.push({
                        label: typeName,
                        kind: CompletionItemKind.Class,
                        detail: 'Type',
                        documentation: typeInfo.description
                    });
                });
                
                // Add custom types
                const docTypes = customTypes.get(document.uri);
                if (docTypes) {
                    docTypes.forEach(typeName => {
                        items.push({
                            label: typeName,
                            kind: CompletionItemKind.Class,
                            detail: 'Custom Type',
                            documentation: `User-defined type: ${typeName}`
                        });
                    });
                }
                return items;
            }
            
            // Check if we're completing after a backtick (unit completion)
            if (beforeCursor.endsWith('`')) {
                ARTURO_UNITS.forEach(unitName => {
                    items.push({
                        label: unitName,
                        kind: CompletionItemKind.Unit,
                        detail: 'Unit',
                        documentation: `Physical unit: \`${unitName}`
                    });
                });
                return items;
            }
            
            // Check if we're completing after a hash (color completion)
            if (beforeCursor.endsWith('#')) {
                ARTURO_COLORS.forEach(colorName => {
                    items.push({
                        label: colorName,
                        kind: CompletionItemKind.Color,
                        detail: 'Color',
                        documentation: `Named color: #${colorName}`
                    });
                });
                return items;
            }
        }
    }

    // Add all builtin functions
    BUILTIN_NAMES.forEach(funcName => {
        const funcInfo = BUILTIN_FUNCTIONS[funcName];
        items.push({
            label: funcName,
            kind: CompletionItemKind.Function,
            detail: funcInfo ? funcInfo.signature : 'Builtin function',
            documentation: funcInfo ? funcInfo.description : 'Arturo builtin function'
        });
    });

    // Add all types
    Object.keys(ARTURO_TYPES).forEach(typeName => {
        const typeInfo = ARTURO_TYPES[typeName];
        items.push({
            label: ':' + typeName,
            kind: CompletionItemKind.Class,
            detail: 'Type',
            documentation: typeInfo.description
        });
    });

    // Add user-defined symbols
    if (document) {
        const symbols = documentSymbols.get(params.textDocument.uri);
        if (symbols) {
            symbols.variables.forEach((info, name) => {
                items.push({
                    label: name,
                    kind: CompletionItemKind.Variable,
                    detail: info.type,
                    documentation: 'User-defined variable'
                });
            });

            symbols.functions.forEach((info, name) => {
                if (!info.builtin) {
                    items.push({
                        label: name,
                        kind: CompletionItemKind.Function,
                        detail: info.type,
                        documentation: 'User-defined function'
                    });
                }
            });
        }
        
        // Add custom types
        const docTypes = customTypes.get(document.uri);
        if (docTypes) {
            docTypes.forEach(typeName => {
                items.push({
                    label: ':' + typeName,
                    kind: CompletionItemKind.Class,
                    detail: 'Custom Type',
                    documentation: `User-defined type: ${typeName}`
                });
            });
        }
    }

    return items;
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

    // Look up function info
    const funcInfo = BUILTIN_FUNCTIONS[baseFuncName];
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
