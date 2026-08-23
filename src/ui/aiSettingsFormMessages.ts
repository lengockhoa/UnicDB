// src/ui/aiSettingsFormMessages.ts
// Message protocol between AiSettingsForm (host) and the webview form.
// Mirror pattern src/ui/connectionFormMessages.ts / newTableFormMessages.ts —
// type discriminator, unknown ignored.
//
// SECURITY: apiKey is NEVER carried in host → webview messages. The host
// posts `hasApiKey: boolean` only; the webview returns the apiKey only as
// part of `save`/`test` payloads (write-only channel from webview → host).

import type { AiSettings } from "../ai/settings";

// ---- Host → Webview --------------------------------------------------------

/** Host → webview: initial state. apiKey is REDACTED — webview never receives it. */
export interface AiSettingsFormInit {
  type: "init";
  /** Full settings snapshot from the store (or defaults when nothing stored). */
  settings: AiSettings;
  /** true ⇒ a stored apiKey exists; webview shows placeholder + treat empty submit as "keep". */
  hasApiKey: boolean;
}

/** Host → webview: result of a Test-button smoke call against the provider. */
export interface AiSettingsFormTestResult {
  type: "testResult";
  ok: boolean;
  /** Round-trip latency in ms (only when ok=true). */
  latencyMs?: number;
  /** apiKey-FREE error string — provider scrubs, host adds no key material. */
  error?: string;
}

/** Host → webview: settings + apiKey persisted to the store. Webview shows success. */
export interface AiSettingsFormSaved {
  type: "saved";
}

export type AiSettingsFormHostMessage =
  | AiSettingsFormInit
  | AiSettingsFormTestResult
  | AiSettingsFormSaved;

// ---- Webview → Host --------------------------------------------------------

/** Webview → host: webview is mounted and ready for an init message. */
export interface AiSettingsFormReady {
  type: "ready";
}

/** Webview → host: user pressed OK with valid form values. */
export interface AiSettingsFormSave {
  type: "save";
  /** Validated webview-side; host re-validates (authoritative). */
  settings: AiSettings;
  /** Empty string ⇒ keep stored key (host decides). */
  apiKey: string;
}

/** Webview → host: user pressed Test; host fires a provider smoke call. */
export interface AiSettingsFormTest {
  type: "test";
  settings: AiSettings;
  /** Empty string ⇒ host uses stored key. */
  apiKey: string;
}

/** Webview → host: user pressed Cancel or Escape; host disposes the panel. */
export interface AiSettingsFormCancel {
  type: "cancel";
}

export type AiSettingsFormWebviewMessage =
  | AiSettingsFormReady
  | AiSettingsFormSave
  | AiSettingsFormTest
  | AiSettingsFormCancel;