"use client";

import { invoke } from "@tauri-apps/api/core";
import { useStore as useFlowStore } from "@xyflow/react";
import { ArrowRight, ChevronRight, Info, Loader2, Minus, Plus, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { useFlow, useRunning, type FlowNode } from "@/lib/store";
import { findModel, useModels } from "@/lib/spec";
import { isAdvanced, optionLabel, settingLabel } from "@/lib/settingLabels";
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
    invoke<Setting[]>("model_settings", { endpoint })
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
            {!setting.default && <option value="">Par défaut</option>}
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
                placeholder="aléatoire"
                onChange={(e) => onChange(e.target.value)}
              />
              <label className="flex shrink-0 items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={random}
                  onChange={(e) => onChange(e.target.checked ? "" : String(Math.floor(Math.random() * 1_000_000)))}
                />
                Aléatoire
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
              placeholder="défaut"
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
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: value < 1 ? 3 : 2 }).format(value);
}

/**
 * Right-hand panel for the selected model node: every setting fal publishes
 * for the endpoint that will be called, and a run section with a repeat count.
 */
export default function Inspector() {
  const node = useFlow((s) => {
    const selected = s.nodes.filter((n) => n.selected);
    return selected.length === 1 && selected[0].data.kind === "model" ? selected[0] : null;
  });
  if (!node) return null;
  return <ModelInspector key={node.id} node={node} />;
}

function ModelInspector({ node }: { node: FlowNode }) {
  const { id, data } = node;
  useModels((s) => s.models.length);
  const model = findModel(data.params.modelId);
  const setParam = useFlow((s) => s.setParam);
  const patchNode = useFlow((s) => s.patchNode);
  const run = useFlow((s) => s.run);
  const running = useRunning(id);
  const refsWired = useFlowStore((s) => s.edges.some((e) => e.target === id && e.targetHandle === "refs"));
  const endpoint = (refsWired ? model?.editEndpoint : model?.textEndpoint) ?? model?.textEndpoint ?? model?.editEndpoint ?? null;
  // The endpoint of the other mode, whose settings are listed too.
  const other = [model?.textEndpoint, model?.editEndpoint].find((e) => e && e !== endpoint) ?? null;
  const { settings, prices, loadSettings, loadPrices } = useRemote();
  const [runs, setRuns] = useState(1);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    if (endpoint) loadSettings(endpoint);
    if (other) loadSettings(other);
    loadPrices();
  }, [endpoint, other, loadSettings, loadPrices]);

  if (!model || !endpoint) return null;
  const list = settings[endpoint];
  // The registry's settings come first; fal's schema adds the rest.
  // Single-option ones are fixed values, nothing to choose.
  const main: Setting[] = model.params
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
  const own = new Set([...model.params.map((p) => p.key), "prompt", "negative_prompt"]);
  const otherList = other ? settings[other] : undefined;
  const otherOnly: Shown[] = Array.isArray(otherList) && Array.isArray(list)
    ? otherList
        .filter((s) => !list.some((l) => l.key === s.key))
        .map((s) => ({ ...s, onlyIn: refsWired ? "sans réf." : model.category === "video" ? "avec image" : "avec réf." }))
    : [];
  const extra: Shown[] = [...(Array.isArray(list) ? list : []), ...otherOnly]
    .filter((s) => !own.has(s.key))
    .sort((x, y) => rank(x) - rank(y));
  const common = extra.filter((s) => !isAdvanced(s.key));
  const advanced = extra.filter((s) => isAdvanced(s.key));
  const touched = Object.keys(data.params).some((k) => k.startsWith("x:") && data.params[k] !== "");
  const price = prices?.find((p) => p.endpoint === endpoint);
  const perRun = price?.unitPrice != null && price.unit && PER_RUN_UNITS.has(price.unit);
  const control = (s: Shown, key: string) => (
    <div key={s.key} className={s.onlyIn ? "opacity-60" : undefined} title={s.onlyIn ? "Appliqué seulement dans ce mode" : undefined}>
      <SettingControl setting={s} value={data.params[key]} onChange={(v) => setParam(id, key, v)} />
    </div>
  );

  async function runRepeated() {
    for (let i = 0; i < runs; i++) {
      setProgress(i + 1);
      await run(id);
      // Stop the series when a run fails.
      if (useFlow.getState().nodes.find((n) => n.id === id)?.data.status === "error") break;
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
          <div className="truncate text-[10px] text-muted">
            {model.provider} · {refsWired ? (model.category === "video" ? "image → vidéo" : "édition") : "texte →"}
          </div>
        </div>
        {price?.unitPrice != null && (
          <span
            className="shrink-0 rounded-md bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted tabular-nums"
            title={`Tarif fal : ${money(price.unitPrice, price.currency ?? "USD")} par ${price.unit}`}
          >
            {money(price.unitPrice, price.currency ?? "USD")}
            {perRun ? "" : ` / ${price.unit}`}
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-medium tracking-wide text-muted uppercase">Réglages</h3>
          {touched && (
            <button className="flex items-center gap-1 text-[10px] text-muted hover:text-fg" onClick={reset} title="Revenir aux valeurs par défaut de fal">
              <RotateCcw size={10} /> Réinitialiser
            </button>
          )}
        </div>
        {main.map((s) => control(s, s.key))}
        {list === undefined && <Loader2 size={14} className="animate-spin text-muted" />}
        {list === "error" && <p className="text-[11px] text-muted">Réglages indisponibles (schéma fal inaccessible).</p>}
        {Array.isArray(list) && extra.length === 0 && main.length === 0 && <p className="text-[11px] text-muted">Aucun réglage pour ce modèle.</p>}
        {common.map((s) => control(s, `x:${s.key}`))}
        {advanced.length > 0 && (
          <details className="group/adv border-t border-line pt-3">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] font-medium tracking-wide text-muted uppercase select-none hover:text-fg">
              <ChevronRight size={12} className="transition-transform group-open/adv:rotate-90" /> Avancé
            </summary>
            <div className="mt-3 space-y-3">{advanced.map((s) => control(s, `x:${s.key}`))}</div>
          </details>
        )}
        <p className="pt-1 text-[10px] leading-snug text-muted">
          Réglages lus sur le schéma publié par fal pour cet endpoint{refsWired ? " (mode avec image de référence)" : ""}.
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
          <span className="text-muted">Coût estimé</span>
          <span className="tabular-nums">
            {price?.unitPrice == null
              ? "—"
              : perRun
                ? money(price.unitPrice * runs, price.currency ?? "USD")
                : `${money(price.unitPrice, price.currency ?? "USD")} / ${price.unit}`}
          </span>
        </div>
        <button
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-fg py-2 text-[13px] font-medium text-bg disabled:opacity-50"
          disabled={running || progress !== null}
          onClick={runRepeated}
        >
          {progress !== null ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Run {progress}/{runs}
            </>
          ) : (
            <>
              <ArrowRight size={14} /> Exécuter{runs > 1 ? ` ×${runs}` : ""}
            </>
          )}
        </button>
        {runs > 1 && <p className="text-[10px] leading-snug text-muted">Chaque run s&apos;ajoute à l&apos;historique du nœud (‹ › sur l&apos;image).</p>}
      </footer>
    </aside>
  );
}
