"use client";

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { dollars, useVideoDuration } from "@/lib/cost";
import { IMAGE_UPSCALE_FORMATS, IMAGE_UPSCALE_RESOLUTIONS, imageUpscaleCost, UPSCALE_FIDELITY, UPSCALE_FORMATS, UPSCALE_FPS, UPSCALE_LOOKS, UPSCALE_QUALITY, UPSCALE_RESOLUTIONS, VOICES, VOICE_STABILITY } from "@/lib/tools";
import { DRAFT_DAYS, dayMonth, draftExpired, draftExpiry, draftProvider, finalizeDraft, finalizeEstimate } from "@/lib/draft";
import {
  SEEDANCE_DURATIONS,
  SEEDANCE_MAX_REFS,
  SEEDANCE_RATIOS,
  bpSeedanceEstimate,
  bpSeedreamCost,
  missingKey,
  trustExpiry,
  useBytePlusKeys,
} from "@/lib/byteplus";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Handle, NodeResizer, Position, useNodeId, useUpdateNodeInternals, useStore as useFlowStore, type NodeProps } from "@xyflow/react";
import {
  ArrowRight,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Crop,
  Download,
  Drama,
  Eye,
  FileText,
  Film,
  FolderDown,
  FolderOpen,
  ImageIcon,
  ImageUp,
  Images,
  Loader2,
  Maximize2,
  ListChecks,
  Grid3x3,
  Merge,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Split,
  Type,
  X,
  WandSparkles,
  type LucideIcon,
  Square,
  AudioLines,
  Layers,
  Minus,
  Pencil,
  Star,
  ScanFace,
  TriangleAlert,
  KeyRound,
  Frame,
  ScrollText,
  MonitorUp,
  ImageUpscale,
  Mic,
  UserRound,
} from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFlow, useRunning, type FlowNode } from "@/lib/store";
import ProviderIcon from "./ProviderIcon";
import CompositorEditor, { type LayerInput } from "./CompositorEditor";
import CropEditor from "./CropEditor";
import { runnerLabel, useKeys } from "@/lib/provider";
import TemplateEditor, { type TemplateEditorHandle, type VarDisplay } from "./TemplateEditor";
import { ANGLE_LAYOUTS, MAX_GRID, MAX_LAYERS, compositorLayers, refNumbers, PORT_COLORS, varLabel, angleLayout, angleShots, findModel, gridSize, parseViews, listItems, llmOptions, portsFor, promptVars, recastParams, recastPrompt, useModels, type Port, type View } from "@/lib/spec";
import { optionLabel } from "@/lib/settingLabels";

const field =
  "nodrag w-full rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-xs text-fg outline-none placeholder:text-muted focus:border-accent";

const HANDLE_TOP = 22;
const HANDLE_STEP = 30;

/** Remote URLs pass through; local paths go through Tauri's asset protocol. */
function mediaSrc(value: string) {
  return /^https?:\/\//.test(value) ? value : convertFileSrc(value);
}

/** Infers what a value is from its shape: routers and previews are untyped. */
function valueKind(value: string): "image" | "video" | "audio" | "views" | "text" {
  if (parseViews(value).length) return "views";
  const isFile = value.startsWith("/") || /^https?:\/\//.test(value);
  if (isFile && /\.(mp4|mov|webm)$/i.test(value)) return "video";
  if (isFile && /\.(mp3|wav|m4a|aac|ogg)$/i.test(value)) return "audio";
  if (isFile && /\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(value)) return "image";
  return "text";
}

const VIDEO_EXTENSIONS = ["mp4", "mov", "webm"];
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
const AUDIO_EXTENSIONS = ["mp3", "wav", "m4a", "aac", "ogg"];

function Handles({ ports, side, step = HANDLE_STEP }: { ports: Port[]; side: "in" | "out"; step?: number }) {
  const isIn = side === "in";
  return ports.map((port, i) => {
    const top = HANDLE_TOP + i * step;
    return (
      <div key={port.id}>
        <Handle
          type={isIn ? "target" : "source"}
          position={isIn ? Position.Left : Position.Right}
          id={port.id}
          className="!h-3.5 !w-3.5 !border-[3px] !border-bg"
          style={{ top, background: PORT_COLORS[port.type] }}
        />
        <span
          className="pointer-events-none absolute rounded bg-bg/80 px-1 text-[10px] whitespace-nowrap text-muted opacity-0 transition-opacity group-hover:opacity-100"
          style={{
            top: top - 7,
            ...(isIn ? { right: "calc(100% + 12px)" } : { left: "calc(100% + 12px)" }),
          }}
        >
          {port.label}
        </span>
      </div>
    );
  });
}

/** A node's run button, which turns into Stop while it runs. */
function RunStop({ id, running, title }: { id: string; running: boolean; title: string }) {
  const run = useFlow((s) => s.run);
  const stop = useFlow((s) => s.stop);
  return running ? (
    <button
      className="nodrag flex items-center gap-1.5 rounded-lg border border-danger-tint/50 px-3 py-1.5 text-[12px] text-danger hover:bg-danger-tint/10"
      onClick={() => stop([id])}
      title="Stops this node and cancels its request"
    >
      <Square size={11} fill="currentColor" /> Stop
    </button>
  ) : (
    <button className="nodrag flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] hover:border-accent" onClick={() => run(id)} title={title}>
      <ArrowRight size={13} /> Run
    </button>
  );
}

