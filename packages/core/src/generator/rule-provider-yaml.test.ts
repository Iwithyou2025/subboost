import { describe, expect, it } from "vitest";
import type { ClashConfig } from "@subboost/core/types/config";
import { convertMetaCubeXRuleProvidersToYaml } from "./rule-provider-yaml";

describe("convertMetaCubeXRuleProvidersToYaml", () => {
  it("converts MetaCubeX geosite MRS providers to classical YAML", () => {
    const config: ClashConfig = {
      "rule-providers": {
        youtube: {
          type: "http",
          behavior: "domain",
          url: "https://github.com/MetaCubeX/meta-rules-dat/raw/refs/heads/meta/geo/geosite/youtube.mrs",
          path: "./ruleset/youtube.mrs",
          interval: 86400,
          format: "mrs",
        },
      },
    };

    const converted = convertMetaCubeXRuleProvidersToYaml(config);

    expect(converted["rule-providers"]?.youtube).toEqual({
      type: "http",
      behavior: "classical",
      url: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/refs/heads/meta/geo/geosite/classical/youtube.yaml",
      path: "./ruleset/youtube.yaml",
      interval: 86400,
      format: "yaml",
    });
  });

  it("converts MetaCubeX geoip MRS providers while keeping ipcidr behavior", () => {
    const config: ClashConfig = {
      "rule-providers": {
        "google-ip": {
          type: "http",
          behavior: "ipcidr",
          url: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/refs/heads/meta/geo/geoip/google.mrs",
          path: "./ruleset/google-ip.mrs",
          interval: 86400,
          format: "mrs",
        },
      },
    };

    const converted = convertMetaCubeXRuleProvidersToYaml(config);

    expect(converted["rule-providers"]?.["google-ip"]).toEqual({
      type: "http",
      behavior: "ipcidr",
      url: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/refs/heads/meta/geo/geoip/google.yaml",
      path: "./ruleset/google-ip.yaml",
      interval: 86400,
      format: "yaml",
    });
  });

  it("leaves third-party MRS providers untouched", () => {
    const thirdParty = {
      type: "http",
      behavior: "domain",
      url: "https://example.com/custom.mrs",
      path: "./ruleset/custom.mrs",
      interval: 86400,
      format: "mrs",
    };
    const config: ClashConfig = {
      "rule-providers": { custom: thirdParty },
    };

    const converted = convertMetaCubeXRuleProvidersToYaml(config);

    expect(converted["rule-providers"]?.custom).toEqual(thirdParty);
  });
});
