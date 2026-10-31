"use client";

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ExternalLink, FolderOpen, KeyRound, Loader2, ReceiptText, RefreshCw, HardDrive, Heart, Info } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import ProviderIcon from "./ProviderIcon";
import { useModels } from "@/lib/spec";
import { perSecondRows } from "@/lib/cost";

type KeyKind = "main" | "billing";

interface KeyStatus {
  main: "saved" | "env" | null;
  billing: boolean;
}

interface PriceRow {
  label: string;
  category: "image" | "video" | "llm" | "audio" | "outil";
  mode: string;
  endpoint: string;
  unitPrice: number | null;
  unit: string | null;
  currency: string | null;
}

interface Spend {
  since: string;
  total: number;
  currency: string;
  rows: { endpoint: string; label: string | null; unit: string; quantity: number; cost: number }[];
}

interface MediaUsage {
  path: string;
  files: number;
  bytes: number;
}

const FAL_KEYS_URL = "https://fal.ai/dashboard/keys";
const FAL_BILLING_URL = "https://fal.ai/dashboard/billing";

const money = (value: number, currency = "USD") =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: value < 1 ? 4 : 2 }).format(value);

const bytes = (n: number) => {
  const units = ["o", "Ko", "Mo", "Go"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} ${units[i]}`;
};

const UNIT_LABELS: Record<string, string> = {
  image: "image",
  images: "image",
  megapixels: "mégapixel",
  seconds: "seconde",
  second: "seconde",
  video: "vidéo",
  videos: "vidéo",
  "1000 tokens": "1 000 tokens",
  units: "unité",
  requests: "requête",
};

const unitLabel = (unit: string | null) => (unit ? (UNIT_LABELS[unit] ?? unit) : "");

function Section({ id, icon: Icon, title, description, children }: { id: string; icon: typeof KeyRound; title: string; description: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 rounded-xl border border-line bg-panel">
      <header className="flex items-start gap-3 border-b border-line px-5 py-4">
        <Icon size={16} className="mt-0.5 text-muted" />
        <div>
          <h2 className="text-[14px] font-medium">{title}</h2>
          <p className="mt-0.5 text-[12px] text-muted">{description}</p>
        </div>
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

/** Opens in the system browser: the webview itself never navigates away. */
function ExternalLinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button onClick={() => openUrl(href)} className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline">
      {children} <ExternalLink size={11} />
    </button>
  );
}

function KeyField({ kind, configured, label, hint, onSaved }: { kind: KeyKind; configured: boolean; label: string; hint: ReactNode; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [state, setState] = useState<{ busy?: boolean; ok?: string; error?: string }>({});

  async function act(fn: () => Promise<unknown>, ok: string) {
    setState({ busy: true });
    try {
      await fn();
      setState({ ok });
      onSaved();
    } catch (err) {
      setState({ error: String(err) });
    }
  }

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-2">
        <span className="text-[13px]">{label}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${configured ? "bg-emerald-500/15 text-emerald-300" : "bg-panel-2 text-muted"}`}>
          {configured ? "Configurée" : "Absente"}
        </span>
      </div>
      <p className="mt-1 text-[12px] text-muted">{hint}</p>
      <div className="mt-2.5 flex gap-2">
        <input
          type="password"
          className="flex-1 rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-[13px] outline-none focus:border-accent"
          placeholder={configured ? "Coller une nouvelle clé pour la remplacer" : "Coller la clé"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          className="rounded-lg bg-fg px-3 py-1.5 text-[12px] font-medium text-bg disabled:opacity-40"
          disabled={!value.trim() || state.busy}
          onClick={() => act(() => invoke("set_fal_key", { kind, key: value }).then(() => setValue("")), "Clé enregistrée.")}
        >
          Enregistrer
        </button>
        <button
          className="rounded-lg border border-line px-3 py-1.5 text-[12px] disabled:opacity-40"
          disabled={!configured || state.busy}
          onClick={() => act(() => invoke("test_fal_key", { kind }), "La clé fonctionne.")}
        >
          Tester
        </button>
        <button
          className="rounded-lg px-2 py-1.5 text-[12px] text-red-300 disabled:opacity-40"
          disabled={!configured || state.busy}
          onClick={() => act(() => invoke("set_fal_key", { kind, key: "" }), "Clé supprimée.")}
        >
          Supprimer
        </button>
      </div>
      {state.busy && <Loader2 size={13} className="mt-2 animate-spin text-muted" />}
      {state.ok && (
        <p className="mt-2 flex items-center gap-1 text-[12px] text-emerald-300">
          <Check size={12} /> {state.ok}
        </p>
      )}
      {state.error && <p className="mt-2 text-[12px] text-red-300">{state.error}</p>}
    </div>
  );
}