function NodeShell({
  id,
  data,
  selected,
  icon,
  title,
  subtitle,
  runnable = true,
  cardWidth = 300,
  handleStep = HANDLE_STEP,
  fitHeight = false,
  modelId,
  llmModel,
  children,
}: NodeProps<FlowNode> & {
  icon: LucideIcon;
  title: string;
  /** Registry model whose provider logo replaces the icon. */
  modelId?: string;
  llmModel?: string;
  subtitle?: string;
  runnable?: boolean;
  /** Not `width`: React Flow already passes a `width` prop to every node. */
  cardWidth?: number;
  /** Vertical spacing of ports; tighter for nodes with many outputs. */
  handleStep?: number;
  /** Grows with its content even once resized by hand: for cards whose
   *  content changes length (Recast's segments), which would overflow. */
  fitHeight?: boolean;
  children: ReactNode;
}) {
  const run = useFlow((s) => s.run);
  const stop = useFlow((s) => s.stop);
  const running = useRunning(id);
  const checkpoint = useFlow((s) => s.checkpoint);
  const renaming = useFlow((s) => s.renamingId === id);
  const setRenaming = useFlow((s) => s.setRenaming);
  const renameNode = useFlow((s) => s.renameNode);
  // Only set once resized by hand; until then the card sizes to its content.
  const resized = useFlow((s) => !!s.nodes.find((n) => n.id === id)?.width);
  // Re-render once the registry loads so model ports appear.
  useModels((s) => s.models.length);
  const { inputs, outputs } = portsFor(data);
  // React Flow measures a node's handles once; when ports come and go (a new
  // prompt variable, another grid size, a different model) it must re-measure,
  // or the new handles can't be connected and their edges don't draw.
  const updateNodeInternals = useUpdateNodeInternals();
  const portsKey = [...inputs, ...outputs].map((p) => p.id).join("|");
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, portsKey, handleStep, updateNodeInternals]);
  const ring =
    data.status === "error" ? "border-danger-tint/70" : selected ? "border-accent" : "border-line hover:border-line-hover";
  // Tall enough for every port, so none hangs below the card.
  const minHeight = HANDLE_TOP + Math.max(inputs.length, outputs.length, 1) * handleStep + 8;

  return (
    <div
      data-resized={resized || undefined}
      className={`group group/card relative flex flex-col rounded-2xl border bg-panel shadow-2xl shadow-shadow/50 transition-colors ${ring}`}
      style={
        !resized
          ? { width: cardWidth, minHeight }
          : fitHeight
            ? { width: "100%", minHeight: `max(100%, ${minHeight}px)` }
            : { width: "100%", height: "100%", minHeight }
      }
    >
      <NodeResizer
        isVisible={selected}
        minWidth={220}
        minHeight={Math.max(minHeight, 120)}
        onResizeStart={checkpoint}
        lineClassName="!border-transparent"
        handleClassName="!h-2.5 !w-2.5 !rounded-sm !border-2 !border-accent !bg-bg"
      />
      <Handles ports={inputs} side="in" step={handleStep} />
      <Handles ports={outputs} side="out" step={handleStep} />
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
        <ProviderIcon modelId={modelId} llmModel={llmModel} size={15} fallback={icon} className="text-muted" />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <input
              autoFocus
              defaultValue={data.title ?? title}
              placeholder={title}
              className="nodrag nokey w-full rounded border border-accent bg-panel-2 px-1 text-[13px] font-medium outline-none"
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => renameNode(id, e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <div className="truncate text-[13px] font-medium" onDoubleClick={() => setRenaming(id)} title="Double-click to rename">
              {data.title || title}
            </div>
          )}
          {subtitle && <div className="truncate text-[10px] text-muted">{subtitle}</div>}
        </div>
        {data.status === "running" && <Loader2 size={14} className="animate-spin text-accent" />}
        {runnable &&
          (running ? (
            <button
              className="nodrag grid h-6 w-6 place-items-center rounded-md text-danger hover:bg-danger-tint/10"
              onClick={() => stop([id])}
              title="Stop this node (cancels its request)"
            >
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button
              className="nodrag grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-fg"
              onClick={() => run(id)}
              title="Run up to this node"
            >
              <Play size={12} fill="currentColor" />
            </button>
          ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-3.5 pb-3.5">{children}</div>
      {data.error && <div className="mx-3.5 mb-3 rounded-lg bg-danger-tint/10 px-2.5 py-1.5 text-[11px] text-danger">{data.error}</div>}
    </div>
  );
}

function useParam(id: string, data: FlowNode["data"], key: string) {
  const setParam = useFlow((s) => s.setParam);
  return [data.params[key] ?? "", (v: string) => setParam(id, key, v)] as const;
}

/** Hides an inline field once the matching input port is wired. */
function useConnected(id: string, handle: string) {
  return useFlowStore((s) => s.edges.some((e) => e.target === id && e.targetHandle === handle));
}

/** Value produced by whatever is wired into `handle`, if it has run. */
function useInputValue(id: string, handle: string) {
  return useFlowStore((s) => {
    const edge = s.edges.find((e) => e.target === id && e.targetHandle === handle);
    if (!edge) return undefined;
    const src = s.nodeLookup.get(edge.source)?.data as FlowNode["data"] | undefined;
    return src?.outputs[edge.sourceHandle ?? ""];
  });
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] text-muted">{label}</span>
      <select className={field} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** "Ben's shot" -> "ben-s-shot"; same rule as `storage::slug` in Rust. */
function slugify(label: string) {
  return label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Saves a result where the user picks. Only for files the app stored itself
 * (generated or imported), which is what results are.
 */
function DownloadButton({ path, name, className }: { path: string; name?: string; className: string }) {
  const [state, setState] = useState<"idle" | "done" | "error">("idle");
  if (!path.startsWith("/")) return null;
  const ext = path.split(".").pop() ?? "png";
  const fileName = name ? `${slugify(name)}.${ext}` : path.split("/").pop();

  async function download(e: ReactMouseEvent) {
    e.stopPropagation();
    const dest = await save({ defaultPath: fileName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!dest) return;
    try {
      await invoke("save_media", { source: path, dest });
      setState("done");
    } catch {
      setState("error");
    }
    setTimeout(() => setState("idle"), 1500);
  }

  return (
    <button type="button" onClick={download} title={state === "error" ? "Save failed" : "Download"} className={className}>
      {state === "done" ? <Check size={14} /> : state === "error" ? <X size={14} /> : <Download size={14} />}
    </button>
  );
}

/**
 * Saves every generation of a node into a folder the user picks, numbered in
 * history order (name-1.png, name-2.png…).
 */
function DownloadAllButton({ paths, name, className }: { paths: string[]; name?: string; className: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const local = paths.filter((p) => p.startsWith("/"));
  if (local.length < 2) return null;

  async function download(e: ReactMouseEvent) {
    e.stopPropagation();
    const dir = await open({ directory: true, title: `Choose a folder for the ${local.length} generations` });
    if (typeof dir !== "string") return;
    setState("busy");
    const base = slugify(name || "simplenode");
    try {
      for (const [i, path] of local.entries()) {
        await invoke("save_media", { source: path, dest: `${dir}/${base}-${i + 1}.${path.split(".").pop() ?? "png"}` });
      }
      setState("done");
    } catch {
      setState("error");
    }
    setTimeout(() => setState("idle"), 1500);
  }

  return (
    <button
      type="button"
      onClick={download}
      disabled={state === "busy"}
      title={state === "error" ? "Save failed" : `Download all (${local.length})`}
      className={className}
    >
      {state === "busy" ? (
        <Loader2 size={14} className="animate-spin" />
      ) : state === "done" ? (
        <Check size={14} />
      ) : state === "error" ? (
        <X size={14} />
      ) : (
        <FolderDown size={14} />
      )}
    </button>
  );
}

const toolButton = "nodrag grid h-7 w-7 place-items-center rounded-md text-on-overlay/90 hover:bg-on-overlay/15 hover:text-on-overlay";

/** Full-window viewer; Escape or a click outside closes it. */
function Lightbox({ value, name, onClose }: { value: string; name?: string; onClose: () => void }) {
  useEffect(() => {
    // Capture phase, and stop there: Escape closes the viewer only, not the
    // library panel or a menu listening on the same window.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    // Sized against the viewport: a percentage max-height doesn't resolve in
    // the centering container, and the top band stays free for the buttons.
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-overlay/90 px-8 pt-16 pb-8" onClick={onClose}>
      <div className="absolute top-4 right-4 flex gap-1" onClick={(e) => e.stopPropagation()}>
        <DownloadButton path={value} name={name} className={toolButton} />
        <button className={toolButton} onClick={onClose} title="Close (Esc)">
          <X size={16} />
        </button>
      </div>
      {valueKind(value) === "video" ? (
        <video src={mediaSrc(value)} className="max-h-[calc(100vh-6rem)] max-w-[calc(100vw-4rem)] rounded-md" controls autoPlay loop onClick={(e) => e.stopPropagation()} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={mediaSrc(value)} alt="" className="max-h-[calc(100vh-6rem)] max-w-[calc(100vw-4rem)] rounded-md object-contain" onClick={(e) => e.stopPropagation()} />
      )}
    </div>,
    document.body,
  );
}

/**
 * A result: image or video with a toolbar (history, download, full screen)
 * and its pixel size, as on a model node.
 */
function Media({
  value,
  running,
  empty,
  name,
  history,
  onPick,
}: {
  value?: string;
  running?: boolean;
  empty: ReactNode;
  name?: string;
  /** Previous results, oldest first; `onPick` makes one the current output. */
  history?: string[];
  onPick?: (index: number) => void;
}) {
  const [size, setSize] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const index = value && history ? history.indexOf(value) : -1;
  // Images only: the home page shows the cover as a picture.
  const nodeId = useNodeId();
  const setCover = useFlow((s) => s.setCover);
  const isCover = useFlow((s) => !!value && !!nodeId && s.nodes.find((n) => n.id === nodeId)?.data.cover === value);
  const canCover = !!nodeId && !!value && valueKind(value) === "image";
  const browsable = !!onPick && !!history && history.length > 1 && index >= 0;

  return (
    // With media: no border, which drew a halo around the image's corners.
    // No translateZ / will-change here: in the zoomed canvas WebKit then
    // rasterizes the layer at a lower resolution and the image goes blurry.
    <div
      className={`checker relative isolate grid min-h-[180px] place-items-center overflow-hidden rounded-md ${
        value ? "" : "border border-line"
      }`}
    >
      {value && valueKind(value) === "audio" ? (
        <audio src={mediaSrc(value)} className="nodrag w-full px-3" controls />
      ) : value && valueKind(value) === "video" ? (
        <video
          src={mediaSrc(value)}
          className="nodrag block w-full"
          controls
          muted
          loop
          playsInline
          onLoadedMetadata={(e) => setSize(`${e.currentTarget.videoWidth}×${e.currentTarget.videoHeight}`)}
        />
      ) : value ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={mediaSrc(value)}
          alt=""
          className="block w-full"
          draggable={false}
          onLoad={(e) => setSize(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
        />
      ) : (
        <div className="flex flex-col items-center gap-2 text-[11px] text-muted">{empty}</div>
      )}
      {value && (
        <div className="absolute inset-x-0 top-0 flex items-center gap-0.5 bg-gradient-to-b from-overlay/55 to-transparent px-1.5 pt-1.5 pb-4">
          {browsable && (
            <>
              <button className={`${toolButton} disabled:opacity-30`} disabled={index === 0} onClick={() => onPick(index - 1)} title="Previous generation">
                <ChevronLeft size={15} />
              </button>
              <span className="min-w-9 text-center text-[11px] text-on-overlay/90 tabular-nums">
                {index + 1} / {history.length}
              </span>
              <button
                className={`${toolButton} disabled:opacity-30`}
                disabled={index === history.length - 1}
                onClick={() => onPick(index + 1)}
                title="Next generation"
              >
                <ChevronRight size={15} />
              </button>
            </>
          )}
          <div className="ml-auto flex gap-0.5">
            {canCover && (
              <button
                className={toolButton}
                onClick={() => setCover(nodeId, isCover ? null : value)}
                title={isCover ? "Project cover: click to go back to the last generated image" : "Set as the project cover (home page)"}
              >
                <Star size={14} className={isCover ? "fill-warning text-warning" : undefined} />
              </button>
            )}
            <DownloadButton path={value} name={name} className={toolButton} />
            {history && <DownloadAllButton paths={history} name={name} className={toolButton} />}
            <button className={toolButton} onClick={() => setFull(true)} title="Full screen">
              <Maximize2 size={14} />
            </button>
          </div>
        </div>
      )}
      {value && size && (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-overlay/55 px-1.5 py-0.5 text-[10px] text-on-overlay/90 tabular-nums">
          {size}
        </span>
      )}
      {running && <div className="absolute inset-0 animate-pulse bg-accent/10" />}
      {full && value && <Lightbox value={value} name={name} onClose={() => setFull(false)} />}
    </div>
  );
}

/** Added to text fields and outputs: they take the extra room of a resized card. */
const GROW = "group-data-[resized]/card:min-h-16 group-data-[resized]/card:flex-1 group-data-[resized]/card:max-h-none";

function TextOut({ value }: { value?: string }) {
  if (!value) return null;
  return (
    <div className={`${GROW} nodrag nowheel max-h-56 cursor-text overflow-auto rounded-xl bg-panel-2 p-2.5 text-xs leading-relaxed whitespace-pre-wrap select-text`}>
      {value}
    </div>
  );
}

const DISPLAYS: [VarDisplay, string][] = [
  ["both", "Source + value"],
  ["source", "Source"],
  ["value", "Value"],
];

export function PromptNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const setParam = useFlow((s) => s.setParam);
  const disconnect = useFlow((s) => s.disconnect);
  const vars = promptVars(data.params);
  const editor = useRef<TemplateEditorHandle>(null);
  // Values wired into each variable port, serialized so the selector result is stable.
  const valuesJson = useFlowStore((s) => {
    // null: wired, but the source has produced nothing yet (e.g. an LLM not run).
    const values: Record<string, string | null> = {};
    for (const e of s.edges) {
      if (e.target !== id || !e.targetHandle?.startsWith("var:")) continue;
      const src = s.nodeLookup.get(e.source)?.data as FlowNode["data"] | undefined;
      const name = e.targetHandle.slice(4);
      values[name] = values[name] ?? src?.outputs[e.sourceHandle ?? ""] ?? null;
    }
    return JSON.stringify(values);
  });
  const values = JSON.parse(valuesJson) as Record<string, string | null>;

  // Removing a chip from the text keeps the variable, its port and edges: it
  // shows up as unused below, to put back or delete on purpose.
  const unused = vars.filter((v) => !(data.params.text ?? "").includes(`{${v}}`));

  function deleteVar(name: string) {
    disconnect(id, `var:${name}`);
    setParam(id, "vars", vars.filter((v) => v !== name).join(","));
  }

  /** Declares the next free variable (and its port); returns its name. */
  function createVar() {
    let n = 1;
    while (vars.includes(`var${n}`)) n++;
    const name = `var${n}`;
    setParam(id, "vars", [...vars, name].join(","));
    return name;
  }

  function addVar() {
    editor.current?.insertVar(createVar());
  }

  return (
    <NodeShell {...props} icon={Type} title="Prompt" runnable={false}>
      <TemplateEditor
        ref={editor}
        value={data.params.text ?? ""}
        vars={vars}
        values={values}
        display={(data.params.display as VarDisplay) || "both"}
        placeholder="Describe what you want to generate… (@ for a variable)"
        onChange={(template) => setParam(id, "text", template)}
        onCreateVar={createVar}
      />
      {unused.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted">
          Unused:
          {unused.map((name) => (
            <span key={name} className="nodrag flex items-center rounded-md border border-dashed border-chip-tint/40 text-[10px] text-chip">
              <button className="py-0.5 pl-1.5" onClick={() => editor.current?.insertVar(name)} title="Insert again at the cursor">
                {varLabel(name)}
              </button>
              <button className="px-1 py-0.5 opacity-60 hover:opacity-100" onClick={() => deleteVar(name)} title="Delete the variable and its link">
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          className="nodrag flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-[11px] whitespace-nowrap text-muted hover:text-fg"
          onClick={addVar}
          title="Adds an input whose value is inserted in the text, where the cursor is"
        >
          <Plus size={12} /> Add a variable
        </button>
        {vars.length > 0 && (
          <label className="ml-auto flex min-w-0 items-center gap-1.5 text-[10px] text-muted">
            Display
            <select
              className="nodrag max-w-[130px] min-w-0 rounded-md border border-line bg-panel-2 px-1.5 py-0.5 text-[11px] text-fg outline-none"
              value={data.params.display || "both"}
              onChange={(e) => setParam(id, "display", e.target.value)}
            >
              {DISPLAYS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </NodeShell>
  );
}

export function ListNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const setParam = useFlow((s) => s.setParam);
  const items = listItems(data.params);
  const selected = Number(data.params.selected) || 0;

  const save = (next: string[], nextSelected = selected) => {
    setParam(id, "items", JSON.stringify(next));
    setParam(id, "selected", String(Math.min(nextSelected, Math.max(next.length - 1, 0))));
  };

  return (
    <NodeShell {...props} icon={ListChecks} title="List" runnable={false} cardWidth={260}>
      <div className="space-y-1.5">
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              type="radio"
              className="nodrag accent-accent"
              checked={i === selected}
              onChange={() => setParam(id, "selected", String(i))}
              title="Use this item"
            />
            <input
              className={`${field} !py-1.5 ${i === selected ? "!border-accent/60" : ""}`}
              value={item}
              placeholder={`Item ${i + 1}`}
              onChange={(e) => save(items.map((v, j) => (j === i ? e.target.value : v)))}
            />
            <button
              className="nodrag grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted hover:text-fg disabled:opacity-30"
              disabled={items.length <= 1}
              onClick={() => save(items.filter((_, j) => j !== i), i < selected ? selected - 1 : selected)}
              title="Remove"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
      <button
        className="nodrag flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-line py-1.5 text-[11px] text-muted hover:border-accent hover:text-fg"
        onClick={() => save([...items, ""])}
      >
        <Plus size={12} /> Add an item
      </button>
    </NodeShell>
  );
}

export function ImageNode(props: NodeProps<FlowNode>) {
  const [path, setPath] = useParam(props.id, props.data, "path");
  const patchNode = useFlow((s) => s.patchNode);
  const [busy, setBusy] = useState(false);

  async function pick() {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Images, videos and audio", extensions: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS] }],
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      const stored = await invoke<string>("import_image", { path: picked });
      const kind = valueKind(stored);
      const media = kind === "video" || kind === "audio" ? kind : "image";
      setPath(stored);
      patchNode(props.id, {
        params: { ...props.data.params, path: stored, media },
        outputs: { [media]: stored },
        status: "done",
        error: undefined,
      });
    } catch (err) {
      patchNode(props.id, { status: "error", error: String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <NodeShell {...props} icon={ImageUp} title={props.data.params.label || "Import"} subtitle={props.data.params.label ? "Extracted shot" : undefined} runnable={false}>
      {path ? (
        <>
          <Media value={path} name={props.data.params.label || undefined} empty={null} />
          <button className="nodrag text-[11px] text-muted hover:text-fg" onClick={pick} disabled={busy}>
            {busy ? "Importing…" : "Replace the file"}
          </button>
        </>
      ) : (
        <button className="nodrag block w-full" onClick={pick} disabled={busy}>
          <Media
            empty={
              <>
                <ImageUp size={20} />
                {busy ? "Importing…" : "Click to import"}
              </>
            }
          />
        </button>
      )}
    </NodeShell>
  );
}

/** How reference-to-video models name their images in the prompt (each model's own convention). */
const REFERENCE_PROMPTS: Record<string, string> = {
  "seedance-2.5-reference": 'Prompt: name the images @Image1, @Image2… (e.g. "@Image1 walks into the room of @Image2")',
  "minimax-h3-reference": 'Prompt: name the images Image 1, Image 2… (e.g. "The woman in Image 1 walks into the room of Image 2")',
  "minimax-h3-max-reference": 'Prompt: name the images Image 1, Image 2… (e.g. "The woman in Image 1 walks into the room of Image 2")',
};

export function ModelNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const model = findModel(data.params.modelId);
  // "WaveSpeed" or "fal only" when WaveSpeed is the provider.
  const runner = useKeys((s) => runnerLabel(s.status, model?.id));
  const [prompt, setPrompt] = useParam(id, data, "prompt");
  const [system, setSystem] = useParam(id, data, "system");
  const promptWired = useConnected(id, "prompt");
  const negativeWired = useConnected(id, "negative");
  const [negative, setNegative] = useParam(id, data, "negative");
  const isLlm = model?.category === "llm";
  const isVideo = model?.category === "video";
  const isAudio = model?.category === "audio";
  const running = useRunning(id);
  const pickHistory = useFlow((s) => s.pickHistory);
  // Set while a draft renders in 1080p, from the button or from Claude Code (MCP).
  const finalizing = !!data.finalizing;

  return (
    <NodeShell {...props} icon={isLlm ? Sparkles : isVideo ? Clapperboard : isAudio ? AudioLines : ImageIcon} title={model?.label ?? data.params.modelId}
      subtitle={[model?.provider, runner].filter(Boolean).join(" · ")}
      modelId={data.params.modelId}
      llmModel={data.params.model}>
      {!model && <div className="text-xs text-muted">Model not found in the registry.</div>}
      {isLlm ? (
        <>
          <textarea className={`${GROW} ${field} nowheel h-14 resize-none`} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="System instruction (optional)" />
          <TextOut value={data.outputs.text} />
        </>
      ) : (
        <>
          <Media
            value={isVideo ? data.outputs.video : isAudio ? data.outputs.audio : data.outputs.image}
            running={data.status === "running" || finalizing}
            empty={isVideo ? <Clapperboard size={20} /> : isAudio ? <AudioLines size={20} /> : <ImageIcon size={20} />}
            name={model?.label}
            history={data.history}
            onPick={(i) => pickHistory(id, i)}
          />
          <DraftBar id={id} data={data} running={running} />
        </>
      )}
      {!promptWired && (
        <textarea
          className={`${GROW} ${field} nowheel h-16 resize-none`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={REFERENCE_PROMPTS[model?.id ?? ""] ?? "Prompt (or connect a Prompt node)"}
        />
      )}
      {model?.negative && !negativeWired && (
        <textarea
          className={`${GROW} ${field} nowheel h-12 resize-none`}
          value={negative}
          onChange={(e) => setNegative(e.target.value)}
          placeholder="Negative prompt (optional): what the model should avoid"
        />
      )}
      <div className="flex items-center gap-1">
        {model && model.maxRefs > 1 && <RefButtons id={id} max={model.maxRefs} count={refNumbers(model, data.params).length} />}
        <div className="ml-auto">
          <RunStop id={id} running={running} title="Runs this model (upstream nodes already generated are reused)" />
        </div>
      </div>
    </NodeShell>
  );
}

/** A Seedance draft's label, expiry and "Finalize in 1080p" button (fal or BytePlus). */
function DraftBar({ id, data, running }: { id: string; data: FlowNode["data"]; running: boolean }) {
  const draftId = data.outputs.draftId;
  if (!draftId) return null;
  const finalizing = !!data.finalizing;
  const finalCost = finalizeEstimate(data);
  const expiry = draftExpiry(data);
  const expired = draftExpired(data);
  const provider = draftProvider(data);

  async function finalize() {
    const price = finalCost
      ? `Estimated cost: ~${dollars(finalCost.cost)}${finalCost.auto ? ` (\"auto\" duration: estimated at ${finalCost.seconds} s)` : ""}, billed by ${provider}.`
      : "Cost can't be estimated.";
    const until = expiry ? `\nThe draft expires on ${dayMonth(expiry)}.` : "";
    const ok = await ask(`Render this draft in 1080p?\n\n${price}${until}`, {
      title: "Finalize in 1080p",
      kind: "warning",
      okLabel: "Finalize",
      cancelLabel: "Cancel",
    });
    // Errors are shown on the node.
    if (ok) finalizeDraft(id).catch(() => {});
  }

  return (
    <div className="flex items-center gap-2">
      <span className={`rounded px-1.5 py-0.5 text-[10px] ${expired ? "bg-danger-tint/15 text-danger" : "bg-warning-tint/15 text-warning"}`}>
        {expired ? "Draft expired" : "480p draft"}
        {expiry && ` · ${expired ? "on" : "expires"} ${dayMonth(expiry)}`}
      </span>
      <button
        className="nodrag ml-auto rounded-lg bg-fg px-2.5 py-1.5 text-[11px] font-medium text-bg disabled:opacity-50"
        disabled={finalizing || running || expired}
        onClick={finalize}
        title={`Renders the same video in 1080p. ${provider} keeps the draft ${DRAFT_DAYS} days, and only for the account that generated it.`}
      >
        {finalizing ? "Finalizing…" : `Finalize in 1080p${finalCost ? ` (~${dollars(finalCost.cost)})` : ""}`}
      </button>
    </div>
  );
}

/** Adds or removes a numbered reference input (Image 1, Image 2…) of a model. */
function RefButtons({ id, max, count }: { id: string; max: number; count: number }) {
  const setParam = useFlow((s) => s.setParam);
  const lastWired = useConnected(id, `ref${count}`);
  return (
    <>
      <button
        className="nodrag flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30"
        disabled={count >= max}
        onClick={() => setParam(id, "refs", String(count + 1))}
        title={count >= max ? `${max} images at most for this model` : "Adds an image input; images keep the order of the inputs"}
      >
        <Plus size={13} /> Image
      </button>
      <button
        className="nodrag grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30"
        disabled={count <= 1 || lastWired}
        onClick={() => setParam(id, "refs", String(count - 1))}
        title={lastWired ? "Disconnect the last image first" : "Removes the last image input"}
      >
        <Minus size={13} />
      </button>
    </>
  );
}

export function PreviewNode(props: NodeProps<FlowNode>) {
  const value = props.data.outputs.value;
  return (
    <NodeShell {...props} icon={Eye} title="Preview">
      {value && valueKind(value) === "views" ? (
        <Gallery views={parseViews(value)} cols={galleryCols(parseViews(value).length)} />
      ) : value && valueKind(value) === "text" ? (
        <TextOut value={value} />
      ) : (
        <Media value={value} empty={<span>Connect a node, then run</span>} />
      )}
    </NodeShell>
  );
}

export function RouterNode(props: NodeProps<FlowNode>) {
  const value = props.data.outputs.value;
  const kind = value ? valueKind(value) : undefined;
  return (
    <NodeShell {...props} icon={Split} title="Router" cardWidth={190} runnable={false}>
      <div className="text-[11px] text-muted">
        {kind ? `Passes on: ${kind}` : "One input, as many outputs as needed."}
      </div>
    </NodeShell>
  );
}

const SEPARATORS: [string, string][] = [
  ["newline", "New line"],
  ["space", "Space"],
  ["comma", "Comma"],
];

export function ConcatNode(props: NodeProps<FlowNode>) {
  const [separator, setSeparator] = useParam(props.id, props.data, "separator");
  const count = useFlowStore((s) => s.edges.filter((e) => e.target === props.id).length);
  return (
    <NodeShell {...props} icon={Merge} title="Prompt Concatenator" runnable={false}>
      <div className="text-[11px] text-muted">{count} text{count > 1 ? "s" : ""} connected, in the order of the connections.</div>
      <Select label="Separator" value={separator} options={SEPARATORS} onChange={setSeparator} />
      {props.data.outputs.text ? (
        <TextOut value={props.data.outputs.text} />
      ) : (
        <div className="text-[11px] text-muted">The joined text shows here live.</div>
      )}
    </NodeShell>
  );
}

/**
 * Frames the crop on the image itself. Live: the cropped image is made as
 * soon as the frame is let go, and flows on without running anything.
 */
export function CropNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const patchNode = useFlow((s) => s.patchNode);
  const setCover = useFlow((s) => s.setCover);
  const input = useInputValue(id, "image");
  const [full, setFull] = useState(false);
  const result = data.outputs.image;
  const p = data.params;
  // What the current result was made from: nothing to redo when it matches.
  const key = JSON.stringify([input ?? "", p.box, p.aspect, p.x, p.y, p.w, p.h]);
  useEffect(() => {
    if (data.liveKey === key) return;
    if (!input) {
      if (result) patchNode(id, { outputs: {}, status: "idle", liveKey: key });
      return;
    }
    const timer = setTimeout(() => {
      invoke<string>("crop_image", { value: input, params: useFlow.getState().nodes.find((n) => n.id === id)?.data.params ?? p })
        .then((image) => patchNode(id, { outputs: { image }, status: "done", error: undefined, liveKey: key }))
        .catch((err) => patchNode(id, { status: "error", error: String(err), liveKey: key }));
    }, 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const toolbar = result && (
    <>
      <button
        className={toolButton}
        onClick={() => setCover(id, data.cover === result ? null : result)}
        title={data.cover === result ? "Project cover: click to go back to the last generated image" : "Set as the project cover (home page)"}
      >
        <Star size={14} className={data.cover === result ? "fill-warning text-warning" : undefined} />
      </button>
      <DownloadButton path={result} name="crop" className={toolButton} />
      <button className={toolButton} onClick={() => setFull(true)} title="Full screen">
        <Maximize2 size={14} />
      </button>
    </>
  );

  return (
    <NodeShell {...props} icon={Crop} title="Crop" runnable={false}>
      {input ? (
        <CropEditor
          src={mediaSrc(input)}
          params={data.params}
          toolbar={toolbar}
          onChange={(patch) => patchNode(id, { params: { ...data.params, ...patch } })}
        />
      ) : (
        <div className="checker grid min-h-[160px] place-items-center rounded-xl border border-line text-[11px] text-muted">
          Connect an image (already run)
        </div>
      )}
      {full && result && <Lightbox value={result} name="crop" onClose={() => setFull(false)} />}
    </NodeShell>
  );
}

/**
 * One frame of a video as an image (local ffmpeg, free). Live like Crop: the
 * frame is made again whenever the video or the time changes.
 */
export function FrameNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const patchNode = useFlow((s) => s.patchNode);
  const [time, setTime] = useParam(id, data, "time");
  const input = useInputValue(id, "video");
  const video = useRef<HTMLVideoElement>(null);
  const result = data.outputs.image;
  const key = JSON.stringify([input ?? "", time]);
  useEffect(() => {
    if (data.liveKey === key) return;
    if (!input) {
      if (result) patchNode(id, { outputs: {}, status: "idle", liveKey: key });
      return;
    }
    const timer = setTimeout(() => {
      patchNode(id, { status: "running" });
      invoke<string>("extract_frame", { value: input, time: Number(time) || 0 })
        .then((image) => patchNode(id, { outputs: { image }, status: "done", error: undefined, liveKey: key }))
        .catch((err) => patchNode(id, { status: "error", error: String(err), liveKey: key }));
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // The player follows the time typed in the field.
  useEffect(() => {
    const v = video.current;
    const t = Number(time) || 0;
    if (v && Math.abs(v.currentTime - t) > 0.05) v.currentTime = t;
  }, [time, input]);

  return (
    <NodeShell {...props} icon={Frame} title="Extract frame" runnable={false}>
      {input ? (
        <video ref={video} src={mediaSrc(input)} className="nodrag w-full rounded-md bg-overlay" controls muted playsInline preload="metadata" />
      ) : (
        <div className="checker grid min-h-[120px] place-items-center rounded-xl border border-line text-[11px] text-muted">
          Connect a video (already run)
        </div>
      )}
      <div className="flex items-center gap-2">
        <label className="nodrag flex items-center gap-2 text-[11px] text-muted">
          Time (s)
          <input
            type="number"
            min={0}
            step={0.1}
            className={`${field} w-20 text-right`}
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </label>
        <button
          className="nodrag ml-auto rounded-lg border border-line px-3 py-1.5 text-[12px] hover:border-accent disabled:opacity-30"
          disabled={!input}
          onClick={() => video.current && setTime(String(Math.round(video.current.currentTime * 100) / 100))}
          title="Pause the video on the frame you want, then click"
        >
          Use this frame
        </button>
      </div>
      <Media value={result} running={data.status === "running"} empty={<span>The frame shows here</span>} name="frame" />
    </NodeShell>
  );
}

function LlmSelect({ id, data }: { id: string; data: FlowNode["data"] }) {
  const [model, setModel] = useParam(id, data, "model");
  useModels((s) => s.models.length);
  return <Select label="Model" value={model} options={llmOptions().map((o) => [o, o])} onChange={setModel} />;
}

export function EnhancerNode(props: NodeProps<FlowNode>) {
  const [text, setText] = useParam(props.id, props.data, "text");
  const wired = useConnected(props.id, "text");
  return (
    <NodeShell {...props} icon={WandSparkles} title="Prompt Enhancer">
      {!wired && (
        <textarea className={`${GROW} ${field} nowheel h-16 resize-none`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Starting idea (or connect a Prompt)" />
      )}
      <LlmSelect id={props.id} data={props.data} />
      <TextOut value={props.data.outputs.text} />
    </NodeShell>
  );
}

const DETAILS: [string, string][] = [
  ["long", "Detailed"],
  ["short", "Short"],
];

export function DescriberNode(props: NodeProps<FlowNode>) {
  const [detail, setDetail] = useParam(props.id, props.data, "detail");
  const input = useInputValue(props.id, "image");
  return (
    <NodeShell {...props} icon={FileText} title="Image Describer">
      {input && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={mediaSrc(input)} alt="" className="block max-h-28 w-full rounded-lg object-cover" draggable={false} />
      )}
      <div className="grid grid-cols-2 gap-2">
        <LlmSelect id={props.id} data={props.data} />
        <Select label="Description" value={detail} options={DETAILS} onChange={setDetail} />
      </div>
      <TextOut value={props.data.outputs.text} />
    </NodeShell>
  );
}

export function VideoDescriberNode(props: NodeProps<FlowNode>) {
  const [question, setQuestion] = useParam(props.id, props.data, "question");
  const [detailed, setDetailed] = useParam(props.id, props.data, "detailed");
  return (
    <NodeShell {...props} icon={Film} title="Video Describer" subtitle="fal video-understanding">
      <textarea
        className={`${GROW} ${field} nowheel h-14 resize-none`}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Specific question (optional) — otherwise a full description"
      />
      <label className="nodrag flex items-center gap-2 text-[11px] text-muted">
        <input type="checkbox" className="accent-accent" checked={detailed === "true"} onChange={(e) => setDetailed(String(e.target.checked))} />
        Detailed analysis
      </label>
      <TextOut value={props.data.outputs.text} />
    </NodeShell>
  );
}

/**
 * Describes a video's action, camera and setting as a timed prompt, so a
 * video model can generate it again from reference images, without the video.
 */
export function MotionPromptNode(props: NodeProps<FlowNode>) {
  const [notes, setNotes] = useParam(props.id, props.data, "notes");
  const [outfit, setOutfit] = useParam(props.id, props.data, "outfit");
  const notesWired = useConnected(props.id, "notes");
  return (
    <NodeShell {...props} icon={ScrollText} title="Video → Prompt" subtitle="frames read by a vision LLM">
      {!notesWired && (
        <textarea
          className={`${GROW} ${field} nowheel h-14 resize-none`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional): what to change or stress, e.g. “she wears a red dress”"
        />
      )}
      <label className="nodrag flex items-center gap-2 text-[11px] text-muted" title="Off: the prompt leaves the clothes to your reference images (add a full-body one)">
        <input type="checkbox" className="accent-accent" checked={outfit === "video"} onChange={(e) => setOutfit(e.target.checked ? "video" : "character")} />
        Keep the video&apos;s outfit
      </label>
      <TextOut value={props.data.outputs.text} />
      <div className="text-[10px] leading-snug text-muted">
        Refers to the performer as @Image1 and leaves out their looks: identity comes from your reference images.
      </div>
    </NodeShell>
  );
}

/** Mirrors `recast::Piece` in Rust. */
interface Piece {
  source: string;
  video: string;
  error: string;
}

/** A Recast node's segments, when its source had to be cut. */
function parsePieces(value: string | undefined): Piece[] {
  if (!value?.startsWith("[")) return [];
  try {
    const pieces = JSON.parse(value);
    return Array.isArray(pieces) ? pieces : [];
  } catch {
    return [];
  }
}

/** Values produced by every node wired into `handle`, in edge order. */
function useInputValues(id: string, handle: string) {
  // Joined so the selector returns a string, which compares by value.
  const joined = useFlowStore((s) =>
    s.edges
      .filter((e) => e.target === id && e.targetHandle === handle)
      .map((e) => (s.nodeLookup.get(e.source)?.data as FlowNode["data"] | undefined)?.outputs[e.sourceHandle ?? ""])
      .filter(Boolean)
      .join("\n"),
  );
  return joined ? joined.split("\n") : [];
}

/** Longest segment, in seconds; read by `recast::max_piece`. Shorter keeps the
 *  character closer to the photo, since each segment starts again from it. */
const RECAST_SEGMENTS: [string, string][] = [
  ["auto", "As long as possible"],
  ["10", "10 s, more faithful"],
  ["6", "6 s, most faithful"],
];

export function RecastNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const keys = useKeys((s) => s.status);
  const runner = runnerLabel(keys, data.params.modelId);
  const patchNode = useFlow((s) => s.patchNode);
  const setParam = useFlow((s) => s.setParam);
  const pickHistory = useFlow((s) => s.pickHistory);
  const run = useFlow((s) => s.run);
  const running = useRunning(id);
  const modes = useModels((s) => s.recastModes);
  const mode = modes.find((m) => m.id === data.params.mode) ?? modes[0];
  const model = findModel(data.params.modelId);
  const choice = mode?.models.find((c) => c.id === data.params.modelId);
  const source = useInputValue(id, "video");
  const characters = useInputValues(id, "characters");
  const [prompt, setPrompt] = useParam(id, data, "prompt");
  const promptWired = useConnected(id, "prompt");
  const pieces = parsePieces(data.outputs.pieces);
  const [redoing, setRedoing] = useState<number | "join" | null>(null);
  const ready = pieces.filter((p) => p.video).length;

  // Another mode or model: its own defaults, and fal settings (`x:`) of the old endpoint dropped.
  function choose(modeId: string, modelId?: string) {
    // The new mode's instructions replace the old one's, but not the user's own.
    const current = data.params.prompt ?? "";
    const prompt = !current.trim() || current === recastPrompt(data.params.mode) ? recastPrompt(modeId) : current;
    const kept = { prompt, segment: data.params.segment ?? "10" };
    patchNode(id, { params: { ...recastParams(modeId, modelId), ...kept }, status: "idle", error: undefined });
  }

  /** Re-renders one segment only, or with "join" just joins them; Rust reads
   *  `redo`, keeps the other segments and joins them once all are ready. */
  async function redo(index: number | "join") {
    setRedoing(index);
    setParam(id, "redo", String(index));
    try {
      await run(id);
    } finally {
      setParam(id, "redo", "");
      setRedoing(null);
    }
  }

  const history = data.history ?? [];
  const version = data.outputs.video ? history.lastIndexOf(data.outputs.video) : -1;
  const iconButton = "nodrag grid h-6 w-6 place-items-center rounded-md hover:bg-panel-2 hover:text-fg disabled:opacity-30";

  // Segments, small: to check and redo before joining. The finished video is
  // shown by the Preview node only, so this node stays free for new settings.
  const piecesView = pieces.length > 0 && (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-3 gap-1.5">
        {pieces.map((p, i) => (
          <div key={i} className="flex flex-col gap-0.5">
            <div className="checker relative grid aspect-[9/16] place-items-center overflow-hidden rounded-lg border border-line">
              {p.video ? (
                <video src={mediaSrc(p.video)} className="nodrag h-full w-full object-cover" controls muted loop playsInline />
              ) : p.error ? (
                <span className="px-1 text-center text-[10px] leading-tight text-danger" title={p.error}>
                  {/flagged by a content checker/i.test(p.error) ? "Refused by the model's content filter" : p.error}
                </span>
              ) : running ? (
                <Loader2 size={14} className="animate-spin text-muted" />
              ) : (
                <span className="text-[9px] text-muted">Stopped</span>
              )}
              {redoing === i && <div className="absolute inset-0 animate-pulse bg-accent/10" />}
            </div>
            <div className="flex items-center text-[10px] text-muted">
              <span className="mr-auto">Seg. {i + 1}</span>
              {p.video && <DownloadButton path={p.video} name={`recast-segment-${i + 1}`} className={iconButton} />}
              <button className={iconButton} disabled={running} onClick={() => redo(i)} title="Redo this segment only">
                <RotateCcw size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted">
        <span className="mr-auto">
          {ready < pieces.length
            ? `${ready}/${pieces.length} segments ready${running ? "" : ": redo the failed ones to merge"}`
            : data.outputs.video
              ? "Merged: full video in Preview"
              : running
                ? "Merging…"
                : `${pieces.length} segments ready`}
        </span>
        {ready === pieces.length && !data.outputs.video && !running && (
          <button className="nodrag rounded-lg bg-fg px-2.5 py-1.5 text-[11px] font-medium text-bg" onClick={() => redo("join")} title="Joins the segments in order, in the Preview node">
            Merge
          </button>
        )}
      </div>
    </div>
  );

  return (
    <NodeShell {...props} icon={Drama} title="Recast" subtitle={[model?.label, runner].filter(Boolean).join(" · ")} modelId={data.params.modelId} cardWidth={340} fitHeight>
      <div className="relative grid grid-cols-2 gap-1.5">
        <div className="checker grid aspect-[4/5] place-items-center overflow-hidden rounded-xl border border-line">
          {source ? (
            <video src={mediaSrc(source)} className="nodrag h-full w-full object-cover" muted loop playsInline autoPlay />
          ) : (
            <span className="px-2 text-center text-[11px] text-muted">Connect a source video</span>
          )}
        </div>
        <div className="checker grid aspect-[4/5] place-items-center overflow-hidden rounded-xl border border-line">
          {characters.length ? (
            <div className={`grid h-full w-full gap-0.5 ${characters.length > 1 ? "grid-cols-2" : ""}`}>
              {characters.map((c, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={mediaSrc(c)} alt="" className="h-full w-full object-cover" draggable={false} />
              ))}
            </div>
          ) : (
            <span className="px-2 text-center text-[11px] text-muted">Connect your character&apos;s image</span>
          )}
        </div>
        {data.status === "running" && pieces.length === 0 && <div className="absolute inset-0 animate-pulse rounded-xl bg-accent/10" />}
      </div>

      {piecesView}

      {data.outputs.video && (pieces.length === 0 || history.length > 1) && (
        <div className="flex items-center gap-1 text-[10px] text-muted">
          <span className="mr-auto">{pieces.length ? "Versions" : "Result shown in Preview"}</span>
          {history.length > 1 && (
            <>
              <button className={iconButton} disabled={version <= 0} onClick={() => pickHistory(id, version - 1)} title="Previous version">
                ‹
              </button>
              <span>
                {version + 1}/{history.length}
              </span>
              <button className={iconButton} disabled={version >= history.length - 1} onClick={() => pickHistory(id, version + 1)} title="Next version">
                ›
              </button>
            </>
          )}
        </div>
      )}

      <div className="nodrag grid grid-cols-2 gap-1 rounded-lg bg-panel-2 p-0.5">
        {modes.map((m) => (
          <button
            key={m.id}
            className={`rounded-md py-1.5 text-[12px] ${m.id === mode?.id ? "bg-panel text-fg shadow" : "text-muted hover:text-fg"}`}
            onClick={() => m.id !== mode?.id && choose(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode && <div className="text-[10px] leading-snug text-muted">{mode.hint}</div>}

      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <Select
            label="Model"
            value={data.params.modelId}
            options={(mode?.models ?? []).map((c): [string, string] => [
              c.id,
              `${findModel(c.id)?.label ?? c.id}${keys?.provider === "wavespeed" && !findModel(c.id)?.wavespeed ? " (fal only)" : ""}`,
            ])}
            onChange={(v) => choose(mode!.id, v)}
          />
        </div>
        <Select
          label="Segments"
          value={data.params.segment || "auto"}
          options={RECAST_SEGMENTS}
          onChange={(v) => setParam(id, "segment", v)}
        />
        {model?.params
          .filter((p) => p.kind !== "bool" && p.options.length > 1)
          .map((p) => (
            <Select
              key={p.key}
              label={p.label}
              value={p.options.includes(data.params[p.key]) ? data.params[p.key] : p.default}
              options={p.options.map((o): [string, string] => [o, optionLabel(p.key, o)])}
              onChange={(v) => setParam(id, p.key, v)}
            />
          ))}
        {model?.params
          .filter((p) => p.kind === "bool")
          .map((p) => (
            <label key={p.key} className="nodrag flex items-center gap-2 self-end pb-2 text-[11px] text-muted">
              <input
                type="checkbox"
                className="accent-accent"
                checked={(data.params[p.key] ?? p.default) === "true"}
                onChange={(e) => setParam(id, p.key, String(e.target.checked))}
              />
              {p.label}
            </label>
          ))}
      </div>
      {choice && <div className="text-[10px] leading-snug text-muted">{choice.note}</div>}

      {!promptWired && (
        <textarea
          className={`${GROW} ${field} nowheel h-14 resize-none`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Instructions (optional): who becomes whom, what to keep or change"
        />
      )}
      <div className="flex items-center justify-between gap-2">
        {!promptWired && mode?.prompt && prompt !== mode.prompt ? (
          <button
            className="nodrag text-left text-[10px] text-muted underline hover:text-fg"
            onClick={() => setPrompt(mode.prompt)}
            title={mode.prompt}
          >
            Generic instructions
          </button>
        ) : (
          <span />
        )}
        <RunStop id={id} running={running} title="The price per run is shown in the right panel" />
      </div>
    </NodeShell>
  );
}

const GRID_PRESETS: [string, string, number][] = [
  ["2x2", "4 views — 2×2", 2],
  ["3x3", "9 views — 3×3", 3],
  ["4x4", "16 views — 4×4", 4],
  ["5x5", "25 views — 5×5", 5],
];

export function GridCropNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const setParam = useFlow((s) => s.setParam);
  const patchNode = useFlow((s) => s.patchNode);
  const pruneOutputs = useFlow((s) => s.pruneOutputs);
  const gridCropToAngles = useFlow((s) => s.gridCropToAngles);
  const input = useInputValue(id, "image");
  const { rows, cols } = gridSize(data.params);
  const square = rows === cols && GRID_PRESETS.some(([, , n]) => n === rows);
  const [custom, setCustom] = useState(!square);
  const preset = custom ? "custom" : `${rows}x${cols}`;
  const inset = Number(data.params.inset) || 0;
  const cells = Array.from({ length: rows * cols });
  const views = parseViews(data.outputs.views);

  function setGrid(r: number, c: number) {
    setParam(id, "rows", String(r));
    setParam(id, "cols", String(c));
    // Old tiles no longer match the grid; edges to vanished cells go too.
    patchNode(id, { outputs: {}, status: "idle", error: undefined });
    pruneOutputs(id);
  }

  return (
    <NodeShell {...props} icon={Grid3x3} title="Grid Crop">
      <div className="rounded-lg border border-warning-tint/25 bg-warning-tint/5 px-2.5 py-2 text-[11px] leading-snug text-warning">
        Cuts an image <b>already laid out as a grid</b> (a sheet of several views). To generate different camera angles from
        a single image:
        <button
          className="nodrag mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md bg-warning-solid/90 py-1 text-[11px] font-medium text-on-warning-solid hover:bg-warning-solid"
          onClick={() => gridCropToAngles(id)}
        >
          <Camera size={12} /> Replace with Camera angles
        </button>
      </div>
      <div className="checker relative overflow-hidden rounded-xl border border-line">
        {data.status === "done" && views.length ? (
          <div className="bg-bg p-0.5">
            <Gallery views={views} cols={cols} />
          </div>
        ) : input ? (
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={mediaSrc(input)} alt="" className="block w-full" draggable={false} />
            <div
              className="absolute inset-0 grid"
              style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
            >
              {cells.map((_, i) => (
                <div key={i} className="relative border border-on-overlay/70">
                  {inset > 0 && <div className="absolute border border-dashed border-warning-solid/80" style={{ inset: `${inset}%` }} />}
                  <span className="absolute top-0.5 left-0.5 rounded bg-overlay/60 px-1 text-[9px]">{i + 1}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid min-h-[140px] place-items-center text-[11px] text-muted">Connect a sheet of images</div>
        )}
      </div>
      <Select
        label="Grid"
        value={preset}
        options={[...GRID_PRESETS.map(([v, l]): [string, string] => [v, l]), ["custom", "Custom"]]}
        onChange={(v) => {
          if (v === "custom") return setCustom(true);
          setCustom(false);
          const n = GRID_PRESETS.find(([key]) => key === v)![2];
          setGrid(n, n);
        }}
      />
      {custom && (
        <div className="grid grid-cols-2 gap-2">
          <Select
            label="Rows"
            value={String(rows)}
            options={Array.from({ length: MAX_GRID }, (_, i): [string, string] => [String(i + 1), String(i + 1)])}
            onChange={(v) => setGrid(Number(v), cols)}
          />
          <Select
            label="Columns"
            value={String(cols)}
            options={Array.from({ length: MAX_GRID }, (_, i): [string, string] => [String(i + 1), String(i + 1)])}
            onChange={(v) => setGrid(rows, Number(v))}
          />
        </div>
      )}
      <label className="block text-[10px] text-muted">
        Trim the edges of each view: {inset}%
        <input
          type="range"
          min={0}
          max={10}
          step={0.5}
          value={inset}
          onChange={(e) => {
            setParam(id, "inset", e.target.value);
            patchNode(id, { status: "idle" });
          }}
          className="nodrag block w-full accent-accent"
        />
      </label>
      <div className="text-[10px] text-muted">
        {rows * cols} views on a single “Views” output, to connect to Angle picker or Export angles. ▶ to cut.
      </div>
    </NodeShell>
  );
}

const PANEL_FORMATS: [string, string][] = [
  ["16:9", "16:9"],
  ["4:3", "4:3"],
  ["1:1", "1:1"],
  ["9:16", "9:16"],
];

export function AnglesNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const setParam = useFlow((s) => s.setParam);
  const patchNode = useFlow((s) => s.patchNode);
  const pruneOutputs = useFlow((s) => s.pruneOutputs);
  const models = useModels((s) => s.models);
  const catalog = useModels((s) => s.shots);
  const reference = useInputValue(id, "image");
  const [cols, rows] = angleLayout(data.params);
  const shots = angleShots(data.params);
  const separate = data.params.mode === "separate";
  const model = findModel(data.params.modelId);
  const resolutions = model?.params.find((p) => p.key === "resolution")?.options;
  const views = parseViews(data.outputs.views);
  const done = data.status === "done" && views.length > 0;

  // Any setting change makes the previous result stale.
  function update(key: string, value: string) {
    setParam(id, key, value);
    patchNode(id, { status: "idle", error: undefined });
    pruneOutputs(id);
  }

  return (
    <NodeShell {...props} icon={Camera} title="Camera angles" subtitle={model?.label} modelId={data.params.modelId} cardWidth={380}>
      {done ? (
        <Gallery views={views} cols={cols} />
      ) : (
        <div className="checker relative grid min-h-[110px] place-items-center overflow-hidden rounded-xl border border-line">
          {reference ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={mediaSrc(reference)} alt="" className="block max-h-44 w-full object-contain" draggable={false} />
          ) : (
            <span className="text-[11px] text-muted">Connect a reference image</span>
          )}
          {data.status === "running" && <div className="absolute inset-0 animate-pulse bg-accent/10" />}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Select
          label="Model"
          value={data.params.modelId}
          options={models.filter((m) => m.category === "image" && m.editEndpoint).map((m): [string, string] => [m.id, m.label])}
          onChange={(v) => update("modelId", v)}
        />
        <Select
          label="Layout"
          value={`${cols}x${rows}`}
          options={ANGLE_LAYOUTS.map(([c, r]): [string, string] => [`${c}x${r}`, `${c}×${r} — ${c * r} shots`])}
          onChange={(v) => {
            update("layout", v);
            // Resize the shot list to the new grid, keeping choices already made.
            setParam(id, "shots", JSON.stringify(angleShots({ ...data.params, layout: v })));
          }}
        />
        <Select
          label="Generation"
          value={separate ? "separate" : "sheet"}
          options={[
            ["sheet", "Sheet (1 call)"],
            ["separate", `Per shot (${cols * rows} calls)`],
          ]}
          onChange={(v) => update("mode", v)}
        />
        <Select label="Shot ratio" value={data.params.panel || "16:9"} options={PANEL_FORMATS} onChange={(v) => update("panel", v)} />
        {resolutions && (
          <Select
            label="Resolution"
            value={resolutions.includes(data.params.resolution) ? data.params.resolution : (model?.params.find((p) => p.key === "resolution")?.default ?? "")}
            options={resolutions.map((r): [string, string] => [r, r])}
            onChange={(v) => update("resolution", v)}
          />
        )}
        {!separate && (
          <label className="nodrag flex items-center gap-2 self-end pb-2 text-[11px] text-muted">
            <input type="checkbox" className="accent-accent" checked={data.params.labels === "true"} onChange={(e) => update("labels", String(e.target.checked))} />
            Names in the image
          </label>
        )}
      </div>

      <div>
        <div className="mb-1 text-[10px] text-muted">Shots, in the order of the sheet</div>
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {shots.map((shotId, i) => (
            <label key={i} className="flex min-w-0 items-center gap-1 rounded-md border border-line bg-panel-2 pl-1.5 focus-within:border-accent">
              {/* Beside the select, not over it: macOS draws native selects without their left padding. */}
              <span className="shrink-0 text-[9px] text-muted tabular-nums">{i + 1}</span>
              <select
                className="nodrag min-w-0 flex-1 truncate bg-transparent py-1 pr-1 text-[10px] text-fg outline-none"
                value={shotId}
                onChange={(e) => update("shots", JSON.stringify(shots.map((s, j) => (j === i ? e.target.value : s))))}
              >
                {catalog.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </div>
      <div className="text-[10px] text-muted">
        {separate
          ? `${cols * rows} separate generations, better resolution per shot.`
          : "A single grid image, cut into shots: cheaper and more consistent."}
      </div>
    </NodeShell>
  );
}

/** Thumbnails of a set of views; clicking one selects it when `onSelect` is given. */
function Gallery({
  views,
  cols,
  selected,
  onSelect,
  square = false,
}: {
  views: View[];
  cols: number;
  selected?: number;
  onSelect?: (index: number) => void;
  /** Square thumbnails, cropped to their center; otherwise 16:9. */
  square?: boolean;
}) {
  return (
    <div className={`grid ${square ? "gap-2 p-0.5" : "gap-1"}`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {views.map((v, i) => (
        <div key={i} className="group/media relative">
          <button
            type="button"
            disabled={!onSelect}
            onClick={() => onSelect?.(i)}
            title={v.label}
            // A ring, not a border: a transparent border shows the button's own (black) background.
            className={`nodrag relative isolate block w-full overflow-hidden rounded bg-transparent p-0 transition-shadow ${
              i === selected ? "ring-2 ring-accent ring-offset-2 ring-offset-panel" : onSelect ? "hover:ring-1 hover:ring-on-overlay/40" : ""
            } ${onSelect ? "cursor-pointer" : "cursor-default"}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={mediaSrc(v.path)} alt="" className={`block w-full object-cover ${square ? "aspect-square" : "aspect-video"}`} draggable={false} />
            <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-overlay/75 to-transparent px-1.5 pt-3 pb-1 text-left text-[9px] text-on-overlay">
              {i + 1}. {v.label}
            </span>
          </button>
          <DownloadButton
            path={v.path}
            name={`${String(i + 1).padStart(2, "0")}-${v.label}`}
            className="nodrag absolute top-1 right-1 grid h-6 w-6 place-items-center rounded-md bg-overlay/65 text-on-overlay opacity-0 transition-opacity group-hover/media:opacity-100 hover:bg-overlay/85"
          />
        </div>
      ))}
    </div>
  );
}

/** Columns for a gallery of `n` views: close to square, at most 4. */
const galleryCols = (n: number) => Math.min(4, Math.max(1, Math.ceil(Math.sqrt(n))));

export function AnglePickNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const setParam = useFlow((s) => s.setParam);
  const extractViews = useFlow((s) => s.extractViews);
  const views = parseViews(useInputValue(id, "views"));
  const selected = Math.min(Number(data.params.selected) || 0, Math.max(views.length - 1, 0));

  return (
    <NodeShell {...props} icon={Images} title="Angle picker" runnable={false} cardWidth={340} fitHeight>
      {views.length ? (
        <>
          <Gallery views={views} cols={galleryCols(views.length)} selected={selected} onSelect={(i) => setParam(id, "selected", String(i))} square />
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span className="min-w-0 flex-1 truncate">
              Output: <span className="text-fg">{views[selected].label}</span> — click a shot to choose it.
            </span>
            <button
              className="nodrag flex shrink-0 items-center gap-1 rounded-md bg-fg px-2 py-1 text-[11px] font-medium text-bg hover:opacity-90"
              onClick={() => extractViews(id)}
              title="Creates one image node per shot, each with its own output"
            >
              <Images size={12} /> Extract all
            </button>
          </div>
        </>
      ) : (
        <div className="checker grid min-h-[120px] place-items-center rounded-xl border border-line text-[11px] text-muted">
          Connect the &quot;Shots&quot; output of Camera angles
        </div>
      )}
    </NodeShell>
  );
}

export function AngleExportNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const setParam = useFlow((s) => s.setParam);
  const patchNode = useFlow((s) => s.patchNode);
  const views = parseViews(useInputValue(id, "views"));
  const folder = data.params.folder ?? "";

  async function pickFolder() {
    const picked = await open({ directory: true, multiple: false, defaultPath: folder || undefined });
    if (typeof picked !== "string") return;
    setParam(id, "folder", picked);
    patchNode(id, { outputs: {}, status: "idle", error: undefined });
  }

  return (
    <NodeShell {...props} icon={FolderDown} title="Export angles" cardWidth={280}>
      <div className="text-[11px] text-muted">
        {views.length ? `${views.length} shots received.` : "Connect the \"Shots\" output of Camera angles."} They are saved on each
        run, named <span className="font-mono text-fg">01-close-up.png</span>…
      </div>
      <button
        className="nodrag flex w-full items-center gap-2 rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-left text-[11px] hover:border-accent"
        onClick={pickFolder}
        title={folder || undefined}
      >
        <FolderOpen size={13} className="shrink-0 text-muted" />
        <span className={`truncate ${folder ? "text-fg" : "text-muted"}`}>{folder || "Choose the export folder"}</span>
      </button>
      {data.outputs.summary && (
        <div className="flex items-center gap-2 text-[11px] text-success">
          {data.outputs.summary}
          <button className="nodrag ml-auto text-accent hover:underline" onClick={() => revealItemInDir(folder)}>
            Open
          </button>
        </div>
      )}
    </NodeShell>
  );
}

/** Puts a sound on a video (fal's ffmpeg merge), from an offset in seconds. */
export function AddAudioNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const [offset, setOffset] = useParam(id, data, "offset");
  const pickHistory = useFlow((s) => s.pickHistory);
  const running = useRunning(id);
  return (
    <NodeShell {...props} icon={AudioLines} title="Add sound">
      <Media
        value={data.outputs.video}
        running={data.status === "running"}
        empty={<span>Connect a video and a sound</span>}
        name="video-son"
        history={data.history}
        onPick={(i) => pickHistory(id, i)}
      />
      <label className="nodrag flex items-center justify-between gap-2 text-[11px] text-muted">
        Sound start (s)
        <input
          type="number"
          min={0}
          step={0.5}
          className={`${field} w-20 text-right`}
          value={offset}
          onChange={(e) => setOffset(e.target.value)}
        />
      </label>
      <div className="text-[10px] leading-snug text-muted">Replaces the video&apos;s sound track.</div>
      <div className="flex justify-end">
        <RunStop id={id} running={running} title="Puts the sound on the video" />
      </div>
    </NodeShell>
  );
}

/** A cost on WaveSpeed for an amount (characters or seconds), none on fal. */
function useSpeechCost(kind: "voice" | "avatar", amount: number | null) {
  const [cost, setCost] = useState<number | null>(null);
  const onFal = useKeys((s) => s.status?.provider !== "wavespeed");
  useEffect(() => {
    if (amount == null || amount <= 0) return setCost(null);
    let live = true;
    invoke<number | null>("speech_cost", { kind, amount })
      .then((c) => live && setCost(c))
      .catch(() => live && setCost(null));
    return () => {
      live = false;
    };
  }, [kind, amount, onFal]);
  return cost;
}

/**
 * Text to speech in a fixed ElevenLabs voice: every line a character says
 * goes through the same voice, so they always sound alike.
 */
export function VoiceNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const [text, setText] = useParam(id, data, "text");
  const [voice, setVoice] = useParam(id, data, "voice");
  const [stability, setStability] = useParam(id, data, "stability");
  const wired = useConnected(id, "text");
  const input = useInputValue(id, "text");
  const pickHistory = useFlow((s) => s.pickHistory);
  const running = useRunning(id);
  const length = (wired ? (input ?? "") : text).length;
  const cost = useSpeechCost("voice", length || null);
  return (
    <NodeShell {...props} icon={Mic} title="Voice">
      <Media
        value={data.outputs.audio}
        running={data.status === "running"}
        empty={<span>Write or connect a text, then run</span>}
        name={`voice-${voice || "Matilda"}`}
        history={data.history}
        onPick={(i) => pickHistory(id, i)}
      />
      {!wired && (
        <textarea
          className={`${GROW} ${field} nowheel h-20 resize-none`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What the character says. Tags like [whispers] or [laughs] set the tone."
        />
      )}
      <Select label="Voice" value={voice || "Matilda"} options={VOICES} onChange={setVoice} />
      <Select label="Delivery" value={stability || "0.5"} options={VOICE_STABILITY} onChange={setStability} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted">
          {length === 0 ? "Keep the same voice for every line" : cost != null ? `Cost ≈ ${dollars(cost)} (${length} characters)` : `${length} characters`}
        </span>
        <RunStop id={id} running={running} title="Speaks the text" />
      </div>
    </NodeShell>
  );
}

/** Kling AI Avatar: the character image speaks the connected voice, lips in sync. */
export function AvatarNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const [prompt, setPrompt] = useParam(id, data, "prompt");
  const promptWired = useConnected(id, "prompt");
  const pickHistory = useFlow((s) => s.pickHistory);
  const running = useRunning(id);
  const seconds = useVideoDuration(useInputValue(id, "audio"));
  const cost = useSpeechCost("avatar", seconds);
  return (
    <NodeShell {...props} icon={UserRound} title="Talking avatar" subtitle="Kling AI Avatar v2 Pro">
      <Media
        value={data.outputs.video}
        running={data.status === "running"}
        empty={<span>Connect a character image and a voice, then run</span>}
        name="talking"
        history={data.history}
        onPick={(i) => pickHistory(id, i)}
      />
      {!promptWired && (
        <textarea
          className={`${GROW} ${field} nowheel h-14 resize-none`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Acting (optional): e.g. calm, soft smile, gentle nods, looks into the lens"
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted">
          {seconds == null ? "The video lasts as long as the voice" : cost != null ? `Cost ≈ ${dollars(cost)} (${Math.round(seconds)} s)` : `${Math.round(seconds)} s of voice`}
        </span>
        <RunStop id={id} running={running} title="Makes the character speak" />
      </div>
    </NodeShell>
  );
}

/**
 * A finished video upscaled for export, then written locally in the chosen
 * frame rate, format and sound; downloadable from the node.
 */
/** An image made sharper and larger: fal's SeedVR2 or WaveSpeed's Image Upscaler. */
export function UpscaleImageNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const [resolution, setResolution] = useParam(id, data, "resolution");
  const [format, setFormat] = useParam(id, data, "format");
  const onWs = useKeys((s) => s.status?.provider === "wavespeed");
  const pickHistory = useFlow((s) => s.pickHistory);
  const running = useRunning(id);
  const res = resolution || "4k";
  // SeedVR2 on fal stops at 2160p: 8K is run as 4K there.
  const options = onWs ? IMAGE_UPSCALE_RESOLUTIONS : IMAGE_UPSCALE_RESOLUTIONS.filter(([v]) => v !== "8k");
  const cost = imageUpscaleCost(onWs, res);
  return (
    <NodeShell {...props} icon={ImageUpscale} title="Upscale image">
      <Media
        value={data.outputs.image}
        running={data.status === "running"}
        empty={<span>Connect an image, then run</span>}
        name={`image-${res}`}
        history={data.history}
        onPick={(i) => pickHistory(id, i)}
      />
      <div className="grid grid-cols-2 gap-2">
        <Select label="Resolution" value={!onWs && res === "8k" ? "4k" : res} options={options} onChange={setResolution} />
        <Select label="Format" value={format || "png"} options={IMAGE_UPSCALE_FORMATS} onChange={setFormat} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted">{onWs ? `Cost ${dollars(cost)}` : cost < 0.01 ? "Cost under $0.01" : `Cost ≤ ${dollars(cost)}`}</span>
        <RunStop id={id} running={running} title="Upscales the image" />
      </div>
    </NodeShell>
  );
}

export function UpscaleNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const [resolution, setResolution] = useParam(id, data, "resolution");
  const [quality, setQuality] = useParam(id, data, "quality");
  const [look, setLook] = useParam(id, data, "look");
  const [fidelity, setFidelity] = useParam(id, data, "fidelity");
  const [fps, setFps] = useParam(id, data, "fps");
  const [format, setFormat] = useParam(id, data, "format");
  const [sound, setSound] = useParam(id, data, "sound");
  const onFal = useKeys((s) => s.status?.provider !== "wavespeed");
  const pickHistory = useFlow((s) => s.pickHistory);
  const running = useRunning(id);
  // WaveSpeed's per-second rate × the source's length; fal's can't be told before.
  const seconds = useVideoDuration(useInputValue(id, "video"));
  const [cost, setCost] = useState<number | null>(null);
  useEffect(() => {
    if (seconds == null) return setCost(null);
    let live = true;
    invoke<number | null>("upscale_cost", { resolution: resolution || "1080p", quality: quality || "standard", seconds })
      .then((c) => live && setCost(c))
      .catch(() => live && setCost(null));
    return () => {
      live = false;
    };
  }, [resolution, quality, seconds, onFal]);
  return (
    <NodeShell {...props} icon={MonitorUp} title="Upscale / Export">
      <Media
        value={data.outputs.video}
        running={data.status === "running"}
        empty={<span>Connect a finished video, then run</span>}
        name={`video-${resolution || "1080p"}`}
        history={data.history}
        onPick={(i) => pickHistory(id, i)}
      />
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted">Upscale (AI)</div>
      <div className="grid grid-cols-2 gap-2">
        <Select label="Resolution" value={resolution || "1080p"} options={UPSCALE_RESOLUTIONS} onChange={setResolution} />
        <Select label="Quality" value={quality || "standard"} options={UPSCALE_QUALITY} onChange={setQuality} />
      </div>
      {onFal && (
        <div className="grid grid-cols-2 gap-2">
          <Select label="Footage" value={look || "aigc"} options={UPSCALE_LOOKS} onChange={setLook} />
          <Select label="Enhancement" value={fidelity || "high"} options={UPSCALE_FIDELITY} onChange={setFidelity} />
        </div>
      )}
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted">Export (on this computer, free)</div>
      <div className="grid grid-cols-2 gap-2">
        <Select label="Frame rate" value={fps} options={UPSCALE_FPS} onChange={setFps} />
        <Select label="Format" value={format || "h264"} options={UPSCALE_FORMATS} onChange={setFormat} />
      </div>
      <label className="nodrag flex items-center gap-2 text-[11px] text-muted">
        <input type="checkbox" className="accent-accent" checked={sound !== "off"} onChange={(e) => setSound(e.target.checked ? "on" : "off")} />
        Keep the sound
      </label>
      <div className="text-[10px] leading-snug text-muted">
        Upscale a draft once you like it: a 480p render plus an upscale costs far less than rendering in 1080p.
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted">
          {seconds == null
            ? "Cost: connect a video"
            : cost != null
              ? `Cost ≈ ${dollars(cost)} (${Math.round(seconds)} s)`
              : `fal bills by length (${Math.round(seconds)} s): see its pricing`}
        </span>
        <RunStop id={id} running={running} title="Upscales and exports the video" />
      </div>
    </NodeShell>
  );
}

/** Images, videos and sounds as layers, placed in a full-screen editor and rendered with ffmpeg. */
export function CompositorNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const setParam = useFlow((s) => s.setParam);
  const running = useRunning(id);
  const [editing, setEditing] = useState(false);
  const numbers = compositorLayers(data.params);
  const ports = [{ port: "bg", label: "Background" }, ...numbers.map((i) => ({ port: `layer${i}`, label: `Layer ${i}` }))];
  // One string, so the selector's result compares equal between renders.
  const joined = useFlowStore((s) =>
    ports
      .map(({ port }) => {
        const edge = s.edges.find((e) => e.target === id && e.targetHandle === port);
        const src = edge && (s.nodeLookup.get(edge.source)?.data as FlowNode["data"] | undefined);
        return (src && src.outputs[edge.sourceHandle ?? ""]) ?? "";
      })
      .join("\u0000"),
  );
  const values = joined.split("\u0000");
  const layers: LayerInput[] = ports.map((p, i) => ({ ...p, value: values[i] || undefined }));
  const last = numbers.length;
  const lastWired = useConnected(id, `layer${last}`);

  return (
    <NodeShell {...props} icon={Layers} title="Compositor" handleStep={26}>
      <Media
        value={data.outputs.media}
        running={data.status === "running"}
        empty={<span>Connect images, videos or sounds, then edit</span>}
        name="composition"
      />
      <div className="flex items-center gap-1">
        <button
          className="nodrag flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30"
          disabled={last >= MAX_LAYERS}
          onClick={() => setParam(id, "layers", String(last + 1))}
          title="Adds a layer input"
        >
          <Plus size={13} /> Layer
        </button>
        <button
          className="nodrag grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30"
          disabled={last === 0 || lastWired}
          onClick={() => setParam(id, "layers", String(last - 1))}
          title={lastWired ? "Disconnect the last layer first" : "Removes the last layer"}
        >
          <Minus size={13} />
        </button>
        <div className="ml-auto flex gap-1.5">
          <button
            className="nodrag flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] hover:border-accent"
            onClick={() => setEditing(true)}
          >
            <Pencil size={12} /> Edit
          </button>
          <RunStop id={id} running={running} title="Exports the composition as a video or an image, on this computer (free)" />
        </div>
      </div>
      {editing && <CompositorEditor id={id} params={data.params} layers={layers} onClose={() => setEditing(false)} />}
    </NodeShell>
  );
}

// ---------------------------------------------------------------------------
// BytePlus ModelArk (optional, the user's own account and keys)

/** The BytePlus key a node needs, or null; loads the key status once. */
function useBytePlusGate(kind: FlowNode["data"]["kind"]) {
  const keys = useBytePlusKeys((s) => s.keys);
  const refresh = useBytePlusKeys((s) => s.refresh);
  useEffect(() => {
    if (!keys) refresh();
  }, [keys, refresh]);
  return missingKey(kind, keys);
}

/** Replaces the run button while a BytePlus key is missing. */
function KeyNotice({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-1.5 rounded-lg bg-warning-tint/10 px-2.5 py-1.5 text-[11px] leading-snug text-warning">
      <KeyRound size={12} className="mt-0.5 shrink-0" />
      <span>{text} (BytePlus ModelArk).</span>
    </div>
  );
}

function Toggle({ label, value, onChange, title }: { label: string; value: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="nodrag flex items-center gap-1.5 text-[11px] text-muted" title={title}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

const PORTRAIT_STATUS: Record<string, [string, string]> = {
  Processing: ["In review", "bg-warning-tint/15 text-warning"],
  Active: ["Validated", "bg-success-tint/15 text-success"],
  Failed: ["Refused", "bg-danger-tint/15 text-danger"],
};

/** Sends an AI character to the user's BytePlus portrait library and follows its review. */
export function BpPortraitNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const [name, setName] = useParam(id, data, "name");
  const [group, setGroup] = useParam(id, data, "group");
  const [existing, setExisting] = useParam(id, data, "existing");
  const image = useInputValue(id, "image");
  // A portrait added by hand (BytePlus console) replaces the upload.
  const pasted = existing.trim() !== "";
  const running = useRunning(id);
  const gate = useBytePlusGate("bpPortrait");
  const [label, tone] = PORTRAIT_STATUS[data.outputs.assetStatus ?? ""] ?? ["Not sent yet", "bg-panel-2 text-muted"];
  // Another image wired since: running again sends it as a new portrait.
  const changed = !pasted && !!data.outputs.source && !!image && image !== data.outputs.source;

  return (
    <NodeShell {...props} icon={ScanFace} title="AI Portrait" subtitle="BytePlus ModelArk" runnable={!gate}>
      <Media
        value={pasted ? undefined : (image ?? (data.outputs.source || undefined))}
        running={data.status === "running"}
        empty={<span>{pasted ? "Portrait from your BytePlus library" : "Connect the character's image, or paste an existing asset ID"}</span>}
        name={name || "portrait"}
      />
      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${tone}`}>{label}</span>
        {changed && <span className="text-[10px] text-muted">new image: run again to send it</span>}
      </div>
      {data.outputs.portrait && (
        <code className="nodrag select-text truncate rounded bg-panel-2 px-2 py-1 font-mono text-[10px] text-muted" title={data.outputs.portrait}>
          {data.outputs.portrait}
        </code>
      )}
      <input
        className={`${field} font-mono`}
        value={existing}
        onChange={(e) => setExisting(e.target.value)}
        placeholder="Existing asset ID (optional): asset://asset-…"
        title="A portrait already in your BytePlus library, e.g. added in the console (Model Playground → My assets). It replaces the upload: no image needed."
      />
      {!pasted && (
        <div className="grid grid-cols-2 gap-2">
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. Nora)" />
          <input className={field} value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Group" title="BytePlus portrait group, created if missing" />
        </div>
      )}
      <div className="flex items-start gap-1.5 text-[10px] leading-snug text-muted">
        <TriangleAlert size={11} className="mt-px shrink-0 text-warning" />
        <span>AI character only — must not resemble any real person — no brand logo on the image.</span>
      </div>
      {gate ? (
        <KeyNotice text={gate} />
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-[10px] leading-snug text-muted">
            {pasted ? "Checks the portrait's review status." : "The image goes through fal storage (fal key required)."}
          </span>
          <div className="ml-auto">
            <RunStop id={id} running={running} title="Sends the portrait to BytePlus and follows its review (an image already validated is not sent again)" />
          </div>
        </div>
      )}
    </NodeShell>
  );
}

/** Which Seedance 2.5 task the wired inputs make; the two kinds can't be mixed. */
function useSeedanceMode(id: string) {
  return useFlowStore((s) => {
    const wired = (h: string) => s.edges.filter((e) => e.target === id && e.targetHandle === h).length;
    const refs = wired("portraits") + wired("refs");
    const frames = wired("start") + wired("end");
    if (refs && frames) return { mode: "conflict" as const, refs };
    if (frames) return { mode: wired("end") && !wired("start") ? ("noStart" as const) : ("frames" as const), refs };
    return { mode: refs ? ("refs" as const) : ("text" as const), refs };
  }, (a, b) => a.mode === b.mode && a.refs === b.refs);
}

const SEEDANCE_MODES = {
  text: "Mode: text → video",
  refs: "Mode: references. In the prompt, call them \"Image 1\", \"Image 2\"…: portraits first, then images.",
  frames: "Mode: start/end image (adaptive ratio enforced). A face only gets through if it comes from a BytePlus Seedream.",
};

/** Seedance 2.5 on BytePlus: faces through validated portraits or trusted Seedream images. */
export function BpSeedanceNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const [prompt, setPrompt] = useParam(id, data, "prompt");
  const [duration, setDuration] = useParam(id, data, "duration");
  const [ratio, setRatio] = useParam(id, data, "ratio");
  const [audio, setAudio] = useParam(id, data, "audio");
  const [draft, setDraft] = useParam(id, data, "draft");
  const [resolution, setResolution] = useParam(id, data, "resolution");
  const promptWired = useConnected(id, "prompt");
  const running = useRunning(id);
  const pickHistory = useFlow((s) => s.pickHistory);
  const gate = useBytePlusGate("bpSeedance");
  const { mode, refs } = useSeedanceMode(id);
  const isDraft = draft !== "false";
  const est = bpSeedanceEstimate(data.params);
  const blocked = mode === "conflict" || mode === "noStart" || refs > SEEDANCE_MAX_REFS;

  return (
    <NodeShell {...props} icon={Clapperboard} title="Seedance 2.5" subtitle="BytePlus ModelArk" modelId="seedance-2.5" runnable={!gate}>
      <Media
        value={data.outputs.video}
        running={data.status === "running" || !!data.finalizing}
        empty={<Clapperboard size={20} />}
        name="seedance-byteplus"
        history={data.history}
        onPick={(i) => pickHistory(id, i)}
      />
      <DraftBar id={id} data={data} running={running} />
      {!promptWired && (
        <textarea className={`${GROW} ${field} nowheel h-16 resize-none`} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder='Prompt (e.g. "The woman in Image 1 walks…")' />
      )}
      {mode === "conflict" ? (
        <div className="rounded-lg bg-danger-tint/10 px-2.5 py-1.5 text-[11px] leading-snug text-danger">
          Seedance 2.5 can&apos;t mix a start/end image with references. Disconnect one of them: to keep the character, keep the portrait and describe the first shot in the prompt.
        </div>
      ) : mode === "noStart" ? (
        <div className="rounded-lg bg-danger-tint/10 px-2.5 py-1.5 text-[11px] text-danger">An end image also needs a start image.</div>
      ) : refs > SEEDANCE_MAX_REFS ? (
        <div className="rounded-lg bg-danger-tint/10 px-2.5 py-1.5 text-[11px] text-danger">{SEEDANCE_MAX_REFS} references at most (portraits and images).</div>
      ) : (
        <div className="text-[10px] leading-snug text-muted">{SEEDANCE_MODES[mode]}</div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Select label="Duration" value={duration || "5"} options={SEEDANCE_DURATIONS} onChange={setDuration} />
        <Select label="Aspect ratio" value={ratio || "adaptive"} options={SEEDANCE_RATIOS} onChange={setRatio} />
        {!isDraft && (
          <Select
            label="Resolution"
            value={resolution || "1080p"}
            options={[
              ["480p", "480p"],
              ["720p", "720p"],
              ["1080p", "1080p"],
            ]}
            onChange={setResolution}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Toggle label="480p draft" value={isDraft} onChange={(v) => setDraft(String(v))} title="A cheaper 480p draft, to finalize in 1080p if you like it (14 days)" />
        <Toggle label="Sound" value={audio !== "false"} onChange={(v) => setAudio(String(v))} />
      </div>
      {gate ? (
        <KeyNotice text={gate} />
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-[10px] leading-snug text-muted" title="BytePlus pricing: tokens = width × height × 24 × seconds / 1024">
            ~{dollars(est.cost)} · {est.resolution}
            {est.auto ? `, estimated at ${est.seconds} s` : ""}
            {est.adaptive ? ", largest ratio" : ""} · billed by BytePlus
          </span>
          <div className="ml-auto">
            {blocked ? (
              <button className="nodrag rounded-lg border border-line px-3 py-1.5 text-[12px] text-muted opacity-50" disabled>
                Run
              </button>
            ) : (
              <RunStop id={id} running={running} title="Starts the generation on BytePlus (upstream nodes already generated are reused)" />
            )}
          </div>
        </div>
      )}
    </NodeShell>
  );
}

/** Seedream 5.0 on BytePlus: text-to-image outputs are trusted Seedance inputs for 30 days. */
export function BpSeedreamNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const [prompt, setPrompt] = useParam(id, data, "prompt");
  const [model, setModel] = useParam(id, data, "model");
  const [size, setSize] = useParam(id, data, "size");
  const promptWired = useConnected(id, "prompt");
  const running = useRunning(id);
  const pickHistory = useFlow((s) => s.pickHistory);
  const gate = useBytePlusGate("bpSeedream");
  const refs = useFlowStore((s) => s.edges.filter((e) => e.target === id && e.targetHandle === "refs").length);
  const expiry = trustExpiry(data.outputs);
  const trusted = !!expiry && expiry.getTime() > Date.now();

  return (
    <NodeShell {...props} icon={ImageIcon} title="Seedream" subtitle="BytePlus ModelArk" modelId="seedream-5-lite" runnable={!gate}>
      <Media value={data.outputs.image} running={data.status === "running"} empty={<ImageIcon size={20} />} name="seedream-byteplus" history={data.history} onPick={(i) => pickHistory(id, i)} />
      {data.outputs.image &&
        (expiry ? (
          <span className={`self-start rounded px-1.5 py-0.5 text-[10px] ${trusted ? "bg-success-tint/15 text-success" : "bg-panel-2 text-muted"}`}>
            {trusted ? `Trusted for Seedance · expires ${dayMonth(expiry)}` : `Trust expired on ${dayMonth(expiry)}`}
          </span>
        ) : (
          <span className="self-start rounded bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted">With references: trust not guaranteed</span>
        ))}
      {!promptWired && (
        <textarea className={`${GROW} ${field} nowheel h-16 resize-none`} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Prompt (or connect a Prompt node)" />
      )}
      <div className="grid grid-cols-2 gap-2">
        <Select
          label="Model"
          value={model || "pro"}
          options={[
            ["pro", "Seedream 5.0 pro"],
            ["flash", "Seedream 5.0 flash"],
          ]}
          onChange={setModel}
        />
        <Select
          label="Size"
          value={size || "2K"}
          options={[
            ["2K", "2K"],
            ["1K", "1K"],
          ]}
          onChange={setSize}
        />
      </div>
      {refs > 0 && <div className="text-[10px] leading-snug text-muted">Only text-to-image outputs are accepted by Seedance with a face.</div>}
      {gate ? (
        <KeyNotice text={gate} />
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted">~{dollars(bpSeedreamCost(data.params, refs))} · billed by BytePlus</span>
          <div className="ml-auto">
            <RunStop id={id} running={running} title="Generates the image on BytePlus" />
          </div>
        </div>
      )}
    </NodeShell>
  );
}

export const nodeTypes = {
  bpPortrait: BpPortraitNode,
  bpSeedance: BpSeedanceNode,
  bpSeedream: BpSeedreamNode,
  compositor: CompositorNode,
  prompt: PromptNode,
  list: ListNode,
  gridCrop: GridCropNode,
  angles: AnglesNode,
  anglePick: AnglePickNode,
  angleExport: AngleExportNode,
  image: ImageNode,
  model: ModelNode,
  preview: PreviewNode,
  router: RouterNode,
  concat: ConcatNode,
  crop: CropNode,
  frame: FrameNode,
  enhancer: EnhancerNode,
  describer: DescriberNode,
  videoDescriber: VideoDescriberNode,
  motionPrompt: MotionPromptNode,
  upscale: UpscaleNode,
  upscaleImage: UpscaleImageNode,
  voice: VoiceNode,
  avatar: AvatarNode,
  recast: RecastNode,
  addAudio: AddAudioNode,
};
