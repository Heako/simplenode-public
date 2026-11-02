/**
 * Runs the tools of the MCP server (src-tauri/src/mcp.rs) on the open graph,
 * the way the user would, so the canvas shows every change. Also keeps the
 * spending cap: each run is estimated, and refused beyond the budget left.
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { perSecond, seedanceEstimate } from "./cost";
import { DRAFT_DAYS, dayMonth, draftExpiry, finalizeDraft, finalizeEstimate } from "./draft";
import { listProjects, loadProject, newProjectId, saveProject } from "./projects";
import { findModel, isRefPort, libraryItems, portsFor, useModels, type NodeKind } from "./spec";
import { useFlow, type FlowNode } from "./store";

/** Mirrors `mcp::McpStatus` in src-tauri. */
export interface McpStatus {
  enabled: boolean;
  port: number;
  token: string;
  budget: number;
  running: boolean;
  error: string | null;
}

/** Estimated dollars Claude Code has launched since the app started. */
export const useMcpSpend = create<{ spent: number; reset: () => void }>((set) => ({
  spent: 0,
  reset: () => set({ spent: 0 }),
}));

interface Price {
  endpoint: string;
  unitPrice: number | null;
  unit: string | null;
}

/** Same set as `graph::is_remote`: paid, and not re-run once they have a result. */
const PAID = new Set<NodeKind>(["model", "enhancer", "describer", "videoDescriber", "angles", "recast", "addAudio"]);
const PER_RUN_UNITS = new Set(["image", "images", "video", "videos", "units", "requests", "generations"]);
/** LLM calls and ffmpeg jobs on fal: a cent at most. */
const SMALL = 0.01;

let prices: Promise<Price[]> | null = null;
function loadPrices() {
  prices ??= invoke<Price[]>("model_prices").catch(() => {
    prices = null;
    return [];
  });
  return prices;
}

function mediaDuration(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const done = (v: number | null) => {
      video.removeAttribute("src");
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 10_000);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      done(Number.isFinite(video.duration) ? video.duration : null);
    };
    video.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
    video.src = /^https?:\/\//.test(path) ? path : convertFileSrc(path);
  });
}

function inputValue(nodeId: string, handle: string): string | undefined {
  const { nodes, edges } = useFlow.getState();
  const edge = edges.find((e) => e.target === nodeId && e.targetHandle === handle);
  return edge ? nodes.find((n) => n.id === edge.source)?.data.outputs[edge.sourceHandle ?? ""] : undefined;
}

/** Dollars one run of this node costs, or null when it can't be told. */
async function nodeCost(node: FlowNode): Promise<number | null> {
  const p = node.data.params;
  const rows = await loadPrices();
  const priceOf = (endpoint: string | null | undefined) => rows.find((r) => r.endpoint === endpoint);
  switch (node.data.kind) {
    case "enhancer":
    case "describer":
    case "videoDescriber":
    case "addAudio":
      return SMALL;
    case "recast": {
      const def = findModel(p.modelId);
      const rate = perSecond(priceOf(def?.editEndpoint), p.resolution);
      const source = inputValue(node.id, "video");
      const seconds = source ? await mediaDuration(source) : null;
      return rate != null && seconds != null ? rate * seconds : null;
    }
    case "angles": {
      const price = priceOf(findModel(p.modelId)?.editEndpoint);
      return price?.unitPrice != null && price.unit && PER_RUN_UNITS.has(price.unit) ? price.unitPrice : null;
    }
    case "model": {
      const def = findModel(p.modelId);
      if (!def) return null;
      if (def.category === "llm") return SMALL;
      const refs = useFlow.getState().edges.some((e) => e.target === node.id && isRefPort(e.targetHandle));
      const price = priceOf((refs ? def.editEndpoint : def.textEndpoint) ?? def.textEndpoint ?? def.editEndpoint);
      // Billed in video tokens; a duration "auto" is estimated on its longest.
      const tokens = seedanceEstimate(def.id, p, { price });
      if (tokens) return tokens.cost;
      if (price?.unitPrice == null || !price.unit) return null;
      if (PER_RUN_UNITS.has(price.unit)) return price.unitPrice * (Number(p["x:num_images"] || p.num_images) || 1);
      if (price.unit === "seconds" || price.unit === "second") {
        const seconds = Number(p.duration || p["x:duration"] || p.seconds_total || p["x:seconds_total"]);
        return seconds > 0 ? price.unitPrice * seconds : null;
      }
      return null;
    }
    default:
      return 0;
  }
}

