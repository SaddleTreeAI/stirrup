// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 SaddleTree AI

// biome-ignore-all lint/suspicious/noExportsInTest: helpers stay in this guard file; no runtime module.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

export type Rgba = { r: number; g: number; b: number; a: number };

/** Parse `#rgb`, `#rrggbb`, or `#rrggbbaa` into sRGB channels. */
export function parseCssColor(value: string): Rgba {
  const hex = value.trim().replace(/^#/, "");
  if (hex.length === 3) {
    return {
      r: Number.parseInt(hex[0]! + hex[0]!, 16),
      g: Number.parseInt(hex[1]! + hex[1]!, 16),
      b: Number.parseInt(hex[2]! + hex[2]!, 16),
      a: 1,
    };
  }
  if (hex.length === 6) {
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }
  if (hex.length === 8) {
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
      a: Number.parseInt(hex.slice(6, 8), 16) / 255,
    };
  }
  throw new Error(`Unsupported color: ${value}`);
}

/** Source-over alpha composite of `fg` onto opaque `bg`. */
export function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a;
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

function channelToLinear(channel: number): number {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: Rgba): number {
  return (
    0.2126 * channelToLinear(color.r) +
    0.7152 * channelToLinear(color.g) +
    0.0722 * channelToLinear(color.b)
  );
}

/** WCAG contrast ratio of two CSS colors; composites alpha foregrounds onto the background. */
export function contrastRatio(foreground: string, background: string): number {
  const bg = parseCssColor(background);
  if (bg.a < 1) throw new Error(`Background must be opaque: ${background}`);
  let fg = parseCssColor(foreground);
  if (fg.a < 1) fg = compositeOver(fg, bg);
  const lighter = Math.max(relativeLuminance(fg), relativeLuminance(bg));
  const darker = Math.min(relativeLuminance(fg), relativeLuminance(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

/** Apply an extra opacity multiplier to a (possibly already translucent) color. */
export function withOpacity(color: string, opacity: number): string {
  const c = parseCssColor(color);
  const a = Math.round(c.a * opacity * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${((c.r << 16) | (c.g << 8) | c.b).toString(16).padStart(6, "0")}${a}`;
}

export function solidOver(foreground: string, background: string): string {
  const c = compositeOver(parseCssColor(foreground), parseCssColor(background));
  return `#${((c.r << 16) | (c.g << 8) | c.b).toString(16).padStart(6, "0")}`;
}

type ThemeTokens = {
  background: string;
  foreground: string;
  card: string;
  muted: string;
  mutedForeground: string;
  destructive: string;
  border: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarBorder: string;
  sidebarAccent: string;
  overlay: string;
};

function parseThemeBlock(css: string, selector: string): ThemeTokens {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`Missing theme block ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const body = css.slice(open + 1, close);
  const read = (name: string): string => {
    const match = body.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]+)\\s*;`));
    if (!match?.[1]) throw new Error(`Missing --${name} in ${selector}`);
    return match[1];
  };
  return {
    background: read("background"),
    foreground: read("foreground"),
    card: read("card"),
    muted: read("muted"),
    mutedForeground: read("muted-foreground"),
    destructive: read("destructive"),
    border: read("border"),
    input: read("input"),
    ring: read("ring"),
    sidebar: read("sidebar"),
    sidebarBorder: read("sidebar-border"),
    sidebarAccent: read("sidebar-accent"),
    overlay: read("overlay"),
  };
}

export function loadThemeTokens(cssPath: string): { dark: ThemeTokens; light: ThemeTokens } {
  const css = readFileSync(cssPath, "utf8");
  return {
    dark: parseThemeBlock(css, ':root,\n[data-theme="dark"]'),
    light: parseThemeBlock(css, '[data-theme="light"]'),
  };
}

type PairKind = "text" | "ui";

type ContrastPair = {
  id: string;
  kind: PairKind;
  /** Foreground (or indicator) CSS color for the theme. */
  foreground: (theme: ThemeTokens) => string;
  /** Opaque background the pair sits on. */
  background: (theme: ThemeTokens) => string;
};

function sidebarAccentFill(theme: ThemeTokens): string {
  return solidOver(theme.sidebarAccent, theme.sidebar);
}

function mutedOverBackground(theme: ThemeTokens): string {
  return solidOver(withOpacity(theme.muted, 0.4), theme.background);
}

/** Law UI pairs that must keep WCAG 2.2 AA after this change. */
export const LAW_CONTRAST_PAIRS: ContrastPair[] = [
  {
    id: "muted-foreground on background",
    kind: "text",
    foreground: (t) => t.mutedForeground,
    background: (t) => t.background,
  },
  {
    id: "muted-foreground on sidebar",
    kind: "text",
    foreground: (t) => t.mutedForeground,
    background: (t) => t.sidebar,
  },
  {
    id: "muted-foreground on sidebar-accent",
    kind: "text",
    foreground: (t) => t.mutedForeground,
    background: (t) => sidebarAccentFill(t),
  },
  {
    id: "muted-foreground on card",
    kind: "text",
    foreground: (t) => t.mutedForeground,
    background: (t) => t.card,
  },
  {
    id: "muted-foreground on muted/40 over background",
    kind: "text",
    foreground: (t) => t.mutedForeground,
    background: (t) => mutedOverBackground(t),
  },
  {
    id: "foreground on background",
    kind: "text",
    foreground: (t) => t.foreground,
    background: (t) => t.background,
  },
  {
    id: "foreground on sidebar",
    kind: "text",
    foreground: (t) => t.foreground,
    background: (t) => t.sidebar,
  },
  {
    id: "foreground on sidebar-accent",
    kind: "text",
    foreground: (t) => t.foreground,
    background: (t) => sidebarAccentFill(t),
  },
  {
    id: "foreground on card",
    kind: "text",
    foreground: (t) => t.foreground,
    background: (t) => t.card,
  },
  {
    id: "destructive on background",
    kind: "text",
    foreground: (t) => t.destructive,
    background: (t) => t.background,
  },
  {
    id: "destructive on card",
    kind: "text",
    foreground: (t) => t.destructive,
    background: (t) => t.card,
  },
  {
    id: "placeholder muted-foreground on card",
    kind: "text",
    foreground: (t) => t.mutedForeground,
    background: (t) => t.card,
  },
  {
    id: "selected ring-foreground/50 on sidebar",
    kind: "ui",
    foreground: (t) => withOpacity(t.foreground, 0.5),
    background: (t) => t.sidebar,
  },
  {
    id: "selected ring-foreground/50 on sidebar-accent",
    kind: "ui",
    foreground: (t) => withOpacity(t.foreground, 0.5),
    background: (t) => sidebarAccentFill(t),
  },
  {
    id: "focus ring-foreground/50 on background",
    kind: "ui",
    foreground: (t) => withOpacity(t.foreground, 0.5),
    background: (t) => t.background,
  },
  {
    id: "focus ring-foreground/50 on card",
    kind: "ui",
    foreground: (t) => withOpacity(t.foreground, 0.5),
    background: (t) => t.card,
  },
  {
    id: "focus ring-foreground/50 on sidebar",
    kind: "ui",
    foreground: (t) => withOpacity(t.foreground, 0.5),
    background: (t) => t.sidebar,
  },
  {
    id: "input border-foreground/50 on card",
    kind: "ui",
    foreground: (t) => withOpacity(t.foreground, 0.5),
    background: (t) => t.card,
  },
  {
    id: "input border-foreground/50 on sidebar",
    kind: "ui",
    foreground: (t) => withOpacity(t.foreground, 0.5),
    background: (t) => t.sidebar,
  },
];

function thresholdFor(kind: PairKind): number {
  return kind === "text" ? 4.5 : 3;
}

const tokensCssPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/ui-tokens/src/tokens.css",
);

