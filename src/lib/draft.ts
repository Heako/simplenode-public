/**
 * Seedance 2.5 drafts: a 480p render that fal can turn into the same video
 * in 1080p. Shared by the node's button and the MCP `finalize_draft` tool.
 */
import { invoke } from "@tauri-apps/api/core";
import { seedanceEstimate } from "./cost";
import { useFlow, type FlowNode } from "./store";

/** fal keeps a draft this long, and only for the fal account that rendered it. */
export const DRAFT_DAYS = 14;

/** When the draft stops being finalizable; null for drafts rendered before the date was kept. */
export function draftExpiry(data: FlowNode["data"]): Date | null {
  const at = Number(data.outputs.draftAt);
  return at > 0 ? new Date(at + DRAFT_DAYS * 24 * 3600 * 1000) : null;
}

export function draftExpired(data: FlowNode["data"], now = Date.now()) {
  const expiry = draftExpiry(data);
  return !!expiry && expiry.getTime() <= now;
}

/** "16/11" */
export function dayMonth(date: Date) {
  return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

/** What finalizing costs: the node's duration rendered in 1080p. */
export function finalizeEstimate(data: FlowNode["data"]) {
  return seedanceEstimate(data.params.modelId, data.params, { resolution: "1080p" });
}

/** Renders the draft in 1080p and makes it the node's result. Returns the video's path. */
export async function finalizeDraft(nodeId: string): Promise<string> {
  const { nodes, patchNode } = useFlow.getState();
  const node = nodes.find((n) => n.id === nodeId);
  const draftId = node?.data.outputs.draftId;
  if (!node || !draftId) throw new Error("Ce nœud n'a pas de brouillon à finaliser.");
  if (draftExpired(node.data)) throw new Error(`Brouillon expiré : fal ne le garde que ${DRAFT_DAYS} jours.`);
  if (node.data.finalizing) throw new Error("Ce brouillon est déjà en cours de finalisation.");
  patchNode(nodeId, { finalizing: true, error: undefined });
  try {
    const video = await invoke<string>("finalize_draft", { draftId });
    const latest = useFlow.getState().nodes.find((n) => n.id === nodeId)?.data ?? node.data;
    // Drop draftId: a finalized draft can't be finalized again.
    patchNode(nodeId, { outputs: { video }, status: "done", history: [...(latest.history ?? []), video], finalizing: false });
    return video;
  } catch (err) {
    patchNode(nodeId, { error: String(err), finalizing: false });
    throw err;
  }
}
