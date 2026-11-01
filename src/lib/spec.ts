import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/** `views`: a set of labelled images (camera angles, grid tiles), JSON-encoded. */
export type PortType = "text" | "image" | "video" | "audio" | "views" | "any";

export type NodeKind =
  | "prompt"
  | "image"
  | "model"
  | "preview"
  | "router"
  | "concat"
  | "crop"
  | "enhancer"
  | "describer"
  | "videoDescriber"
  | "list"
  | "gridCrop"
  | "angles"
  | "anglePick"
  | "angleExport"
  | "recast"
  | "addAudio"
  | "compositor";

export type NodeStatus = "idle" | "running" | "done" | "error";

export interface Port {
  id: string;
  label: string;
  type: PortType;
  /** Accepts several incoming edges (values arrive as a list in Rust). */
  multiple?: boolean;
}

/** Mirrors `models::ModelDef` in src-tauri; the Rust registry is the source of truth. */
export interface ModelParam {
  key: string;
  label: string;
  options: string[];
  default: string;
  kind: "enum" | "int" | "bool";
  /** Not sent to the image-to-video / edit endpoint. */
  textOnly: boolean;
}

export interface ModelDef {
  id: string;
  label: string;
  provider: string;
  category: "image" | "video" | "llm" | "audio";
  textEndpoint: string | null;
  editEndpoint: string | null;
  refField: "urls" | "url" | "startImage" | "referenceUrls";
  maxRefs: number;
  endField: string | null;
  /** Renders a 480p preview that can be finalized in 1080p. */
  draft: boolean;
  /** Accepts a negative prompt. */
  negative: boolean;
  /** Port label for the references when the generic one would mislead. */
  refsLabel: string | null;
  /** Extra media inputs (style images, mask, keyframes, audio…); `edit` ones only go with references. */
  media: { key: string; label: string; kind: "image" | "video" | "audio"; multiple: boolean; mode: "both" | "edit" }[];
  params: ModelParam[];
}

export interface NodeData extends Record<string, unknown> {
  kind: NodeKind;
  params: Record<string, string>;
  outputs: Record<string, string>;
  status: NodeStatus;
  error?: string;
  /** Model nodes: every media result so far, oldest first. */
  history?: string[];
  /** User-chosen title; the node's default title when absent. */
  title?: string;
  /** Image chosen as the project's cover on the home page. */
  cover?: string;
}

export const PORT_COLORS: Record<PortType, string> = {
  text: "#e8b04a",
  image: "#8b7bff",
  video: "#3ecfa0",
  audio: "#4fb3ff",
  views: "#e86fb5",
  any: "#9a9aa3",
};

/** Mirrors `angles::Shot` in src-tauri. */
export interface Shot {
  id: string;
  label: string;
}

/** Mirrors `recast::Mode` in src-tauri. */
export interface RecastMode {
  id: string;
  label: string;
  hint: string;
  /** Instructions a new node starts with. */
  prompt: string;
  /** Best first; `note` gives the endpoint's limits. */
  models: { id: string; note: string }[];
}

/** Registries served by Rust: models, camera shots and recast modes. */
export const useModels = create<{ models: ModelDef[]; shots: Shot[]; recastModes: RecastMode[]; load: () => Promise<void> }>((set) => ({
  models: [],
  shots: [],
  recastModes: [],
  load: async () => {
    const [models, shots, recastModes] = await Promise.all([
      invoke<ModelDef[]>("list_models"),
      invoke<Shot[]>("camera_shots"),
      invoke<RecastMode[]>("recast_modes"),
    ]);
    set({ models, shots, recastModes });
  },
}));

/** Recast models only run inside a Recast node, never as a plain model node. */
export function isRecastModel(id: string) {
  return useModels.getState().recastModes.some((m) => m.models.some((c) => c.id === id));
}

