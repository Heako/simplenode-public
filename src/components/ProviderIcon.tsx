import type { LucideIcon } from "lucide-react";

/**
 * Provider logo per registry model id. `mono` logos are single-color
 * (`currentColor`) and are drawn as a CSS mask so they follow the text color.
 */
const MODEL_LOGOS: Record<string, { file: string; mono?: boolean }> = {
  "nano-banana-pro": { file: "gemini-color" },
  "nano-banana-2": { file: "gemini-color" },
  "seedream-5-lite": { file: "bytedance-color" },
  "seedream-4.5": { file: "bytedance-color" },
  "gpt-image-2": { file: "openai", mono: true },
  "flux-2-pro": { file: "flux", mono: true },
  "flux-kontext-pro": { file: "flux", mono: true },
  "flux-schnell": { file: "flux", mono: true },
  "qwen-image-max": { file: "qwen-color" },
  "recraft-v4-pro": { file: "recraft", mono: true },
  "ideogram-v3": { file: "ideogram", mono: true },
  "kling-4": { file: "kling-color" },
  "kling-3-pro": { file: "kling-color" },
  "kling-2.5-turbo-pro": { file: "kling-color" },
  "minimax-h3": { file: "minimax-color" },
  "minimax-h3-max": { file: "minimax-color" },
  "hailuo-02": { file: "hailuo-color" },
  "seedance-2.5": { file: "bytedance-color" },
  "seedance-2.5-draft": { file: "bytedance-color" },
  "seedance-2": { file: "bytedance-color" },
  "seedance-1-pro": { file: "bytedance-color" },
  "veo-3.1": { file: "google-color" },
  "veo-3.1-fast": { file: "google-color" },
  "wan-2.5": { file: "alibaba-color" },
  "ltx-2": { file: "lightricks", mono: true },
  "h3-max-recast": { file: "minimax-color" },
  "wan-2.2-animate-replace": { file: "alibaba-color" },
  "kling-3-pro-motion": { file: "kling-color" },
  "kling-3-standard-motion": { file: "kling-color" },
};

/** LLM nodes show the logo of the model currently selected. */
const LLM_LOGOS: [prefix: string, logo: { file: string; mono?: boolean }][] = [
  ["google/", { file: "gemini-color" }],
  ["anthropic/", { file: "claude-color" }],
  ["openai/", { file: "openai", mono: true }],
  ["moonshotai/", { file: "kimi-color" }],
  ["meta-llama/", { file: "meta-color" }],
];

export function logoFor(modelId?: string, llmModel?: string) {
  if (modelId === "llm" && llmModel) return LLM_LOGOS.find(([prefix]) => llmModel.startsWith(prefix))?.[1];
  return modelId ? MODEL_LOGOS[modelId] : undefined;
}

export default function ProviderIcon({
  modelId,
  llmModel,
  size,
  fallback: Fallback,
  className = "",
}: {
  modelId?: string;
  llmModel?: string;
  size: number;
  fallback: LucideIcon;
  className?: string;
}) {
  const logo = logoFor(modelId, llmModel);
  if (!logo) return <Fallback size={size} strokeWidth={1.7} className={className} />;
  const url = `/providers/${logo.file}.svg`;
  if (logo.mono) {
    return (
      <span
        aria-hidden
        className={`inline-block shrink-0 bg-current ${className}`}
        style={{ width: size, height: size, mask: `url(${url}) center / contain no-repeat`, WebkitMask: `url(${url}) center / contain no-repeat` }}
      />
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" width={size} height={size} className={`shrink-0 ${className}`} draggable={false} />;
}
