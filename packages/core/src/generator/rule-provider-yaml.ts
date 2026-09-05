import type { ClashConfig, RuleProvider } from "@subboost/core/types/config";

const META_RULES_RAW_BASE =
  "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/refs/heads/meta/geo";

type MetaRuleLocation = {
  kind: "geosite" | "geoip";
  name: string;
};

function parseMetaCubeXMrsUrl(url: string): MetaRuleLocation | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "");
  let match: RegExpMatchArray | null = null;

  if (host === "github.com") {
    match = path.match(
      /^\/MetaCubeX\/meta-rules-dat\/raw\/refs\/heads\/meta\/geo\/(geosite|geoip)\/([^/]+)\.mrs$/i
    );
  } else if (host === "raw.githubusercontent.com") {
    match = path.match(
      /^\/MetaCubeX\/meta-rules-dat\/refs\/heads\/meta\/geo\/(geosite|geoip)\/([^/]+)\.mrs$/i
    );
  }

  if (!match) return null;

  const kind = match[1]?.toLowerCase();
  const name = match[2];
  if (!name || (kind !== "geosite" && kind !== "geoip")) return null;

  return { kind, name };
}

function convertProvider(provider: RuleProvider): RuleProvider {
  if (typeof provider.url !== "string") return provider;

  const location = parseMetaCubeXMrsUrl(provider.url);
  // 第三方 .mrs 不处理。
  if (!location) return provider;

  const converted: RuleProvider = {
    ...provider,
    format: "yaml",
  };

  if (location.kind === "geosite") {
    converted.url = `${META_RULES_RAW_BASE}/geosite/classical/${location.name}.yaml`;
    converted.behavior = "classical";
  } else {
    converted.url = `${META_RULES_RAW_BASE}/geoip/${location.name}.yaml`;
    // GeoIP 保持 ipcidr。
  }

  if (typeof provider.path === "string") {
    converted.path = provider.path.replace(/\.mrs$/i, ".yaml");
  }

  return converted;
}

export function convertMetaCubeXRuleProvidersToYaml(config: ClashConfig): ClashConfig {
  const providers = config["rule-providers"];
  if (!providers) return config;

  const convertedProviders: Record<string, RuleProvider> = {};
  for (const [name, provider] of Object.entries(providers)) {
    convertedProviders[name] = convertProvider(provider);
  }

  return {
    ...config,
    "rule-providers": convertedProviders,
  };
}