/** A Recast node's params for `mode` and one of its models (the mode's best by default). */
export function recastParams(mode: string, modelId?: string): Record<string, string> {
  const choices = useModels.getState().recastModes.find((m) => m.id === mode)?.models ?? [];
  const id = choices.some((c) => c.id === modelId) ? modelId! : (choices[0]?.id ?? "");
  const params: Record<string, string> = { mode, modelId: id };
  findModel(id)?.params.forEach((p) => (params[p.key] = p.default));
  return params;
}

/** The instructions a recast node of this mode starts with. */
export function recastPrompt(mode: string): string {
  return useModels.getState().recastModes.find((m) => m.id === mode)?.prompt ?? "";
}

/** Grid layouts of the camera angles node as [columns, rows]; same as `angles::LAYOUTS`. */
export const ANGLE_LAYOUTS: [number, number][] = [
  [2, 2],
  [3, 2],
  [2, 3],
  [3, 3],
  [3, 4],
  [2, 6],
  [4, 4],
];

/** Default shot order, enough for the largest layout (4×4). */
export const DEFAULT_SHOTS = [
  "close", "extreme", "pov", "medium", "low", "ots", "high", "tracking",
  "reveal", "wide", "dutch", "birdseye", "long", "cowboy", "tight", "cutaway",
];

export function angleLayout(params: Record<string, string>): [number, number] {
  const [c, r] = (params.layout ?? "").split("x").map(Number);
  return ANGLE_LAYOUTS.find(([lc, lr]) => lc === c && lr === r) ?? [3, 4];
}

/** Chosen shot ids, resized to the layout: kept in order, gaps filled with unused defaults. */
export function angleShots(params: Record<string, string>): string[] {
  const [c, r] = angleLayout(params);
  let chosen: string[] = [];
  try {
    chosen = JSON.parse(params.shots ?? "[]");
  } catch {}
  const shots = chosen.slice(0, c * r);
  for (const id of DEFAULT_SHOTS) {
    if (shots.length >= c * r) break;
    if (!shots.includes(id)) shots.push(id);
  }
  return shots;
}

export function findModel(id: string | undefined) {
  return useModels.getState().models.find((m) => m.id === id);
}

/** Must match `compose::MAX_LAYERS` in src-tauri. */
export const MAX_LAYERS = 12;

/** Numbers of a compositor's layer inputs, 1 to n, above its background. */
export function compositorLayers(params: Record<string, string>): number[] {
  const n = Math.min(Math.max(Number(params.layers) || 0, 0), MAX_LAYERS);
  return Array.from({ length: n }, (_, i) => i + 1);
}

/** The name the user gave a compositor layer, if any. */
function layerName(params: Record<string, string>, port: string): string | undefined {
  try {
    return JSON.parse(params.comp || "{}")[port]?.name || undefined;
  } catch {
    return undefined;
  }
}

/** Numbers of a model's reference inputs (Image 1, Image 2…), for models taking several. */
export function refNumbers(model: ModelDef, params: Record<string, string>): number[] {
  const n = Math.min(Math.max(Number(params.refs) || 1, 1), model.maxRefs);
  return Array.from({ length: n }, (_, i) => i + 1);
}

/** A model input carrying reference images: the single `refs`, or a numbered `refN`. */
export function isRefPort(id: string | null | undefined) {
  return id === "refs" || /^ref\d+$/.test(id ?? "");
}

