// src/adapters/__tests__/gitDiff.test.ts
//
// TASK-GC-002 — gitDiff adapter (vscode.git extension API).
//
// Tests #1-#6 from the task. Fakes implement `GitRepositoryLike` structurally;
// the `vscode` mock is only required for the `getGitApi()` cases (#6).
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// vscode is only used by `getGitApi` inside `gitDiff.ts`; mock the whole module
// here so the suite can load in node. Each getGitApi test rewrites the mock
// via the `vscode` object re-exported below.
vi.mock("vscode", () => ({
  extensions: {
    getExtension: vi.fn(),
  },
}));
import * as vscode from "vscode";
import {
  GIT_DIFF_MAX_BYTES,
  collectCommitDiff,
  getGitApi,
  pickRepository,
  type GitApiLike,
  type GitRepositoryLike,
} from "../gitDiff";

beforeEach(() => {
  (vscode.extensions.getExtension as unknown as Mock).mockReset();
});

// ---------------------------------------------------------------------------
// Fakes — minimal `GitRepositoryLike` shapes
// ---------------------------------------------------------------------------

function makeRepo(overrides: {
  rootFsPath?: string;
  staged?: string;
  unstaged?: string;
  headName?: string;
  indexChanges?: { uri: { fsPath: string } }[];
  workingTreeChanges?: { uri: { fsPath: string } }[];
  mergeChanges?: { uri: { fsPath: string } }[];
}): GitRepositoryLike {
  const root = overrides.rootFsPath ?? "/repo/UnicDB";
  const staged = overrides.staged;
  const unstaged = overrides.unstaged;
  return {
    rootUri: { fsPath: root },
    diff: ((cached?: boolean) => {
      if (cached) return Promise.resolve(staged ?? "");
      return Promise.resolve(unstaged ?? "");
    }) as GitRepositoryLike["diff"],
    state: {
      HEAD: overrides.headName !== undefined ? { name: overrides.headName } : undefined,
      indexChanges: overrides.indexChanges ?? [],
      workingTreeChanges: overrides.workingTreeChanges ?? [],
      mergeChanges: overrides.mergeChanges ?? [],
    },
    inputBox: { value: "" },
  };
}

// ===========================================================================
// #1 — staged diff preferred
// ===========================================================================
describe("gitDiff — collectCommitDiff: staged preferred", () => {
  it("returns staged text, deduped files, repoName, branch", async () => {
    const repo = makeRepo({
      rootFsPath: "/home/dev/UnicDB",
      staged: "diff --git a/src/a.ts\n+staged line\n",
      unstaged: "diff --git a/src/b.ts\n+unstaged line\n",
      headName: "main",
      indexChanges: [
        { uri: { fsPath: "/home/dev/UnicDB/src/a.ts" } },
        { uri: { fsPath: "/home/dev/UnicDB/src/shared.ts" } },
      ],
      workingTreeChanges: [
        { uri: { fsPath: "/home/dev/UnicDB/src/shared.ts" } }, // dup
        { uri: { fsPath: "/home/dev/UnicDB/src/b.ts" } },
      ],
    });
    const result = await collectCommitDiff(repo);
    expect(result).not.toBeNull();
    expect(result!.repoName).toBe("UnicDB");
    expect(result!.branch).toBe("main");
    expect(result!.diffText).toBe("diff --git a/src/a.ts\n+staged line\n");
    // deduped repo-relative
    expect(result!.files.sort()).toEqual(["src/a.ts", "src/b.ts", "src/shared.ts"]);
  });
});

// ===========================================================================
// #2 — nothing to commit → null
// ===========================================================================
describe("gitDiff — collectCommitDiff: empty diff", () => {
  it("returns null when both staged and unstaged are whitespace-only", async () => {
    const repo = makeRepo({
      staged: "   \n  ",
      unstaged: "   \n  ",
    });
    const result = await collectCommitDiff(repo);
    expect(result).toBeNull();
  });
});

// ===========================================================================
// #3 — fallback to unstaged when staged empty
// ===========================================================================
describe("gitDiff — collectCommitDiff: fall back to unstaged", () => {
  it("uses unstaged when staged trims empty", async () => {
    const repo = makeRepo({
      staged: "",
      unstaged: "diff --git a/x.ts\n+line\n",
    });
    const result = await collectCommitDiff(repo);
    expect(result).not.toBeNull();
    expect(result!.diffText).toBe("diff --git a/x.ts\n+line\n");
  });
});

