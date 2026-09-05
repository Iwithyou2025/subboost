import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeLocalRateLimit: vi.fn(),
  generateSubscriptionYaml: vi.fn(),
  getTrustedClientRateLimitKey: vi.fn(),
  hashLocalRateLimitKey: vi.fn(() => "token-hash"),
  localRateLimitResponse: vi.fn(
    () => new Response(JSON.stringify({ error: "limited", code: "RATE_LIMITED" }), { status: 429 })
  ),
}));

vi.mock("@local/lib/rate-limit", () => ({
  consumeLocalRateLimit: mocks.consumeLocalRateLimit,
  getTrustedClientRateLimitKey: mocks.getTrustedClientRateLimitKey,
  hashLocalRateLimitKey: mocks.hashLocalRateLimitKey,
  localRateLimitResponse: mocks.localRateLimitResponse,
}));
vi.mock("@local/lib/subscription-service", () => ({
  generateSubscriptionYaml: mocks.generateSubscriptionYaml,
}));

import { GET } from "./route";

describe("local YAML-rule subscription route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consumeLocalRateLimit.mockReturnValue({ allowed: true, retryAfterSeconds: 0 });
    mocks.getTrustedClientRateLimitKey.mockReturnValue("client-hash");
    mocks.generateSubscriptionYaml.mockResolvedValue({
      yaml: "mixed-port: 7890\n",
      name: "Test",
      subscriptionInfo: {},
      cacheExpirySeconds: 3600,
      autoUpdateIntervalSeconds: null,
      isAdmin: true,
    });
  });

  it("requests the YAML rule-provider variant", async () => {
    const response = await GET(new Request("https://local.test/config-yaml.yaml"), {
      params: Promise.resolve({ id: "secret-token" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.generateSubscriptionYaml).toHaveBeenCalledWith("secret-token", "yaml");
    expect(mocks.consumeLocalRateLimit).toHaveBeenNthCalledWith(
      1,
      "subscription-yaml-client",
      "client-hash",
      { limit: 600, windowMs: 60_000 }
    );
    expect(mocks.consumeLocalRateLimit).toHaveBeenNthCalledWith(
      2,
      "subscription-yaml-token",
      "token-hash",
      { limit: 120, windowMs: 60_000 }
    );
  });

  it("returns 429 before generating the YAML variant", async () => {
    mocks.consumeLocalRateLimit.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 17 });

    const response = await GET(new Request("https://local.test/config-yaml.yaml"), {
      params: Promise.resolve({ id: "secret-token" }),
    });

    expect(response.status).toBe(429);
    expect(mocks.generateSubscriptionYaml).not.toHaveBeenCalled();
  });
});
