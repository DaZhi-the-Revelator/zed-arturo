'use strict';

const path = require('path');

module.exports = {
    target: 'node',
    mode: 'production',

    entry: './server.js',

    output: {
        path: path.resolve(__dirname, '..'),
        filename: 'bundle.js',
        libraryTarget: 'commonjs2',
    },

    // Don't bundle these — they are provided by the Node.js runtime itself
    externals: {
        // Node built-ins
        fs:     'commonjs fs',
        path:   'commonjs path',
        os:     'commonjs os',
        child_process: 'commonjs child_process',
        crypto: 'commonjs crypto',
        http:   'commonjs http',
        https:  'commonjs https',
        net:    'commonjs net',
        stream: 'commonjs stream',
        url:    'commonjs url',
        util:   'commonjs util',
        events: 'commonjs events',
        buffer: 'commonjs buffer',
        assert: 'commonjs assert',
        zlib:   'commonjs zlib',
    },

    resolve: {
        extensions: ['.js', '.json'],
    },

    optimization: {
        minimize: false,   // keep readable for debugging; set true for release
    },

    // Suppress the "critical dependency" warning from vscode-languageserver
    // which does a dynamic require for its protocol modules
    module: {
        rules: [
            {
                test: /\.js$/,
                parser: { amd: false },
            },
        ],
    },
};
