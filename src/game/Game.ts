import * as THREE from "three";
import { Physics } from "./Physics";
import { Input } from "./Input";
import { CameraController } from "./CameraController";
import { F1Car } from "./F1Car";
import { Circuit } from "./Circuit";
import { UI } from "./UI";
import { LapSystem } from "./LapSystem";
import { Audio } from "./Audio";

/**
 * Central orchestrator. Owns every subsystem and drives the main game loop.
 *
 * The loop is split in two parts:
 *   1. Fixed-step physics (60 Hz via Physics's accumulator). The car controller
 *      reads input and applies forces inside this step so physics behavior is
 *      deterministic regardless of frame rate.
 *   2. Per-frame rendering, camera, audio, UI, and lap-system updates.
 */
export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private clock = new THREE.Clock();

  private physics: Physics;
  private input: Input;
  private cameraCtrl: CameraController;
  private car!: F1Car;
  private circuit: Circuit;
  private ui: UI;
  private lapSystem: LapSystem;
  private audio: Audio;

  private running = false;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLDivElement) {
    // ---- Renderer ------------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    // ---- Scene ---------------------------------------------------------
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xbed7ff);
    this.scene.fog = new THREE.Fog(0xbed7ff, 350, 1500);

    // Hemisphere fill + warm-ish key light with shadow casting.
    const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x6c7a55, 0.7);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(120, 220, 80);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 600;
    sun.shadow.camera.left = -200;
    sun.shadow.camera.right = 200;
    sun.shadow.camera.top = 200;
    sun.shadow.camera.bottom = -200;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);

    // ---- Subsystems ----------------------------------------------------
    this.physics = new Physics();
    this.input = new Input();
    this.cameraCtrl = new CameraController(window.innerWidth / window.innerHeight);
    this.audio = new Audio();
    this.ui = new UI(uiRoot);

    this.circuit = new Circuit(this.scene, this.physics);
    this.lapSystem = new LapSystem(this.circuit.checkpoints, 3);
    this.ui.setCheckpointCount(this.circuit.checkpoints.length);

    this.car = new F1Car(
      this.scene,
      this.physics,
      this.circuit.spawnPosition,
      this.circuit.spawnQuaternion
    );

    this.cameraCtrl.snapTo(
      this.circuit.spawnPosition,
      this.circuit.spawnQuaternion
    );

    // Audio must wait for a user gesture; arm on the first key press.
    const armAudio = () => {
      this.audio.init();
      window.removeEventListener("keydown", armAudio);
      window.removeEventListener("pointerdown", armAudio);
    };
    window.addEventListener("keydown", armAudio);
    window.addEventListener("pointerdown", armAudio);
  }

  start() {
    this.running = true;
    this.clock.start();
    requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
  }

  onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.cameraCtrl.setAspect(w / h);
  }

  private tick = () => {
    if (!this.running) return;
    const dt = Math.min(0.1, this.clock.getDelta());

    // ---- Fixed-step physics & car update -------------------------------
    this.physics.step(dt, (fixedDt) => {
      this.car.update(fixedDt, this.input);
    });

    // ---- Sync visual transforms ----------------------------------------
    this.car.syncVisual();

    // ---- Camera --------------------------------------------------------
    this.cameraCtrl.update(dt, this.car.position, this.car.orientation, this.car.speedKmh);

    // ---- Lap detection -------------------------------------------------
    const lapEvent = this.lapSystem.update(dt, this.car.position);
    if (lapEvent === "lap") {
      this.ui.showToast(
        this.lapSystem.lap > this.lapSystem.totalLaps ? "RACE COMPLETE" : "LAP +1",
        1.5
      );
    }

    // ---- Track limits & off-track grip / auto-reset --------------------
    const offDist = this.circuit.distanceOffTrack(
      this.car.position.x,
      this.car.position.z
    );
    this.car.trackLimitsTick(dt, offDist, () => {
      this.resetCar();
      this.ui.showToast("TRACK LIMITS — RESET", 1.4);
    });

    // ---- Manual reset --------------------------------------------------
    if (this.input.reset) {
      this.resetCar();
      this.ui.showToast("RESET", 1.0);
    }

    // ---- Audio ---------------------------------------------------------
    this.audio.update(dt, this.car.speedKmh, this.car.rpm01 * (this.input.throttle > 0 ? 1 : 0.4) + (this.input.throttle > 0 ? 0.3 : 0));

    // ---- HUD -----------------------------------------------------------
    this.ui.update(dt, {
      speedKmh: this.car.speedKmh,
      rpm01: this.car.rpm01,
      gear: this.car.gearLabel,
      lap: this.lapSystem.lap,
      totalLaps: this.lapSystem.totalLaps,
      currentLapMs: this.lapSystem.currentLapMs,
      bestLapMs: this.lapSystem.bestLapMs,
      lastLapMs: this.lapSystem.lastLapMs,
      checkpoints: this.lapSystem.checkpoints.map((c) => ({ hit: c.hit })),
      drsArmed: this.car.drsArmed,
      drsActive: this.car.drsActive,
    });

    // ---- Render --------------------------------------------------------
    this.renderer.render(this.scene, this.cameraCtrl.camera);

    this.input.endFrame();
    requestAnimationFrame(this.tick);
  };

  private resetCar() {
    this.car.resetTo(this.circuit.spawnPosition, this.circuit.spawnQuaternion);
    this.cameraCtrl.snapTo(this.circuit.spawnPosition, this.circuit.spawnQuaternion);
  }
}
