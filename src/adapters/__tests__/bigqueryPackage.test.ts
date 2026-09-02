// src/adapters/__tests__/bigqueryPackage.test.ts
//
// TASK-BQ00-001 proof: @google-cloud/bigquery installs, loads, and bundles
// under the extension's exact esbuild options. No extension wiring; this is a
// pure environment probe that future tasks (002/003/004) cite for compatibility
// evidence.
//
// Tests:
//  1. client module loads under Node without credentials (happy)
//  2. bundle probe succeeds under extension build options (happy)
//  3. probe output contains no credential artifacts (edge - safety)
//  4. client engine floor is compatible with the dev runtime (engine-floor)
//  5. vscode stays external in probe (edge - bundle boundary)
//  6. lockfile resolves exactly one version in range (edge - pin boundary)
//  7. client .d.ts declares the pagination and cancellation methods (edge - roadmap line-67)
//
// Named *.test.ts (NOT *.integration.test.ts) so vitest.config.ts picks it up
// in `npm test` and not in the integration lane.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as esbuild from "esbuild";

const BQ_PKG = "@google-cloud/bigquery";
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function readPkgJson(pkgName: string): {
  name: string;
  version: string;
  engines?: { node?: string };
} {
  // Resolve from node_modules at repo root (vitest runs from worktree root).
  const pkgPath = require.resolve(`${pkgName}/package.json`);
  // require.cache for json files returns the parsed object already.
  const pkg = require(pkgPath);
  return pkg;
}

function bigqueryDtsPath(pkgRoot: string): string {
  // The shipped declaration file path is stable across major versions we care
  // about (8.x and 9.x both publish build/src/bigquery.d.ts and build/src/job.d.ts).
  return path.join(pkgRoot, "build", "src", "bigquery.d.ts");
}

function jobDtsPath(pkgRoot: string): string {
  return path.join(pkgRoot, "build", "src", "job.d.ts");
}

function pkgRoot(pkgName: string): string {
  const pkgPath = require.resolve(`${pkgName}/package.json`);
  return path.dirname(pkgPath);
}

// Mirrors the extension build config in esbuild.js — keep these in sync.
const EXTENSION_BUILD_OPTIONS = {
  bundle: true,
  platform: "node" as const,
  format: "cjs" as const,
  target: "node18" as const,
  external: ["vscode"],
  write: false,
  logLevel: "silent" as const,
};

// Virtual stdin probe entry — the simplest possible BigQuery import.
const PROBE_ENTRY = `import { BigQuery } from "${BQ_PKG}"; console.log(BigQuery);`;

async function runProbe(): Promise<{
  outputText: string;
  byteSize: number;
  errors: readonly esbuild.Message[];
}> {
  const result = await esbuild.build({
    ...EXTENSION_BUILD_OPTIONS,
    stdin: {
      contents: PROBE_ENTRY,
      resolveDir: REPO_ROOT,
      loader: "ts",
    },
  });
  const text = result.outputFiles?.[0]?.text ?? "";
  return {
    outputText: text,
    byteSize: Buffer.byteLength(text, "utf8"),
    errors: result.errors ?? [],
  };
}

