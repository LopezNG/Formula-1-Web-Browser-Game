/**
 * DOM-based heads-up display.
 *
 * Building the HUD with HTML/CSS keeps the layout responsive and readable on any
 * resolution while staying out of the WebGL canvas. The Game calls `update()`
 * every frame with the current state to refresh values.
 */
export interface HUDState {
  speedKmh: number;
  rpm01: number; // 0..1
  gear: string;
  lap: number;
  totalLaps: number;
  currentLapMs: number;
  bestLapMs: number | null;
  lastLapMs: number | null;
  checkpoints: { hit: boolean }[];
  drsArmed: boolean;
  drsActive: boolean;
}

export class UI {
  private root: HTMLDivElement;
  private elSpeed!: HTMLDivElement;
  private elGear!: HTMLDivElement;
  private elRpm!: HTMLDivElement;
  private elLap!: HTMLSpanElement;
  private elCurLap!: HTMLSpanElement;
  private elBestLap!: HTMLSpanElement;
  private elLastLap!: HTMLSpanElement;
  private elCheckpoints!: HTMLDivElement;
  private elDrs!: HTMLDivElement;
  private elToast!: HTMLDivElement;

  private toastTimer = 0;

  constructor(root: HTMLDivElement) {
    this.root = root;
    this.build();
  }

  private build() {
    this.root.innerHTML = `
      <div class="hud hud-laps hud-panel">
        <div class="row"><span class="label">LAP</span><span class="value"><span id="ui-lap">1</span> / 3</span></div>
        <div class="row"><span class="label">CURRENT</span><span class="value" id="ui-curlap">--:--.---</span></div>
        <div class="row best"><span class="label">BEST</span><span class="value" id="ui-bestlap">--:--.---</span></div>
        <div class="row"><span class="label">LAST</span><span class="value" id="ui-lastlap">--:--.---</span></div>
      </div>

      <div class="hud hud-checkpoints" id="ui-checkpoints"></div>

      <div class="hud hud-drs" id="ui-drs">DRS</div>

      <div class="hud hud-speed hud-panel">
        <div class="value" id="ui-speed">0</div>
        <div class="unit">KM/H</div>
        <div class="gear" id="ui-gear">N</div>
      </div>
      <div class="hud hud-rpm"><div class="fill" id="ui-rpm"></div></div>

      <div class="hud hud-controls hud-panel">
        <div><kbd>W</kbd>/<kbd>↑</kbd> Throttle &nbsp; <kbd>S</kbd>/<kbd>↓</kbd> Brake</div>
        <div><kbd>A</kbd><kbd>D</kbd>/<kbd>←</kbd><kbd>→</kbd> Steer &nbsp; <kbd>Space</kbd> Handbrake</div>
        <div><kbd>Shift</kbd> DRS Boost &nbsp; <kbd>R</kbd> Reset to Track</div>
      </div>

      <div class="hud hud-toast" id="ui-toast">TRACK LIMITS</div>
    `;
    this.elSpeed = this.root.querySelector("#ui-speed") as HTMLDivElement;
    this.elGear = this.root.querySelector("#ui-gear") as HTMLDivElement;
    this.elRpm = this.root.querySelector("#ui-rpm") as HTMLDivElement;
    this.elLap = this.root.querySelector("#ui-lap") as HTMLSpanElement;
    this.elCurLap = this.root.querySelector("#ui-curlap") as HTMLSpanElement;
    this.elBestLap = this.root.querySelector("#ui-bestlap") as HTMLSpanElement;
    this.elLastLap = this.root.querySelector("#ui-lastlap") as HTMLSpanElement;
    this.elCheckpoints = this.root.querySelector(
      "#ui-checkpoints"
    ) as HTMLDivElement;
    this.elDrs = this.root.querySelector("#ui-drs") as HTMLDivElement;
    this.elToast = this.root.querySelector("#ui-toast") as HTMLDivElement;
  }

  /** Sets the number of checkpoint dots shown (called once when circuit is built). */
  setCheckpointCount(count: number) {
    this.elCheckpoints.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const dot = document.createElement("div");
      dot.className = "dot";
      this.elCheckpoints.appendChild(dot);
    }
  }

  showToast(message: string, durationSec = 1.6) {
    this.elToast.textContent = message;
    this.elToast.classList.add("show");
    this.toastTimer = durationSec;
  }

  update(dt: number, state: HUDState) {
    this.elSpeed.textContent = Math.round(Math.abs(state.speedKmh)).toString();
    this.elGear.textContent = state.gear;
    this.elRpm.style.width = `${Math.min(100, state.rpm01 * 100).toFixed(1)}%`;

    this.elLap.textContent = `${Math.min(state.lap, state.totalLaps)}`;
    this.elCurLap.textContent = formatLapTime(state.currentLapMs);
    this.elBestLap.textContent =
      state.bestLapMs == null ? "--:--.---" : formatLapTime(state.bestLapMs);
    this.elLastLap.textContent =
      state.lastLapMs == null ? "--:--.---" : formatLapTime(state.lastLapMs);

    const dots = this.elCheckpoints.children;
    for (let i = 0; i < dots.length; i++) {
      const dot = dots[i] as HTMLDivElement;
      dot.classList.toggle("hit", !!state.checkpoints[i]?.hit);
    }

    this.elDrs.classList.toggle("armed", state.drsArmed && !state.drsActive);
    this.elDrs.classList.toggle("active", state.drsActive);

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.elToast.classList.remove("show");
    }
  }
}

function formatLapTime(ms: number): string {
  if (!isFinite(ms) || ms < 0) return "--:--.---";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = Math.floor(ms % 1000);
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
}
