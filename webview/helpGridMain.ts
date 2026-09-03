// webview/helpGridMain.ts
//
// TASK-OC4O-002 — VSDB Help Grid webview. Renders the cards payload sent by
// the host into a responsive CSS grid; each card has a "Try it" button that
// posts `{ type: "runCommand", commandId }` to the host.

declare const acquireVsCodeApi: undefined | (() => {
  postMessage: (msg: unknown) => void;
});
const vscodeApi =
  typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;

interface HelpCard {
  id: string;
  title: string;
  blurb: string;
  icon: string;
  commandId: string;
}

const root = document.getElementById("vsdb-help-root") as HTMLDivElement;

function render(cards: readonly HelpCard[]): void {
  root.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "vsdb-help-grid";
  for (const c of cards) {
    const card = document.createElement("div");
    card.className = "vsdb-help-card";
    card.dataset["commandId"] = c.commandId;

    const header = document.createElement("div");
    header.className = "vsdb-help-card-header";
    const icon = document.createElement("span");
    icon.className = "codicon";
    icon.classList.add(c.icon.replace(/[()]/g, ""));
    icon.textContent = "";
    const title = document.createElement("h3");
    title.textContent = c.title;
    header.appendChild(icon);
    header.appendChild(title);

    const blurb = document.createElement("p");
    blurb.className = "vsdb-help-card-blurb";
    blurb.textContent = c.blurb;

    const cmd = document.createElement("code");
    cmd.className = "vsdb-help-card-cmd";
    cmd.textContent = c.commandId;

    const button = document.createElement("button");
    button.className = "vsdb-help-card-try";
    button.type = "button";
    button.textContent = "Try it";
    button.addEventListener("click", () => {
      vscodeApi?.postMessage({ type: "runCommand", commandId: c.commandId });
    });

    card.appendChild(header);
    card.appendChild(blurb);
    card.appendChild(cmd);
    card.appendChild(button);
    grid.appendChild(card);
  }
  root.appendChild(grid);
}

const cardsAttr = root.getAttribute("data-cards");
if (cardsAttr) {
  try {
    const cards = JSON.parse(cardsAttr) as HelpCard[];
    render(Array.isArray(cards) ? cards : []);
  } catch {
    render([]);
  }
} else {
  render([]);
}