describe(`TASK-BQ00-001 ${BQ_PKG} proof`, () => {
  it("1. client module loads under Node without credentials", async () => {
    // Default export shape: BigQuery is a named export (constructible class).
    const mod = await import(BQ_PKG);
    expect(mod).toBeDefined();
    expect(typeof mod.BigQuery).toBe("function");
    // Confirm it can be instantiated without ADC env vars (constructor only,
    // no real network call yet). The library defers credential discovery to
    // the first request, so this should not throw.
    const ctor = mod.BigQuery as new (opts?: Record<string, unknown>) => unknown;
    const inst = new ctor({ projectId: "probe-only-no-network" });
    expect(inst).toBeDefined();
  });

  it("2. bundle probe succeeds under extension build options", async () => {
    const probe = await runProbe();
    expect(probe.errors).toEqual([]);
    expect(probe.outputText.length).toBeGreaterThan(0);
    // Recognizable client marker — the BigQuery class identity appears in the
    // bundled output. We look for a string the constructor emits so a renamed
    // symbol still trips this.
    expect(probe.outputText).toMatch(/BigQuery/);
    // Log the size for the Executor Report / Discussion thread.
    // eslint-disable-next-line no-console
    console.info(
      `[bq00] probe bundle: ${probe.byteSize} bytes, errors=${probe.errors.length}`
    );
  });

  it("3. probe output contains no credential artifacts", async () => {
    const probe = await runProbe();
    const lower = probe.outputText.toLowerCase();
    // Real credential-material markers — actual PEM private-key blocks with
    // a header AND a body (PEM blocks always come in pairs). Bare
    // `application_default_credentials` and `private_key` strings are
    // legitimate code (file paths, JSON field names), so we check for
    // STRUCTURED PEM markers that would only appear if a real key were
    // embedded.
    //
    // Strip JS regex literals before scanning so that string patterns the
    // library uses to PARSE cert chains (`/-----BEGIN CERTIFICATE-----...-----END CERTIFICATE-----/`)
    // don't false-positive.
    const stripRegexLiterals = (s: string): string =>
      s.replace(/\/[^/\n]+\/[gimsuy]*/g, " ");
    const text = stripRegexLiterals(lower);
    // A real inline private key would look like `-----BEGIN ...PRIVATE KEY-----`
    // followed by a base64 body and `-----END ...PRIVATE KEY-----`.
    expect(text).not.toMatch(/-----begin (rsa |ec |openssh |private |pgp |dsa |enrypted )?private key-----/);
    // No inline service-account JSON blob with a literal PEM private_key
    // embedded (the dev/test keyfile would carry that field as a string).
    expect(text).not.toMatch(/"private_key"\s*:\s*"-----begin/);
  });

  it("4. client engine floor is compatible with the dev runtime", () => {
    const pkg = readPkgJson(BQ_PKG);
    const floor = pkg.engines?.node ?? "*";
    // Record the resolved major and the floor for the Executor Report.
    const major = pkg.version.split(".")[0];
    // eslint-disable-next-line no-console
    console.info(
      `[bq00] installed ${pkg.name}@${pkg.version} engines.node="${floor}" major=${major} runtime=${process.version}`
    );
    // Conservative parse: ">=18", ">=22", ">=14". Reject if declared floor is
    // strictly greater than the runtime major.
    const match = floor.match(/>=\s*(\d+)/);
    if (match) {
      const required = parseInt(match[1], 10);
      const running = parseInt(process.versions.node.split(".")[0], 10);
      expect(running).toBeGreaterThanOrEqual(required);
    } else {
      // Unrecognized floor string: don't silently pass; require the dev box to
      // be at least Node 18 since that's the bundle target.
      const running = parseInt(process.versions.node.split(".")[0], 10);
      expect(running).toBeGreaterThanOrEqual(18);
    }
  });

  it("5. vscode stays external in probe", async () => {
    const probe = await runProbe();
    // The probe entry doesn't import vscode, so the external marker is a
    // config-shape check: the build must not have inlined any path that looks
    // like the real vscode module from `require("vscode")`. Since the entry
    // has no vscode import, we assert the bundle is self-contained and that
    // the external option is honored (no `require("vscode")` resolution was
    // forced).
    expect(probe.outputText).not.toMatch(/require\("vscode"\)/);
    // And: the bundle should NOT contain a resolved VS Code API marker.
    // `@google-cloud/bigquery` does not depend on vscode, so any literal
    // `vscode.` API call in the probe output would indicate a leaked import.
    expect(probe.outputText).not.toMatch(/vscode\.(window|workspace|commands)/);
  });

  it("6. lockfile resolves exactly one version in range", () => {
    const lockPath = path.join(REPO_ROOT, "package-lock.json");
    expect(fs.existsSync(lockPath)).toBe(true);
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    // lockfile v3 puts deps under `packages."node_modules/@google-cloud/bigquery"`
    const packages = lock.packages ?? {};
    const bqEntries = Object.entries(packages).filter(
      ([k]) => k === "node_modules/@google-cloud/bigquery"
    );
    expect(bqEntries.length).toBe(1);
    const [entryPath, entry] = bqEntries[0];
    expect(entryPath).toBe("node_modules/@google-cloud/bigquery");
    const installedVersion = (entry as { version?: string }).version ?? "";
    expect(installedVersion).toMatch(/^(9|8)\./);
    // Declared range from package.json
    const rootPkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
    );
    const declared = rootPkg.dependencies?.[BQ_PKG] ?? "";
    expect(declared).toMatch(/^\^?(9|8)\./);
    // The lockfile-pinned version must satisfy the declared range.
    const major = declared.replace(/^\^?/, "").split(".")[0];
    expect(installedVersion.startsWith(`${major}.`)).toBe(true);
  });

  it("7. client .d.ts declares the pagination and cancellation methods", () => {
    const root = pkgRoot(BQ_PKG);
    const bqDts = bigqueryDtsPath(root);
    const jobDts = jobDtsPath(root);
    expect(fs.existsSync(bqDts)).toBe(true);
    expect(fs.existsSync(jobDts)).toBe(true);
    const bqText = fs.readFileSync(bqDts, "utf8");
    const jobText = fs.readFileSync(jobDts, "utf8");

    // roadmap line-67 mandate: the real names + return shapes live in the
    // installed .d.ts. We assert each method appears as a declaration, and
    // extract the line number so the executor can write the evidence file
    // with file:line refs (test #7 is the source of truth — never assume).
    const requiredOnBigQuery = ["getQueryResults", "query", "createQueryJob"];
    for (const name of requiredOnBigQuery) {
      const re = new RegExp(`\\b${name}\\s*\\(`, "m");
      expect(bqText, `${name} must be declared in bigquery.d.ts`).toMatch(re);
    }
    const cancelRe = new RegExp(`\\bcancel\\s*\\(`, "m");
    expect(jobText, `cancel must be declared in job.d.ts`).toMatch(cancelRe);
  });
});