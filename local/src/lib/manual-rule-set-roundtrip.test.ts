import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { load } from "js-yaml";
import { buildDefaultSubBoostTemplateConfig } from "@subboost/core/config/defaults";
import { normalizeRuleModelFromConfig } from "@subboost/core/rules/rule-model";
import type { ClashConfig, CustomRuleSet } from "@subboost/core/types/config";

// In-memory Prisma boundary, real services/encryption/normalizers/generators.
// This is a persistence contract test, not a PostgreSQL pg_dump/restore test.
const db = vi.hoisted(() => ({ subscription: null as any, template: null as any }));
vi.mock("./prisma", () => {
  const subscription = {
    create: vi.fn(async ({ data }) => {
      db.subscription = { id: "sub-1", isPrimary: false, createdAt: new Date(), updatedAt: new Date(), ...data };
      return structuredClone(db.subscription);
    }),
    findFirst: vi.fn(async () => structuredClone(db.subscription)),
    findUnique: vi.fn(async () => structuredClone(db.subscription)),
    update: vi.fn(async ({ data }) => {
      Object.assign(db.subscription, data);
      return structuredClone(db.subscription);
    }),
    updateMany: vi.fn(async ({ data }) => {
      Object.assign(db.subscription, data);
      return { count: 1 };
    }),
  };
  const transaction = { subscription, subscriptionAutoUpdateState: { upsert: vi.fn(async () => ({})) } };
  return {
    prisma: {
      ...transaction,
      $transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction),
      localTemplate: {
        create: vi.fn(async ({ data }) => {
          db.template = { id: "template-1", createdAt: new Date(), updatedAt: new Date(), ...data };
          return structuredClone(db.template);
        }),
        findFirst: vi.fn(async () => structuredClone(db.template)),
      },
    },
  };
});
vi.mock("./source-import", () => ({
  importSourceUrlDirect: vi.fn(async () => ({ ok: true, parsedNodes: [{ name: "Refreshed", type: "ss", server: "node.example", port: 443, cipher: "aes-128-gcm", password: "test" }], parseErrors: [], headers: {} })),
  fetchSourceUserInfoHeadersDirect: vi.fn(async () => ({})),
}));

import { createSubscription, getSubscription, updateSubscription, refreshSubscription, generateSubscriptionYaml } from "./subscription-service";
import { createTemplate, getTemplateDetail } from "./template-service";
import { decryptJsonObject } from "./crypto";

const rules: CustomRuleSet[] = [
  { id: "manual-rule-set-finance", name: "金融", path: "https://rules.example/finance.yml?token=a%2Bb", format: "yaml", behavior: "classical", target: { kind: "module", id: "select" }, noResolve: false },
  { id: "manual-rule-set-ip", name: "IP", path: "https://rules.example/ip.mrs", format: "mrs", behavior: "ipcidr", target: { kind: "module", id: "select" }, noResolve: false },
  { id: "legacy", name: "旧规则", path: "geosite/legacy.mrs", behavior: "domain", target: { kind: "module", id: "select" } },
];
const nodes = [{ name: "Node", type: "ss", server: "node.example", port: 443, cipher: "aes-128-gcm", password: "test" }];

describe("manual rule-set persistence contract", () => {
  beforeEach(() => {
    db.subscription = null;
    db.template = null;
    vi.stubEnv("ENCRYPTION_KEY", "test-only-manual-rule-set-roundtrip-key");
    vi.stubEnv("APP_URL", "http://localhost:3001");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("retains rules through encrypted database writes, read/update, source refresh and restored records", async () => {
    const config = {
      enabledGroups: ["select", "cn", "final"], customRuleSets: structuredClone(rules),
      ruleOrder: rules.map((rule) => `custom-rule-set:${rule.id}`),
      sources: [{ id: "source-1", type: "url", content: "https://nodes.example/sub" }],
    };
    await createSubscription("owner-1", { name: "Finance", nodes, urls: ["https://nodes.example/sub"], config });
    expect(db.subscription.encryptedConfig).not.toContain("finance.yml");
    expect(decryptJsonObject(db.subscription.encryptedConfig).customRuleSets).toEqual(rules);
    const detail = await getSubscription("owner-1", "sub-1");
    expect(normalizeRuleModelFromConfig(detail!.config).customRuleSets).toEqual(rules);
    await updateSubscription("owner-1", "sub-1", { name: "Renamed" });
    await updateSubscription("owner-1", "sub-1", { config: JSON.parse(JSON.stringify(detail!.config)) });
    const refreshed = await refreshSubscription("owner-1", "sub-1");
    expect(refreshed?.ok).toBe(true);
    expect(decryptJsonObject(db.subscription.encryptedConfig).customRuleSets).toEqual(rules);
    expect(decryptJsonObject(db.subscription.encryptedConfig).ruleOrder).toEqual(config.ruleOrder);

    // A database backup restores the encrypted column unchanged with its key.
    db.subscription = structuredClone(db.subscription);
    const encryptedBefore = db.subscription.encryptedConfig;
    for (const format of ["mrs", "yaml"] as const) {
      const result = await generateSubscriptionYaml(db.subscription.token, format);
      const generated = load(result!.yaml) as ClashConfig;
      expect(generated["rule-providers"]?.[rules[0].id]).toMatchObject({ format: "yaml", behavior: "classical", url: rules[0].path });
      expect(generated["rule-providers"]?.[rules[1].id].format).toBe("mrs");
      expect(generated.rules).toContain(`RULE-SET,${rules[0].id},🚀 节点选择`);
    }
    expect(db.subscription.encryptedConfig).toBe(encryptedBefore);
  });

  it("round-trips encrypted templates without dropping format or stable target IDs", async () => {
    const config = { ...buildDefaultSubBoostTemplateConfig("minimal"), customRuleSets: rules };
    await createTemplate("owner-1", { name: "Finance", config });
    expect(db.template.encryptedConfig).not.toContain("finance.yml");
    db.template = structuredClone(db.template);
    const detail = await getTemplateDetail("owner-1", "template-1");
    expect(detail!.config.customRuleSets).toEqual(rules);
    expect(normalizeRuleModelFromConfig(detail!.config).customRuleSets).toEqual(rules);
  });

  it("rejects incompatible new fields before any database write", async () => {
    const invalidRules = [{ ...rules[0], format: "mrs" }];
    await expect(createSubscription("owner-1", { name: "Bad", nodes, config: { customRuleSets: invalidRules } })).rejects.toThrow("classical");
    expect(db.subscription).toBeNull();
    await expect(createTemplate("owner-1", { name: "Bad", config: { ...buildDefaultSubBoostTemplateConfig("minimal"), customRuleSets: invalidRules } })).rejects.toThrow("classical");
    expect(db.template).toBeNull();
  });
});
