import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { generateMap } from "../../../core/game/generator/GenerateMap";
import { mapGenClient } from "../../../core/game/generator/MapGenClient";
import {
  MAP_SIZES,
  MapArchetype,
  type GeneratedMapBundle,
  type MapGenParams,
  type MapGenProgress,
  type MapSizePreset,
} from "../../../core/game/generator/MapGenTypes";
import { profileFor } from "../../../core/game/generator/MapStyleProfile";
import { unpackTerrain } from "../../../core/game/generator/PackTerrain";
import { renderPreview } from "../../../core/game/generator/Thumbnail";
import { translateText } from "../../Utils";
import { registerGeneratedMap } from "./GeneratedMapStore";

/** Longest edge of the live preview. Small enough to build synchronously. */
const PREVIEW_MAX_EDGE = 220;
/** Quiet period after a slider moves before the preview is rebuilt. */
const PREVIEW_DEBOUNCE_MS = 180;

const ARCHETYPE_ORDER: readonly MapArchetype[] = [
  MapArchetype.Continents,
  MapArchetype.Archipelago,
  MapArchetype.Pangaea,
  MapArchetype.InlandSea,
  MapArchetype.LakesRivers,
];

/** Archetypes that are one landmass by definition, so island count is moot. */
const SINGLE_ISLAND = new Set<MapArchetype>([
  MapArchetype.Pangaea,
  MapArchetype.InlandSea,
]);

function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) | 0;
}

/**
 * Parameter panel and live preview for procedural map generation.
 *
 * The preview runs the real generator at reduced resolution rather than
 * approximating it, so what the player sees is what they get. At roughly
 * 220 tiles across that costs a few milliseconds, which is cheap enough to
 * redraw while a slider is being dragged.
 */
@customElement("map-generator-panel")
export class MapGeneratorPanel extends LitElement {
  /** Called once a generated map is registered and ready to play. */
  @property({ attribute: false }) onMapReady?: (
    bundle: GeneratedMapBundle,
  ) => void;
  @property({ attribute: false }) onCancel?: () => void;

  @state() private archetype: MapArchetype = MapArchetype.Continents;
  @state() private islandCount = 5;
  @state() private landCoveragePct = 40;
  @state() private sizeId: MapSizePreset["id"] = "medium";
  @state() private mountainousnessPct = 50;
  @state() private roughnessPct = 50;
  @state() private nationCount = 16;
  @state() private seed = randomSeed();

