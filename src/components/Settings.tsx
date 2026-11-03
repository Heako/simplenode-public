"use client";

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Bot, Check, Waves, Clapperboard, Coffee, Copy, Eye, EyeOff, ExternalLink, FolderOpen, KeyRound, Loader2, ReceiptText, RefreshCw, HardDrive, Heart, Info } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import ProviderIcon from "./ProviderIcon";
import { useModels } from "@/lib/spec";
import { perSecondRows } from "@/lib/cost";
import { useMcpSpend, type McpStatus } from "@/lib/mcp";
import { BYTEPLUS_LINKS, useBytePlusKeys } from "@/lib/byteplus";
import { WAVESPEED_LINKS, useKeys, type KeyStatus } from "@/lib/provider";

type KeyKind = "main" | "billing" | "byteplus" | "byteplusAk" | "byteplusSk" | "wavespeed";

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
  new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: value < 1 ? 4 : 2 }).format(value);

const bytes = (n: number) => {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${units[i]}`;
};

const UNIT_LABELS: Record<string, string> = {
  image: "image",
  images: "image",
  megapixels: "megapixel",
  seconds: "second",
  second: "second",
  video: "video",
  videos: "video",
  "1000 tokens": "1,000 tokens",
  units: "unit",
  requests: "request",
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

function KeyField({
  kind,
  configured,
  label,
  hint,
  onSaved,
  testable = true,
}: {
  kind: KeyKind;
  configured: boolean;
  label: string;
  hint: ReactNode;
  onSaved: () => void;
  /** BytePlus keys are tested together, from their section's button. */
  testable?: boolean;
}) {
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
          {configured ? "Set" : "Missing"}
        </span>
      </div>
      <p className="mt-1 text-[12px] text-muted">{hint}</p>
      <div className="mt-2.5 flex gap-2">
        <input
          type="password"
          className="flex-1 rounded-lg border border-line bg-panel-2 px-3 py-1.5 text-[13px] outline-none focus:border-accent"
          placeholder={configured ? "Paste a new key to replace it" : "Paste the key"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          className="rounded-lg bg-fg px-3 py-1.5 text-[12px] font-medium text-bg disabled:opacity-40"
          disabled={!value.trim() || state.busy}
          onClick={() => act(() => invoke("set_fal_key", { kind, key: value }).then(() => setValue("")), "Key saved.")}
        >
          Save
        </button>
        {testable && (
          <button
            className="rounded-lg border border-line px-3 py-1.5 text-[12px] disabled:opacity-40"
            disabled={!configured || state.busy}
            onClick={() => act(() => invoke("test_fal_key", { kind }), "The key works.")}
          >
            Test
          </button>
        )}
        <button
          className="rounded-lg px-2 py-1.5 text-[12px] text-red-300 disabled:opacity-40"
          disabled={!configured || state.busy}
          onClick={() => act(() => invoke("set_fal_key", { kind, key: "" }), "Key deleted.")}
        >
          Delete
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
  // Shared: the Provider section follows a fal key saved or deleted here.
  const status = useKeys((s) => s.status);
  const refresh = useKeys((s) => s.refresh);
  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <Section id="keys" icon={KeyRound} title="fal.ai API key" description="Stored on this computer in a private file of the app, never in your projects.">
      <div className="divide-y divide-line">
        <KeyField
          kind="main"
          configured={!!status?.main}
          label="Generation key"
          onSaved={refresh}
          hint={
            status?.main === "env" ? (
              "Read from the FAL_KEY environment variable. Save one here to replace it."
            ) : (
              <>
                Used to run the models. <ExternalLinkButton href={FAL_KEYS_URL}>Manage my keys on fal.ai</ExternalLinkButton>
              </>
            )
          }
        />
        <KeyField
          kind="billing"
          configured={!!status?.billing}
          label="Billing key (optional)"
          onSaved={refresh}
          hint="To show your spending. fal requires a key created with the BILLING or FULL preset; otherwise the generation key is used."
        />
      </div>
    </Section>
  );
}

/** Who runs the models: fal.ai or WaveSpeed, at a glance and switched in one click. */
function ProviderSection() {
  const status = useKeys((s) => s.status);
  const refresh = useKeys((s) => s.refresh);
  const models = useModels((s) => s.models);
  const [error, setError] = useState<string | null>(null);
  const [switched, setSwitched] = useState<string | null>(null);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const hosted = models.filter((m) => m.wavespeed).length;
  const cards = [
    { id: "fal", name: "fal.ai", models: `All ${models.length} models, Recast and the LLM tools`, key: !!status?.main, section: "#keys" },
    {
      id: "wavespeed",
      name: "WaveSpeed",
      models: `${hosted} models, Recast with Wan 2.2 and Kling; the others need fal`,
      key: !!status?.wavespeed,
      section: "#wavespeed",
    },
  ] as const;

  function choose(id: "fal" | "wavespeed") {
    if (status?.provider === id) return;
    setError(null);
    invoke("set_provider", { provider: id })
      .then(refresh)
      .then(() => setSwitched(id === "fal" ? "fal.ai" : "WaveSpeed"))
      .catch((e) => setError(String(e)));
  }

  return (
    <Section id="provider" icon={Waves} title="Provider" description="Who runs the image, video and sound models. Each one bills its own account.">
      <div className="grid grid-cols-2 gap-3">
        {cards.map((c) => {
          const active = status?.provider === c.id && c.key;
          return (
            <div
              key={c.id}
              role="button"
              tabIndex={c.key ? 0 : -1}
              onClick={() => c.key && choose(c.id)}
              onKeyDown={(e) => e.key === "Enter" && c.key && choose(c.id)}
              className={`rounded-lg border p-3 text-[12px] ${
                active ? "border-accent bg-accent/10" : c.key ? "cursor-pointer border-line hover:border-[#4a4a52]" : "border-line opacity-70"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`grid h-3.5 w-3.5 place-items-center rounded-full border ${active ? "border-accent" : "border-muted"}`}>
                  {active && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
                </span>
                <span className="text-[13px] font-medium">{c.name}</span>
                <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${c.key ? "bg-emerald-500/15 text-emerald-300" : "bg-panel-2 text-muted"}`}>
                  {c.key ? "Key set" : "No key"}
                </span>
              </div>
              <p className="mt-1.5 text-muted">{c.models}</p>
              {!c.key && (
                <a href={c.section} className="mt-1.5 inline-block text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
                  Add key
                </a>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        {!status?.main && !status?.wavespeed
          ? "Add a fal.ai or a WaveSpeed key to run models."
          : status?.provider === "wavespeed"
            ? status.main
              ? "Everything runs on WaveSpeed, nothing on fal: models and tools it doesn't host are marked “fal only” and won't run. Recast segments are cut and joined on this computer (ffmpeg)."
              : "Everything runs on WaveSpeed. Models and tools marked “fal only” in the library need fal. Recast segments are cut and joined on this computer (ffmpeg)."
            : "Every model runs on fal.ai."}{" "}
        The inspector shows a “WaveSpeed” badge on models that run there.
      </p>
      {switched && (
        <p className="mt-2 rounded-md bg-sky-500/10 px-2.5 py-2 text-[11px] leading-snug text-sky-200">
          Switched to {switched}. Nodes use it from their next run; results and messages already on the canvas stay as they were until you
          run those nodes again.
        </p>
      )}
      {error && <p className="mt-2 text-[12px] text-red-300">{error}</p>}
    </Section>
  );
}

/** WaveSpeedAI: an alternative to fal for the models it hosts. */
function WaveSpeedSection() {
  const status = useKeys((s) => s.status);
  const refresh = useKeys((s) => s.refresh);
  const models = useModels((s) => s.models);
  const [balance, setBalance] = useState<{ busy?: boolean; value?: number; error?: string }>({});
  const loadBalance = useCallback(() => {
    setBalance({ busy: true });
    invoke<number>("wavespeed_balance")
      .then((value) => setBalance({ value }))
      .catch((e) => setBalance({ error: String(e) }));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (status?.wavespeed) loadBalance();
  }, [status?.wavespeed, loadBalance]);

  const hosted = models.filter((m) => m.wavespeed);
  const both = !!status?.main && !!status?.wavespeed;

  return (
    <Section
      id="wavespeed"
      icon={Waves}
      title="WaveSpeed API key"
      description={`An alternative to fal, for those without a fal account: ${hosted.length} of the models also run on WaveSpeed. Stored on this computer, never in your projects.`}
    >
      <KeyField
        kind="wavespeed"
        configured={!!status?.wavespeed}
        label="API key"
        testable={false}
        onSaved={() => {
          refresh();
          loadBalance();
        }}
        hint={
          <>
            <ExternalLinkButton href={WAVESPEED_LINKS.signup}>Create an account</ExternalLinkButton> ·{" "}
            <ExternalLinkButton href={WAVESPEED_LINKS.keys}>Manage my keys</ExternalLinkButton> ·{" "}
            <ExternalLinkButton href={WAVESPEED_LINKS.dashboard}>Top up</ExternalLinkButton>. A developer key: billing keys can&apos;t run models.
          </>
        }
      />
      {status?.wavespeed && (
        <div className="mt-3 space-y-3 border-t border-line pt-3 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="text-muted">Balance</span>
            {balance.busy ? (
              <Loader2 size={13} className="animate-spin text-muted" />
            ) : balance.error ? (
              <span className="text-red-300">{balance.error}</span>
            ) : (
              <span className="tabular-nums">${(balance.value ?? 0).toFixed(2)}</span>
            )}
            <button className="text-muted hover:text-fg" onClick={loadBalance} title="Refresh (also tests the key)">
              <RefreshCw size={12} />
            </button>
          </div>
          {both ? (
            <p className="text-muted">
              Who runs the models is chosen in <a href="#provider" className="text-accent hover:underline">Provider</a>, at the top of Settings.
            </p>
          ) : !status.main ? (
            <p className="text-muted">
              No fal key: models run on WaveSpeed. Those it doesn&apos;t host are marked “fal only” in the library, as are H3 Max Recast, the LLM
              tools, Camera angles and the Seedance 2.5 Draft.
            </p>
          ) : null}
          <details>
            <summary className="cursor-pointer text-muted hover:text-fg">Models hosted by WaveSpeed ({hosted.length})</summary>
            <p className="mt-1.5 leading-relaxed text-muted">{hosted.map((m) => m.label).join(" · ")}</p>
          </details>
        </div>
      )}
    </Section>
  );
}

/** The user's own BytePlus ModelArk account: optional, billed by BytePlus. */
function BytePlusSection() {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [test, setTest] = useState<{ busy?: boolean; results?: [string, string | null][] }>({});
  const refreshKeys = useBytePlusKeys((s) => s.refresh);
  const refresh = useCallback(() => {
    invoke<KeyStatus>("key_status").then(setStatus);
    // The nodes show or hide their "add your key" notice.
    refreshKeys();
  }, [refreshKeys]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function testConnection() {
    setTest({ busy: true });
    const results: [string, string | null][] = [];
    const run = async (label: string, which: string) => {
      try {
        await invoke("test_byteplus", { which });
        results.push([label, null]);
      } catch (err) {
        results.push([label, String(err)]);
      }
    };
    await run("API key (Seedance, Seedream)", "api");
    if (status?.byteplusAk && status?.byteplusSk) await run("Access Key / Secret Key (portraits)", "aksk");
    setTest({ results });
  }

  const step = "flex gap-2 text-[12px] text-muted";
  return (
    <Section
      id="byteplus"
      icon={Clapperboard}
      title="BytePlus ModelArk"
      description="Optional. Seedance 2.5 with an AI character whose face shows, through portraits validated by BytePlus. Your own account and keys: billed by BytePlus."
    >
      <div className="divide-y divide-line">
        <KeyField
          kind="byteplus"
          configured={!!status?.byteplus}
          label="API key"
          onSaved={refresh}
          testable={false}
          hint={
            <>
              For Seedance 2.5 and Seedream. <ExternalLinkButton href={BYTEPLUS_LINKS.apiKey}>Create an API key</ExternalLinkButton>
            </>
          }
        />
        <KeyField
          kind="byteplusAk"
          configured={!!status?.byteplusAk}
          label="Access Key (AK)"
          onSaved={refresh}
          testable={false}
          hint={
            <>
              For the portrait library only: BytePlus doesn&apos;t accept the API key there.{" "}
              <ExternalLinkButton href={BYTEPLUS_LINKS.accessKey}>Create an Access Key</ExternalLinkButton>
            </>
          }
        />
        <KeyField kind="byteplusSk" configured={!!status?.byteplusSk} label="Secret Key (SK)" onSaved={refresh} testable={false} hint="Given with the Access Key, shown only once by BytePlus." />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-3">
        <label className="flex items-center gap-2 text-[12px]">
          Region
          <select className="rounded-md border border-line bg-panel-2 px-2 py-1 text-[12px] outline-none" value="ap-southeast-1" disabled>
            <option value="ap-southeast-1">ap-southeast-1 (Johor)</option>
          </select>
        </label>
        <span className="text-[11px] text-muted">The only region described in the BytePlus documentation.</span>
        <button
          className="ml-auto rounded-lg border border-line px-3 py-1.5 text-[12px] disabled:opacity-40"
          disabled={!status?.byteplus || test.busy}
          onClick={testConnection}
        >
          Test connection
        </button>
      </div>
      {test.busy && <Loader2 size={13} className="mt-2 animate-spin text-muted" />}
      {test.results?.map(([label, error]) => (
        <p key={label} className={`mt-2 flex items-start gap-1 text-[12px] ${error ? "text-red-300" : "text-emerald-300"}`}>
          {error ? `${label}: ${error}` : <><Check size={12} className="mt-0.5" /> {label}: connected.</>}
        </p>
      ))}

      <div className="mt-5 space-y-1.5 border-t border-line pt-4">
        <h3 className="text-[13px] font-medium">Getting started, in the BytePlus console</h3>
        <p className={step}>
          <span className="text-fg">1.</span>
          <span>
            Create an account and get it verified. <ExternalLinkButton href={BYTEPLUS_LINKS.signup}>Create an account</ExternalLinkButton>
          </span>
        </p>
        <p className={step}>
          <span className="text-fg">2.</span>
          <span>
            Seedance 2.5 requires a balance of at least $30 (or an AI Savings Plan, or a Seedance pack), then activating the model.{" "}
            <ExternalLinkButton href={BYTEPLUS_LINKS.topUp}>Top up</ExternalLinkButton> ·{" "}
            <ExternalLinkButton href={BYTEPLUS_LINKS.activate}>Activate models</ExternalLinkButton>
          </span>
        </p>
        <p className={step}>
          <span className="text-fg">3.</span>
          <span>
            For portraits: activate the “Advanced Creation Rights”. When the first portrait group is created, BytePlus asks you to sign an authorization
            letter. <ExternalLinkButton href={BYTEPLUS_LINKS.rights}>Advanced Creation Rights</ExternalLinkButton> ·{" "}
            <ExternalLinkButton href={BYTEPLUS_LINKS.portraits}>My portraits</ExternalLinkButton>
          </span>
        </p>
        <p className={step}>
          <span className="text-fg">4.</span>
          <span>
            Create the API key (ModelArk → API keys): copy the “API Key”; the “Resource ID” isn&apos;t needed. <ExternalLinkButton href={BYTEPLUS_LINKS.apiKey}>API keys</ExternalLinkButton>
          </span>
        </p>
        <p className={step}>
          <span className="text-fg">5.</span>
          <span>
            For portraits, a limited Access Key and Secret Key: IAM → Permission policy → create a JSON policy allowing <code>ark:*Asset*</code>, attach it
            (Authorize) to the <code>simplenode-…</code> user created with the API key, then open that user → Create access key. The Secret Key is
            shown only once. <ExternalLinkButton href={BYTEPLUS_LINKS.iam}>IAM</ExternalLinkButton>
          </span>
        </p>
        <p className={step}>
          <span className="text-fg">6.</span>
          <span>Paste the three values above, save each one, then “Test connection”.</span>
        </p>
        <p className="pt-1 text-[11px] text-muted">
          SimpleNode automates none of these steps and provides no key. Portraits must show an AI character that resembles no real
          person, with no logo: you alone are responsible for that. A portrait&apos;s image goes through fal storage to get the URL BytePlus requires.
        </p>
      </div>
    </Section>
  );
}

const PERIODS: [number, string][] = [
  [7, "7 days"],
  [30, "30 days"],
  [0, "This month"],
];

const CATEGORY_TITLES: Record<PriceRow["category"], string> = {
  image: "Image models",
  video: "Video models",
  audio: "Music & sound",
  llm: "Text",
  outil: "Tools",
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
    <Section id="costs" icon={ReceiptText} title="Costs" description="Price of each model and actual spending of your fal account.">
      <div className="flex items-center gap-2">
        <h3 className="mr-auto text-[13px] font-medium">Spending by model</h3>
        {PERIODS.map(([d, label]) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`rounded-md px-2.5 py-1 text-[12px] ${days === d ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"}`}
          >
            {label}
          </button>
        ))}
        <button className="grid h-7 w-7 place-items-center rounded-md text-muted hover:text-fg" onClick={() => loadSpend(days)} title="Refresh">
          <RefreshCw size={13} />
        </button>
      </div>

      {spend.busy && <Loader2 size={14} className="mt-3 animate-spin text-muted" />}
      {spend.error && (
        <div className="mt-3 rounded-lg bg-panel-2 px-3 py-2.5 text-[12px] text-muted">
          <span className="text-red-300">Spending unavailable</span> — {spend.error}
        </div>
      )}
      {spend.data && (
        <>
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-[26px] font-semibold tabular-nums">{money(spend.data.total, spend.data.currency)}</span>
            <span className="text-[12px] text-muted">since {new Date(spend.data.since).toLocaleDateString("en-US")} · fal estimate</span>
          </div>
          {spend.data.rows.length === 0 ? (
            <p className="mt-2 text-[12px] text-muted">No spending over the period.</p>
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
                    {r.quantity.toLocaleString("en-US", { maximumFractionDigits: 1 })} {unitLabel(r.unit)}
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
        fal doesn&apos;t publish the balance through its API. <ExternalLinkButton href={FAL_BILLING_URL}>See the balance and top up</ExternalLinkButton>
      </p>

      <div className="mt-6 flex items-center gap-2 border-t border-line pt-5">
        <h3 className="mr-auto text-[13px] font-medium">Model prices</h3>
        <input
          className="w-44 rounded-md border border-line bg-panel-2 px-2.5 py-1 text-[12px] outline-none focus:border-accent"
          placeholder="Filter"
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
                    <span className="text-muted">{r.mode === "image" ? (cat === "video" ? "image → video" : "edit") : r.mode === "texte" ? "text →" : ""}</span>
                    <span className="text-right tabular-nums">
                      {r.unitPrice == null ? (
                        <span className="text-muted">not published</span>
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
      setMessage(freed.files ? `${freed.files} file${freed.files > 1 ? "s" : ""} deleted, ${bytes(freed.bytes)} freed.` : "No unused media.");
      refresh();
    } catch (err) {
      setMessage(String(err));
    }
  }

  return (
    <Section id="storage" icon={HardDrive} title="Storage" description="Imported or generated images and videos, kept locally.">
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
          <FolderOpen size={13} /> Open the folder
        </button>
        {confirming ? (
          <>
            <button className="rounded-lg bg-red-500/80 px-3 py-1.5 text-[12px] font-medium" onClick={clean}>
              Confirm deletion
            </button>
            <button className="rounded-lg px-3 py-1.5 text-[12px] text-muted" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="rounded-lg border border-line px-3 py-1.5 text-[12px]" onClick={() => setConfirming(true)}>
            Delete unused media
          </button>
        )}
      </div>
      <p className="mt-2 text-[12px] text-muted">
        Deletes the files that appear in no project, trash included. This can&apos;t be undone.
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
    <Section id="about" icon={Info} title="About" description="SimpleNode — node-based canvas for AI generation.">
      <dl className="grid grid-cols-[140px_1fr] gap-y-1.5 text-[12px]">
        <dt className="text-muted">Version</dt>
        <dd>{version}</dd>
        <dt className="text-muted">Models</dt>
        <dd>Run through fal.ai, and BytePlus ModelArk (optional)</dd>
        <dt className="text-muted">Logos</dt>
        <dd>
          <ExternalLinkButton href="https://github.com/lobehub/lobe-icons">@lobehub/icons</ExternalLinkButton> (MIT) — trademarks of their respective owners
        </dd>
      </dl>
      <p className="mt-4 border-t border-line pt-3 text-[11px] text-muted">
        © {new Date().getFullYear()} LUDACOM SARL. SimpleNode by Ludacom. All rights reserved.
        <span className="mt-1 flex items-center gap-1">
          Made with <Heart size={11} className="fill-[#ff4d6d] text-[#ff4d6d]" aria-label="love" /> Paris
        </span>
      </p>
    </Section>
  );
}

function McpSection() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  const [client, setClient] = useState<"code" | "desktop">("code");
  const { spent, reset } = useMcpSpend();
  useEffect(() => {
    invoke<McpStatus>("mcp_status").then(setStatus).catch((e) => setError(String(e)));
  }, []);
  if (!status) return null;

  const configure = (patch: Partial<McpStatus>) => {
    const { enabled, port, token, budget } = { ...status, ...patch };
    setError(null);
    invoke<McpStatus>("mcp_configure", { config: { enabled, port, token, budget } })
      .then(setStatus)
      .catch((e) => setError(String(e)));
  };
  const url = `http://127.0.0.1:${status.port}/mcp`;
  const command = (token: string) =>
    client === "code"
      ? `claude mcp add --scope user --transport http simplenode ${url} --header "Authorization: Bearer ${token}"`
      : // The desktop app only starts local (stdio) servers: mcp-remote relays to this one.
        JSON.stringify(
          {
            mcpServers: {
              simplenode: {
                command: "npx",
                args: ["-y", "mcp-remote", url, "--allow-http", "--header", "Authorization:${AUTH_HEADER}"],
                env: { AUTH_HEADER: `Bearer ${token}` },
              },
            },
          },
          null,
          2,
        );
  const field = "w-24 rounded-md border border-line bg-panel-2 px-2 py-1 text-[12px] text-fg outline-none focus:border-accent tabular-nums";

  return (
    <Section
      id="mcp"
      icon={Bot}
      title="MCP"
      description="Let Claude Code drive SimpleNode: create projects, add and connect nodes, launch generations and get the results."
    >
      <div className="space-y-4 text-[12px]">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={status.enabled} onChange={(e) => configure({ enabled: e.target.checked })} />
          Enable the MCP server
          <span className={`ml-auto text-[11px] ${status.running ? "text-emerald-400" : "text-muted"}`}>
            {status.running ? `Listening on 127.0.0.1:${status.port}` : "Stopped"}
          </span>
        </label>
        {(error || status.error) && <p className="rounded-md bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">{error || status.error}</p>}

        <div className="space-y-1.5">
          <div className="flex gap-1">
            {(
              [
                ["code", "Claude Code"],
                ["desktop", "Claude (desktop app)"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={`rounded-md px-2.5 py-1 ${client === id ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"}`}
                onClick={() => setClient(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {client === "code" ? (
            <p className="text-muted">In a Terminal, once:</p>
          ) : (
            <p className="text-muted">
              In Claude: Settings → Developer → Edit config. Add this block to <code>claude_desktop_config.json</code> (inside
              &quot;mcpServers&quot; if it already exists), then quit and relaunch Claude. Requires Node.js (npx).
            </p>
          )}
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 rounded-md bg-panel-2 px-2.5 py-2 font-mono text-[11px] break-all whitespace-pre-wrap">
              {command(shown ? status.token : "•".repeat(12))}
            </code>
            <div className="flex shrink-0 flex-col gap-1">
              <button
                className="flex items-center gap-1 rounded-md border border-line px-2 py-1 hover:border-accent"
                onClick={() => {
                  navigator.clipboard.writeText(command(status.token)).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
              </button>
              <button className="flex items-center gap-1 rounded-md px-2 py-1 text-muted hover:text-fg" onClick={() => setShown(!shown)}>
                {shown ? <EyeOff size={12} /> : <Eye size={12} />} {shown ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          <p className="text-[11px] text-muted">
            &quot;Add custom connector&quot; in Claude won&apos;t work: those connectors go through Anthropic&apos;s servers and
            can&apos;t reach an app on your Mac. SimpleNode must be open while Claude uses it. The token gives control of the app: don&apos;t share it.{" "}
            <button
              className="text-accent hover:underline"
              onClick={() =>
                invoke<McpStatus>("mcp_regenerate_token")
                  .then(setStatus)
                  .catch((e) => setError(String(e)))
              }
            >
              Change token
            </button>{" "}
            (you&apos;ll need to run the command again).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line pt-3">
          <label className="flex items-center gap-2">
            Spending cap per session ($)
            <input
              type="number"
              min={0}
              step={1}
              className={field}
              defaultValue={status.budget}
              key={status.budget}
              onBlur={(e) => {
                const budget = Math.max(0, Number(e.target.value) || 0);
                if (budget !== status.budget) configure({ budget });
              }}
            />
          </label>
          <label className="flex items-center gap-2">
            Port
            <input
              type="number"
              min={1024}
              max={65535}
              className={field}
              defaultValue={status.port}
              key={status.port}
              onBlur={(e) => {
                const port = Number(e.target.value);
                if (port && port !== status.port) configure({ port });
              }}
            />
          </label>
        </div>
        <p className="text-[11px] text-muted">
          Launched by Claude Code since the app opened (estimate): <span className="text-fg tabular-nums">${spent.toFixed(2)}</span> of $
          {status.budget.toFixed(2)}.{" "}
          <button className="text-accent hover:underline" onClick={reset}>
            Reset
          </button>
          . Beyond the cap, the app refuses to launch and Claude Code must ask you. A generation whose cost can&apos;t be estimated is
          always refused.
        </p>
      </div>
    </Section>
  );
}

function CoffeeSection() {
  return (
    <Section id="coffee" icon={Coffee} title="Buy me a coffee" description="SimpleNode is free. If the app helps you, you can support its development.">
      <button
        onClick={() => openUrl("https://buymeacoffee.com/heako")}
        className="inline-flex items-center gap-2 rounded-lg bg-[#ffdd00] px-4 py-2 text-[13px] font-medium text-black hover:brightness-95"
      >
        <Coffee size={15} /> Buy a coffee <ExternalLink size={12} />
      </button>
      <p className="mt-2 text-[11px] text-muted">Opens buymeacoffee.com/heako in your browser.</p>
    </Section>
  );
}

const SECTIONS: [string, string][] = [
  ["provider", "Provider"],
  ["keys", "API key"],
  ["wavespeed", "WaveSpeed"],
  ["byteplus", "BytePlus"],
  ["costs", "Costs"],
  ["storage", "Storage"],
  ["mcp", "MCP"],
  ["about", "About"],
  ["coffee", "Buy me a coffee"],
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
        <ProviderSection />
        <KeysSection />
        <WaveSpeedSection />
        <BytePlusSection />
        <CostsSection />
        <StorageSection />
        <McpSection />
        <AboutSection />
        <CoffeeSection />
      </div>
    </div>
  );
}
