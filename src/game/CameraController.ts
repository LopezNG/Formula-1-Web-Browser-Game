import * as THREE from "three";

/**
 * Smooth, slightly-lagging chase camera that follows the F1 car.
 *
 * - Position uses critically-damped exponential smoothing toward an ideal pose.
 * - Look-at point includes a small forward look-ahead so the camera anticipates
 *   corners instead of staring at the rear wing.
 * - FOV pulses gently with speed for a sense-of-speed cue.
 */
export class CameraController {
  readonly camera: THREE.PerspectiveCamera;

  private targetPosition = new THREE.Vector3();
  private currentPosition = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private lookAtSmooth = new THREE.Vector3();

  /** Local offset behind/above the car. */
  private offset = new THREE.Vector3(0, 4.2, -10.5);
  /** Where the camera "wants" to look (slightly ahead and above the car). */
  private lookAhead = new THREE.Vector3(0, 1.4, 6);

  private baseFov = 70;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 0.1, 4000);
    this.camera.position.set(0, 5, -12);
  }

  setAspect(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Snap the camera instantly to its ideal position. Useful right after a reset
   * so the camera does not lerp dramatically across the map.
   */
  snapTo(carPosition: THREE.Vector3, carQuat: THREE.Quaternion) {
    const ideal = this.computeIdealPose(carPosition, carQuat);
    this.currentPosition.copy(ideal.pos);
    this.targetPosition.copy(ideal.pos);
    this.lookAtSmooth.copy(ideal.look);
    this.lookAt.copy(ideal.look);
    this.camera.position.copy(this.currentPosition);
    this.camera.lookAt(this.lookAtSmooth);
  }

  update(
    dt: number,
    carPosition: THREE.Vector3,
    carQuat: THREE.Quaternion,
    speedKmh: number
  ) {
    const ideal = this.computeIdealPose(carPosition, carQuat);
    this.targetPosition.copy(ideal.pos);
    this.lookAt.copy(ideal.look);

    // Critically-damped smoothing. The factor controls how snappy the camera feels.
    const k = 1 - Math.exp(-dt * 6);
    this.currentPosition.lerp(this.targetPosition, k);
    this.lookAtSmooth.lerp(this.lookAt, 1 - Math.exp(-dt * 9));

    this.camera.position.copy(this.currentPosition);
    this.camera.lookAt(this.lookAtSmooth);

    // Subtle FOV pulse: 70° at rest → up to ~82° near top speed.
    const speedT = Math.min(1, speedKmh / 320);
    const targetFov = this.baseFov + speedT * 12;
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-dt * 4));
    this.camera.updateProjectionMatrix();
  }

  private computeIdealPose(carPosition: THREE.Vector3, carQuat: THREE.Quaternion) {
    const offsetWorld = this.offset.clone().applyQuaternion(carQuat);
    const lookWorld = this.lookAhead.clone().applyQuaternion(carQuat);
    return {
      pos: carPosition.clone().add(offsetWorld),
      look: carPosition.clone().add(lookWorld),
    };
  }
}
