import * as THREE from "three";

/**
 * One checkpoint along the circuit centerline.
 *
 * Geometrically a checkpoint is an oriented infinite plane (defined by `position`
 * and `forward`) clipped to a finite rectangle of `halfWidth` × `halfHeight`.
 * The car must cross the plane in the +`forward` direction *and* be inside the
 * rectangle to register the checkpoint.
 */
export interface Checkpoint {
  index: number;
  position: THREE.Vector3;
  /** Tangent direction at the centerline; the player must cross from -forward to +forward. */
  forward: THREE.Vector3;
  /** Lateral right vector (forward × up). */
  right: THREE.Vector3;
  halfWidth: number;
  halfHeight: number;
  hit: boolean;
  /** Last frame's signed distance from the plane (used for crossing detection). */
  lastSigned: number;
}

export class LapSystem {
  readonly checkpoints: Checkpoint[];
  readonly totalLaps: number;

  lap = 1;
  currentLapMs = 0;
  bestLapMs: number | null = null;
  lastLapMs: number | null = null;

  /** Set false once any checkpoint or the start-line is crossed for the first time. */
  private waitingForFirstStart = true;

  constructor(checkpoints: Checkpoint[], totalLaps = 3) {
    this.checkpoints = checkpoints;
    this.totalLaps = totalLaps;
  }

  reset() {
    this.lap = 1;
    this.currentLapMs = 0;
    this.bestLapMs = null;
    this.lastLapMs = null;
    this.waitingForFirstStart = true;
    for (const cp of this.checkpoints) {
      cp.hit = false;
      cp.lastSigned = 0;
    }
  }

  /**
   * Advance the lap timer and check whether the car has just crossed any checkpoint.
   * Returns `"lap"` if a lap was just completed, `"checkpoint"` if a sub-checkpoint
   * was hit, or `null` otherwise.
   */
  update(dt: number, carPosition: THREE.Vector3): "lap" | "checkpoint" | null {
    if (!this.waitingForFirstStart) {
      this.currentLapMs += dt * 1000;
    }

    let event: "lap" | "checkpoint" | null = null;

    for (const cp of this.checkpoints) {
      const dx = carPosition.x - cp.position.x;
      const dy = carPosition.y - cp.position.y;
      const dz = carPosition.z - cp.position.z;
      const signed = dx * cp.forward.x + dy * cp.forward.y + dz * cp.forward.z;
      const lateral = dx * cp.right.x + dy * cp.right.y + dz * cp.right.z;
      const vertical = Math.abs(dy);

      // Only count crossings that go in the correct direction (negative → positive)
      // AND that fall inside the gate's finite rectangle.
      const crossed =
        cp.lastSigned < 0 &&
        signed >= 0 &&
        Math.abs(lateral) <= cp.halfWidth &&
        vertical <= cp.halfHeight;
      cp.lastSigned = signed;

      if (!crossed) continue;

      if (cp.index === 0) {
        // Start/finish line: count a lap only if every other checkpoint was hit.
        if (this.waitingForFirstStart) {
          this.waitingForFirstStart = false;
          this.currentLapMs = 0;
        } else {
          const allHit = this.checkpoints
            .slice(1)
            .every((c) => c.hit);
          if (allHit) {
            const lapMs = this.currentLapMs;
            this.lastLapMs = lapMs;
            if (this.bestLapMs == null || lapMs < this.bestLapMs) {
              this.bestLapMs = lapMs;
            }
            this.lap++;
            this.currentLapMs = 0;
            for (const c of this.checkpoints) c.hit = false;
            event = "lap";
          }
          // If not all checkpoints were hit, treat it as a "warning crossing"
          // and silently reset the lap timer so cheating doesn't pay off.
          else {
            this.currentLapMs = 0;
            for (const c of this.checkpoints) c.hit = false;
          }
        }
      } else {
        // Mid-lap checkpoint: only register if the previous checkpoint was hit.
        const prev = this.checkpoints[cp.index - 1];
        if (prev.hit && !cp.hit) {
          cp.hit = true;
          if (event !== "lap") event = "checkpoint";
        }
      }
    }

    return event;
  }
}