export function portsFor(data: Pick<NodeData, "kind" | "params">): { inputs: Port[]; outputs: Port[] } {
  switch (data.kind) {
    case "prompt":
      return {
        inputs: promptVars(data.params).map((name) => ({ id: `var:${name}`, label: varLabel(name), type: "text" })),
        outputs: [{ id: "text", label: "Texte", type: "text" }],
      };
    case "list":
      return { inputs: [], outputs: [{ id: "text", label: "Élément choisi", type: "text" }] };
    case "image": {
      const media = data.params.media === "video" || data.params.media === "audio" ? data.params.media : "image";
      const label = { image: "Image", video: "Vidéo", audio: "Audio" }[media];
      return { inputs: [], outputs: [{ id: media, label, type: media }] };
    }
    case "preview":
      // Passes its value on, so a result checked here can feed the next step.
      return { inputs: [{ id: "value", label: "Entrée", type: "any" }], outputs: [{ id: "value", label: "Sortie", type: "any" }] };
    case "router":
      return { inputs: [{ id: "value", label: "Entrée", type: "any" }], outputs: [{ id: "value", label: "Sortie", type: "any" }] };
    case "concat":
      return {
        inputs: [{ id: "texts", label: "Textes", type: "text", multiple: true }],
        outputs: [{ id: "text", label: "Texte", type: "text" }],
      };
    case "crop":
      return { inputs: [{ id: "image", label: "Image", type: "image" }], outputs: [{ id: "image", label: "Image", type: "image" }] };
    case "compositor":
      return {
        inputs: [
          { id: "bg", label: layerName(data.params, "bg") ?? "Arrière-plan", type: "any" },
          ...compositorLayers(data.params).map((i): Port => ({ id: `layer${i}`, label: layerName(data.params, `layer${i}`) ?? `Calque ${i}`, type: "any" })),
        ],
        outputs: [{ id: "media", label: "Sortie", type: "any" }],
      };
    case "addAudio":
      return {
        inputs: [
          { id: "video", label: "Vidéo", type: "video" },
          { id: "audio", label: "Son", type: "audio" },
        ],
        outputs: [{ id: "video", label: "Vidéo", type: "video" }],
      };
    case "angles": {
      return {
        inputs: [
          { id: "image", label: "Référence", type: "image" },
          { id: "context", label: "Contexte (optionnel)", type: "text" },
        ],
        outputs: [{ id: "views", label: "Plans", type: "views" }],
      };
    }
    case "anglePick":
      return { inputs: [{ id: "views", label: "Plans", type: "views" }], outputs: [{ id: "image", label: "Plan choisi", type: "image" }] };
    case "angleExport":
      return { inputs: [{ id: "views", label: "Plans", type: "views" }], outputs: [] };
    case "gridCrop":
      return { inputs: [{ id: "image", label: "Planche", type: "image" }], outputs: [{ id: "views", label: "Vues", type: "views" }] };
    case "enhancer":
      return { inputs: [{ id: "text", label: "Prompt", type: "text", multiple: true }], outputs: [{ id: "text", label: "Prompt", type: "text" }] };
    case "describer":
      return { inputs: [{ id: "image", label: "Image", type: "image" }], outputs: [{ id: "text", label: "Texte", type: "text" }] };
    case "videoDescriber":
      return { inputs: [{ id: "video", label: "Vidéo", type: "video" }], outputs: [{ id: "text", label: "Texte", type: "text" }] };
    case "recast": {
      const most = findModel(data.params.modelId)?.maxRefs ?? 1;
      return {
        inputs: [
          { id: "video", label: "Vidéo source", type: "video" },
          { id: "characters", label: most > 1 ? `Personnages (≤${most})` : "Personnage", type: "image", multiple: most > 1 },
          { id: "prompt", label: "Consignes (optionnel)", type: "text", multiple: true },
        ],
        outputs: [{ id: "video", label: "Vidéo", type: "video" }],
      };
    }
    case "model": {
      const model = findModel(data.params.modelId);
      const inputs: Port[] = [{ id: "prompt", label: "Prompt", type: "text", multiple: true }];
      // Prompt and negative prompt first, then media, as in Weave.
      if (model?.negative) inputs.push({ id: "negative", label: "Prompt négatif", type: "text", multiple: true });
      const isVideo = model?.category === "video";
      if (model && model.maxRefs > 1) {
        // One input per reference, so their order (image 1, image 2…) is explicit.
        for (const i of refNumbers(model, data.params)) inputs.push({ id: `ref${i}`, label: `Image ${i}`, type: "image" });
      } else if (model && model.maxRefs > 0) {
        inputs.push({
          id: "refs",
          label: model.refsLabel ?? (isVideo ? "Image de départ" : model.maxRefs > 1 ? `Références (≤${model.maxRefs})` : "Référence"),
          type: "image",
          multiple: model.maxRefs > 1,
        });
      }
      if (model?.endField) inputs.push({ id: "endFrame", label: "Image de fin", type: "image" });
      for (const m of model?.media ?? []) {
        inputs.push({
          id: `media:${m.key}`,
          label: m.mode === "edit" ? `${m.label} (avec réf.)` : m.label,
          type: m.kind,
          multiple: m.multiple,
        });
      }
      const out: Port =
        model?.category === "llm"
          ? { id: "text", label: "Texte", type: "text" }
          : model?.category === "audio"
            ? { id: "audio", label: "Son", type: "audio" }
            : isVideo
            ? { id: "video", label: "Vidéo", type: "video" }
            : { id: "image", label: "Image", type: "image" };
      return { inputs, outputs: [out] };
    }
  }
}

