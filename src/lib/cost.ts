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