describe("law contrast (WCAG 2.2 AA)", () => {
  const themes = loadThemeTokens(tokensCssPath);

  for (const themeName of ["dark", "light"] as const) {
    const theme = themes[themeName];
    for (const pair of LAW_CONTRAST_PAIRS) {
      it(`${pair.id} (${themeName})`, () => {
        const ratio = contrastRatio(pair.foreground(theme), pair.background(theme));
        const need = thresholdFor(pair.kind);
        expect(
          ratio,
          `${pair.id} (${themeName}): ${ratio.toFixed(2)}:1 < ${need}:1`,
        ).toBeGreaterThanOrEqual(need);
      });
    }
  }

  it("rejects a weak selected-state ring that looks like the fill-only indicator", () => {
    const weak = solidOver(themes.dark.sidebarAccent, themes.dark.sidebar);
    const ratio = contrastRatio(weak, themes.dark.sidebar);
    expect(ratio).toBeLessThan(1.5);
    expect(() => {
      const need = 3;
      if (ratio < need) {
        throw new Error(
          `selected ring-sidebar-accent on sidebar (dark): ${ratio.toFixed(2)}:1 < ${need}:1`,
        );
      }
    }).toThrow(/selected ring-sidebar-accent on sidebar \(dark\): 1\.\d+:1 < 3:1/);
  });
});
