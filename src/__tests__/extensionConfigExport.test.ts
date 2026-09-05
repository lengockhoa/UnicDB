// src/__tests__/extensionConfigExport.test.ts — Cycle AD TASK-003
//
// RED-then-GREEN for OMP config injection. Pins:
//  (a) emitUnicDBAiConfig YAML shape + privacy (apiKey NEVER in YAML body)
//  (b) ompCommandLine shape: --config, -p, --append-system-prompt, --model
//  (c) formatSystemPrompt byte-equality with buildMessages[0] (cycle AD §8)
//
// NOTE: aiChatPanel.ts imports `vscode` at module top — stub it before
// importing production modules (mirrors cycle AA aiChatPanelPrivacy.test.ts).

vi.mock("vscode", () => ({
  Uri: {
    file: (p: string) => ({ toString: () => `file://${p}`, fsPath: p }),
    joinPath: (...parts: unknown[]) => ({
      toString: () => parts.map((p) => String(p)).join("/"),
    }),
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: vi.fn(),
  },
  window: {
    showInformationMessage: vi.fn(),
    showErrorMessage: vi.fn(),
  },
  env: { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } },
}));

import { describe, it, expect, vi } from "vitest";

import { defaultAiSettings } from "../ai/settings";
import type { AiSettings } from "../ai/settings";
import { emitUnicDBAiConfig } from "../extensionConfigExport";
import { buildMessages, formatSystemPrompt } from "../ui/aiChatPanel";
import type { ChatMessage } from "../ai/provider";
import type { AdapterFactory } from "../ai/tools/types";

const SENTINEL_KEY = "sk-test-XYZ-DO-NOT-LEAK-7c4f";

function settingsWithFakeKey(): AiSettings {
  const s = defaultAiSettings();
  s.baseUrl = "https://api.openai.com/v1";
  s.models.work.modelId = "gpt-4o";
  s.models.smart.modelId = "o1-preview";
  return s;
}

const NOOP_FACTORY: AdapterFactory = async () => null;
const NOOP_HISTORY: readonly ChatMessage[] = [];

describe("emitUnicDBAiConfig — OMP YAML emitter (cycle AD §8/§9/§10)", () => {
  it("YAML body MUST NOT contain the apiKey string (privacy lock)", () => {
    const settings = settingsWithFakeKey();
    const { yaml } = emitUnicDBAiConfig(
      settings,
      "/tmp/UnicDB-db-context.md",
      "/tmp/UnicDB-ai-config.yml",
      NOOP_FACTORY,
      NOOP_HISTORY,
    );
    expect(yaml.includes(SENTINEL_KEY)).toBe(false);
    expect(/\bapiKey\s*:\s*["']?[A-Za-z0-9_-]/.test(yaml)).toBe(false);
  });

  it("YAML exposes the work + smart model ids under `model:`", () => {
    const { yaml } = emitUnicDBAiConfig(
      settingsWithFakeKey(),
      "/tmp/UnicDB-db-context.md",
      "/tmp/UnicDB-ai-config.yml",
      NOOP_FACTORY,
      NOOP_HISTORY,
    );
    expect(yaml).toMatch(/model\s*:/);
    expect(yaml).toMatch(/gpt-4o/);
    expect(yaml).toMatch(/o1-preview/);
  });

  it("YAML references the appended system-prompt file path", () => {
    const ctxPath = "/abs/workspace/.vscode/UnicDB-db-context.md";
    const { yaml } = emitUnicDBAiConfig(
      settingsWithFakeKey(),
      ctxPath,
      "/tmp/UnicDB-ai-config.yml",
      NOOP_FACTORY,
      NOOP_HISTORY,
    );
    expect(yaml).toContain(ctxPath);
    expect(/appendSystemPrompt\s*:/.test(yaml) || /append-system-prompt\s*:/.test(yaml)).toBe(true);
  });

  it("ompCommandLine includes --config, -p, --append-system-prompt, --model", () => {
    const settings = settingsWithFakeKey();
    const ctxPath = "/abs/workspace/.vscode/UnicDB-db-context.md";
    const configPath = "/abs/workspace/.vscode/UnicDB-ai-config.yml";
    const { ompCommandLine } = emitUnicDBAiConfig(
      settings,
      ctxPath,
      configPath,
      NOOP_FACTORY,
      NOOP_HISTORY,
    );
    expect(ompCommandLine).toContain("--config");
    expect(ompCommandLine).toContain("-p");
    expect(ompCommandLine).toContain("--append-system-prompt");
    expect(ompCommandLine).toContain("--model");
    expect(ompCommandLine).toContain(ctxPath);
    expect(ompCommandLine).toContain("gpt-4o");
    expect(ompCommandLine.includes(SENTINEL_KEY)).toBe(false);
  });
});

describe("formatSystemPrompt byte-equality with buildMessages (cycle AD §8)", () => {
  it("buildMessages system prompt === formatSystemPrompt output for same input", async () => {
    const factory: AdapterFactory = async () => null;
    const history: ChatMessage[] = [{ role: "user", content: "hi" }];
    const userMsg: ChatMessage = { role: "user", content: "hello" };
    const fromBuild = await buildMessages(factory, history, userMsg);
    const buildSystem = fromBuild[0]?.content ?? "";
    const formatted = await formatSystemPrompt(factory, history, {});
    expect(formatted).toBe(buildSystem);
  });
});