  @state() private previewUrl: string | null = null;
  @state() private previewStats: { islands: number; land: number } | null =
    null;
  @state() private generating = false;
  @state() private progress: MapGenProgress | null = null;
  @state() private error: string | null = null;

  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private previewToken = 0;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.schedulePreview();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.previewTimer !== null) clearTimeout(this.previewTimer);
    if (this.previewUrl !== null) URL.revokeObjectURL(this.previewUrl);
  }

  private get size(): MapSizePreset {
    return MAP_SIZES.find((s) => s.id === this.sizeId) ?? MAP_SIZES[1];
  }

  private params(width: number, height: number): MapGenParams {
    return {
      archetype: this.archetype,
      seed: this.seed,
      width,
      height,
      islandCount: this.islandCount,
      landCoverage: this.landCoveragePct / 100,
      mountainousness: this.mountainousnessPct / 100,
      coastlineRoughness: this.roughnessPct / 100,
      nationCount: this.nationCount,
    };
  }

  private schedulePreview(): void {
    if (this.previewTimer !== null) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(
      () => this.buildPreview(),
      PREVIEW_DEBOUNCE_MS,
    );
  }

  private buildPreview(): void {
    const { width, height } = this.size;
    const scale = PREVIEW_MAX_EDGE / Math.max(width, height);
    const token = ++this.previewToken;

    let bundle: GeneratedMapBundle;
    try {
      bundle = generateMap(
        this.params(
          Math.round((width * scale) / 4) * 4,
          Math.round((height * scale) / 4) * 4,
        ),
      );
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      return;
    }
    // A later preview may have started while this one ran.
    if (token !== this.previewToken) return;

    const grid = unpackTerrain(
      bundle.mapBin,
      bundle.manifest.map.width,
      bundle.manifest.map.height,
    );
    const image = renderPreview(grid);

    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    ctx.putImageData(
      new ImageData(image.data, image.width, image.height),
      0,
      0,
    );

    if (this.previewUrl !== null) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = canvas.toDataURL("image/png");
    this.previewStats = {
      islands: bundle.stats.islandCount,
      land: Math.round(bundle.stats.landFraction * 100),
    };
    this.error = null;
  }

  /** Applies a parameter change and queues a preview rebuild. */
  private change(apply: () => void): void {
    apply();
    this.schedulePreview();
  }

  private async handleGenerate(): Promise<void> {
    if (this.generating) return;
    this.generating = true;
    this.error = null;
    this.progress = null;

    try {
      const { width, height } = this.size;
      const bundle = await mapGenClient.generate(
        this.params(width, height),
        (progress) => {
          this.progress = progress;
        },
      );
      await registerGeneratedMap(bundle);
      this.onMapReady?.(bundle);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.generating = false;
      this.progress = null;
    }
  }

  private renderArchetypes(): TemplateResult {
    return html`
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
        ${ARCHETYPE_ORDER.map((a) => {
          const active = this.archetype === a;
          return html`<button
            type="button"
            aria-pressed=${active}
            class="px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all active:scale-95 border ${active
              ? "bg-malibu-blue/20 border-malibu-blue/50 text-white"
              : "bg-white/5 border-white/10 text-white/60 hover:text-white hover:bg-white/10"}"
            @click=${() =>
              this.change(() => {
                this.archetype = a;
              })}
          >
            ${translateText(`map_generator.archetype.${a}`)}
          </button>`;
        })}
      </div>
    `;
  }

  private renderSlider(
    labelKey: string,
    value: number,
    min: number,
    max: number,
    onInput: (v: number) => void,
    display: string,
    disabled = false,
  ): TemplateResult {
    return html`
      <label class="block ${disabled ? "opacity-40" : ""}">
        <div class="flex justify-between items-baseline mb-1">
          <span class="text-xs font-bold text-white/60 uppercase tracking-wider"
            >${translateText(labelKey)}</span
          >
          <span class="text-xs font-bold text-white">${display}</span>
        </div>
        <input
          type="range"
          class="w-full"
          min=${min}
          max=${max}
          .value=${String(value)}
          ?disabled=${disabled}
          @input=${(e: Event) =>
            onInput(Number((e.target as HTMLInputElement).value))}
        />
      </label>
    `;
  }

  private renderPreviewPane(): TemplateResult {
    const stats = this.previewStats;
    return html`
      <div class="space-y-2">
        <div
          class="w-full aspect-[4/3] rounded-xl overflow-hidden bg-black/30 border border-white/10 flex items-center justify-center"
        >
          ${this.previewUrl === null
            ? html`<span class="text-xs text-white/40"
                >${translateText("map_generator.building_preview")}</span
              >`
            : html`<img
                src=${this.previewUrl}
                alt=${translateText("map_generator.preview_alt")}
                class="w-full h-full object-contain"
                draggable="false"
              />`}
        </div>
        ${stats === null
          ? null
          : html`<p class="text-xs text-white/50 text-center">
              ${translateText("map_generator.achieved", {
                islands: stats.islands,
                land: stats.land,
              })}
            </p>`}
      </div>
    `;
  }

  render() {
    const singleIsland = SINGLE_ISLAND.has(this.archetype);
    // Slider bounds come from the measured spread of the real maps, so the
    // extremes still land inside the range the shipped maps occupy.
    const profile = profileFor(this.archetype);
    const maxIslands = Math.max(
      12,
      Math.round(profile.significantBodies.p90 * 2),
    );

    return html`
      <div class="space-y-5">
        <div class="grid md:grid-cols-2 gap-5">
          <div class="space-y-4">
            ${this.renderArchetypes()}
            ${this.renderSlider(
              "map_generator.islands",
              this.islandCount,
              1,
              maxIslands,
              (v) =>
                this.change(() => {
                  this.islandCount = v;
                }),
              singleIsland ? "1" : String(this.islandCount),
              singleIsland,
            )}
            ${this.renderSlider(
              "map_generator.land_coverage",
              this.landCoveragePct,
              10,
              70,
              (v) =>
                this.change(() => {
                  this.landCoveragePct = v;
                }),
              `${this.landCoveragePct}%`,
            )}
            ${this.renderSlider(
              "map_generator.mountainousness",
              this.mountainousnessPct,
              0,
              100,
              (v) =>
                this.change(() => {
                  this.mountainousnessPct = v;
                }),
              `${this.mountainousnessPct}%`,
            )}
            ${this.renderSlider(
              "map_generator.roughness",
              this.roughnessPct,
              0,
              100,
              (v) =>
                this.change(() => {
                  this.roughnessPct = v;
                }),
              `${this.roughnessPct}%`,
            )}
            ${this.renderSlider(
              "map_generator.nations",
              this.nationCount,
              0,
              64,
              (v) =>
                this.change(() => {
                  this.nationCount = v;
                }),
              String(this.nationCount),
            )}
          </div>

          <div class="space-y-4">
            ${this.renderPreviewPane()}

            <div>
              <span
                class="block text-xs font-bold text-white/60 uppercase tracking-wider mb-1"
                >${translateText("map_generator.size")}</span
              >
              <div class="grid grid-cols-3 gap-2">
                ${MAP_SIZES.map((s) => {
                  const active = this.sizeId === s.id;
                  return html`<button
                    type="button"
                    aria-pressed=${active}
                    class="px-2 py-2 rounded-lg text-xs font-bold uppercase tracking-wider border transition-all active:scale-95 ${active
                      ? "bg-malibu-blue/20 border-malibu-blue/50 text-white"
                      : "bg-white/5 border-white/10 text-white/60 hover:text-white"}"
                    @click=${() =>
                      this.change(() => {
                        this.sizeId = s.id;
                      })}
                  >
                    ${translateText(`map_generator.size_${s.id}`)}
                  </button>`;
                })}
              </div>
            </div>

            <div>
              <span
                class="block text-xs font-bold text-white/60 uppercase tracking-wider mb-1"
                >${translateText("map_generator.seed")}</span
              >
              <div class="flex gap-2">
                <input
                  type="text"
                  inputmode="numeric"
                  class="flex-1 min-w-0 px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white text-sm"
                  .value=${String(this.seed)}
                  @change=${(e: Event) => {
                    const raw = Number((e.target as HTMLInputElement).value);
                    this.change(() => {
                      this.seed = Number.isFinite(raw) ? raw | 0 : 0;
                    });
                  }}
                />
                <button
                  type="button"
                  class="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-white hover:bg-white/10 active:scale-95 transition-all"
                  title=${translateText("map_generator.reroll")}
                  @click=${() =>
                    this.change(() => {
                      this.seed = randomSeed();
                    })}
                >
                  🎲
                </button>
              </div>
            </div>
          </div>
        </div>

        ${this.error === null
          ? null
          : html`<p class="text-xs text-red-400">${this.error}</p>`}
        ${this.progress === null
          ? null
          : html`<div class="space-y-1">
              <div
                class="h-1.5 w-full rounded-full bg-white/10 overflow-hidden"
              >
                <div
                  class="h-full bg-malibu-blue transition-all"
                  style="width: ${Math.round(this.progress.fraction * 100)}%"
                ></div>
              </div>
              <p class="text-xs text-white/50">
                ${translateText(`map_generator.phase.${this.progress.phase}`)}
              </p>
            </div>`}

        <div class="flex gap-2 justify-end">
          <button
            type="button"
            class="px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider bg-white/5 border border-white/10 text-white/70 hover:text-white active:scale-95 transition-all"
            @click=${() => this.onCancel?.()}
          >
            ${translateText("map_generator.cancel")}
          </button>
          <button
            type="button"
            ?disabled=${this.generating}
            class="px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider bg-malibu-blue/20 border border-malibu-blue/50 text-white hover:bg-malibu-blue/30 active:scale-95 transition-all disabled:opacity-50"
            @click=${() => void this.handleGenerate()}
          >
            ${this.generating
              ? translateText("map_generator.generating")
              : translateText("map_generator.generate")}
          </button>
        </div>
      </div>
    `;
  }
}
