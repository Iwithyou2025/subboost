import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("lucide-react", () => ({
  QrCode: () => null,
  ChevronDown: () => React.createElement("span", null, "down-icon"),
  ChevronRight: () => React.createElement("span", null, "right-icon"),
}));

import { SectionHeader } from "./section-header";

function TestIcon() {
  return React.createElement("span", null, "test-icon");
}

describe("SectionHeader", () => {
  it("renders expanded or collapsed icons and optional badges", () => {
    const expanded = renderToStaticMarkup(
      React.createElement(SectionHeader, {
        icon: TestIcon,
        title: "输入源",
        badge: React.createElement("span", null, "2"),
        isExpanded: true,
        onToggle: vi.fn(),
      })
    );
    const collapsed = renderToStaticMarkup(
      React.createElement(SectionHeader, {
        icon: TestIcon,
        title: "规则",
        isExpanded: false,
        onToggle: vi.fn(),
      })
    );

    expect(expanded).toContain("down-icon");
    expect(expanded).toContain("test-icon");
    expect(expanded).toContain("输入源");
    expect(expanded).toContain("2");
    expect(collapsed).toContain("right-icon");
    expect(collapsed).toContain("规则");
  });

  it("calls onToggle from the rendered button", () => {
    const onToggle = vi.fn();
    const element = SectionHeader({
      icon: TestIcon,
      title: "输入源",
      isExpanded: true,
      onToggle,
    }) as React.ReactElement<{ onClick: () => void }>;

    element.props.onClick();

    expect(onToggle).toHaveBeenCalled();
  });
});
