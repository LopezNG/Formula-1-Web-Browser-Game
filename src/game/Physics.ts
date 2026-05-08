import RAPIER from "@dimforge/rapier3d-compat";

/**
 * Thin wrapper around a Rapier world.
 *
 * Owning all physics state in one place keeps the rest of the codebase free of
 * Rapier-specific boilerplate (gravity tweaks, fixed timestep, query pipelines, etc.).
 */
export class Physics {
  readonly world: RAPIER.World;
  readonly eventQueue: RAPIER.EventQueue;
  /** Re-usable ray we mutate each frame to avoid GC pressure. */
  readonly scratchRay: RAPIER.Ray;

  /** Fixed simulation step in seconds. */
  readonly fixedDt = 1 / 60;
  private accumulator = 0;

  constructor() {
    const gravity = { x: 0, y: -9.81, z: 0 };
    this.world = new RAPIER.World(gravity);
    this.world.timestep = this.fixedDt;
    this.eventQueue = new RAPIER.EventQueue(true);
    this.scratchRay = new RAPIER.Ray(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: -1, z: 0 }
    );
  }

  /**
   * Drives the physics simulation forward using a fixed-timestep accumulator so
   * the simulation behaves identically regardless of frame rate.
   *
   * Returns the number of steps that ran this frame (useful for diagnostics).
   */
  step(deltaSeconds: number, onFixedStep?: (dt: number) => void): number {
    // Clamp to avoid the spiral-of-death on slow tabs.
    this.accumulator += Math.min(deltaSeconds, 0.1);
    let steps = 0;
    while (this.accumulator >= this.fixedDt) {
      onFixedStep?.(this.fixedDt);
      this.world.step(this.eventQueue);
      this.accumulator -= this.fixedDt;
      steps++;
      if (steps > 5) {
        // Prevent runaway when CPU spikes badly.
        this.accumulator = 0;
        break;
      }
    }
    return steps;
  }

  /**
   * Cast a downward-style ray from world `origin` along `direction` for `maxToi` units.
   * Returns the time-of-impact distance (==length along the ray) or null on miss.
   */
  rayCast(
    origin: RAPIER.Vector,
    direction: RAPIER.Vector,
    maxToi: number,
    excludeCollider?: RAPIER.Collider
  ): { toi: number; normal: RAPIER.Vector } | null {
    this.scratchRay.origin = origin;
    this.scratchRay.dir = direction;
    const filter = excludeCollider
      ? (c: RAPIER.Collider) => c.handle !== excludeCollider.handle
      : undefined;
    const hit = this.world.castRayAndGetNormal(
      this.scratchRay,
      maxToi,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      filter
    );
    if (!hit) return null;
    return { toi: hit.timeOfImpact, normal: hit.normal };
  }
}