function ancestors(id: string): Set<string> {
  const { edges } = useFlow.getState();
  const seen = new Set([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of edges) {
      if (e.target === cur && !seen.has(e.source)) {
        seen.add(e.source);
        stack.push(e.source);
      }
    }
  }
  return seen;
}

/** The paid nodes a run would execute, as `graph::run` picks them, and their cost. */
async function estimate(target?: string) {
  const { nodes } = useFlow.getState();
  const subset = target ? ancestors(target) : new Set(nodes.map((n) => n.id));
  const paid = nodes.filter(
    (n) => subset.has(n.id) && PAID.has(n.data.kind) && (n.id === target || Object.keys(n.data.outputs).length === 0),
  );
  const costs = await Promise.all(paid.map(async (n) => ({ node: n, cost: await nodeCost(n) })));
  return {
    total: costs.reduce((sum, c) => sum + (c.cost ?? 0), 0),
    nodes: costs.map((c) => ({ id: c.node.id, title: titleOf(c.node), estimated_cost: c.cost })),
    unknown: costs.filter((c) => c.cost == null).map((c) => titleOf(c.node)),
  };
}

function titleOf(n: FlowNode) {
  return n.data.title || (n.data.kind === "model" ? (findModel(n.data.params.modelId)?.label ?? n.data.params.modelId) : n.data.kind);
}

const money = (v: number) => `$${v.toFixed(2)}`;

function requireProject() {
  if (!useFlow.getState().projectId) throw new Error("Aucun projet ouvert : utilisez open_project ou create_project.");
}

function requireNode(id: unknown): FlowNode {
  const node = useFlow.getState().nodes.find((n) => n.id === id);
  if (!node) throw new Error(`Nœud introuvable : ${String(id)}`);
  return node;
}

/** Right of everything on the canvas, unless the caller placed it. */
function placement(args: Record<string, unknown>) {
  if (typeof args.x === "number" && typeof args.y === "number") return { x: args.x, y: args.y };
  const { nodes } = useFlow.getState();
  if (!nodes.length) return { x: 0, y: 0 };
  const right = Math.max(...nodes.map((n) => n.position.x + (n.measured?.width ?? 300)));
  return { x: right + 80, y: Math.min(...nodes.map((n) => n.position.y)) };
}

function graph() {
  const { nodes, edges, projectId, title } = useFlow.getState();
  return {
    project: { id: projectId, title },
    nodes: nodes.map((n) => {
      const ports = portsFor(n.data);
      return {
        id: n.id,
        kind: n.data.kind,
        title: titleOf(n),
        params: n.data.params,
        inputs: ports.inputs.map((p) => ({ id: p.id, label: p.label, type: p.type, multiple: !!p.multiple })),
        outputs: ports.outputs.map((p) => ({ id: p.id, label: p.label, type: p.type, value: n.data.outputs[p.id] ?? null })),
        status: n.data.status,
        error: n.data.error ?? null,
        // A Seedance 2.5 draft that finalize_draft can render in 1080p.
        ...(n.data.outputs.draftId && {
          draft: {
            finalize_cost_estimate: finalizeEstimate(n.data)?.cost ?? null,
            expires: draftExpiry(n.data)?.toISOString() ?? null,
            finalizing: !!n.data.finalizing,
          },
        }),
      };
    }),
    edges: edges.map((e) => ({ source: e.source, source_handle: e.sourceHandle, target: e.target, target_handle: e.targetHandle })),
  };
}

/**
 * Counts `cost` against the session budget, or refuses when it doesn't fit.
 * Returns the budget left once it is spent.
 */
