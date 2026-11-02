/**
 * Seedance 2.5 drafts: a 480p render that can be turned into the same video
 * in 1080p, on fal (model node "Seedance 2.5 Draft") or on BytePlus (node
 * "Seedance 2.5 (BytePlus)" with Draft on). Shared by the nodes' button and
 * the MCP `finalize_draft` tool.
 */
import { invoke } from "@tauri-apps/api/core";
import { bpSeedanceEstimate } from "./byteplus";
import { seedanceEstimate } from "./cost";
import { useFlow, type FlowNode } from "./store";

/** fal and BytePlus both keep a draft this long, for the account that rendered it. */
export const DRAFT_DAYS = 14;

/** Who renders and bills the draft. */
export function draftProvider(data: FlowNode["data"]) {
  return data.kind === "bpSeedance" ? "BytePlus" : "fal";
}

/** When the draft stops being finalizable; null for drafts rendered before the date was kept. */
export function draftExpiry(data: FlowNode["data"]): Date | null {
  const at = Number(data.outputs.draftAt);
  return at > 0 ? new Date(at + DRAFT_DAYS * 24 * 3600 * 1000) : null;
}

export function draftExpired(data: FlowNode["data"], now = Date.now()) {
  const expiry = draftExpiry(data);
  return !!expiry && expiry.getTime() <= now;
}

/** "Nov 16" */
export function dayMonth(date: Date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** What finalizing costs: the node's duration rendered in 1080p. */
export function finalizeEstimate(data: FlowNode["data"]): { cost: number; seconds: number; auto: boolean } | null {
  if (data.kind === "bpSeedance") return bpSeedanceEstimate(data.params, "1080p");
  return seedanceEstimate(data.params.modelId, data.params, { resolution: "1080p" });
}

/** A failed finalization; `unbilled` when it was refused before any render. */
export class FinalizeError extends Error {
  constructor(
    message: string,
    readonly unbilled: boolean,
  ) {
    super(message);
  }
}

/** Renders the draft in 1080p and makes it the node's result. Returns the video's path. */
export async function finalizeDraft(nodeId: string): Promise<string> {
  const { nodes, patchNode } = useFlow.getState();
  const node = nodes.find((n) => n.id === nodeId);
  const draftId = node?.data.outputs.draftId;
  if (!node || !draftId) throw new FinalizeError("This node has no draft to finalize.", true);
  const provider = draftProvider(node.data);
  if (draftExpired(node.data)) throw new FinalizeError(`Draft expired: ${provider} only keeps it ${DRAFT_DAYS} days.`, true);
  if (node.data.finalizing) throw new FinalizeError("This draft is already being finalized.", true);
  patchNode(nodeId, { finalizing: true, error: undefined });
  try {
    const command = node.data.kind === "bpSeedance" ? "finalize_byteplus_draft" : "finalize_draft";
    const video = await invoke<string>(command, { draftId });
    const latest = useFlow.getState().nodes.find((n) => n.id === nodeId)?.data ?? node.data;
    // Drop draftId: a finalized draft can't be finalized again.
    patchNode(nodeId, { outputs: { video }, status: "done", history: [...(latest.history ?? []), video], finalizing: false });
    return video;
  } catch (err) {
    // Commands answer { message, unbilled }.
    const e = err as { message?: string; unbilled?: boolean } | string;
    const message = typeof e === "string" ? e : (e.message ?? String(err));
    patchNode(nodeId, { error: message, finalizing: false });
    throw new FinalizeError(message, typeof e === "object" && !!e.unbilled);
  }
}
