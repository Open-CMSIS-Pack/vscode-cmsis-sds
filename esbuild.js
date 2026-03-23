const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionBuild = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'out/src/extension.js',
    external: [
        'vscode',
        // Native addons — cannot be bundled
        'serialport',
        'usb',
    ],
    format: 'cjs',
    platform: 'node',
    target: 'es2021',
    sourcemap: !production,
    minify: production,
    // Mangle private properties (prefixed with _) for extra obfuscation
    mangleProps: production ? /^_/ : undefined,
    treeShaking: true,
};

/** @type {import('esbuild').BuildOptions} */
const webviewBase = {
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    sourcemap: !production,
    minify: production,
    define: {
        'process.env.NODE_ENV': production ? '"production"' : '"development"',
    },
};

const webviewEntries = [
    { entryPoints: ['src/recorder/webview/recorderApp.tsx'], outfile: 'out/recorderWebview.js' },
    { entryPoints: ['src/viewer/webview/viewerApp.tsx'], outfile: 'out/viewerWebview.js' },
    { entryPoints: ['src/viewer/webview/mediaViewerApp.tsx'], outfile: 'out/mediaViewerWebview.js' },
];

async function buildOnce() {
    await esbuild.build(extensionBuild);
    await Promise.all(webviewEntries.map(cfg => esbuild.build({ ...webviewBase, ...cfg })));
    console.log(`✓ Bundled extension + webviews${production ? ' (minified)' : ''}`);
}

async function buildWatch() {
    const contexts = [];
    contexts.push(await esbuild.context(extensionBuild));
    for (const cfg of webviewEntries) {
        contexts.push(await esbuild.context({ ...webviewBase, ...cfg }));
    }
    await Promise.all(contexts.map(ctx => ctx.watch()));
    console.log('Watching for changes…');
}

async function main() {
    if (watch) {
        await buildWatch();
    } else {
        await buildOnce();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