async function spend(cost: number) {
  const { budget } = await invoke<McpStatus>("mcp_status");
  const left = budget - useMcpSpend.getState().spent;
  if (cost > left + 1e-9) {
    throw new Error(
      `Refusé : coût estimé ${money(cost)}, budget restant ${money(left)} (plafond ${money(budget)} par session, réglable dans SimpleNode → Réglages → MCP). Demandez à l'utilisateur.`,
    );
  }
  useMcpSpend.setState({ spent: useMcpSpend.getState().spent + cost });
  return left - cost;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TOOLS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  async list_projects() {
    const open = useFlow.getState().projectId;
    return (await listProjects())
      .filter((p) => !p.trashed)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => ({ id: p.id, title: p.title, updated_at: new Date(p.updatedAt).toISOString(), open: p.id === open }));
  },

  async open_project({ id }) {
    useFlow.getState().openProject(await loadProject(String(id)));
    return graph();
  },

  async create_project({ title }) {
    const project = { id: newProjectId(), title: String(title || "Sans titre"), updatedAt: 0, thumbnail: null, trashed: false, nodes: [], edges: [] };
    await saveProject(project);
    useFlow.getState().openProject(project);
    return { id: project.id, title: project.title };
  },

  async get_graph() {
    requireProject();
    return graph();
  },

  async list_node_types() {
    const models = useModels.getState().models;
    return libraryItems(models).map((item) => {
      const def = item.modelId ? findModel(item.modelId) : undefined;
      return {
        kind: item.kind,
        model_id: item.modelId ?? null,
        label: item.label,
        group: item.group,
        description: item.hint,
        ...(def && {
          category: def.category,
          max_reference_images: def.maxRefs,
          settings: def.params.map((p) => ({ key: p.key, options: p.options, default: p.default })),
        }),
      };
    });
  },

  async get_model_settings({ model_id }) {
    const def = findModel(String(model_id));
    if (!def) throw new Error(`Modèle inconnu : ${String(model_id)}`);
    const endpoints = [def.textEndpoint, def.editEndpoint].filter(Boolean) as string[];
    const lists = await Promise.all(endpoints.map((endpoint) => invoke("model_settings", { endpoint }).then((settings) => ({ endpoint, settings }))));
    return { model_id: def.id, note: "Réglez-les avec update_node, params \"x:<key>\".", endpoints: lists };
  },

  async add_node(args) {
    requireProject();
    const kind = String(args.kind) as NodeKind;
    const modelId = args.model_id ? String(args.model_id) : undefined;
    const known = libraryItems(useModels.getState().models).some((i) => i.kind === kind && (kind !== "model" || i.modelId === modelId));
    if (!known) throw new Error(`Type de nœud inconnu : ${kind}${modelId ? ` / ${modelId}` : ""} (voir list_node_types)`);
    const s = useFlow.getState();
    const id = s.addNode(kind, placement(args), modelId);
    const node = requireNode(id);
    const params = { ...node.data.params, ...((args.params as Record<string, string>) ?? {}) };
    s.patchNode(id, { params, ...(args.title ? { title: String(args.title) } : {}) });
    return graph().nodes.find((n) => n.id === id);
  },

  async update_node({ id, params, title }) {
    const node = requireNode(id);
    const next = { ...node.data.params };
    for (const [k, v] of Object.entries((params as Record<string, unknown>) ?? {})) {
      if (v === null) delete next[k];
      else next[k] = String(v);
    }
    useFlow.getState().patchNode(node.id, { params: next, ...(title !== undefined ? { title: String(title) } : {}) });
    return graph().nodes.find((n) => n.id === node.id);
  },

  async delete_node({ id }) {
    useFlow.getState().deleteNode(requireNode(id).id);
    return { deleted: id };
  },

  async connect({ source, source_handle, target, target_handle }) {
    const s = useFlow.getState();
    const from = requireNode(source);
    requireNode(target);
    const outputs = portsFor(from.data).outputs;
    const handle = source_handle ? String(source_handle) : outputs[0]?.id;
    if (!handle) throw new Error("Ce nœud n'a pas de sortie");
    if (target_handle) {
      const c = { source: String(source), sourceHandle: handle, target: String(target), targetHandle: String(target_handle) };
      if (!s.isValidConnection(c)) throw new Error("Liaison impossible : ports incompatibles, inexistants ou boucle (voir get_graph)");
      s.onConnect(c);
    } else if (!s.autoConnect({ nodeId: String(source), handleId: handle, side: "source" }, String(target))) {
      throw new Error("Aucune entrée compatible sur le nœud cible");
    }
    return graph().edges.filter((e) => e.target === target);
  },

  async disconnect({ target, target_handle }) {
    useFlow.getState().disconnect(requireNode(target).id, String(target_handle));
    return graph().edges.filter((e) => e.target === target);
  },

  async import_media(args) {
    requireProject();
    const stored = await invoke<string>("import_image", { path: String(args.path) });
    const media = /\.(mp4|mov|webm)$/i.test(stored) ? "video" : /\.(mp3|wav|m4a|aac|ogg)$/i.test(stored) ? "audio" : "image";
    const s = useFlow.getState();
    const id = s.addNode("image", placement(args));
    s.patchNode(id, { params: { ...requireNode(id).data.params, path: stored, media }, outputs: { [media]: stored }, status: "done" });
    return { id, output: media, value: stored };
  },

  async estimate_cost({ node_id }) {
    requireProject();
    if (node_id) requireNode(node_id);
    const est = await estimate(node_id ? String(node_id) : undefined);
    const { budget } = await invoke<McpStatus>("mcp_status");
    return { estimated_cost: est.total, nodes: est.nodes, cost_unknown_for: est.unknown, budget_left: budget - useMcpSpend.getState().spent };
  },

  async run({ node_id }) {
    requireProject();
    const target = node_id ? requireNode(node_id).id : undefined;
    const s = useFlow.getState();
    if (s.runs.includes(target ?? "*")) throw new Error("Cette exécution est déjà en cours : utilisez wait_for_run.");
    const est = await estimate(target);
    if (est.unknown.length) {
      throw new Error(
        `Coût non estimable pour : ${est.unknown.join(", ")}. Lancez-les vous-même dans SimpleNode (le plafond de dépenses ne peut pas être vérifié).`,
      );
    }
    const left = await spend(est.total);
    void s.run(target);
    return { started: true, estimated_cost: est.total, nodes: est.nodes, budget_left: left, next: "wait_for_run" };
  },

  async finalize_draft({ node_id }) {
    requireProject();
    const node = requireNode(node_id);
    if (!node.data.outputs.draftId) throw new Error("Ce nœud n'a pas de brouillon Seedance à finaliser (lancez d'abord Seedance 2.5 Draft).");
    const expiry = draftExpiry(node.data);
    if (expiry && expiry.getTime() <= Date.now()) throw new Error(`Brouillon expiré le ${dayMonth(expiry)} : fal ne le garde que ${DRAFT_DAYS} jours.`);
    const est = finalizeEstimate(node.data);
    if (!est) throw new Error("Coût non estimable pour ce brouillon. Finalisez-le vous-même dans SimpleNode.");
    const left = await spend(est.cost);
    const video = await finalizeDraft(node.id);
    return {
      video,
      estimated_cost: est.cost,
      ...(est.auto && { note: `Durée « auto » : estimée sur ${est.seconds} s.` }),
      budget_left: left,
    };
  },

  async wait_for_run({ timeout_seconds }) {
    requireProject();
    const limit = Math.min(Math.max(Number(timeout_seconds) || 120, 1), 600) * 1000;
    const start = Date.now();
    // The run starts on the next tick: give it a moment to show up.
    await sleep(300);
    const busy = () => {
      const s = useFlow.getState();
      return s.runs.length > 0 || s.nodes.some((n) => n.data.status === "running");
    };
    while (busy() && Date.now() - start < limit) await sleep(500);
    const g = graph();
    return {
      finished: !busy(),
      nodes: g.nodes.map(({ id, title, status, error, outputs }) => ({ id, title, status, error, outputs: outputs.filter((o) => o.value) })),
    };
  },

  async stop({ node_id }) {
    useFlow.getState().stop(node_id ? [requireNode(node_id).id] : undefined);
    return { stopped: node_id ?? "tout" };
  },
};

/** Answers tool calls from the MCP server for as long as the app is open. */
export function listenToMcp() {
  return listen<{ id: number; tool: string; args: Record<string, unknown> }>("mcp-request", async ({ payload }) => {
    const { id, tool, args } = payload;
    try {
      const fn = TOOLS[tool];
      if (!fn) throw new Error(`Outil inconnu : ${tool}`);
      const result = await fn(args ?? {});
      await invoke("mcp_reply", { id, ok: true, result: result ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await invoke("mcp_reply", { id, ok: false, result: message });
    }
  });
}
