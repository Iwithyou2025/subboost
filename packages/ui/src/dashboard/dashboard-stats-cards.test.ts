import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("lucide-react", () => ({
  QrCode: () => null,
  Database: () => React.createElement("span", null, "database-icon"),
  FileCode: () => React.createElement("span", null, "file-code-icon"),
  Link2: () => React.createElement("span", null, "link-icon"),
  Server: () => React.createElement("span", null, "server-icon"),
}));

import { DashboardStatsCards } from "./dashboard-stats-cards";

const baseQuota = {
  maxSubscriptions: 5,
  maxNodesPerSubscription: 120,
  maxCustomTemplates: 4,
  maxImportSourcesPerType: 2,
};

describe("DashboardStatsCards", () => {
  it("renders quota values for a normal user", () => {
    const html = renderToStaticMarkup(
      React.createElement(DashboardStatsCards, {
        subscriptionCount: 2,
        user: {
          isAdmin: false,
          templateCount: 3,
          quota: baseQuota,
        },
      })
    );

    expect(html).toContain("订阅配额");
    expect(html).toContain("2");
    expect(html).toContain("/5");
    expect(html).toContain("节点上限配额");
    expect(html).toContain("120");
    expect(html).toContain("/订阅");
    expect(html).toContain("模板配额");
    expect(html).toContain("3");
    expect(html).toContain("/4");
    expect(html).toContain("导入源配额");
    expect(html).toContain("/每种");
    expect(html).toContain("2");
  });

  it("renders unlimited import-source quota for admins or very high quotas", () => {
    const adminHtml = renderToStaticMarkup(
      React.createElement(DashboardStatsCards, {
        subscriptionCount: 1,
        user: {
          isAdmin: true,
          templateCount: 0,
          quota: baseQuota,
        },
      })
    );
    const highQuotaHtml = renderToStaticMarkup(
      React.createElement(DashboardStatsCards, {
        subscriptionCount: 1,
        user: {
          isAdmin: false,
          templateCount: 0,
          quota: {
            ...baseQuota,
            maxImportSourcesPerType: 9999,
          },
        },
      })
    );

    expect(adminHtml).toContain("不限");
    expect(highQuotaHtml).toContain("不限");
  });
});
