import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { canonicalRuleSetUrl, createManualRuleSet, inferRuleSetFormat, validateManualRuleSetInput, type ManualRuleSetInput } from "./manual-rule-set";
import { normalizeRuleModelFromConfig } from "./rule-model";
import { collectCustomRoutingRuleSets } from "./custom-routing-rule-sets";
import { buildGenerateOptionsFromConfig } from "@subboost/core/subscription/config-utils";
import { buildDefaultSubBoostTemplateConfig } from "@subboost/core/config/defaults";
import { validateSubBoostTemplateConfig } from "@subboost/core/templates/config-template";
import { generateClashConfig, generateClashYamlWithYamlRuleProviders } from "@subboost/core/generator";
import type { ClashConfig, CustomRuleSet } from "@subboost/core/types/config";

const input: ManualRuleSetInput = {
  name: "Finance", url: "https://rules.example.com/finance.yaml?token=abc%2Bdef",
  format: "yaml", behavior: "classical", target: { kind: "module", id: "select" },
};

describe("manual remote rule sets", () => {
  it.each([
    ["https://rules.example/a.MRS?download=1", "mrs"],
    ["https://rules.example/a.yaml", "yaml"],
    ["https://rules.example/a.YML#rules", "yaml"],
    ["https://rules.example/download?id=1", null],
    ["incomplete", null],
  ])("infers the source format from %s", (url, expected) => {
    expect(inferRuleSetFormat(url)).toBe(expected);
  });

  it.each([
    { name: " " }, { url: "https://" }, { url: "file:///etc/passwd" },
    { url: "javascript:alert(1)" }, { url: "https://user:password@rules.example/a.yaml" },
    { format: "mrs" }, { format: "text" }, { behavior: "other" }, { target: { kind: "module", id: "" } },
  ])("rejects invalid or incompatible input %j", (patch) => {
    expect(validateManualRuleSetInput({ ...input, ...patch } as ManualRuleSetInput)).toBeTruthy();
  });

  it("preserves the URL query, supports extensionless endpoints, and isolates IDs from names", () => {
    expect(validateManualRuleSetInput(input)).toBeNull();
    expect(validateManualRuleSetInput({ ...input, url: "https://rules.example/download?id=1" })).toBeNull();
    expect(canonicalRuleSetUrl(" HTTPS://RULES.example:443/a.mrs?q=1#fragment ")).toBe("https://rules.example/a.mrs?q=1");
    const a = createManualRuleSet({ ...input, name: "../../google,another-policy" }, new Set(["google"]));
    const b = createManualRuleSet(input, new Set([a.id]));
    expect(a.id).toMatch(/^manual-rule-set-[A-Za-z0-9-]+$/);
    expect(b.id).not.toBe(a.id);
    expect(a.path).toBe(input.url);
    expect(a).toMatchObject({ format: "yaml", behavior: "classical", noResolve: false });
  });

  it("preserves format across normalization, rule-list projection and template export/import", () => {
    const rules = [createManualRuleSet(input, new Set())];
    const config = { ...buildDefaultSubBoostTemplateConfig("minimal"), customRuleSets: rules };
    const normalized = normalizeRuleModelFromConfig(JSON.parse(JSON.stringify(config)));
    expect(normalized.customRuleSets).toEqual(rules);
    expect(collectCustomRoutingRuleSets(normalized)[0]).toMatchObject({ format: "yaml", behavior: "classical" });
    const validated = validateSubBoostTemplateConfig(config);
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.config.customRuleSets).toEqual(rules);
    expect(validateSubBoostTemplateConfig({ ...config, customRuleSets: [{ ...rules[0], format: "mrs" }] }).ok).toBe(false);
    expect(normalizeRuleModelFromConfig({ customRuleSets: [{ ...rules[0], format: "text" }] }).customRuleSets).toEqual([]);
  });

  it("generates mixed sources, converts only recognized official MRS, and never mutates persisted data", () => {
    const meta = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/refs/heads/meta/geo";
    const rules: CustomRuleSet[] = [
      { id: "manual-official-domain", name: "Meta", path: `${meta}/geosite/finance.mrs`, behavior: "domain", format: "mrs", target: input.target },
      { id: "manual-official-ip", name: "IP", path: `${meta}/geoip/finance.mrs`, behavior: "ipcidr", format: "mrs", noResolve: true, target: input.target },
      { id: "manual-third-party", name: "Third party", path: "https://third.example/rules.mrs", behavior: "domain", format: "mrs", target: input.target },
      { id: "manual-yaml", name: "YAML", path: input.url, behavior: "classical", format: "yaml", target: input.target },
      { id: "manual-domain-yaml", name: "Domain YAML", path: "https://rules.example/domain.yml", behavior: "domain", format: "yaml", target: input.target },
      { id: "manual-ip-yaml", name: "IP YAML", path: "https://rules.example/ip.yaml", behavior: "ipcidr", format: "yaml", target: input.target },
      { id: "legacy", name: "Legacy", path: "geosite/legacy.mrs", behavior: "domain", target: input.target },
    ];
    const config = { enabledGroups: ["select", "cn", "final"], customRuleSets: rules, proxyGroupNameOverrides: { select: "Finance Proxy" } };
    const before = JSON.stringify(config);
    const options = buildGenerateOptionsFromConfig(config, { nodes: [] });
    const standard = generateClashConfig(options);
    const converted = load(generateClashYamlWithYamlRuleProviders(options)) as ClashConfig;
    const providers = converted["rule-providers"]!;
    expect(standard["rule-providers"]?.["manual-official-domain"]).toMatchObject({ format: "mrs", behavior: "domain" });
    expect(providers["manual-official-domain"]).toMatchObject({ format: "yaml", behavior: "classical", url: `${meta}/geosite/classical/finance.yaml`, path: "./ruleset/manual-official-domain.yaml" });
    expect(providers["manual-official-ip"]).toMatchObject({ format: "yaml", behavior: "ipcidr", url: `${meta}/geoip/finance.yaml` });
    expect(providers["geolocation-cn"]).toMatchObject({ format: "yaml", behavior: "classical" });
    for (const id of ["manual-third-party", "manual-yaml", "manual-domain-yaml", "manual-ip-yaml"]) {
      expect(providers[id]).toEqual(standard["rule-providers"]?.[id]);
    }
    expect(providers["manual-third-party"].format).toBe("mrs");
    expect(providers["manual-yaml"]).toMatchObject({ format: "yaml", url: input.url, path: "./ruleset/manual-yaml.yaml" });
    expect(standard["rule-providers"]?.legacy.format).toBe("mrs");
    expect(standard.rules).toEqual(converted.rules);
    expect(converted.rules).toContain("RULE-SET,manual-yaml,🚀 Finance Proxy");
    expect(converted.rules).toContain("RULE-SET,manual-official-ip,🚀 Finance Proxy,no-resolve");
    expect(JSON.stringify(config)).toBe(before);
    expect(generateClashConfig(options)).toEqual(standard);
  });
});
