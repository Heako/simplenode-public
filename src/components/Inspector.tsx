"use client";

import { invoke } from "@tauri-apps/api/core";
import { useStore as useFlowStore } from "@xyflow/react";
import { ArrowRight, ChevronRight, Info, Loader2, Minus, Plus, RotateCcw, SlidersHorizontal, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { hasHistory, useFlow, useRunning, type FlowNode } from "@/lib/store";
import { findModel, isRefPort, useModels } from "@/lib/spec";
import { runsOnWaveSpeed, useKeys } from "@/lib/provider";
import { isAdvanced, optionLabel, settingLabel } from "@/lib/settingLabels";
import { isSeedanceReference, perSecond, seedanceEstimate, useVideoDuration } from "@/lib/cost";
import { TOOL_PANELS, imageUpscaleCost, type ToolPanel } from "@/lib/tools";
import ProviderIcon from "./ProviderIcon";

/** Mirrors `schema::Setting` in src-tauri. */
interface Setting {
  key: string;
  label: string;
  kind: "select" | "toggle" | "integer" | "number" | "text";
  options: string[];
  numericOptions: boolean;
  min: number | null;
  max: number | null;
  default: string | null;
  description: string | null;
}

interface Price {
  endpoint: string;
  unitPrice: number | null;
  unit: string | null;
  currency: string | null;
}

/** Settings per endpoint and model prices, fetched once per session. */
const useRemote = create<{
  settings: Record<string, Setting[] | "error">;
  prices: Price[] | null;
  loadSettings: (endpoint: string) => void;
  loadPrices: () => void;
}>((set, get) => ({
  settings: {},
  prices: null,
  loadSettings: (endpoint) => {
    if (get().settings[endpoint]) return;
    // "ws:<modelId>:text|edit": a registry model run on WaveSpeed, with WaveSpeed's own schema.
    const [scheme, modelId, mode] = endpoint.split(":");
    const request =
      scheme === "ws"
        ? invoke<Setting[]>("wavespeed_settings", { modelId, edit: mode === "edit" })
        : invoke<Setting[]>("model_settings", { endpoint });
    request
      .then((s) => set({ settings: { ...get().settings, [endpoint]: s } }))
      .catch(() => set({ settings: { ...get().settings, [endpoint]: "error" } }));
  },
  loadPrices: () => {
    if (get().prices) return;
    set({ prices: [] });
    invoke<Price[]>("model_prices")
      .then((prices) => set({ prices }))
      .catch(() => {});
  },
}));

/** WaveSpeed's exact price for the node's settings, asked again when they change. */
function useWaveSpeedPrice(modelId: string | undefined, edit: boolean, params: Record<string, string>, seconds?: number) {
  const [state, setState] = useState<{ key: string; cost?: number; error?: string }>({ key: "" });
  const key = modelId ? JSON.stringify([modelId, edit, params, seconds]) : "";
  useEffect(() => {
    if (!modelId) return;
    const timer = setTimeout(() => {
      invoke<{ cost: number }>("wavespeed_price", { modelId, edit, params, seconds: seconds ?? null })
        .then((p) => setState({ key, cost: p.cost }))
        .catch((e) => setState({ key, error: String(e) }));
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? state : { key };
}

const box = "nodrag rounded-md border border-line bg-panel-2 px-2 py-1.5 text-xs text-fg outline-none focus:border-accent";
const field = `${box} w-full`;

/** Units billed per run, so a total can be shown; others are priced per second, megapixel… */
const PER_RUN_UNITS = new Set(["image", "images", "video", "videos", "units", "requests", "generations"]);

/**
 * A setting only the other endpoint takes (the image-to-image `strength`
 * without a reference wired, say): shown, but only sent in that mode.
 */
type Shown = Setting & { onlyIn?: string };

/** Label with fal's description behind an info icon. */
function Label({ setting }: { setting: Shown }) {
  return (
    <span className="mb-1 flex items-center gap-1 text-[11px] text-muted">
      <span className="truncate">{settingLabel(setting.key, setting.label)}</span>
      {setting.onlyIn && <span className="shrink-0 rounded bg-panel-2 px-1 text-[9px]">{setting.onlyIn}</span>}
      {setting.description && (
        <span title={setting.description} className="shrink-0 cursor-help opacity-60 hover:opacity-100">
          <Info size={10} />
        </span>
      )}
    </span>
  );
}

function SettingControl({ setting, value, onChange }: { setting: Shown; value: string | undefined; onChange: (v: string) => void }) {
  const current = value ?? setting.default ?? "";

  switch (setting.kind) {
    case "select":
      return (
        <label className="block">
          <Label setting={setting} />
          <select className={field} value={current} onChange={(e) => onChange(e.target.value)}>
            {!setting.default && <option value="">Default</option>}
            {setting.options.map((o) => (
              <option key={o} value={o}>
                {optionLabel(setting.key, o)}
              </option>
            ))}
          </select>
        </label>
      );
    case "toggle":
      return (
        <label className="flex items-center justify-between gap-2 py-0.5 text-xs" title={setting.description ?? undefined}>
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate">{settingLabel(setting.key, setting.label)}</span>
            {setting.onlyIn && <span className="shrink-0 rounded bg-panel-2 px-1 text-[9px] text-muted">{setting.onlyIn}</span>}
          </span>
          <input type="checkbox" className="accent-accent" checked={current === "true"} onChange={(e) => onChange(String(e.target.checked))} />
        </label>
      );
    case "integer":
    case "number": {
      if (setting.key === "seed") {
        // Empty means random: fal picks a new seed each run.
        const random = current === "";
        return (
          <div>
            <Label setting={setting} />
            <div className="flex items-center gap-2">
              <input
                type="number"
                className={`${field} min-w-0 flex-1 disabled:opacity-40`}
                disabled={random}
                value={random ? "" : current}
                placeholder="random"
                onChange={(e) => onChange(e.target.value)}
              />
              <label className="flex shrink-0 items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={random}
                  onChange={(e) => onChange(e.target.checked ? "" : String(Math.floor(Math.random() * 1_000_000)))}
                />
                Random
              </label>
            </div>
          </div>
        );
      }
      const step = setting.kind === "integer" ? 1 : setting.max !== null && setting.max <= 2 ? 0.05 : 0.1;
      const bounded = setting.min !== null && setting.max !== null;
      return (
        <div>
          <Label setting={setting} />
          <div className="flex items-center gap-2">
            {bounded && (
              <input
                type="range"
                className="nodrag min-w-0 flex-1 accent-accent"
                min={setting.min!}
                max={setting.max!}
                step={step}
                value={current === "" ? setting.min! : Number(current)}
                onChange={(e) => onChange(e.target.value)}
              />
            )}
            <input
              type="number"
              className={bounded ? `${box} w-16 shrink-0 text-center` : field}
              min={setting.min ?? undefined}
              max={setting.max ?? undefined}
              step={step}
              value={current}
              placeholder="default"
              onChange={(e) => onChange(e.target.value)}
            />
          </div>
        </div>
      );
    }
    default:
      return (
        <label className="block">
          <Label setting={setting} />
          <input className={field} value={current} placeholder={setting.default ?? ""} onChange={(e) => onChange(e.target.value)} />
        </label>
      );
  }
}

/** Creative choices first, then numbers, switches, free text, and the seed last. */
const KIND_ORDER: Record<Setting["kind"], number> = { select: 0, integer: 1, number: 1, toggle: 2, text: 3 };
const rank = (s: Setting) => (s.key === "seed" ? 9 : KIND_ORDER[s.kind]);

function money(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: value < 1 ? 3 : 2 }).format(value);
}

/**
 * Right-hand panel for the selected model node: every setting fal publishes
 * for the endpoint that will be called, and a run section with a repeat count.
 */
export default function Inspector() {
  const node = useFlow((s) => {
    const selected = s.nodes.filter((n) => n.selected);
    return selected.length === 1 && (hasHistory(selected[0]) || TOOL_PANELS[selected[0].data.kind]) ? selected[0] : null;
  });
  if (!node) return null;
  const panel = TOOL_PANELS[node.data.kind];
  if (panel) return <ToolInspector key={node.id} node={node} panel={panel} />;
  return <ModelInspector key={node.id} node={node} />;
}

/** Value produced by whatever is wired into `handle` of node `id`, if it has run. */
function useWiredValue(id: string, handle: string) {
  return useFlowStore((s) => {
    const edge = s.edges.find((e) => e.target === id && e.targetHandle === handle);
    const from = edge && (s.nodeLookup.get(edge.source)?.data as FlowNode["data"] | undefined);
    return from ? from.outputs[edge.sourceHandle ?? ""] : undefined;
  });
}

/** What one run of a tool node costs, when it can be told; a label otherwise. */
function useToolCost(node: FlowNode): { cost: number | null; note: string } {
  const { id, data } = node;
  const keys = useKeys((s) => s.status);
  const onWs = keys?.provider === "wavespeed";
  const text = useWiredValue(id, "text");
  const media = useWiredValue(id, data.kind === "avatar" ? "audio" : "video");
  const seconds = useVideoDuration(data.kind === "avatar" || data.kind === "upscale" ? media : undefined);
  const [cost, setCost] = useState<number | null>(null);
  const chars = data.kind === "voice" ? (text ?? data.params.text ?? "").length : 0;
  useEffect(() => {
    let live = true;
    const done = (c: number | null) => live && setCost(c);
    if (data.kind === "voice" && chars > 0) invoke<number | null>("speech_cost", { kind: "voice", amount: chars }).then(done, () => done(null));
    else if (data.kind === "avatar" && seconds != null) invoke<number | null>("speech_cost", { kind: "avatar", amount: seconds }).then(done, () => done(null));
    else if (data.kind === "upscale" && seconds != null)
      invoke<number | null>("upscale_cost", { resolution: data.params.resolution || "1080p", quality: data.params.quality || "standard", seconds }).then(done, () => done(null));
    else done(null);
    return () => {
      live = false;
    };
  }, [data.kind, chars, seconds, data.params.resolution, data.params.quality, onWs]);
  if (data.kind === "upscaleImage") return { cost: imageUpscaleCost(onWs, data.params.resolution), note: onWs ? "" : " (up to, by output size)" };
  if (data.kind === "addAudio") return { cost: onWs ? 0 : null, note: onWs ? "Free (on this computer)" : "fal ffmpeg, a few cents" };
  if (data.kind === "motionPrompt") return { cost: null, note: onWs ? "≈ $0.05 (WaveSpeed vision LLM)" : "a few cents (fal any-llm)" };
  if (data.kind === "voice" && chars === 0) return { cost: null, note: "Write or connect a text" };
  if (data.kind === "avatar" && seconds == null) return { cost: null, note: "Connect a voice" };
  if (data.kind === "upscale" && seconds == null) return { cost: null, note: "Connect a video" };
  const amount = data.kind === "voice" ? ` (${chars} characters)` : seconds != null ? ` (${Math.round(seconds)} s)` : "";
  return { cost, note: cost == null ? `fal's price isn't known before${amount}` : amount };
}

/**
 * Right-hand panel for tool nodes that call a service without being registry
 * models: their settings (as on the node), the estimated cost and a run section.
 */
function ToolInspector({ node, panel }: { node: FlowNode; panel: ToolPanel }) {
  const { id, data } = node;
  const setParam = useFlow((s) => s.setParam);
  const run = useFlow((s) => s.run);
  const stop = useFlow((s) => s.stop);
  const running = useRunning(id);
  const onWs = useKeys((s) => s.status?.provider === "wavespeed");
  const wired = useFlowStore((s) => s.edges.filter((e) => e.target === id).map((e) => e.targetHandle ?? "").join(","));
  const [runs, setRuns] = useState(1);
  const [progress, setProgress] = useState<number | null>(null);
  const { cost, note } = useToolCost(node);

  async function runRepeated() {
    for (let i = 0; i < runs; i++) {
      setProgress(i + 1);
      await run(id);
      if (useFlow.getState().nodes.find((n) => n.id === id)?.data.status !== "done") break;
    }
    setProgress(null);
  }

  const fields = panel.fields.filter((f) => !(f.falOnly && onWs) && !(f.unlessWired && wired.split(",").includes(f.unlessWired)));
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-panel">
      <header className="flex items-center gap-2.5 border-b border-line px-4 py-3.5">
        <SlidersHorizontal size={18} className="text-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{data.title || panel.label}</div>
          <div className="flex min-w-0 items-center gap-1.5 truncate text-[10px] text-muted">
            {onWs && <span className="shrink-0 rounded bg-info-tint/15 px-1 py-px text-[10px] text-info">WaveSpeed</span>}
            <span className="truncate">{panel.service}</span>
          </div>
        </div>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted">Settings</div>
        {fields.map((f) => {
          const value = data.params[f.key] ?? f.default;
          return (
            <div key={f.key} className="space-y-1">
              {f.kind === "toggle" ? (
                <label className="flex items-center justify-between text-xs">
                  <span>{f.label}</span>
                  <input type="checkbox" className="accent-accent" checked={value === f.on} onChange={(e) => setParam(id, f.key, (e.target.checked ? f.on : f.off) ?? "")} />
                </label>
              ) : (
                <label className="block space-y-1">
                  <span className="block text-xs text-muted">{f.label}</span>
                  {f.kind === "select" ? (
                    <select className={field} value={value} onChange={(e) => setParam(id, f.key, e.target.value)}>
                      {(f.options ?? []).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <textarea className={`${field} h-24 resize-none`} value={value} placeholder={f.placeholder} onChange={(e) => setParam(id, f.key, e.target.value)} />
                  )}
                </label>
              )}
              {f.hint && <p className="text-[10px] leading-snug text-muted">{f.hint}</p>}
            </div>
          );
        })}
      </div>

      <footer className="space-y-3 border-t border-line px-4 py-4">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">Runs</span>
          <div className="flex items-center rounded-md border border-line">
            <button className="grid h-7 w-7 place-items-center text-muted hover:text-fg disabled:opacity-30" disabled={runs <= 1} onClick={() => setRuns(runs - 1)}>
              <Minus size={12} />
            </button>
            <span className="w-6 text-center tabular-nums">{runs}</span>
            <button className="grid h-7 w-7 place-items-center text-muted hover:text-fg disabled:opacity-30" disabled={runs >= 10} onClick={() => setRuns(runs + 1)}>
              <Plus size={12} />
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted">Estimated cost</span>
          <span className="truncate text-right tabular-nums" title={note}>
            {cost != null ? `${cost === 0 ? "Free" : money(cost * runs, "USD")}${note && cost !== 0 ? ` ${note}` : ""}` : note}
          </span>
        </div>
        {running || progress !== null ? (
          <button
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-danger-tint/50 py-2 text-[13px] font-medium text-danger hover:bg-danger-tint/10"
            onClick={() => stop([id])}
          >
            <Square size={12} fill="currentColor" /> Stop{progress !== null && runs > 1 ? ` (run ${progress}/${runs})` : ""}
          </button>
        ) : (
          <button className="flex w-full items-center justify-center gap-2 rounded-lg bg-fg py-2 text-[13px] font-medium text-bg" onClick={runRepeated}>
            <ArrowRight size={14} /> Run{runs > 1 ? ` ×${runs}` : ""}
          </button>
        )}
        {onWs && <p className="text-[10px] leading-snug text-muted">On WaveSpeed a started run can&apos;t be cancelled: Stop only stops waiting.</p>}
      </footer>
    </aside>
  );
}

function ModelInspector({ node }: { node: FlowNode }) {
  const { id, data } = node;
  useModels((s) => s.models.length);
  const model = findModel(data.params.modelId);
  const setParam = useFlow((s) => s.setParam);
  const patchNode = useFlow((s) => s.patchNode);
  const run = useFlow((s) => s.run);
  const stop = useFlow((s) => s.stop);
  const running = useRunning(id);
  const refsWired = useFlowStore((s) => s.edges.some((e) => e.target === id && isRefPort(e.targetHandle)));
  const keys = useKeys((s) => s.status);
  const refreshKeys = useKeys((s) => s.refresh);
  // On WaveSpeed, settings and prices come from WaveSpeed's own schema of the model.
  const onWs = runsOnWaveSpeed(keys, model?.id);
  const falEndpoint = (refsWired ? model?.editEndpoint : model?.textEndpoint) ?? model?.textEndpoint ?? model?.editEndpoint ?? null;
  const endpoint = onWs ? `ws:${model!.id}:${refsWired ? "edit" : "text"}` : falEndpoint;
  // The endpoint of the other mode, whose settings are listed too.
  const other = onWs
    ? model?.textEndpoint && model?.editEndpoint
      ? `ws:${model.id}:${refsWired ? "text" : "edit"}`
      : null
    : ([model?.textEndpoint, model?.editEndpoint].find((e) => e && e !== endpoint) ?? null);
  const { settings, prices, loadSettings, loadPrices } = useRemote();
  const [runs, setRuns] = useState(1);
  const [progress, setProgress] = useState<number | null>(null);
  // Recast is billed per second of video: the estimate needs the source's length.
  // Recast and Seedance 2.5 with a reference video bill the source's seconds.
  const sourceHandle = data.kind === "recast" ? "video" : isSeedanceReference(model?.id) ? "media:video_urls" : null;
  const source = useFlowStore((s) => {
    if (!sourceHandle) return undefined;
    const edge = s.edges.find((e) => e.target === id && e.targetHandle === sourceHandle);
    const from = edge && (s.nodeLookup.get(edge.source)?.data as FlowNode["data"] | undefined);
    return from ? from.outputs[edge.sourceHandle ?? ""] : undefined;
  });
  const duration = useVideoDuration(source);
  // Recast on WaveSpeed is priced per second of source video.
  const wsPrice = useWaveSpeedPrice(onWs ? model?.id : undefined, refsWired, data.params, data.kind === "recast" ? (duration ?? undefined) : undefined);
  // WaveSpeed is the provider but doesn't host this model: it won't run.
  const falOnlyHere = keys?.provider === "wavespeed" && !onWs;

  useEffect(() => {
    refreshKeys();
  }, [refreshKeys]);
  useEffect(() => {
    if (endpoint) loadSettings(endpoint);
    if (other) loadSettings(other);
    loadPrices();
  }, [endpoint, other, loadSettings, loadPrices]);

  if (!model || !endpoint) return null;
  const list = settings[endpoint];
  // The registry's settings come first; fal's schema adds the rest.
  // Single-option ones are fixed values, nothing to choose.
  // On WaveSpeed, every setting comes from its schema (the registry's are fal's).
  const main: Setting[] = (onWs ? [] : model.params)
    .filter((p) => p.options.length > 1 && !(p.textOnly && refsWired))
    .map((p) => ({
      key: p.key,
      label: p.label,
      kind: p.kind === "bool" ? "toggle" : "select",
      options: p.options,
      numericOptions: p.kind === "int",
      min: null,
      max: null,
      default: p.default,
      description: null,
    }));
  // ElevenLabs sound effects name their prompt `text`: it comes from the node, not here.
  const own = new Set([...(onWs ? [] : model.params.map((p) => p.key)), "prompt", "negative_prompt", ...(model.category === "audio" ? ["text"] : [])]);
  const otherList = other ? settings[other] : undefined;
  const otherOnly: Shown[] = Array.isArray(otherList) && Array.isArray(list)
    ? otherList
        .filter((s) => !list.some((l) => l.key === s.key))
        .map((s) => ({ ...s, onlyIn: refsWired ? "without ref." : model.category === "video" ? "with image" : "with ref." }))
    : [];
  const extra: Shown[] = [...(Array.isArray(list) ? list : []), ...otherOnly]
    .filter((s) => !own.has(s.key))
    .sort((x, y) => rank(x) - rank(y));
  const common = extra.filter((s) => !isAdvanced(s.key));
  const advanced = extra.filter((s) => isAdvanced(s.key));
  const touched = Object.keys(data.params).some((k) => k.startsWith("x:") && data.params[k] !== "");
  const price = onWs ? undefined : prices?.find((p) => p.endpoint === endpoint);
  const perRun = price?.unitPrice != null && price.unit && PER_RUN_UNITS.has(price.unit);
  const rate = data.kind === "recast" ? perSecond(price, data.params.resolution) : null;
  // Seedance 2.5 is billed in video tokens, from its resolution and duration.
  const tokens = seedanceEstimate(model.id, data.params, { price, inputSeconds: duration });
  const currency = price?.currency ?? "USD";
  const control = (s: Shown, key: string) => (
    <div key={s.key} className={s.onlyIn ? "opacity-60" : undefined} title={s.onlyIn ? "Only applied in this mode" : undefined}>
      <SettingControl setting={s} value={data.params[key]} onChange={(v) => setParam(id, key, v)} />
    </div>
  );

  async function runRepeated() {
    for (let i = 0; i < runs; i++) {
      setProgress(i + 1);
      await run(id);
      // Stop the series when a run fails or is stopped.
      if (useFlow.getState().nodes.find((n) => n.id === id)?.data.status !== "done") break;
    }
    setProgress(null);
  }

  function reset() {
    const params = Object.fromEntries(Object.entries(data.params).filter(([k]) => !k.startsWith("x:")));
    patchNode(id, { params });
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-panel">
      <header className="flex items-center gap-2.5 border-b border-line px-4 py-3.5">
        <ProviderIcon modelId={model.id} llmModel={data.params.model} size={18} fallback={SlidersHorizontal} className="text-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{data.title || model.label}</div>
          <div className="flex min-w-0 items-center gap-1.5 truncate text-[10px] text-muted">
            {/* The service that runs it comes first, before the model's maker. */}
            {onWs && (
              <span className="shrink-0 rounded bg-info-tint/15 px-1 py-px text-[10px] text-info" title="This model runs on WaveSpeed (Settings → WaveSpeed)">
                WaveSpeed
              </span>
            )}
            <span className="truncate">
            {model.provider} ·{" "}
            {data.kind === "recast" ? "video → video" : refsWired ? (model.category === "video" ? "image → video" : "edit") : "text →"}
            </span>
          </div>
        </div>
        {onWs ? null : rate != null ? (
          <span
            className="shrink-0 rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted tabular-nums"
            title={`fal price: ${money(rate, currency)} per second of video, at this resolution`}
          >
            {money(rate, currency)} / s
          </span>
        ) : price?.unitPrice != null && (
          <span
            className="shrink-0 rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted tabular-nums"
            title={`fal price: ${money(price.unitPrice, price.currency ?? "USD")} per ${price.unit}`}
          >
            {money(price.unitPrice, price.currency ?? "USD")}
            {perRun ? "" : ` / ${price.unit}`}
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {falOnlyHere && (
          <p className="rounded-md bg-warning-tint/10 px-2.5 py-2 text-[11px] leading-snug text-warning">
            WaveSpeed is your provider and doesn&apos;t host {model.label}: it won&apos;t run. Pick another model, or switch Provider to fal.ai in
            Settings.
          </p>
        )}
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-medium tracking-wide text-muted uppercase">Settings</h3>
          {touched && (
            <button className="flex items-center gap-1 text-[10px] text-muted hover:text-fg" onClick={reset} title="Back to fal's defaults">
              <RotateCcw size={10} /> Reset
            </button>
          )}
        </div>
        {main.map((s) => control(s, s.key))}
        {list === undefined && <Loader2 size={14} className="animate-spin text-muted" />}
        {list === "error" && <p className="text-[11px] text-muted">Settings unavailable (fal schema unreachable).</p>}
        {Array.isArray(list) && extra.length === 0 && main.length === 0 && <p className="text-[11px] text-muted">No settings for this model.</p>}
        {common.map((s) => control(s, `x:${s.key}`))}
        {advanced.length > 0 && (
          <details className="group/adv border-t border-line pt-3">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] font-medium tracking-wide text-muted uppercase select-none hover:text-fg">
              <ChevronRight size={12} className="transition-transform group-open/adv:rotate-90" /> Advanced
            </summary>
            <div className="mt-3 space-y-3">{advanced.map((s) => control(s, `x:${s.key}`))}</div>
          </details>
        )}
        <p className="pt-1 text-[10px] leading-snug text-muted">
          Settings read from the schema {onWs ? "WaveSpeed" : "fal"} publishes for this model{refsWired ? " (reference image mode)" : ""}.
        </p>
      </div>

      <footer className="space-y-3 border-t border-line px-4 py-4">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">Runs</span>
          <div className="flex items-center rounded-md border border-line">
            <button className="grid h-7 w-7 place-items-center text-muted hover:text-fg disabled:opacity-30" disabled={runs <= 1} onClick={() => setRuns(runs - 1)}>
              <Minus size={12} />
            </button>
            <span className="w-6 text-center tabular-nums">{runs}</span>
            <button className="grid h-7 w-7 place-items-center text-muted hover:text-fg disabled:opacity-30" disabled={runs >= 10} onClick={() => setRuns(runs + 1)}>
              <Plus size={12} />
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">Estimated cost</span>
          <span
            className="tabular-nums"
            title={
              onWs
                ? wsPrice.error
                  ? `WaveSpeed couldn't price this request: ${wsPrice.error}`
                  : "Exact price given by WaveSpeed for these settings, your account's discount included."
                : rate != null
                ? "Price per second × length of the source video. Redoing a segment costs its length."
                : tokens
                  ? tokens.inputSeconds != null
                    ? `${Math.round(tokens.tokens).toLocaleString("en-US")} tokens at ${tokens.resolution}: width × height × 24 × (${tokens.inputSeconds} s of reference video + ${tokens.seconds} s generated) / 1024, at 0.6 × the token price. Sound doesn't change the price.`
                    : `${Math.round(tokens.tokens).toLocaleString("en-US")} tokens at ${tokens.resolution} (width × height × 24 × duration / 1024). Sound doesn't change the price.`
                  : undefined
            }
          >
            {onWs
              ? wsPrice.cost != null
                ? data.kind === "recast" && duration == null
                  ? `${money(wsPrice.cost, "USD")} / s of video`
                  : `${money(wsPrice.cost * runs, "USD")}${data.kind === "recast" && duration != null ? ` (${Math.round(duration)} s)` : ""}`
                : wsPrice.error
                  ? "—"
                  : "…"
              : tokens
              ? `${money(tokens.cost * runs, currency)}${tokens.auto ? ` (auto duration: ${tokens.seconds} s)` : ""}`
              : rate != null
              ? duration != null
                ? `${money(rate * duration * runs, currency)} (${Math.round(duration)} s)`
                : `${money(rate, currency)} / s of video`
              : price?.unitPrice == null
              ? "—"
              : perRun
                ? money(price.unitPrice * runs, price.currency ?? "USD")
                : `${money(price.unitPrice, price.currency ?? "USD")} / ${price.unit}`}
          </span>
        </div>
        {running || progress !== null ? (
          <button
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-danger-tint/50 py-2 text-[13px] font-medium text-danger hover:bg-danger-tint/10"
            onClick={() => stop([id])}
            title="Stops this node and cancels its request"
          >
            <Square size={12} fill="currentColor" /> Stop{progress !== null && runs > 1 ? ` (run ${progress}/${runs})` : ""}
          </button>
        ) : (
          <button className="flex w-full items-center justify-center gap-2 rounded-lg bg-fg py-2 text-[13px] font-medium text-bg" onClick={runRepeated}>
            <ArrowRight size={14} /> Run{runs > 1 ? ` ×${runs}` : ""}
          </button>
        )}
        {runs > 1 && <p className="text-[10px] leading-snug text-muted">Each run is added to the node&apos;s history (‹ › on the image).</p>}
      </footer>
    </aside>
  );
}
