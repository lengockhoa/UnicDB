// webview/__tests__/aiChatPanelThread.test.ts — TASK-AGTUI-005
//
// Pure jsdom unit tests for the chat-thread DOM builder module.
//
// Coverage mirrors the §Test Cases table in
// docs/AI_HANDOFF/tasks/TASK-AGTUI-005.md:
//   1. happy — bubble/thinking/step/tool/plan/error/usage all render their
//      canonical clone class names (§TASK-AGTUI-001).
//   2. edge (XSS) — hostile wire strings inert (textContent/createTextNode
//      only, markdown path escapes before render).
//   3. edge (duplicate) — plan card approve/reject handlers fire exactly
//      once and disable buttons after first click.
//   4. edge (empty) — empty strings render without "undefined"/"NaN".
//   5. edge (boundary) — usage chip shows session totals + renders an
//      "unknown" marker (NOT zero) when `unknown:true`, and per-turn
//      numbers when `unknown:false`.
//
// The module must NOT import `vscode` and must be loadable in plain jsdom.

// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from "vitest";

import {
  appendUserBubble,
  appendAssistantBubble,
  appendThinkingRow,
  removeThinkingRow,
  appendStepRow,
  appendToolCard,
  appendChangePlanCard,
  appendErrorBubble,
  appendNoticeBubble,
  renderUsageChip,
  renderMarkdown,
} from "../aiChatPanelThread";

