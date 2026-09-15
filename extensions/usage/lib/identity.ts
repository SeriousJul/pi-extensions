/**
 * Canonical identity: the alias rules that fold a recorded (provider, model)
 * pair into the grouping unit of the Usage report.
 *
 * The rules below name the raw variants found on this machine. A name no
 * rule touches stays raw, so a new provider or model appears under its own
 * name until a rule is added.
 */

/** One local llama.cpp server, the three names it shows up under. */
const LOCAL_LLMACCPP = "local-llamacpp";

/** Providers that are plain spelling variants of the local server name. */
const PROVIDER_ALIASES: Record<string, string> = {
  "llama.cpp": LOCAL_LLMACCPP,
};

/** Prefixes that mean "the local llama.cpp server behind another front". */
const LOCAL_PROVIDER_PREFIXES = ["llama-server=", "crossbar-llamacpp-"];

export function canonicalProvider(provider: string): string {
  const aliased = PROVIDER_ALIASES[provider];
  if (aliased) return aliased;
  for (const prefix of LOCAL_PROVIDER_PREFIXES) {
    if (provider.startsWith(prefix)) return LOCAL_LLMACCPP;
  }
  return provider;
}

/**
 * Fold a model id: lowercase, drop the trailing `:QUANT` suffix, drop a
 * `-GGUF` infix. `unsloth/Qwen3.8-27B-GGUF:Q4_K_XL` and `unsloth/qwen3.8-27b`
 * become the same line: `unsloth/qwen3.8-27b`.
 */
export function canonicalModel(model: string): string {
  let out = model.toLowerCase();
  out = out.replace(/:[^:]+$/, "");
  out = out.replace(/-gguf(?=[-:]|$)/g, "");
  return out;
}

export interface CanonicalIdentity {
  provider: string;
  model: string;
}

export function canonicalIdentity(provider: string, model: string): CanonicalIdentity {
  return { provider: canonicalProvider(provider), model: canonicalModel(model) };
}