/** "var2" -> "Variable 2". */
export function varLabel(name: string) {
  const n = /^var(\d+)$/.exec(name)?.[1];
  return n ? `Variable ${n}` : name;
}

/** Variable names declared on a Prompt node (`params.vars`, comma-separated). */
export function promptVars(params: Record<string, string>): string[] {
  return (params.vars ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

/** Same cap as `storage::MAX_GRID` in Rust. */
export const MAX_GRID = 6;

/** Rows and columns of a Grid Crop node, clamped to 1..MAX_GRID. */
export function gridSize(params: Record<string, string>) {
  const clamp = (v: string | undefined) => Math.min(Math.max(Number(v) || 2, 1), MAX_GRID);
  return { rows: clamp(params.rows), cols: clamp(params.cols) };
}

/** Mirrors `storage::View` in Rust. */
export interface View {
  path: string;
  label: string;
}

/** Decodes a `views` port value; anything else gives an empty set. */
export function parseViews(value: string | undefined): View[] {
  if (!value?.startsWith("[")) return [];
  try {
    const views = JSON.parse(value);
    return Array.isArray(views) ? views.filter((v) => typeof v?.path === "string") : [];
  } catch {
    return [];
  }
}

/** Items of a List node (`params.items`, a JSON array). */
export function listItems(params: Record<string, string>): string[] {
  try {
    const items = JSON.parse(params.items ?? "[]");
    return Array.isArray(items) ? items.map(String) : [];
  } catch {
    return [];
  }
}

export function defaultParams(kind: NodeKind, modelId?: string): Record<string, string> {
  switch (kind) {
    case "prompt":
      return { text: "", vars: "" };
    case "list":
      return { items: JSON.stringify(["", ""]), selected: "0" };
    case "image":
      return { path: "", media: "image" };
    case "preview":
    case "router":
      return {};
    case "concat":
      return { separator: "newline" };
    case "crop":
      return { aspect: "free", x: "0", y: "0", w: "100", h: "100" };
    case "addAudio":
      return { offset: "0" };
    case "compositor":
      return { layers: "1", comp: "{}", width: "", height: "", timeline: "false" };
    case "gridCrop":
      return { rows: "2", cols: "2", inset: "0" };
    case "anglePick":
      return { selected: "0" };
    case "angleExport":
      return { folder: "" };
    case "angles":
      return {
        modelId: "nano-banana-pro",
        layout: "3x4",
        shots: JSON.stringify(DEFAULT_SHOTS.slice(0, 12)),
        mode: "sheet",
        panel: "16:9",
        resolution: "2K",
        labels: "false",
        inset: "0",
      };
    case "enhancer":
      return { model: DEFAULT_LLM, text: "" };
    case "describer":
      return { model: DEFAULT_LLM, detail: "long" };
    case "videoDescriber":
      return { question: "", detailed: "false" };
    case "recast":
      return { ...recastParams("replace"), prompt: recastPrompt("replace"), segment: "10" };
    case "model": {
      const model = findModel(modelId);
      const params: Record<string, string> = { modelId: modelId ?? "", prompt: "" };
      model?.params.forEach((p) => (params[p.key] = p.default));
      if (model?.category === "llm") params.system = "";
      if (model && model.maxRefs > 1) params.refs = "1";
      return params;
    }
  }
}

/** `any` is checked at run time, so it connects to everything. */
export function portsCompatible(source: PortType, target: PortType) {
  return source === "any" || target === "any" || source === target;
}

const DEFAULT_LLM = "google/gemini-2.5-flash";

/** LLM choices for the text helpers, taken from the registry's `llm` entry. */
export function llmOptions() {
  return findModel("llm")?.params.find((p) => p.key === "model")?.options ?? [DEFAULT_LLM];
}

/** A library entry: either a built-in node or a specific model. */
export interface LibraryItem {
  key: string;
  kind: NodeKind;
  modelId?: string;
  label: string;
  hint: string;
  group: "inputs" | "tools" | "image" | "video" | "audio" | "text" | "outputs";
}

/** Models listed with audio though they return a video: they give it sound. */
const AUDIO_TOOLS = new Set(["mmaudio-v2-video"]);

export function libraryItems(models: ModelDef[]): LibraryItem[] {
  return [
    { key: "prompt", kind: "prompt", label: "Prompt", hint: "Texte libre", group: "inputs" },
    { key: "image", kind: "image", label: "Import", hint: "Image, vidéo ou audio local", group: "inputs" },
    { key: "list", kind: "list", label: "List", hint: "Choisir un texte parmi plusieurs", group: "tools" },
    { key: "angles", kind: "angles", label: "Angles caméra", hint: "Génère plusieurs plans d'une image (IA)", group: "tools" },
    { key: "anglePick", kind: "anglePick", label: "Aperçu des angles", hint: "Choisir un plan parmi les angles", group: "tools" },
    { key: "gridCrop", kind: "gridCrop", label: "Grid Crop", hint: "Découpe une planche existante (ne génère rien)", group: "tools" },
    { key: "router", kind: "router", label: "Router", hint: "Une entrée vers plusieurs sorties", group: "tools" },
    { key: "concat", kind: "concat", label: "Prompt Concatenator", hint: "Assembler plusieurs textes", group: "tools" },
    { key: "crop", kind: "crop", label: "Crop", hint: "Recadrer une image", group: "tools" },
    { key: "enhancer", kind: "enhancer", label: "Prompt Enhancer", hint: "Enrichir un prompt (LLM)", group: "text" },
    { key: "describer", kind: "describer", label: "Image Describer", hint: "Image → texte (LLM)", group: "text" },
    { key: "videoDescriber", kind: "videoDescriber", label: "Video Describer", hint: "Vidéo → texte", group: "text" },
    { key: "compositor", kind: "compositor", label: "Compositeur", hint: "Calques d'images, de vidéos et de sons", group: "video" },
    { key: "recast", kind: "recast", label: "Recast", hint: "Vidéo source + personnage → nouvelle vidéo", group: "video" },
    { key: "addAudio", kind: "addAudio", label: "Ajouter le son", hint: "Pose une piste son sur une vidéo", group: "audio" },
    ...models.filter((m) => !isRecastModel(m.id)).map<LibraryItem>((m) => ({
      key: m.id,
      kind: "model",
      modelId: m.id,
      label: m.label,
      hint: m.provider,
      group: m.category === "llm" ? "text" : AUDIO_TOOLS.has(m.id) ? "audio" : m.category,
    })),
    { key: "angleExport", kind: "angleExport", label: "Export des angles", hint: "Enregistrer tous les plans dans un dossier", group: "outputs" },
    { key: "preview", kind: "preview", label: "Preview", hint: "Afficher un résultat", group: "outputs" },
  ];
}
