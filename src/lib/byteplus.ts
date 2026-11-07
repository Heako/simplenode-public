/**
 * BytePlus ModelArk, next to fal: optional, with the user's own account and
 * keys. Prices and limits come from BytePlus's docs (docs/byteplus-notes.md).
 */
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { NodeKind } from "./spec";

export const BYTEPLUS_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(["bpPortrait", "bpSeedance", "bpSeedream"]);

export function isBytePlusKind(kind: NodeKind | undefined) {
  return !!kind && BYTEPLUS_KINDS.has(kind);
}

/** Mirrors the BytePlus fields of `account::KeyStatus`. */
export interface BytePlusKeys {
  byteplus: boolean;
  byteplusAk: boolean;
  byteplusSk: boolean;
}

/** Which BytePlus keys are saved; refreshed by Settings when they change. */
export const useBytePlusKeys = create<{ keys: BytePlusKeys | null; refresh: () => Promise<void> }>((set) => ({
  keys: null,
  refresh: async () => {
    try {
      set({ keys: await invoke<BytePlusKeys>("key_status") });
    } catch {
      set({ keys: { byteplus: false, byteplusAk: false, byteplusSk: false } });
    }
  },
}));

/** The key a node kind needs, or null when it's there (or still unknown). */
export function missingKey(kind: NodeKind, keys: BytePlusKeys | null): string | null {
  if (!keys) return null;
  if (!keys.byteplus && kind !== "bpPortrait") return "Add your BytePlus key in Settings";
  if (kind === "bpPortrait" && !(keys.byteplusAk && keys.byteplusSk)) return "Add your BytePlus Access Key and Secret Key in Settings";
  return null;
}

/** Reminded once, at the first BytePlus launch. */
export const BILLING_ACK_KEY = "simplenode.byteplusBillingAck";
export const BILLING_NOTICE =
  "BytePlus nodes are billed to your own BytePlus ModelArk account, at its prices and within its quotas (nothing goes through fal or SimpleNode).\n\nSeedance 2.5 requires a balance of at least $30, an AI Savings Plan or a resource pack on that account.";

/** Seedance 2.5 duration choices; -1 lets the model pick ("auto"). */
export const SEEDANCE_DURATIONS: [string, string][] = [
  ["-1", "Auto (≤ 30 s)"],
  ...Array.from({ length: 27 }, (_, i): [string, string] => [String(i + 4), `${i + 4} s`]),
];
export const SEEDANCE_RATIOS: [string, string][] = [
  ["adaptive", "Adaptatif"],
  ["16:9", "16:9"],
  ["9:16", "9:16"],
  ["1:1", "1:1"],
  ["4:3", "4:3"],
  ["3:4", "3:4"],
  ["21:9", "21:9"],
];
/** Seedance 2.5 takes up to 30 reference images (portraits and images together). */
export const SEEDANCE_MAX_REFS = 30;

/** Output pixels per resolution and ratio, from the API reference (Seedance 2.5). */
const SURFACES: Record<string, Record<string, [number, number]>> = {
  "480p": { "16:9": [854, 480], "4:3": [752, 560], "1:1": [640, 640], "3:4": [560, 752], "9:16": [480, 854], "21:9": [992, 432] },
  "720p": { "16:9": [1280, 720], "4:3": [1112, 834], "1:1": [960, 960], "3:4": [834, 1112], "9:16": [720, 1280], "21:9": [1470, 630] },
  "1080p": { "16:9": [1920, 1080], "4:3": [1664, 1248], "1:1": [1440, 1440], "3:4": [1248, 1664], "9:16": [1080, 1920], "21:9": [2206, 946] },
};
/** Dollars per million tokens, without video input (BytePlus pricing, November 2026). */
const PRICE_PER_M: Record<string, number> = { "480p": 10.7, "720p": 10.7, "1080p": 11.7 };
const AUTO_SECONDS = 30;

export interface BytePlusEstimate {
  cost: number;
  tokens: number;
  seconds: number;
  /** Duration "auto": estimated on the longest a clip may last. */
  auto: boolean;
  /** Adaptive ratio: estimated on the largest frame of that resolution. */
  adaptive: boolean;
  resolution: string;
}

/**
 * Cost of one Seedance 2.5 render on BytePlus: tokens = width × height × 24
 * × seconds / 1024, times the price per million. A Draft renders in 480p;
 * `resolution` overrides it (finalizing renders in 1080p).
 */
export function bpSeedanceEstimate(params: Record<string, string>, resolution?: string): BytePlusEstimate {
  const draft = params.draft !== "false";
  const res = resolution ?? (draft ? "480p" : SURFACES[params.resolution] ? params.resolution : "720p");
  const sizes = SURFACES[res];
  const fixed = sizes[params.ratio];
  const [w, h] = fixed ?? Object.values(sizes).reduce((a, b) => (a[0] * a[1] >= b[0] * b[1] ? a : b));
  const duration = Number(params.duration);
  const auto = duration === -1;
  const seconds = auto ? AUTO_SECONDS : duration >= 4 && duration <= 30 ? duration : 5;
  const tokens = (w * h * 24 * seconds) / 1024;
  return { cost: (tokens / 1e6) * PRICE_PER_M[res], tokens, seconds, auto, adaptive: !fixed, resolution: res };
}

/** Seedream 5.0 on BytePlus: price per image, plus reference images past the first (pro). */
export function bpSeedreamCost(params: Record<string, string>, refs: number): number {
  if (params.model === "flash") return 0.018;
  const image = params.size === "1K" ? 0.045 : 0.09;
  return image + Math.max(0, refs - 1) * 0.003;
}

/** A Seedream output stays a trusted Seedance input 30 days. */
export const TRUST_DAYS = 30;

export function trustExpiry(outputs: Record<string, string>): Date | null {
  const at = Number(outputs.trustedAt);
  return at > 0 ? new Date(at + TRUST_DAYS * 24 * 3600 * 1000) : null;
}

/** Console and docs pages for the setup guide in Settings. */
export const BYTEPLUS_LINKS = {
  signup: "https://console.byteplus.com/auth/signup",
  topUp: "https://console.byteplus.com/finance/overview",
  activate: "https://ai.byteplus.com/ark/region:ap-southeast-1/openManagement?LLM=%7B%7D&tab=ComputerVision",
  apiKey: "https://ai.byteplus.com/ark/region:ap-southeast-1/apiKey",
  /** Console page where the free Entry tier is activated. */
  rights: "https://ai.byteplus.com/ark/region:ap-southeast-1/openManagement?LLM=%7B%7D&advancedActiveKey=mediaAsset",
  portraits: "https://ai.byteplus.com/ark/region:ap-southeast-1/experience/gen_video?model=dreamina-seedance-2-0-260128",
  accessKey: "https://docs.byteplus.com/en/docs/byteplus-platform/docs-creating-an-accesskey",
  iam: "https://console.byteplus.com/iam/identitymanage/user",
};
