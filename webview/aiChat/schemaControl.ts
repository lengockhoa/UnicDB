// webview/aiChat/schemaControl.ts — TASK-CHATV2-013
//
// The ACTIVE-SCHEMA chip: a >=36px control that follows the host's
// active-schema frame and emits the existing host picker intent on click.
//
// CONTRACT
// - The chip is a PURE VIEW of host state. The host is authoritative for the
//   active schema/connection; this module never guesses a schema name and never
//   invents a default beyond the safe `No active schema` fallback.
// - Label is `Schema: public` while a schema is active, or the safe
//   `No active schema` when the host has none. A hostile/host-provided schema
//   name is rendered with `textContent` and can never become markup.
// - Click emits the EXISTING host picker intent (`onPickSchema`); the host
//   routes it through `UnicDB.selectActiveSchema`, so every surface stays
//   coherent. The chip never mutates a draft.
// - FUTURE-DRAFT SEMANTICS: a schema change during an active turn applies only
//   to the NEXT draft. This module owns no turn state and never retargets a
//   running turn — the running turn's context is immutable.
//
// Pure DOM TypeScript: no `vscode`, no node builtins, no framework.

import { createChatIcon } from "./icons";

const ROOT_CLASS = "UnicDB-ai-chat-v2";

/** Marker attribute identifying the active-schema chip. */
export const SCHEMA_CHIP_MARKER = "data-chat-schema-chip";
/** Safe label shown when the host has no active schema. */
export const SCHEMA_CHIP_EMPTY_LABEL = "No active schema";

/** Minimum chip height in px (PLAN §5: schema chip is >=36px). */
export const SCHEMA_CHIP_MIN_HEIGHT_PX = 36;
/** Leading icon edge in px. */
export const SCHEMA_CHIP_ICON_PX = 16;

/** Active-schema state as the host reports it. */
export interface ActiveSchemaState {
  readonly schema: string | null;
  readonly connectionId: string | null;
}

export interface SchemaControlOptions {
  /** Element the chip is mounted into (the composer context lane). */
  readonly container: HTMLElement;
  /** Click → the EXISTING host picker intent. Never transport here. */
  readonly onPickSchema: () => void;
  /** Stable DOM id (the composer contract's `schemaChipBtnV2`). Defaults to a
   * constant that exposes the pre-`render` chip node. */
  readonly id?: string;
}

/** Default chip id — a stable handle for the active-schema control. */
export const SCHEMA_CHIP_DEFAULT_ID = "schemaChipBtnV2";

/** The live schema-chip handle. */
export interface SchemaControl {
  readonly element: HTMLButtonElement;
  /** Apply host state. Pure render; never dispatches. */
  setState(state: ActiveSchemaState): void;
  /** The label currently shown (`Schema: <name>` or the safe fallback). */
  label(): string;
  destroy(): void;
}

/** Exact, safe chip label for a state. */
export function schemaChipLabel(state: ActiveSchemaState): string {
  const schema = typeof state.schema === "string" && state.schema.length > 0 ? state.schema : null;
  return schema === null ? SCHEMA_CHIP_EMPTY_LABEL : `Schema: ${schema}`;
}

/**
 * Mount the schema chip against `options.container`. The chip is created with
 * the safe fallback label so it is never label-less before the first frame.
 */
export function createSchemaControl(options: SchemaControlOptions): SchemaControl {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${ROOT_CLASS}-chip ${ROOT_CLASS}-schema-chip`;
  if (options.id !== undefined && options.id.length > 0) button.id = options.id;
  else button.id = SCHEMA_CHIP_DEFAULT_ID;
  button.setAttribute(SCHEMA_CHIP_MARKER, "1");
  button.style.setProperty("--UnicDB-schema-chip-h", `${SCHEMA_CHIP_MIN_HEIGHT_PX}px`);
  button.style.setProperty("--UnicDB-schema-chip-icon", `${SCHEMA_CHIP_ICON_PX}px`);

  const labelNode = document.createElement("span");
  labelNode.className = `${ROOT_CLASS}-schema-chip-label`;
  labelNode.textContent = SCHEMA_CHIP_EMPTY_LABEL;

  button.appendChild(labelNode);
  button.appendChild(createChatIcon("schema", SCHEMA_CHIP_ICON_PX));

  let current: ActiveSchemaState = { schema: null, connectionId: null };
  let destroyed = false;

  function applyState(state: ActiveSchemaState): void {
    current = {
      schema: typeof state.schema === "string" ? state.schema : null,
      connectionId: typeof state.connectionId === "string" ? state.connectionId : null,
    };
    const text = schemaChipLabel(current);
    labelNode.textContent = text;
    // Identical title + aria-label: the full name survives any visual clipping.
    button.title = text;
    button.setAttribute("aria-label", text);
    if (current.schema !== null && current.schema.length > 0) {
      button.setAttribute("data-has-schema", "true");
    } else {
      button.setAttribute("data-has-schema", "false");
    }
  }

  button.addEventListener("click", () => {
    if (destroyed) return;
    options.onPickSchema();
  });

  options.container.appendChild(button);
  applyState(current);

  return {
    element: button,
    setState(state: ActiveSchemaState): void {
      if (destroyed) return;
      applyState(state);
    },
    label: () => schemaChipLabel(current),
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      button.remove();
    },
  };
}
