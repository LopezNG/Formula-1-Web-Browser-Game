/**
 * Keyboard input tracker.
 * Normalizes WASD + arrow keys into a clean action API used by the car controller.
 */
export class Input {
  private keys = new Set<string>();
  private justPressed = new Set<string>();

  constructor() {
    window.addEventListener("keydown", (e) => {
      // Avoid firing the boost cooldown twice on auto-repeat events.
      if (!e.repeat) this.justPressed.add(e.code);
      this.keys.add(e.code);
      // Keep page from scrolling on arrows / space.
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Space",
        ].includes(e.code)
      ) {
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
    });
    window.addEventListener("blur", () => this.keys.clear());
  }

  /** Continuous query: is this key currently down? */
  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Edge query: was this key pressed since the last endFrame()? */
  wasPressed(code: string): boolean {
    return this.justPressed.has(code);
  }

  /** Aggregate accelerator (W / Up). */
  get throttle(): number {
    return this.isDown("KeyW") || this.isDown("ArrowUp") ? 1 : 0;
  }

  /** Aggregate brake/reverse (S / Down). */
  get brake(): number {
    return this.isDown("KeyS") || this.isDown("ArrowDown") ? 1 : 0;
  }

  /** Steering: -1 = left, +1 = right. */
  get steer(): number {
    let s = 0;
    if (this.isDown("KeyA") || this.isDown("ArrowLeft")) s -= 1;
    if (this.isDown("KeyD") || this.isDown("ArrowRight")) s += 1;
    return s;
  }

  get handbrake(): boolean {
    return this.isDown("Space");
  }

  get boost(): boolean {
    return this.isDown("ShiftLeft") || this.isDown("ShiftRight");
  }

  get reset(): boolean {
    return this.wasPressed("KeyR");
  }

  /** Must be called once per frame after the game has consumed inputs. */
  endFrame() {
    this.justPressed.clear();
  }
}
