/**
 * Procedural F1-ish engine sound built with WebAudio oscillators.
 *
 * Real engine notes are layered samples, but a synthesized approximation gives
 * a pleasing "rising whine" tied to RPM without shipping any audio assets.
 * Two detuned saw oscillators run through a low-pass filter; their gain and
 * frequency are modulated by throttle and speed.
 */
export class Audio {
  private ctx: AudioContext | null = null;
  private osc1!: OscillatorNode;
  private osc2!: OscillatorNode;
  private filter!: BiquadFilterNode;
  private master!: GainNode;

  private started = false;
  private targetRpm = 0;
  private currentRpm = 0;
  private throttle = 0;

  /** Browsers require a user gesture before audio can play. Bind this to keydown/click. */
  init() {
    if (this.started) return;
    try {
      const ctx = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
      this.ctx = ctx;

      this.osc1 = ctx.createOscillator();
      this.osc2 = ctx.createOscillator();
      this.osc1.type = "sawtooth";
      this.osc2.type = "square";
      this.osc1.frequency.value = 60;
      this.osc2.frequency.value = 120;

      this.filter = ctx.createBiquadFilter();
      this.filter.type = "lowpass";
      this.filter.frequency.value = 800;
      this.filter.Q.value = 4;

      this.master = ctx.createGain();
      this.master.gain.value = 0.0;

      this.osc1.connect(this.filter);
      this.osc2.connect(this.filter);
      this.filter.connect(this.master);
      this.master.connect(ctx.destination);

      this.osc1.start();
      this.osc2.start();
      this.started = true;
    } catch (e) {
      console.warn("Audio init failed", e);
    }
  }

  /**
   * @param speedKmh current vehicle speed
   * @param throttle01 0..1 raw throttle pedal
   */
  update(dt: number, speedKmh: number, throttle01: number) {
    if (!this.started || !this.ctx) return;

    // RPM tracks speed but rises faster on throttle for a more lively response.
    this.targetRpm = Math.min(1, speedKmh / 320 + throttle01 * 0.3);
    // Smooth so the engine doesn't pop on instant throttle changes.
    this.currentRpm += (this.targetRpm - this.currentRpm) * Math.min(1, dt * 4);
    this.throttle += (throttle01 - this.throttle) * Math.min(1, dt * 6);

    const baseHz = 70 + this.currentRpm * 380; // 70 Hz idle → ~450 Hz redline
    this.osc1.frequency.setTargetAtTime(baseHz, this.ctx.currentTime, 0.02);
    this.osc2.frequency.setTargetAtTime(
      baseHz * 1.5,
      this.ctx.currentTime,
      0.02
    );
    this.filter.frequency.setTargetAtTime(
      600 + this.currentRpm * 2200,
      this.ctx.currentTime,
      0.05
    );

    const targetGain = 0.05 + this.throttle * 0.18 + this.currentRpm * 0.06;
    this.master.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.05);
  }
}