function KeysSection() {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const refresh = useCallback(() => invoke<KeyStatus>("key_status").then(setStatus), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <Section id="keys" icon={KeyRound} title="Clé API fal.ai" description="Stockées sur cet ordinateur dans un fichier privé de l'app, jamais dans vos projets.">
      <div className="divide-y divide-line">
        <KeyField
          kind="main"
          configured={!!status?.main}
          label="Clé de génération"
          onSaved={refresh}
          hint={
            status?.main === "env" ? (
              "Lue depuis la variable d'environnement FAL_KEY. Enregistrez-en une ici pour la remplacer."
            ) : (
              <>
                Utilisée pour exécuter les modèles. <ExternalLinkButton href={FAL_KEYS_URL}>Gérer mes clés sur fal.ai</ExternalLinkButton>
              </>
            )
          }
        />
        <KeyField
          kind="billing"
          configured={!!status?.billing}
          label="Clé de facturation (optionnelle)"
          onSaved={refresh}
          hint="Pour afficher vos dépenses. fal exige une clé créée avec le preset BILLING ou FULL ; sinon la clé de génération est utilisée."
        />
      </div>
    </Section>
  );
}

const PERIODS: [number, string][] = [
  [7, "7 jours"],
  [30, "30 jours"],
  [0, "Ce mois-ci"],
];

const CATEGORY_TITLES: Record<PriceRow["category"], string> = {
  image: "Modèles d'image",
  video: "Modèles vidéo",
  audio: "Musique & son",
  llm: "Texte",
  outil: "Outils",
};

