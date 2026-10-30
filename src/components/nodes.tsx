"use client";

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Handle, NodeResizer, Position, useUpdateNodeInternals, useStore as useFlowStore, type NodeProps } from "@xyflow/react";
import {
  ArrowRight,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Crop,
  Download,
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
  Sparkles,
  Split,
  Type,
  X,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFlow, useRunning, type FlowNode } from "@/lib/store";
import ProviderIcon from "./ProviderIcon";
import TemplateEditor, { type TemplateEditorHandle, type VarDisplay } from "./TemplateEditor";
import { ANGLE_LAYOUTS, MAX_GRID, PORT_COLORS, varLabel, angleLayout, angleShots, findModel, gridSize, parseViews, listItems, llmOptions, portsFor, promptVars, useModels, type Port, type View } from "@/lib/spec";

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
  children: ReactNode;
}) {
  const run = useFlow((s) => s.run);
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
    data.status === "error" ? "border-red-500/70" : selected ? "border-accent" : "border-line hover:border-[#45454d]";
  // Tall enough for every port, so none hangs below the card.
  const minHeight = HANDLE_TOP + Math.max(inputs.length, outputs.length, 1) * handleStep + 8;

  return (
    <div
      data-resized={resized || undefined}
      className={`group group/card relative flex flex-col rounded-2xl border bg-panel shadow-2xl shadow-black/50 transition-colors ${ring}`}
      style={resized ? { width: "100%", height: "100%", minHeight } : { width: cardWidth, minHeight }}
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
            <div className="truncate text-[13px] font-medium" onDoubleClick={() => setRenaming(id)} title="Double-clic pour renommer">
              {data.title || title}
            </div>
          )}
          {subtitle && <div className="truncate text-[10px] text-muted">{subtitle}</div>}
        </div>
        {data.status === "running" && <Loader2 size={14} className="animate-spin text-accent" />}
        {runnable && (
          <button
            className="nodrag grid h-6 w-6 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30"
            disabled={running}
            onClick={() => run(id)}
            title="Exécuter jusqu'à ce nœud"
          >
            <Play size={12} fill="currentColor" />
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-3.5 pb-3.5">{children}</div>
      {data.error && <div className="mx-3.5 mb-3 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">{data.error}</div>}
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
    <button type="button" onClick={download} title={state === "error" ? "Échec de l'enregistrement" : "Télécharger"} className={className}>
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
    const dir = await open({ directory: true, title: `Choisir un dossier pour les ${local.length} générations` });
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
      title={state === "error" ? "Échec de l'enregistrement" : `Tout télécharger (${local.length})`}
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

const toolButton = "nodrag grid h-7 w-7 place-items-center rounded-md text-white/90 hover:bg-white/15 hover:text-white";

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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 px-8 pt-16 pb-8" onClick={onClose}>
      <div className="absolute top-4 right-4 flex gap-1" onClick={(e) => e.stopPropagation()}>
        <DownloadButton path={value} name={name} className={toolButton} />
        <button className={toolButton} onClick={onClose} title="Fermer (Échap)">
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
  const browsable = !!onPick && !!history && history.length > 1 && index >= 0;

  return (
    <div className="checker relative grid min-h-[180px] place-items-center overflow-hidden rounded-xl border border-line">
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
        <div className="absolute inset-x-0 top-0 flex items-center gap-0.5 bg-gradient-to-b from-black/55 to-transparent px-1.5 pt-1.5 pb-4">
          {browsable && (
            <>
              <button className={`${toolButton} disabled:opacity-30`} disabled={index === 0} onClick={() => onPick(index - 1)} title="Génération précédente">
                <ChevronLeft size={15} />
              </button>
              <span className="min-w-9 text-center text-[11px] text-white/90 tabular-nums">
                {index + 1} / {history.length}
              </span>
              <button
                className={`${toolButton} disabled:opacity-30`}
                disabled={index === history.length - 1}
                onClick={() => onPick(index + 1)}
                title="Génération suivante"
              >
                <ChevronRight size={15} />
              </button>
            </>
          )}
          <div className="ml-auto flex gap-0.5">
            <DownloadButton path={value} name={name} className={toolButton} />
            {history && <DownloadAllButton paths={history} name={name} className={toolButton} />}
            <button className={toolButton} onClick={() => setFull(true)} title="Plein écran">
              <Maximize2 size={14} />
            </button>
          </div>
        </div>
      )}
      {value && size && (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white/90 tabular-nums">
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
  ["both", "Source + valeur"],
  ["source", "Source"],
  ["value", "Valeur"],
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
        placeholder="Décrivez ce que vous voulez générer… (@ pour une variable)"
        onChange={(template) => setParam(id, "text", template)}
        onCreateVar={createVar}
      />
      {unused.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted">
          Non utilisées :
          {unused.map((name) => (
            <span key={name} className="nodrag flex items-center rounded-md border border-dashed border-[#e8b04a]/40 text-[10px] text-[#f3c977]">
              <button className="py-0.5 pl-1.5" onClick={() => editor.current?.insertVar(name)} title="Réinsérer au curseur">
                {varLabel(name)}
              </button>
              <button className="px-1 py-0.5 opacity-60 hover:opacity-100" onClick={() => deleteVar(name)} title="Supprimer la variable et son lien">
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
          title="Ajoute une entrée dont la valeur s'insère dans le texte, là où se trouve le curseur"
        >
          <Plus size={12} /> Ajouter une variable
        </button>
        {vars.length > 0 && (
          <label className="ml-auto flex min-w-0 items-center gap-1.5 text-[10px] text-muted">
            Affichage
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
              title="Utiliser cet élément"
            />
            <input
              className={`${field} !py-1.5 ${i === selected ? "!border-accent/60" : ""}`}
              value={item}
              placeholder={`Élément ${i + 1}`}
              onChange={(e) => save(items.map((v, j) => (j === i ? e.target.value : v)))}
            />
            <button
              className="nodrag grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted hover:text-fg disabled:opacity-30"
              disabled={items.length <= 1}
              onClick={() => save(items.filter((_, j) => j !== i), i < selected ? selected - 1 : selected)}
              title="Retirer"
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
        <Plus size={12} /> Ajouter un élément
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
      filters: [{ name: "Images, vidéos et audio", extensions: [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS] }],
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
    <NodeShell {...props} icon={ImageUp} title={props.data.params.label || "Import"} subtitle={props.data.params.label ? "Plan extrait" : undefined} runnable={false}>
      {path ? (
        <>
          <Media value={path} name={props.data.params.label || undefined} empty={null} />
          <button className="nodrag text-[11px] text-muted hover:text-fg" onClick={pick} disabled={busy}>
            {busy ? "Import…" : "Remplacer le fichier"}
          </button>
        </>
      ) : (
        <button className="nodrag block w-full" onClick={pick} disabled={busy}>
          <Media
            empty={
              <>
                <ImageUp size={20} />
                {busy ? "Import…" : "Cliquer pour importer"}
              </>
            }
          />
        </button>
      )}
    </NodeShell>
  );
}

export function ModelNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const model = findModel(data.params.modelId);
  const [prompt, setPrompt] = useParam(id, data, "prompt");
  const [system, setSystem] = useParam(id, data, "system");
  const promptWired = useConnected(id, "prompt");
  const negativeWired = useConnected(id, "negative");
  const [negative, setNegative] = useParam(id, data, "negative");
  const isLlm = model?.category === "llm";
  const isVideo = model?.category === "video";
  const patchNode = useFlow((s) => s.patchNode);
  const running = useRunning(id);
  const [finalizing, setFinalizing] = useState(false);
  const pickHistory = useFlow((s) => s.pickHistory);
  const run = useFlow((s) => s.run);
  const draftId = data.outputs.draftId;

  async function finalize() {
    setFinalizing(true);
    patchNode(id, { error: undefined });
    try {
      const video = await invoke<string>("finalize_draft", { draftId });
      // Drop draftId: a finalized draft can't be finalized again.
      patchNode(id, { outputs: { video }, status: "done", history: [...(data.history ?? []), video] });
    } catch (err) {
      patchNode(id, { error: String(err) });
    } finally {
      setFinalizing(false);
    }
  }

  return (
    <NodeShell {...props} icon={isLlm ? Sparkles : isVideo ? Clapperboard : ImageIcon} title={model?.label ?? data.params.modelId}
      subtitle={model?.provider}
      modelId={data.params.modelId}
      llmModel={data.params.model}>
      {!model && <div className="text-xs text-muted">Modèle introuvable dans le registre.</div>}
      {isLlm ? (
        <>
          <textarea className={`${GROW} ${field} nowheel h-14 resize-none`} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="Instruction système (optionnel)" />
          <TextOut value={data.outputs.text} />
        </>
      ) : (
        <>
          <Media
            value={isVideo ? data.outputs.video : data.outputs.image}
            running={data.status === "running" || finalizing}
            empty={isVideo ? <Clapperboard size={20} /> : <ImageIcon size={20} />}
            name={model?.label}
            history={data.history}
            onPick={(i) => pickHistory(id, i)}
          />
          {draftId && (
            <div className="flex items-center gap-2">
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">Brouillon 480p</span>
              <button
                className="nodrag ml-auto rounded-lg bg-fg px-2.5 py-1.5 text-[11px] font-medium text-bg disabled:opacity-50"
                disabled={finalizing || running}
                onClick={finalize}
                title="Rend la même vidéo en 1080p (brouillon valable 7 jours)"
              >
                {finalizing ? "Finalisation…" : "Finaliser en 1080p"}
              </button>
            </div>
          )}
        </>
      )}
      {!promptWired && (
        <textarea className={`${GROW} ${field} nowheel h-16 resize-none`} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Prompt (ou reliez un nœud Prompt)" />
      )}
      {model?.negative && !negativeWired && (
        <textarea
          className={`${GROW} ${field} nowheel h-12 resize-none`}
          value={negative}
          onChange={(e) => setNegative(e.target.value)}
          placeholder="Prompt négatif (optionnel) : ce que le modèle doit éviter"
        />
      )}
      <div className="flex justify-end">
        <button
          className="nodrag flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] hover:border-accent disabled:opacity-40"
          disabled={running}
          onClick={() => run(id)}
          title="Exécute ce modèle (les nœuds en amont déjà générés sont réutilisés)"
        >
          <ArrowRight size={13} /> Exécuter
        </button>
      </div>
    </NodeShell>
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
        <Media value={value} empty={<span>Reliez un nœud puis exécutez</span>} />
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
        {kind ? `Transmet : ${kind === "text" ? "texte" : kind}` : "Une entrée, autant de sorties que nécessaire."}
      </div>
    </NodeShell>
  );
}

const SEPARATORS: [string, string][] = [
  ["newline", "Retour à la ligne"],
  ["space", "Espace"],
  ["comma", "Virgule"],
];

export function ConcatNode(props: NodeProps<FlowNode>) {
  const [separator, setSeparator] = useParam(props.id, props.data, "separator");
  const count = useFlowStore((s) => s.edges.filter((e) => e.target === props.id).length);
  return (
    <NodeShell {...props} icon={Merge} title="Prompt Concatenator" runnable={false}>
      <div className="text-[11px] text-muted">{count} texte{count > 1 ? "s" : ""} relié{count > 1 ? "s" : ""}, dans l&apos;ordre des connexions.</div>
      <Select label="Séparateur" value={separator} options={SEPARATORS} onChange={setSeparator} />
      {props.data.outputs.text ? (
        <TextOut value={props.data.outputs.text} />
      ) : (
        <div className="text-[11px] text-muted">Le texte assemblé s&apos;affiche ici en direct.</div>
      )}
    </NodeShell>
  );
}

const ASPECTS: [string, string][] = [
  ["free", "Libre"],
  ["1:1", "1:1"],
  ["16:9", "16:9"],
  ["9:16", "9:16"],
  ["4:3", "4:3"],
  ["3:4", "3:4"],
  ["3:2", "3:2"],
  ["2:3", "2:3"],
];

/** Same math as `storage::crop_rect` in Rust, in percent of the source. */
function cropBox(aspect: string, size: { w: number; h: number } | null, p: Record<string, string>) {
  if (aspect === "free" || !size) {
    const x = Number(p.x) || 0;
    const y = Number(p.y) || 0;
    return { x, y, w: Math.min(Number(p.w) || 100, 100 - x), h: Math.min(Number(p.h) || 100, 100 - y) };
  }
  const [a, b] = aspect.split(":").map(Number);
  const ratio = a / b;
  const [cw, ch] = size.w / size.h > ratio ? [size.h * ratio, size.h] : [size.w, size.w / ratio];
  return { x: ((size.w - cw) / 2 / size.w) * 100, y: ((size.h - ch) / 2 / size.h) * 100, w: (cw / size.w) * 100, h: (ch / size.h) * 100 };
}

export function CropNode(props: NodeProps<FlowNode>) {
  const { id, data } = props;
  const setParam = useFlow((s) => s.setParam);
  const patchNode = useFlow((s) => s.patchNode);
  const input = useInputValue(id, "image");
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const aspect = data.params.aspect ?? "free";
  const box = cropBox(aspect, size, data.params);
  const showResult = data.status === "done" && data.outputs.image;

  return (
    <NodeShell {...props} icon={Crop} title="Crop">
      {showResult ? (
        <Media value={data.outputs.image} empty={null} />
      ) : (
        <div className="checker relative grid min-h-[160px] place-items-center overflow-hidden rounded-xl border border-line">
          {input ? (
            <div className="relative w-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={mediaSrc(input)}
                alt=""
                className="block w-full"
                draggable={false}
                onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              />
              <div
                className="absolute border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
                style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` }}
              />
            </div>
          ) : (
            <span className="text-[11px] text-muted">Reliez une image (exécutée)</span>
          )}
        </div>
      )}
      <Select
        label="Format"
        value={aspect}
        options={ASPECTS}
        onChange={(v) => {
          setParam(id, "aspect", v);
          // Go back to the editable view; the old result no longer matches.
          patchNode(id, { status: "idle" });
        }}
      />
      {aspect === "free" && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {(
            [
              ["x", "Gauche"],
              ["y", "Haut"],
              ["w", "Largeur"],
              ["h", "Hauteur"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="block text-[10px] text-muted">
              {label} {data.params[key]}%
              <input
                type="range"
                min={key === "w" || key === "h" ? 1 : 0}
                max={100}
                value={data.params[key] ?? "0"}
                onChange={(e) => {
                  setParam(id, key, e.target.value);
                  patchNode(id, { status: "idle" });
                }}
                className="nodrag block w-full accent-accent"
              />
            </label>
          ))}
        </div>
      )}
    </NodeShell>
  );
}

function LlmSelect({ id, data }: { id: string; data: FlowNode["data"] }) {
  const [model, setModel] = useParam(id, data, "model");
  useModels((s) => s.models.length);
  return <Select label="Modèle" value={model} options={llmOptions().map((o) => [o, o])} onChange={setModel} />;
}

export function EnhancerNode(props: NodeProps<FlowNode>) {
  const [text, setText] = useParam(props.id, props.data, "text");
  const wired = useConnected(props.id, "text");
  return (
    <NodeShell {...props} icon={WandSparkles} title="Prompt Enhancer">
      {!wired && (
        <textarea className={`${GROW} ${field} nowheel h-16 resize-none`} value={text} onChange={(e) => setText(e.target.value)} placeholder="Idée de départ (ou reliez un Prompt)" />
      )}
      <LlmSelect id={props.id} data={props.data} />
      <TextOut value={props.data.outputs.text} />
    </NodeShell>
  );
}

const DETAILS: [string, string][] = [
  ["long", "Détaillée"],
  ["short", "Courte"],
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
        placeholder="Question précise (optionnel) — sinon description complète"
      />
      <label className="nodrag flex items-center gap-2 text-[11px] text-muted">
        <input type="checkbox" className="accent-accent" checked={detailed === "true"} onChange={(e) => setDetailed(String(e.target.checked))} />
        Analyse détaillée
      </label>
      <TextOut value={props.data.outputs.text} />
    </NodeShell>
  );
}

const GRID_PRESETS: [string, string, number][] = [
  ["2x2", "4 vues — 2×2", 2],
  ["3x3", "9 vues — 3×3", 3],
  ["4x4", "16 vues — 4×4", 4],
  ["5x5", "25 vues — 5×5", 5],
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
      <div className="rounded-lg border border-amber-400/25 bg-amber-400/5 px-2.5 py-2 text-[11px] leading-snug text-amber-100/90">
        Découpe une image <b>déjà en grille</b> (planche de plusieurs vues). Pour générer des angles de caméra différents à partir
        d&apos;une seule image :
        <button
          className="nodrag mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md bg-amber-300/90 py-1 text-[11px] font-medium text-black hover:bg-amber-200"
          onClick={() => gridCropToAngles(id)}
        >
          <Camera size={12} /> Remplacer par Angles caméra
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
                <div key={i} className="relative border border-white/70">
                  {inset > 0 && <div className="absolute border border-dashed border-amber-300/80" style={{ inset: `${inset}%` }} />}
                  <span className="absolute top-0.5 left-0.5 rounded bg-black/60 px-1 text-[9px]">{i + 1}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="grid min-h-[140px] place-items-center text-[11px] text-muted">Reliez une planche d&apos;images</div>
        )}
      </div>
      <Select
        label="Grille"
        value={preset}
        options={[...GRID_PRESETS.map(([v, l]): [string, string] => [v, l]), ["custom", "Personnalisée"]]}
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
            label="Lignes"
            value={String(rows)}
            options={Array.from({ length: MAX_GRID }, (_, i): [string, string] => [String(i + 1), String(i + 1)])}
            onChange={(v) => setGrid(Number(v), cols)}
          />
          <Select
            label="Colonnes"
            value={String(cols)}
            options={Array.from({ length: MAX_GRID }, (_, i): [string, string] => [String(i + 1), String(i + 1)])}
            onChange={(v) => setGrid(rows, Number(v))}
          />
        </div>
      )}
      <label className="block text-[10px] text-muted">
        Rogner les bords de chaque vue : {inset}%
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
        {rows * cols} vues sur une seule sortie « Vues », à relier à Aperçu des angles ou Export des angles. ▶ pour découper.
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
    <NodeShell {...props} icon={Camera} title="Angles caméra" subtitle={model?.label} modelId={data.params.modelId} cardWidth={380}>
      {done ? (
        <Gallery views={views} cols={cols} />
      ) : (
        <div className="checker relative grid min-h-[110px] place-items-center overflow-hidden rounded-xl border border-line">
          {reference ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={mediaSrc(reference)} alt="" className="block max-h-44 w-full object-contain" draggable={false} />
          ) : (
            <span className="text-[11px] text-muted">Reliez une image de référence</span>
          )}
          {data.status === "running" && <div className="absolute inset-0 animate-pulse bg-accent/10" />}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Select
          label="Modèle"
          value={data.params.modelId}
          options={models.filter((m) => m.category === "image" && m.editEndpoint).map((m): [string, string] => [m.id, m.label])}
          onChange={(v) => update("modelId", v)}
        />
        <Select
          label="Disposition"
          value={`${cols}x${rows}`}
          options={ANGLE_LAYOUTS.map(([c, r]): [string, string] => [`${c}x${r}`, `${c}×${r} — ${c * r} plans`])}
          onChange={(v) => {
            update("layout", v);
            // Resize the shot list to the new grid, keeping choices already made.
            setParam(id, "shots", JSON.stringify(angleShots({ ...data.params, layout: v })));
          }}
        />
        <Select
          label="Génération"
          value={separate ? "separate" : "sheet"}
          options={[
            ["sheet", "Planche (1 appel)"],
            ["separate", `Par plan (${cols * rows} appels)`],
          ]}
          onChange={(v) => update("mode", v)}
        />
        <Select label="Format des plans" value={data.params.panel || "16:9"} options={PANEL_FORMATS} onChange={(v) => update("panel", v)} />
        {resolutions && (
          <Select
            label="Résolution"
            value={resolutions.includes(data.params.resolution) ? data.params.resolution : (model?.params.find((p) => p.key === "resolution")?.default ?? "")}
            options={resolutions.map((r): [string, string] => [r, r])}
            onChange={(v) => update("resolution", v)}
          />
        )}
        {!separate && (
          <label className="nodrag flex items-center gap-2 self-end pb-2 text-[11px] text-muted">
            <input type="checkbox" className="accent-accent" checked={data.params.labels === "true"} onChange={(e) => update("labels", String(e.target.checked))} />
            Noms dans l&apos;image
          </label>
        )}
      </div>

      <div>
        <div className="mb-1 text-[10px] text-muted">Plans, dans l&apos;ordre de la planche</div>
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {shots.map((shotId, i) => (
            <label key={i} className="relative block">
              <span className="pointer-events-none absolute top-1/2 left-1.5 -translate-y-1/2 text-[9px] text-muted">{i + 1}</span>
              <select
                className="nodrag w-full truncate rounded-md border border-line bg-panel-2 py-1 pr-1 pl-4 text-[10px] text-fg outline-none focus:border-accent"
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
          ? `${cols * rows} générations séparées, meilleure résolution par plan.`
          : "Une seule image en grille, découpée en plans : moins cher et plus cohérent."}
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
}: {
  views: View[];
  cols: number;
  selected?: number;
  onSelect?: (index: number) => void;
}) {
  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {views.map((v, i) => (
        <div key={i} className="group/media relative">
          <button
            type="button"
            disabled={!onSelect}
            onClick={() => onSelect?.(i)}
            title={v.label}
            className={`nodrag relative block w-full overflow-hidden rounded-md border-2 ${i === selected ? "border-accent" : "border-transparent"} ${onSelect ? "cursor-pointer hover:border-accent/50" : "cursor-default"}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={mediaSrc(v.path)} alt="" className="block aspect-video w-full object-cover" draggable={false} />
            <span className="absolute bottom-0.5 left-0.5 max-w-[95%] truncate rounded bg-black/65 px-1 text-[9px]">
              {i + 1}. {v.label}
            </span>
          </button>
          <DownloadButton
            path={v.path}
            name={`${String(i + 1).padStart(2, "0")}-${v.label}`}
            className="nodrag absolute top-1 right-1 grid h-6 w-6 place-items-center rounded-md bg-black/65 text-white opacity-0 transition-opacity group-hover/media:opacity-100 hover:bg-black/85"
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
    <NodeShell {...props} icon={Images} title="Aperçu des angles" runnable={false} cardWidth={340}>
      {views.length ? (
        <>
          <Gallery views={views} cols={galleryCols(views.length)} selected={selected} onSelect={(i) => setParam(id, "selected", String(i))} />
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span className="min-w-0 flex-1 truncate">
              Sortie : <span className="text-fg">{views[selected].label}</span> — cliquez un plan pour le choisir.
            </span>
            <button
              className="nodrag flex shrink-0 items-center gap-1 rounded-md bg-fg px-2 py-1 text-[11px] font-medium text-bg hover:opacity-90"
              onClick={() => extractViews(id)}
              title="Crée un nœud image par plan, chacun avec sa propre sortie"
            >
              <Images size={12} /> Tout extraire
            </button>
          </div>
        </>
      ) : (
        <div className="checker grid min-h-[120px] place-items-center rounded-xl border border-line text-[11px] text-muted">
          Reliez la sortie « Plans » d&apos;Angles caméra
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
    <NodeShell {...props} icon={FolderDown} title="Export des angles" cardWidth={280}>
      <div className="text-[11px] text-muted">
        {views.length ? `${views.length} plans reçus.` : "Reliez la sortie « Plans » d'Angles caméra."} Ils sont enregistrés à chaque
        exécution, nommés <span className="font-mono text-fg">01-gros-plan.png</span>…
      </div>
      <button
        className="nodrag flex w-full items-center gap-2 rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-left text-[11px] hover:border-accent"
        onClick={pickFolder}
        title={folder || undefined}
      >
        <FolderOpen size={13} className="shrink-0 text-muted" />
        <span className={`truncate ${folder ? "text-fg" : "text-muted"}`}>{folder || "Choisir le dossier d'export"}</span>
      </button>
      {data.outputs.summary && (
        <div className="flex items-center gap-2 text-[11px] text-emerald-300">
          {data.outputs.summary}
          <button className="nodrag ml-auto text-accent hover:underline" onClick={() => revealItemInDir(folder)}>
            Ouvrir
          </button>
        </div>
      )}
    </NodeShell>
  );
}

export const nodeTypes = {
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
  enhancer: EnhancerNode,
  describer: DescriberNode,
  videoDescriber: VideoDescriberNode,
};
