// esbuild.js — VSDB extension + webview bundler.
// TASK-001 scaffold: builds two entries (extension host + webview).
// TASK-006 also copies webview/styles.css → dist/webview.css.
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

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


function copyWebviewCss() {
  const src = path.join(__dirname, "webview", "styles.css");
  const dst = path.join(__dirname, "dist", "webview.css");
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`esbuild: copied ${path.relative(__dirname, src)} → ${path.relative(__dirname, dst)}`);
}

async function run() {
  copyWebviewCss();
  if (watch) {
    const ctx1 = await esbuild.context(extensionConfig);
    const ctx2 = await esbuild.context(webviewConfig);
    const ctx3 = await esbuild.context(connectionFormConfig);
    await Promise.all([ctx1.watch(), ctx2.watch(), ctx3.watch()]);
    console.log("esbuild: watching...");
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
      esbuild.build(connectionFormConfig),
    ]);
    console.log("esbuild: build complete");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
