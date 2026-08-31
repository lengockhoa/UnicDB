// esbuild.js — VSDB extension + webview bundler.
// TASK-001 scaffold: builds two entries (extension host + webview).
// TASK-203: CSS for the webview is now bundled via esbuild's CSS import
// resolution from webview/main.ts (see ag-grid-community/styles/* and
// ./styles.css imports). dist/webview.css is the bundled output, not a copy.
// TASK-004: added newTableFormConfig (DataGrip-style designer dialog).
// TASK-003 (AI Chat panel): added aiChatPanelConfig.
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
/** @type {import('esbuild').BuildOptions} */
const aiSettingsFormConfig = {
  entryPoints: ["webview/aiSettingsFormMain.ts"],
  outfile: "dist/aiSettingsForm.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: !minify,
  minify,
  logLevel: "info",
};
/** @type {import('esbuild').BuildOptions} */
const renameFormConfig = {
  entryPoints: ["webview/renameFormMain.ts"],
  outfile: "dist/renameForm.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: !minify,
  minify,
  logLevel: "info",
};
/** @type {import('esbuild').BuildOptions} */
const aiChatPanelConfig = {
  entryPoints: ["webview/aiChatPanelMain.ts"],
  outfile: "dist/aiChatPanel.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: !minify,
  minify,
  logLevel: "info",
};
/** @type {import('esbuild').BuildOptions} */
const schemaFormConfig = {
  entryPoints: ["webview/schemaFormMain.ts"],
  outfile: "dist/schemaForm.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: !minify,
  minify,
  logLevel: "info",
};
/** TASK-002 (SQL Console): DataGrip-style console browser entry. */
/** @type {import('esbuild').BuildOptions} */
const consolePanelConfig = {
  entryPoints: ["webview/consolePanelMain.ts"],
  outfile: "dist/consolePanel.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: !minify,
  minify,
  logLevel: "info",
};
/** TASK-DBX03-004 (Schema & Data Compare): preview panel entry. */
/** @type {import('esbuild').BuildOptions} */
const comparePanelConfig = {
  entryPoints: ["webview/comparePanelMain.ts"],
  outfile: "dist/comparePanel.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: !minify,
  minify,
  logLevel: "info",
};
/** TASK-DBX04-003 (Relationship Explorer): diagram panel entry. */
/** @type {import('esbuild').BuildOptions} */
const erPanelConfig = {
  entryPoints: ["webview/erPanelMain.ts"],
  outfile: "dist/erPanel.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: !minify,
  minify,
  logLevel: "info",
}
async function run() {
  if (watch) {
    const ctx1 = await esbuild.context(extensionConfig);
    const ctx2 = await esbuild.context(webviewConfig);
    const ctx3 = await esbuild.context(connectionFormConfig);
    const ctx4 = await esbuild.context(newTableFormConfig);
    const ctx5 = await esbuild.context(aiSettingsFormConfig);
    const ctx6 = await esbuild.context(aiChatPanelConfig);
    const ctx7 = await esbuild.context(schemaFormConfig);
    const ctx8 = await esbuild.context(consolePanelConfig);
    const ctx9 = await esbuild.context(comparePanelConfig);
    const ctx10 = await esbuild.context(erPanelConfig);
    const ctxRename = await esbuild.context(renameFormConfig);
    await Promise.all([ctx1.watch(), ctx2.watch(), ctx3.watch(), ctx4.watch(), ctx5.watch(), ctx6.watch(), ctx7.watch(), ctx8.watch(), ctx9.watch(), ctx10.watch(), ctxRename.watch()]);
    console.log("esbuild: watching...");
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
      esbuild.build(connectionFormConfig),
      esbuild.build(newTableFormConfig),
      esbuild.build(aiSettingsFormConfig),
      esbuild.build(aiChatPanelConfig),
      esbuild.build(schemaFormConfig),
      // TASK-AIX07-003: consolePanel was wired for watch mode (ctx8) but
      // omitted from this non-watch build array, so `npm run compile`
      // never emitted dist/consolePanel.js and consolePanelBundle.test.ts
      // failed on every fresh clone/worktree. Align build with watch.
      esbuild.build(consolePanelConfig),
      esbuild.build(comparePanelConfig),
      esbuild.build(erPanelConfig),
      esbuild.build(renameFormConfig),
    ]);
    console.log("esbuild: build complete");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