function CostsSection() {
  const models = useModels((s) => s.models);
  const [days, setDays] = useState(30);
  const [spend, setSpend] = useState<{ data?: Spend; error?: string; busy?: boolean }>({});
  const [prices, setPrices] = useState<{ data?: PriceRow[]; error?: string; busy?: boolean }>({});
  const [filter, setFilter] = useState("");

  const loadSpend = useCallback((d: number) => {
    setSpend({ busy: true });
    invoke<Spend>("fal_spend", { days: d })
      .then((data) => setSpend({ data }))
      .catch((e) => setSpend({ error: String(e) }));
  }, []);
  const loadPrices = useCallback(() => {
    setPrices({ busy: true });
    invoke<PriceRow[]>("model_prices")
      .then((data) => setPrices({ data: perSecondRows(data) }))
      .catch((e) => setPrices({ error: String(e) }));
  }, []);

  useEffect(() => loadSpend(days), [days, loadSpend]);
  useEffect(() => loadPrices(), [loadPrices]);

  // Registry label -> id, to show provider logos next to prices.
  const idByLabel = useMemo(() => new Map(models.map((m) => [m.label, m.id])), [models]);
  const shownPrices = (prices.data ?? []).filter((r) => !filter || r.label.toLowerCase().includes(filter.toLowerCase()));
  const maxCost = Math.max(...(spend.data?.rows.map((r) => r.cost) ?? [0]), 0.000001);

  return (
    <Section id="costs" icon={ReceiptText} title="Coûts" description="Tarifs de chaque modèle et dépenses réelles de votre compte fal.">
      <div className="flex items-center gap-2">
        <h3 className="mr-auto text-[13px] font-medium">Dépenses par modèle</h3>
        {PERIODS.map(([d, label]) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`rounded-md px-2.5 py-1 text-[12px] ${days === d ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"}`}
          >
            {label}
          </button>
        ))}
        <button className="grid h-7 w-7 place-items-center rounded-md text-muted hover:text-fg" onClick={() => loadSpend(days)} title="Actualiser">
          <RefreshCw size={13} />
        </button>
      </div>

      {spend.busy && <Loader2 size={14} className="mt-3 animate-spin text-muted" />}
      {spend.error && (
        <div className="mt-3 rounded-lg bg-panel-2 px-3 py-2.5 text-[12px] text-muted">
          <span className="text-red-300">Dépenses indisponibles</span> — {spend.error}
        </div>
      )}
      {spend.data && (
        <>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-[26px] font-semibold tabular-nums">{money(spend.data.total, spend.data.currency)}</span>
            <span className="text-[12px] text-muted">depuis le {new Date(spend.data.since).toLocaleDateString("fr-FR")} · estimation fal</span>
          </div>
          {spend.data.rows.length === 0 ? (
            <p className="mt-2 text-[12px] text-muted">Aucune dépense sur la période.</p>
          ) : (
            <div className="mt-3 space-y-1.5">
              {spend.data.rows.map((r) => (
                <div key={`${r.endpoint}-${r.unit}`} className="grid grid-cols-[minmax(0,1fr)_120px_90px] items-center gap-3 text-[12px]">
                  <div className="min-w-0">
                    <div className="truncate">{r.label ?? r.endpoint}</div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel-2">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${(r.cost / maxCost) * 100}%` }} />
                    </div>
                  </div>
                  <span className="text-right text-muted tabular-nums">
                    {r.quantity.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} {unitLabel(r.unit)}
                    {r.quantity > 1 ? "s" : ""}
                  </span>
                  <span className="text-right tabular-nums">{money(r.cost, spend.data!.currency)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <p className="mt-3 text-[12px] text-muted">
        fal ne publie pas le solde par API. <ExternalLinkButton href={FAL_BILLING_URL}>Voir le solde et recharger</ExternalLinkButton>
      </p>

      <div className="mt-6 flex items-center gap-2 border-t border-line pt-5">
        <h3 className="mr-auto text-[13px] font-medium">Tarifs des modèles</h3>
        <input
          className="w-44 rounded-md border border-line bg-panel-2 px-2.5 py-1 text-[12px] outline-none focus:border-accent"
          placeholder="Filtrer"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {prices.busy && <Loader2 size={14} className="mt-3 animate-spin text-muted" />}
      {prices.error && <p className="mt-3 text-[12px] text-red-300">{prices.error}</p>}
      {prices.data &&
        (Object.keys(CATEGORY_TITLES) as PriceRow["category"][]).map((cat) => {
          const rows = shownPrices.filter((r) => r.category === cat);
          if (!rows.length) return null;
          return (
            <div key={cat} className="mt-4">
              <div className="mb-1.5 text-[11px] text-muted">{CATEGORY_TITLES[cat]}</div>
              <div className="divide-y divide-line rounded-lg border border-line">
                {rows.map((r) => (
                  <div key={r.endpoint} className="grid grid-cols-[minmax(0,1fr)_110px_150px] items-center gap-3 px-3 py-2 text-[12px]">
                    <div className="flex min-w-0 items-center gap-2">
                      <ProviderIcon modelId={idByLabel.get(r.label)} size={14} fallback={ReceiptText} className="text-muted" />
                      <span className="truncate">{r.label}</span>
                    </div>
                    <span className="text-muted">{r.mode === "image" ? (cat === "video" ? "image → vidéo" : "édition") : r.mode === "texte" ? "texte →" : ""}</span>
                    <span className="text-right tabular-nums">
                      {r.unitPrice == null ? (
                        <span className="text-muted">non publié</span>
                      ) : (
                        <>
                          {money(r.unitPrice, r.currency ?? "USD")} <span className="text-muted">/ {unitLabel(r.unit)}</span>
                        </>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
    </Section>
  );
}

function StorageSection() {
  const [usage, setUsage] = useState<MediaUsage | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const refresh = useCallback(() => invoke<MediaUsage>("media_usage").then(setUsage), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function clean() {
    setConfirming(false);
    try {
      const freed = await invoke<MediaUsage>("clean_unused_media");
      setMessage(freed.files ? `${freed.files} fichier${freed.files > 1 ? "s" : ""} supprimé${freed.files > 1 ? "s" : ""}, ${bytes(freed.bytes)} libérés.` : "Aucun média inutilisé.");
      refresh();
    } catch (err) {
      setMessage(String(err));
    }
  }

  return (
    <Section id="storage" icon={HardDrive} title="Stockage" description="Images et vidéos importées ou générées, conservées en local.">
      {usage && (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-[20px] font-semibold tabular-nums">{bytes(usage.bytes)}</span>
            <span className="text-[12px] text-muted">{usage.files} fichiers</span>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-muted" title={usage.path}>
            {usage.path}
          </p>
        </>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px]" onClick={() => invoke("reveal_media_folder")}>
          <FolderOpen size={13} /> Ouvrir le dossier
        </button>
        {confirming ? (
          <>
            <button className="rounded-lg bg-red-500/80 px-3 py-1.5 text-[12px] font-medium" onClick={clean}>
              Confirmer la suppression
            </button>
            <button className="rounded-lg px-3 py-1.5 text-[12px] text-muted" onClick={() => setConfirming(false)}>
              Annuler
            </button>
          </>
        ) : (
          <button className="rounded-lg border border-line px-3 py-1.5 text-[12px]" onClick={() => setConfirming(true)}>
            Supprimer les médias inutilisés
          </button>
        )}
      </div>
      <p className="mt-2 text-[12px] text-muted">
        Supprime les fichiers qui ne figurent dans aucun projet, corbeille comprise. Cette action est définitive.
      </p>
      {message && <p className="mt-2 text-[12px] text-fg">{message}</p>}
    </Section>
  );
}

function AboutSection() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);
  return (
    <Section id="about" icon={Info} title="À propos" description="SimpleNode — canvas à nœuds pour la génération IA.">
      <dl className="grid grid-cols-[140px_1fr] gap-y-1.5 text-[12px]">
        <dt className="text-muted">Version</dt>
        <dd>{version}</dd>
        <dt className="text-muted">Modèles</dt>
        <dd>Exécutés via fal.ai</dd>
        <dt className="text-muted">Logos</dt>
        <dd>
          <ExternalLinkButton href="https://github.com/lobehub/lobe-icons">@lobehub/icons</ExternalLinkButton> (MIT) — marques de leurs propriétaires respectifs
        </dd>
      </dl>
      <p className="mt-4 border-t border-line pt-3 text-[11px] text-muted">
        © {new Date().getFullYear()} LUDACOM SARL. SimpleNode by Ludacom. Tous droits réservés.
        <span className="mt-1 flex items-center gap-1">
          Made with <Heart size={11} className="fill-[#ff4d6d] text-[#ff4d6d]" aria-label="love" /> Paris
        </span>
      </p>
    </Section>
  );
}

const SECTIONS: [string, string][] = [
  ["keys", "Clé API"],
  ["costs", "Coûts"],
  ["storage", "Stockage"],
  ["about", "À propos"],
];

export default function Settings() {
  return (
    <div className="mt-6 grid grid-cols-[160px_minmax(0,1fr)] gap-8">
      <nav className="sticky top-6 space-y-0.5 self-start">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="block rounded-md px-2.5 py-1.5 text-[13px] text-muted hover:bg-panel hover:text-fg">
            {label}
          </a>
        ))}
      </nav>
      <div className="space-y-6 pb-16">
        <KeysSection />
        <CostsSection />
        <StorageSection />
        <AboutSection />
      </div>
    </div>
  );
}
