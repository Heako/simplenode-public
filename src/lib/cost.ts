import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

interface Price {
  endpoint: string;
  unitPrice: number | null;
  unit: string | null;
}

const isSeconds = (unit: string | null) => unit === "seconds" || unit === "second";

/**
 * fal's pricing API gives one price per endpoint, in that endpoint's billing
 * unit; some bill more units per second of video at a higher resolution.
 * Only that ratio lives here, the price itself always comes from fal.
 * From fal's model pages, October 2026:
 * - H3 Max Recast: $0.05 per unit, $0.30/s at 768p and $0.45/s at 1080p.
 * - Wan 2.2 Animate Replace: $0.08 per second at 720p, $0.06 at 580p, $0.04 at 480p.
 */
const UNITS_PER_SECOND: Record<string, (resolution: string) => number> = {
  "minimax/h3-max/recast": (r) => (/1080/.test(r) ? 9 : 6),
  "fal-ai/wan/v2.2-14b/animate/replace": (r) => (/480/.test(r) ? 0.5 : /580/.test(r) ? 0.75 : 1),
};
const RESOLUTIONS = ["480", "580", "768", "1080"];

/** Price of one second of video on this endpoint at this resolution, if billed by duration. */
export function perSecond(price: Price | undefined, resolution: string | undefined): number | null {
  if (price?.unitPrice == null) return null;
  const units = UNITS_PER_SECOND[price.endpoint];
  if (units) return price.unitPrice * units(resolution ?? "");
  return isSeconds(price.unit) ? price.unitPrice : null;
}

/** For a price list: endpoints billed by duration shown per second, at their lowest resolution. */
export function perSecondRows<T extends Price>(rows: T[]): T[] {
  return rows.map((row) => {
    const units = UNITS_PER_SECOND[row.endpoint];
    if (!units || row.unitPrice == null) return row;
    return { ...row, unitPrice: row.unitPrice * Math.min(...RESOLUTIONS.map(units)), unit: "seconds" };
  });
}

/**
 * Seedance 2.5 (and its Draft mode) is billed per 1000 video tokens, with
 * fal's formula: tokens = width × height × 24 × seconds / 1024. The sound
 * doesn't change the price. Surfaces are the same in portrait and landscape.
 */
const SEEDANCE_SURFACES: Record<string, number> = { "480p": 864 * 496, "720p": 1280 * 720, "1080p": 1920 * 1080 };
/** Used when the duration is "auto": the longest a clip may last. */
export const SEEDANCE_AUTO_SECONDS = 15;
/** fal's price per 1000 tokens (November 2026), when the price list isn't loaded. */
const SEEDANCE_PRICE_PER_1K = 0.0214;

/** Seedance 2.5 with a reference video (motion transfer, swap): the input video is billed too. */
const SEEDANCE_REFERENCE = new Set(["seedance-2.5-motion", "seedance-2.5-swap"]);
/** Price factor when video inputs are provided (fal, November 2026). */
const SEEDANCE_VIDEO_INPUT_FACTOR = 0.6;
/** Used when a reference video's length isn't known yet: the longest it may be. */
const SEEDANCE_MAX_INPUT_SECONDS = 30;

export function isSeedance25(modelId: string | undefined) {
  return modelId === "seedance-2.5" || modelId === "seedance-2.5-draft" || SEEDANCE_REFERENCE.has(modelId ?? "");
}

export function isSeedanceReference(modelId: string | undefined) {
  return SEEDANCE_REFERENCE.has(modelId ?? "");
}

export interface SeedanceEstimate {
  cost: number;
  tokens: number;
  seconds: number;
  /** The duration was "auto" (or the input video's length unknown): an upper estimate. */
  auto: boolean;
  resolution: string;
  /** Seconds of reference video billed with the output (motion transfer, swap). */
  inputSeconds?: number;
}

/**
 * Cost of one Seedance 2.5 render. The Draft always renders in 480p;
 * `resolution` overrides it, as finalizing a draft renders in 1080p.
 * `price` is fal's row for the endpoint, when loaded.
 */
export function seedanceEstimate(
  modelId: string | undefined,
  params: Record<string, string>,
  { resolution, price, inputSeconds }: { resolution?: string; price?: Price; inputSeconds?: number | null } = {},
): SeedanceEstimate | null {
  if (!isSeedance25(modelId)) return null;
  const reference = isSeedanceReference(modelId);
  const draft = modelId === "seedance-2.5-draft" || (reference && params.draft !== "false");
  const res = resolution ?? (draft ? "480p" : params.resolution || "720p");
  const surface = SEEDANCE_SURFACES[res];
  // fal bills a reference video's seconds too (input + output), at 0.6 × the token price.
  const input = reference ? (inputSeconds && inputSeconds > 0 ? Math.min(inputSeconds, SEEDANCE_MAX_INPUT_SECONDS) : null) : 0;
  const durationAuto = !params.duration || params.duration === "auto";
  // "auto" on a reference video follows it (a swap keeps its length).
  const seconds = !durationAuto ? Number(params.duration) : reference ? (input ?? SEEDANCE_MAX_INPUT_SECONDS) : SEEDANCE_AUTO_SECONDS;
  const auto = (durationAuto && !(reference && input)) || (reference && input === null);
  const billedInput = reference ? (input ?? SEEDANCE_MAX_INPUT_SECONDS) : 0;
  if (!surface || !(seconds > 0)) return null;
  const tokens = (surface * 24 * (seconds + billedInput)) / 1024;
  const per1k = (price?.unit === "1000 tokens" && price.unitPrice != null ? price.unitPrice : SEEDANCE_PRICE_PER_1K) * (reference ? SEEDANCE_VIDEO_INPUT_FACTOR : 1);
  return { cost: (tokens / 1000) * per1k, tokens, seconds, auto, resolution: res, ...(reference && { inputSeconds: billedInput }) };
}

/** "$16.50" */
export function dollars(value: number) {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Duration in seconds of a local or remote video, once its metadata loads. */
export function useVideoDuration(value: string | undefined): number | null {
  const [duration, setDuration] = useState<{ value: string; seconds: number } | null>(null);
  useEffect(() => {
    if (!value) return;
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration)) setDuration({ value, seconds: video.duration });
    };
    video.src = /^https?:\/\//.test(value) ? value : convertFileSrc(value);
    return () => {
      video.onloadedmetadata = null;
      video.removeAttribute("src");
      video.load();
    };
  }, [value]);
  return value && duration?.value === value ? duration.seconds : null;
}
