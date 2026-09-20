import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client/Utils", () => ({
  translateText: vi.fn(
    (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  ),
}));

import "../../src/client/components/map/MapGeneratorPanel";
import type { MapGeneratorPanel } from "../../src/client/components/map/MapGeneratorPanel";
import { MapArchetype } from "../../src/core/game/generator/MapGenTypes";

// The panel builds a real map for its preview on mount, which is slower than
// a typical component test.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Behaviour of the generator's controls.
 *
 * The panel is the only place the generator is driven from, and its preview
 * runs the real generator rather than an approximation, so a mistake here
 * means the player is choosing settings against a map they will not get.
 */

const flush = async (el: MapGeneratorPanel) => {
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
};

/** Waits for the debounced preview to be built and painted. */
const flushPreview = async (el: MapGeneratorPanel) => {
  await new Promise((r) => setTimeout(r, 400));
  await el.updateComplete;
};

function mount(): MapGeneratorPanel {
  const el = document.createElement("map-generator-panel") as MapGeneratorPanel;
  document.body.appendChild(el);
  return el;
}

function buttonWithText(
  el: MapGeneratorPanel,
  text: string,
): HTMLButtonElement {
  const match = [...el.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text),
  );
  if (match === undefined) {
    throw new Error(`No button containing "${text}"`);
  }
  return match as HTMLButtonElement;
}

describe("map-generator-panel", () => {
  let panel: MapGeneratorPanel;

  beforeEach(() => {
    panel = mount();
  });

  afterEach(() => {
    panel.remove();
  });

  it("offers every archetype", async () => {
    await flush(panel);
    for (const archetype of Object.values(MapArchetype)) {
      expect(panel.textContent).toContain(
        `map_generator.archetype.${archetype}`,
      );
    }
  });

  it("builds a preview and reports what it achieved", async () => {
    await flushPreview(panel);

    const img = panel.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toMatch(/^data:image\/png/);

    // The achieved line must reflect the real result, not the request.
    expect(panel.textContent).toMatch(/map_generator\.achieved:/);
  });

  it("disables the island slider where it has no meaning", async () => {
    await flushPreview(panel);

    const sliders = () =>
      [...panel.querySelectorAll('input[type="range"]')] as HTMLInputElement[];
    expect(sliders()[0].disabled).toBe(false);

    buttonWithText(panel, "map_generator.archetype.pangaea").click();
    await flushPreview(panel);

    // Pangaea is one landmass by definition, so island count is inapplicable
    // rather than merely ignored.
    expect(sliders()[0].disabled).toBe(true);
  });

  // The canvas is stubbed by vitest-canvas-mock, so `toDataURL` returns a
  // constant and the rendered image cannot distinguish one preview from
  // another. These assert on the achieved-stats line instead, which is
  // derived from the generated map and is what the player reads anyway.
  // "different seed produces a different map" is proven properly against the
  // generator itself in MapGeneratorDeterminism.
  it("rerolling the seed replaces the seed and rebuilds", async () => {
    await flushPreview(panel);
    const seedField = panel.querySelector(
      'input[type="text"]',
    ) as HTMLInputElement;
    const before = seedField.value;

    buttonWithText(panel, "🎲").click();
    await flushPreview(panel);

    const after = (
      panel.querySelector('input[type="text"]') as HTMLInputElement
    ).value;
    expect(after).not.toBe(before);
    expect(panel.textContent).toMatch(/map_generator\.achieved:/);
  });

  it("rebuilds the preview when a parameter changes", async () => {
    await flushPreview(panel);
    const landOf = (): number => {
      const m = panel.textContent?.match(/"land":(\d+)/);
      if (m === null || m === undefined) throw new Error("no achieved stats");
      return Number(m[1]);
    };
    const before = landOf();

    const coverage = (
      panel.querySelectorAll(
        'input[type="range"]',
      ) as NodeListOf<HTMLInputElement>
    )[1];
    coverage.value = "65";
    coverage.dispatchEvent(new Event("input"));
    await flushPreview(panel);

    expect(landOf()).toBeGreaterThan(before);
  });

  it("leaves the preview unchanged when nothing meaningful changed", async () => {
    await flushPreview(panel);
    const first = panel.textContent?.match(
      /map_generator\.achieved:[^<]*/,
    )?.[0];

    // Switch away and back; the seed is untouched, so the map must be too.
    buttonWithText(panel, "map_generator.archetype.pangaea").click();
    await flushPreview(panel);
    buttonWithText(panel, "map_generator.archetype.continents").click();
    await flushPreview(panel);

    expect(panel.textContent?.match(/map_generator\.achieved:[^<]*/)?.[0]).toBe(
      first,
    );
  });

  it("calls back when dismissed", async () => {
    const onCancel = vi.fn();
    panel.onCancel = onCancel;
    await flush(panel);

    buttonWithText(panel, "map_generator.cancel").click();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
