// src/ui/groundingService.ts — TASK-AIX01-003
// Host-side grounding orchestrator. I/O is injected (selection + file
// read); pure modules do the trimming, attribution, and search.

import { extractSelection, formatSelectionBlock, type GroundedSelection } from "../ai/grounding/selection";
import {
  containsSecretHeuristic,
  isProbablyBinary,
  type GroundedFile,
} from "../ai/grounding/fileSearch";
import {
  emptyAttributionRecord,
  recordAttribution,
  type AttributionRecord,
  type AttributionEntry,
} from "../ai/grounding/attribution";

/** Same value as the existing MENTION_RESOLVE_FILE_CAP_BYTES cap. */
export const MENTION_FILE_BYTES_CAP = 100 * 1024;

export interface GroundingDeps {
  /** When false (default true), the service short-circuits to empty. */
  enabled?: boolean;
  getSelection?: () => { path: string; text: string; startLine?: number; endLine?: number } | null | undefined;
  readFile?: (path: string) => Promise<string>;
  filesToRead?: readonly string[];
  turnId?: string;
}

export interface GroundingBundle {
  selection: GroundedSelection | null;
  selectionBlock: string | null;
  files: GroundedFile[];
  excluded: string[];
  record: AttributionRecord;
}

export async function collectGrounding(deps: GroundingDeps): Promise<GroundingBundle> {
  const turnId = deps.turnId ?? "turn";
  let record = emptyAttributionRecord(turnId);
  if (deps.enabled === false) {
    return { selection: null, selectionBlock: null, files: [], excluded: [], record };
  }

  let selection: GroundedSelection | null = null;
  let selectionBlock: string | null = null;
  if (deps.getSelection) {
    try {
      const raw = deps.getSelection();
      if (raw) {
        selection = extractSelection(raw);
        if (selection) {
          selectionBlock = formatSelectionBlock(selection);
          record = recordAttribution(record, [
            { kind: "selection", ref: `${selection.path}:${selection.startLine}-${selection.endLine}`, bytes: selection.text.length },
          ]);
        }
      }
    } catch {
      // Selection acquisition failed — degrade to no selection.
    }
  }

  const files: GroundedFile[] = [];
  const excluded: string[] = [];
  if (deps.readFile && deps.filesToRead) {
    for (const p of deps.filesToRead) {
      let content: string;
      try {
        content = await deps.readFile(p);
      } catch {
        excluded.push(p);
        continue;
      }
      const trimmed = content.length > MENTION_FILE_BYTES_CAP ? content.slice(0, MENTION_FILE_BYTES_CAP) : content;
      if (isProbablyBinary(trimmed) || containsSecretHeuristic(trimmed)) {
        excluded.push(p);
        continue;
      }
      files.push({ path: p, content: trimmed });
      const fileEntries: AttributionEntry[] = [{ kind: "file", ref: p, bytes: trimmed.length }];
      record = recordAttribution(record, fileEntries);
    }
  }

  return { selection, selectionBlock, files, excluded, record };
}
