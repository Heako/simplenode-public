"use client";

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowRight, Check, ExternalLink, Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";

const FAL_SIGNUP_URL = "https://fal.ai/login";
const FAL_BILLING_URL = "https://fal.ai/dashboard/billing";
const FAL_KEYS_URL = "https://fal.ai/dashboard/keys";

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3.5">
      <span
        className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold ${done ? "bg-emerald-500/20 text-emerald-300" : "bg-panel-2 text-fg"}`}
      >
        {done ? <Check size={14} /> : n}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <h3 className="text-[14px] font-medium">{title}</h3>
        <div className="mt-1 text-[13px] leading-relaxed text-muted">{children}</div>
      </div>
    </li>
  );
}

function LinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button
      className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12px] text-fg hover:border-accent"
      onClick={() => openUrl(href)}
    >
      {children} <ExternalLink size={12} />
    </button>
  );
}

/**
 * First-launch guide shown while no fal key is saved: create an account, add
 * credit, paste a key. The key is checked against fal right away and removed
 * again if fal refuses it, so a typo can't leave a broken key behind.
 */
export default function Welcome({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState("");
  const [state, setState] = useState<"idle" | "checking" | "ok" | "error">("idle");
  const [error, setError] = useState("");

  async function save() {
    setState("checking");
    try {
      await invoke("set_fal_key", { kind: "main", key });
      try {
        await invoke("test_fal_key", { kind: "main" });
      } catch (err) {
        await invoke("set_fal_key", { kind: "main", key: "" });
        throw err;
      }
      setState("ok");
    } catch (err) {
      setError(String(err));
      setState("error");
    }
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-bg px-4 py-10">
      <div className="w-full max-w-[520px]">
        <div className="mb-2 grid h-10 w-10 place-items-center rounded-xl bg-accent text-base font-bold">S</div>
        <h1 className="text-[22px] font-semibold">Bienvenue dans SimpleNode</h1>
        <p className="mt-1.5 text-[14px] leading-relaxed text-muted">
          Reliez des blocs (prompt, image, vidéo) sur un canvas pour créer avec l&apos;IA. Les images et vidéos sont générées par fal.ai, un service
          payant à l&apos;usage : il vous faut un compte et une clé. Trois étapes, deux minutes.
        </p>

        <ol className="mt-7 space-y-6">
          <Step n={1} title="Créez votre compte fal.ai">
            Inscrivez-vous gratuitement, avec Google ou GitHub par exemple.
            <br />
            <LinkButton href={FAL_SIGNUP_URL}>Ouvrir fal.ai</LinkButton>
          </Step>
          <Step n={2} title="Ajoutez du crédit">
            Les générations sont facturées à l&apos;unité, de quelques centimes pour une image à environ un euro pour une vidéo. Quelques euros
            suffisent pour essayer.
            <br />
            <LinkButton href={FAL_BILLING_URL}>Ouvrir la facturation</LinkButton>
          </Step>
          <Step n={3} title="Créez une clé et collez-la ici" done={state === "ok"}>
            Sur la page des clés, cliquez sur « Add key », copiez la clé affichée, puis collez-la ci-dessous.
            <br />
            <LinkButton href={FAL_KEYS_URL}>Ouvrir mes clés</LinkButton>
            {state !== "ok" && (
              <div className="mt-3 flex gap-2">
                <input
                  type="password"
                  autoFocus
                  className="min-w-0 flex-1 rounded-lg border border-line bg-panel-2 px-3 py-2 text-[13px] text-fg outline-none focus:border-accent"
                  placeholder="Collez votre clé fal ici"
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    if (state === "error") setState("idle");
                  }}
                  onKeyDown={(e) => e.key === "Enter" && key.trim() && save()}
                />
                <button
                  className="flex items-center gap-1.5 rounded-lg bg-fg px-3.5 py-2 text-[13px] font-medium text-bg disabled:opacity-40"
                  disabled={!key.trim() || state === "checking"}
                  onClick={save}
                >
                  {state === "checking" ? <Loader2 size={14} className="animate-spin" /> : null}
                  Vérifier
                </button>
              </div>
            )}
            {state === "error" && (
              <p className="mt-2 text-[12px] text-red-300">
                Cette clé ne fonctionne pas ({error.replace(/^.*?:\s*/, "")}). Vérifiez qu&apos;elle est copiée en entier.
              </p>
            )}
            {state === "ok" && <p className="mt-2 text-[13px] text-emerald-300">Clé vérifiée et enregistrée sur cet ordinateur.</p>}
          </Step>
        </ol>

        <div className="mt-8 flex items-center justify-between">
          <button className="text-[12px] text-muted hover:text-fg" onClick={onDone}>
            {state === "ok" ? "" : "Plus tard"}
          </button>
          <button
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
            disabled={state !== "ok"}
            onClick={onDone}
          >
            Commencer <ArrowRight size={14} />
          </button>
        </div>
        <p className="mt-6 text-[11px] text-muted">Vous pourrez changer de clé plus tard dans Réglages → Clé API.</p>
      </div>
    </div>
  );
}
