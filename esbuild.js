// esbuild.js — VSDB extension + webview bundler.
// TASK-001 scaffold: builds two entries (extension host + webview).
// TASK-203: CSS for the webview is now bundled via esbuild's CSS import
// resolution from webview/main.ts (see ag-grid-community/styles/* and
// ./styles.css imports). dist/webview.css is the bundled output, not a copy.
// TASK-004: added newTableFormConfig (DataGrip-style designer dialog).
const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");
const minify = process.argv.includes("--minify") || process.env.NODE_ENV === "production";

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: !minify,
  minify,
  logLevel: "info",
};
/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ["webview/main.ts"],
  outfile: "dist/webview.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: !minify,
  minify,
  logLevel: "info",
};
/** @type {import('esbuild').BuildOptions} */
const connectionFormConfig = {
  entryPoints: ["webview/connectionFormMain.ts"],
  outfile: "dist/connectionForm.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: !minify,
  minify,
  logLevel: "info",
};
/** @type {import('esbuild').BuildOptions} */
const newTableFormConfig = {
  entryPoints: ["webview/newTableFormMain.ts"],
  outfile: "dist/newTableForm.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: !minify,
  minify,
  logLevel: "info",
};

async function run() {
  if (watch) {
    const ctx1 = await esbuild.context(extensionConfig);
    const ctx2 = await esbuild.context(webviewConfig);
    const ctx3 = await esbuild.context(connectionFormConfig);
    const ctx4 = await esbuild.context(newTableFormConfig);
    await Promise.all([ctx1.watch(), ctx2.watch(), ctx3.watch(), ctx4.watch()]);
    console.log("esbuild: watching...");
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
      esbuild.build(connectionFormConfig),
      esbuild.build(newTableFormConfig),
    ]);
    console.log("esbuild: build complete");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