function freshThread(): HTMLDivElement {
  const t = document.createElement("div");
  t.id = "thread";
  document.body.appendChild(t);
  return t;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("aiChatPanelThread — bubbles (case #1 happy)", () => {
  it("appendUserBubble produces .UnicDB-chat-msg-user with exact text", () => {
    const t = freshThread();
    const b = appendUserBubble(t, "hi");
    expect(t.querySelectorAll(".UnicDB-chat-msg-user").length).toBe(1);
    expect(b.classList.contains("UnicDB-chat-msg-user")).toBe(true);
    expect(b.textContent).toBe("hi");
  });

  it("appendAssistantBubble with markdown=true renders escaped-then-marked HTML (e.g. <strong>md</strong>)", () => {
    const t = freshThread();
    const b = appendAssistantBubble(t, "**md**", true);
    expect(t.querySelectorAll(".UnicDB-chat-msg-assistant").length).toBe(1);
    expect(b.classList.contains("UnicDB-chat-msg-assistant")).toBe(true);
    expect(b.querySelector("strong")?.textContent).toBe("md");
  });

  it("appendAssistantBubble with markdown=false escapes the whole payload", () => {
    const t = freshThread();
    const b = appendAssistantBubble(t, "<plain>", false);
    expect(b.querySelector("plain")).toBeNull();
    expect(b.textContent).toBe("<plain>");
  });

  it("appendThinkingRow + removeThinkingRow produce + remove .UnicDB-chat-thinking-row", () => {
    const t = freshThread();
    const row = appendThinkingRow(t);
    expect(t.querySelectorAll(".UnicDB-chat-thinking-row").length).toBe(1);
    expect(row.classList.contains("UnicDB-chat-thinking-row")).toBe(true);
    removeThinkingRow(t, row);
    expect(t.querySelectorAll(".UnicDB-chat-thinking-row").length).toBe(0);
  });

  it("appendStepRow produces .UnicDB-chat-step with prefixed label", () => {
    const t = freshThread();
    const row = appendStepRow(t, "search");
    expect(row.classList.contains("UnicDB-chat-step")).toBe(true);
    expect(row.textContent).toBe("→ search");
  });

  it("appendToolCard with status=denied produces .UnicDB-chat-tool-denied", () => {
    const t = freshThread();
    const card = appendToolCard(t, "sql", "denied", "blocked by policy");
    expect(card.classList.contains("UnicDB-chat-tool-denied")).toBe(true);
    expect(card.textContent).toBe("blocked by policy");
  });

  it("appendToolCard with status=ok produces .UnicDB-chat-tool-ok", () => {
    const t = freshThread();
    const card = appendToolCard(t, "sql", "ok", "ran 12 rows");
    expect(card.classList.contains("UnicDB-chat-tool-ok")).toBe(true);
    expect(card.textContent).toBe("ran 12 rows");
  });

  it("appendErrorBubble produces .UnicDB-chat-msg-error with exact message", () => {
    const t = freshThread();
    const b = appendErrorBubble(t, "kaboom");
    expect(b.classList.contains("UnicDB-chat-msg-error")).toBe(true);
    expect(b.textContent).toBe("kaboom");
  });

  it("appendNoticeBubble produces a notice class with exact message", () => {
    const t = freshThread();
    const b = appendNoticeBubble(t, "context attached");
    expect(b.classList.contains("UnicDB-chat-local-notice")).toBe(true);
    expect(b.textContent).toBe("context attached");
  });
});

describe("aiChatPanelThread — XSS hardening (case #2 hostile wire strings)", () => {
  it("appendUserBubble renders hostile text literally (no img / no script)", () => {
    const t = freshThread();
    appendUserBubble(
      t,
      '<img src=x onerror=alert(1)> <script>alert("x")</script>',
    );
    expect(document.querySelectorAll("img[src=x]").length).toBe(0);
    expect(document.querySelectorAll("script").length).toBe(0);
    expect(document.querySelectorAll("[onerror]").length).toBe(0);
    // The raw text remains, escaped:
    expect(t.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it("appendToolCard with hostile tool/summary stays inert", () => {
    const t = freshThread();
    appendToolCard(
      t,
      '<img src=x onerror=alert(1)>',
      "ok",
      '<script>alert(1)</script>',
    );
    expect(document.querySelectorAll("img[src=x]").length).toBe(0);
    expect(document.querySelectorAll("script").length).toBe(0);
    // The summary is in textContent, not as a child element:
    expect(t.textContent).toContain("<script>alert(1)</script>");
  });

  it("appendChangePlanCard with hostile SQL/intent renders text-only", () => {
    const t = freshThread();
    let approveCount = 0;
    let rejectCount = 0;
    const card = appendChangePlanCard(
      t,
      {
        intent: '<img src=x onerror=alert(1)>',
        statements: [
          {
            sql: '<script>alert(1)</script>',
            tier: "red",
            dangerNote: "<b>bold</b>",
          },
        ],
        drift: [],
        drifted: false,
      },
      {
        onApprove: () => approveCount++,
        onReject: () => rejectCount++,
      },
    );
    expect(document.querySelectorAll("script").length).toBe(0);
    expect(document.querySelectorAll("img").length).toBe(0);
    expect(card.textContent).toContain("<script>alert(1)</script>");
    expect(card.textContent).toContain("<b>bold</b>");
  });

  it("appendAssistantBubble escapes HTML before inserting (no live nodes from wire text)", () => {
    const t = freshThread();
    const b = appendAssistantBubble(
      t,
      '<img src=x onerror=alert(1)>',
      false,
    );
    expect(document.querySelectorAll("img").length).toBe(0);
    expect(b.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it("renderMarkdown escapes code-fence content (no live nodes from markdown body)", () => {
    const t = freshThread();
    const b = appendAssistantBubble(
      t,
      "before <script>alert(1)</script> after",
      true,
    );
    expect(document.querySelectorAll("script").length).toBe(0);
    expect(b.textContent).toContain("<script>alert(1)</script>");
  });
});

describe("aiChatPanelThread — plan card approval semantics (case #3 duplicate)", () => {
  it("approve / reject buttons: handler fires exactly once and buttons disable after first click", () => {
    const t = freshThread();
    let approveCount = 0;
    let rejectCount = 0;
    const card = appendChangePlanCard(
      t,
      {
        intent: "add column",
        statements: [
          { sql: "ALTER TABLE x ADD COLUMN a int", tier: "green", dangerNote: "" },
        ],
        drift: [],
        drifted: false,
      },
      {
        onApprove: () => approveCount++,
        onReject: () => rejectCount++,
      },
    );
    const approve = card.querySelector<HTMLButtonElement>(
      ".UnicDB-chat-plan-approve",
    );
    const reject = card.querySelector<HTMLButtonElement>(
      ".UnicDB-chat-plan-reject",
    );
    expect(approve).not.toBeNull();
    expect(reject).not.toBeNull();

    approve!.click();
    approve!.click();
    approve!.click();
    expect(approveCount).toBe(1);
    expect(approve!.disabled).toBe(true);

    reject!.click();
    reject!.click();
    reject!.click();
    expect(rejectCount).toBe(1);
    expect(reject!.disabled).toBe(true);
  });

  it("drifted plan: approve starts disabled but reject is enabled", () => {
    const t = freshThread();
    let approveCount = 0;
    let rejectCount = 0;
    const card = appendChangePlanCard(
      t,
      {
        intent: "x",
        statements: [
          { sql: "DROP TABLE t", tier: "red", dangerNote: "destroy" },
        ],
        drift: ["missing: x"],
        drifted: true,
      },
      {
        onApprove: () => approveCount++,
        onReject: () => rejectCount++,
      },
    );
    const approve = card.querySelector<HTMLButtonElement>(
      ".UnicDB-chat-plan-approve",
    )!;
    const reject = card.querySelector<HTMLButtonElement>(
      ".UnicDB-chat-plan-reject",
    )!;
    expect(approve.disabled).toBe(true);
    expect(reject.disabled).toBe(false);

    reject.click();
    expect(rejectCount).toBe(1);
    expect(approveCount).toBe(0);
  });

  it("appendToolCard with unknown status renders with .UnicDB-chat-tool (no crash)", () => {
    const t = freshThread();
    const card = appendToolCard(t, "sql", "weirdstatus" as never, "ok body");
    expect(card.classList.contains("UnicDB-chat-tool")).toBe(true);
    expect(card.textContent).toBe("ok body");
  });
});

describe("aiChatPanelThread — empty payloads (case #4 empty strings)", () => {
  it("appendAssistantBubble('') renders an empty bubble without 'undefined' / 'NaN'", () => {
    const t = freshThread();
    const b = appendAssistantBubble(t, "", true);
    expect(b.classList.contains("UnicDB-chat-msg-assistant")).toBe(true);
    expect(b.textContent).toBe("");
    expect(b.textContent).not.toContain("undefined");
    expect(b.textContent).not.toContain("NaN");
  });

  it("appendUserBubble('') renders an empty bubble", () => {
    const t = freshThread();
    const b = appendUserBubble(t, "");
    expect(b.classList.contains("UnicDB-chat-msg-user")).toBe(true);
    expect(b.textContent).toBe("");
    expect(b.textContent).not.toContain("undefined");
  });

  it("appendToolCard with empty summary renders an empty .UnicDB-chat-tool-denied card (no throw)", () => {
    const t = freshThread();
    const card = appendToolCard(t, "sql", "denied", "");
    expect(card.classList.contains("UnicDB-chat-tool-denied")).toBe(true);
    expect(card.textContent).toBe("");
  });

  it("appendErrorBubble('') renders an empty .UnicDB-chat-msg-error", () => {
    const t = freshThread();
    const b = appendErrorBubble(t, "");
    expect(b.classList.contains("UnicDB-chat-msg-error")).toBe(true);
    expect(b.textContent).toBe("");
  });
});

describe("aiChatPanelThread — usage chip (case #5 unknown tokens)", () => {
  it("unknown:true shows the 'unknown' marker (NOT zero) and shows session totals", () => {
    const c = document.createElement("div");
    document.body.appendChild(c);
    renderUsageChip(c, {
      inputTokens: 0,
      outputTokens: 0,
      unknown: true,
      sessionTokens: { inputTokens: 9, outputTokens: 1 },
      policyNotice: "n",
    });
    const chip = c.querySelector(".UnicDB-chat-usage")!;
    expect(chip.classList.contains("UnicDB-chat-usage-unknown")).toBe(true);
    // Per-turn label is a known "unknown" marker, NOT zeros:
    const txt = chip.textContent ?? "";
    expect(txt).toContain("unknown");
    // Session totals are still rendered (numbers, not the literal "unknown"):
    expect(txt).toContain("9");
    expect(txt).toContain("1");
    expect(chip.textContent).not.toMatch(/Turn:\s*0\s*in\s*\/\s*0\s*out/);
    // Policy notice joins the same chip via textContent:
    expect(txt).toContain("n");
  });

  it("unknown:false shows per-turn numbers (mirrors TASK-ARP06-005)", () => {
    const c = document.createElement("div");
    document.body.appendChild(c);
    renderUsageChip(c, {
      inputTokens: 12,
      outputTokens: 7,
      unknown: false,
      sessionTokens: { inputTokens: 100, outputTokens: 70 },
      policyNotice: "",
    });
    const chip = c.querySelector(".UnicDB-chat-usage")!;
    expect(chip.classList.contains("UnicDB-chat-usage-known")).toBe(true);
    const txt = chip.textContent ?? "";
    expect(txt).toContain("12");
    expect(txt).toContain("7");
    expect(txt).toContain("100");
    expect(txt).toContain("70");
    // No "unknown" marker in known mode:
    expect(txt).not.toContain("unknown");
  });
});

describe("aiChatPanelThread — renderMarkdown (moved helper)", () => {
  it("escapes user content before applying markdown syntax", () => {
    const html = renderMarkdown("**a < b**");
    expect(html).toContain("<strong>a &lt; b</strong>");
  });

  it("markdown fences render as <pre><code> with Copy buttons", () => {
    const html = renderMarkdown("```sql\nSELECT 1\n```");
    expect(html).toContain("UnicDB-md-code");
    expect(html).toContain("UnicDB-md-copy");
    expect(html).toContain("Copy");
  });
});