// ===========================================================================
// #4 — 12 KB truncation
// ===========================================================================
describe("gitDiff — collectCommitDiff: 12 KB truncation", () => {
  it("truncates oversize diff at GIT_DIFF_MAX_BYTES + marker", async () => {
    const big = "x".repeat(20 * 1024);
    const repo = makeRepo({ staged: big });
    const result = await collectCommitDiff(repo);
    expect(result).not.toBeNull();
    // body length must be at most GIT_DIFF_MAX_BYTES + marker length
    const marker = "\n… [diff truncated]";
    expect(result!.diffText.length).toBeLessThanOrEqual(GIT_DIFF_MAX_BYTES + marker.length);
    expect(result!.diffText.endsWith("[diff truncated]")).toBe(true);
    // marker line is included
    expect(result!.diffText.endsWith(marker)).toBe(true);
  });
});

// ===========================================================================
// #5 — missing data tolerated
// ===========================================================================
describe("gitDiff — collectCommitDiff: missing data tolerated", () => {
  it("returns diff with undefined branch and empty files when state is absent", async () => {
    // Build a repo whose state is a barebones object (no HEAD, no changes arrays).
    const repo: GitRepositoryLike = {
      rootUri: { fsPath: "/repo/MyApp" },
      diff: ((cached?: boolean) =>
        Promise.resolve(cached ? "diff --git a/y.ts\n+x\n" : "")) as GitRepositoryLike["diff"],
      state: {} as unknown as GitRepositoryLike["state"],
      inputBox: { value: "" },
    };
    const result = await collectCommitDiff(repo);
    expect(result).not.toBeNull();
    expect(result!.repoName).toBe("MyApp");
    expect(result!.branch).toBeUndefined();
    expect(result!.files).toEqual([]);
    expect(result!.diffText).toBe("diff --git a/y.ts\n+x\n");
  });
});

// ===========================================================================
// #6 — getGitApi + pickRepository
// ===========================================================================
describe("gitDiff — getGitApi + pickRepository", () => {
  function installExtensionMock(opts: {
    present: boolean;
    isActive?: boolean;
    api?: GitApiLike;
    hasExports?: boolean;
  }): void {
    const extensionMock: {
      isActive?: boolean;
      exports?: { getAPI: Mock };
    } = {};
    if (opts.isActive !== undefined) extensionMock.isActive = opts.isActive;
    const wantExports = opts.hasExports ?? (opts.api !== undefined || opts.present);
    if (wantExports) {
      extensionMock.exports = {
        getAPI: vi.fn().mockReturnValue(opts.api ?? ({} as GitApiLike)),
      };
    }
    (vscode.extensions as unknown as { getExtension: Mock }).getExtension = vi.fn(
      (id: string) => {
        if (!opts.present) return undefined;
        return { id, ...extensionMock };
      },
    );
  }

  it("returns api when extension is active and exports exist", () => {
    const api: GitApiLike = { repositories: [] };
    installExtensionMock({ present: true, isActive: true, api });
    const result = getGitApi();
    expect(result).toBe(api);
  });

  it("returns undefined when extension is not present", () => {
    installExtensionMock({ present: false });
    expect(getGitApi()).toBeUndefined();
  });

  it("returns undefined when extension is inactive", () => {
    installExtensionMock({ present: true, isActive: false });
    expect(getGitApi()).toBeUndefined();
  });

  it("returns undefined when exports is undefined", () => {
    installExtensionMock({ present: true, isActive: true, hasExports: false });
    expect(getGitApi()).toBeUndefined();
  });

  it("pickRepository returns repositories[0] when available", () => {
    const repo = makeRepo({});
    const api: GitApiLike = { repositories: [repo] };
    expect(pickRepository(api)).toBe(repo);
  });

  it("pickRepository returns null when no repositories", () => {
    const api: GitApiLike = { repositories: [] };
    expect(pickRepository(api)).toBeNull();
  });

  it("pickRepository tolerates undefined api", () => {
    expect(pickRepository(undefined)).toBeNull();
  });
});