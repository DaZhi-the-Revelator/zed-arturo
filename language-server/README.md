# Arturo Language Server

This directory contains the Language Server Protocol (LSP) implementation for Arturo.

## Features

- **Type Checking**: Validates type annotations and checks for type compatibility
- **Go-to-Definition**: Navigate to variable and function definitions
- **Hover Information**: Display type information and documentation for symbols
- **Code Completion**: Autocomplete for built-in functions, types, and user-defined symbols
- **Diagnostics**: Real-time error and warning messages

## Installation

The language server is automatically bundled with the Zed extension. To install dependencies manually:

```bash
cd language-server
npm install
```

## Usage

The language server is automatically started by Zed when you open an Arturo file (`.art`).

## Development

To test the language server standalone:

```bash
node server.js --stdio
```

## Type System

The language server understands Arturo's type system including:
- Primitives: `:null`, `:logical`, `:integer`, `:floating`, `:char`, `:string`
- Collections: `:block`, `:dictionary`, `:range`
- Functions: `:function`, `:method`
- Advanced: `:complex`, `:rational`, `:quantity`, `:color`, `:date`
- And many more...
