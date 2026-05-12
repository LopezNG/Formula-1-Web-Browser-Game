import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { Physics } from "./Physics";
import type { Input } from "./Input";

interface Wheel {
  /** Local position on the chassis where the suspension top attaches. */
  anchorLocal: THREE.Vector3;
  isFront: boolean;
  isPowered: boolean;
  radius: number;
  restLength: number;
  /** Last frame's suspension extension (distance from anchor to ground − wheelRadius). */
  lastExtension: number;
  /** Visual mesh group (wheel + brake disc). */
  visual: THREE.Group;
  /** Cumulative rotation around the wheel axle (used to roll the visual mesh). */
  rollAngle: number;
  /** Whether the wheel was grounded last update. */
  grounded: boolean;
}

/**
 * F1-style player car.
 *
 * Physics model: a single dynamic Rapier rigid body for the chassis, plus four
 * raycast wheels that compute suspension forces, drive forces, and lateral grip
 * impulses each fixed-step. Strong downforce keeps the car planted at speed,
 * and the handbrake slashes rear grip for controllable slides.
 */
export class F1Car {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;

  readonly group: THREE.Group;
  readonly wheels: Wheel[] = [];

  // -- Tunable F1 parameters (metric) --------------------------------------
  readonly mass = 740; // ~F1 minimum weight (incl. driver)
  readonly maxEngineForce = 16500; // Newtons at one wheel
  readonly maxBrakeForce = 22000;
  readonly maxSpeedKmh = 340;
  readonly maxSteer = 0.55; // ~31°
  readonly steerSpeedFalloff = 0.65; // higher = steering tightens slower with speed
  readonly downforceCoefficient = 9.5; // F = k * v^2 (in N), v in m/s
  readonly drsBoostForce = 5500;
  readonly drsMinSpeedKmh = 180;
  readonly resetGripFront = 95; // lateral grip strength multiplier
  readonly resetGripRear = 90;
  readonly handbrakeRearGrip = 18;
  readonly lowSpeedSteerAssist = 8500;

  // -- Dynamic state -------------------------------------------------------
  private smoothedSteer = 0;
  private steerTarget = 0;
  private throttle = 0;
  private brake = 0;
  private handbrake = false;
  drsActive = false;
  private offTrackTimer = 0;

  /** Derived each frame for the HUD/audio. */
  speedKmh = 0;
  rpm01 = 0;
  isReversing = false;
  drsArmed = false;

  /** Provided to the chassis physics body so the camera can use the same transform. */
  readonly tmpPos = new THREE.Vector3();
  readonly tmpQuat = new THREE.Quaternion();

  constructor(
    private scene: THREE.Scene,
    private physics: Physics,
    spawnPos: THREE.Vector3,
    spawnQuat: THREE.Quaternion
  ) {
    // ---- Visual ---------------------------------------------------------
    this.group = this.buildVisual();
    this.scene.add(this.group);

    // ---- Rigid body & chassis collider ---------------------------------
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnPos.x, spawnPos.y, spawnPos.z)
      .setRotation({
        x: spawnQuat.x,
        y: spawnQuat.y,
        z: spawnQuat.z,
        w: spawnQuat.w,
      })
      .setLinearDamping(0.08)
      .setAngularDamping(2.0)
      .enabledRotations(false, true, false)
      .setCcdEnabled(true);
    this.body = this.physics.world.createRigidBody(bodyDesc);

    // Chassis half-extents (m). Long, flat, narrow.
    const HX = 0.95;
    const HY = 0.32;
    const HZ = 2.4;
    const colDesc = RAPIER.ColliderDesc.cuboid(HX, HY, HZ)
      .setDensity(this.mass / (HX * 2 * HY * 2 * HZ * 2))
      .setFriction(0.4)
      .setRestitution(0.05);
    this.collider = this.physics.world.createCollider(colDesc, this.body);

    // ---- Wheels ---------------------------------------------------------
    // Anchor positions are in chassis local space. Y is slightly above the
    // chassis bottom so the suspension rest length lets the tires touch the ground.
    const wheelRadius = 0.36;
    const restLen = 0.45;
    const wheelLayout: { x: number; z: number; front: boolean; powered: boolean }[] = [
      { x: -0.85, z: 1.55, front: true, powered: false },
      { x: 0.85, z: 1.55, front: true, powered: false },
      { x: -0.95, z: -1.55, front: false, powered: true },
      { x: 0.95, z: -1.55, front: false, powered: true },
    ];
    for (const w of wheelLayout) {
      const visual = this.buildWheelVisual(wheelRadius, w.front);
      this.scene.add(visual);
      this.wheels.push({
        anchorLocal: new THREE.Vector3(w.x, -0.05, w.z),
        isFront: w.front,
        isPowered: w.powered,
        radius: wheelRadius,
        restLength: restLen,
        lastExtension: restLen,
        visual,
        rollAngle: 0,
        grounded: false,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Visual construction
  // ---------------------------------------------------------------------------

  private buildVisual(): THREE.Group {
    const group = new THREE.Group();

    // Livery: fictional team "Apex Velocity" — crimson with silver accents.
    const liveryMain = new THREE.MeshStandardMaterial({
      color: 0xc4112f,
      roughness: 0.35,
      metalness: 0.4,
    });
    const liveryDark = new THREE.MeshStandardMaterial({
      color: 0x1a1a22,
      roughness: 0.3,
      metalness: 0.6,
    });
    const liveryAccent = new THREE.MeshStandardMaterial({
      color: 0xc0c8d4,
      roughness: 0.3,
      metalness: 0.7,
    });

    // Main monocoque (low + long).
    const chassis = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.45, 3.4),
      liveryMain
    );
    chassis.position.y = 0.05;
    chassis.castShadow = true;
    group.add(chassis);

    // Sidepods.
    const sidepodGeom = new THREE.BoxGeometry(0.45, 0.32, 1.7);
    [-0.9, 0.9].forEach((x) => {
      const pod = new THREE.Mesh(sidepodGeom, liveryMain);
      pod.position.set(x, 0.0, 0.1);
      pod.castShadow = true;
      group.add(pod);
    });

    // Engine cover & airbox.
    const cover = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.55, 1.6),
      liveryMain
    );
    cover.position.set(0, 0.4, -0.7);
    cover.castShadow = true;
    group.add(cover);

    const airbox = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.4, 0.55),
      liveryDark
    );
    airbox.position.set(0, 0.7, 0.05);
    airbox.castShadow = true;
    group.add(airbox);

    // Cockpit recess (subtle dark inset).
    const cockpit = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.18, 0.7),
      liveryDark
    );
    cockpit.position.set(0, 0.38, 0.4);
    group.add(cockpit);

    // Halo (simplified: a flat torus arc above the cockpit).
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.05, 8, 24, Math.PI),
      liveryDark
    );
    halo.position.set(0, 0.62, 0.4);
    halo.rotation.x = Math.PI / 2;
    halo.rotation.z = Math.PI;
    halo.castShadow = true;
    group.add(halo);

    // Nose cone — tapered tip (cone scaled to flatten).
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 1.6, 4, 1),
      liveryMain
    );
    nose.rotation.x = Math.PI / 2;
    nose.rotation.z = Math.PI / 4;
    nose.scale.set(1, 1, 0.55);
    nose.position.set(0, 0.05, 2.05);
    nose.castShadow = true;
    group.add(nose);

    // Front wing.
    const fwMain = new THREE.Mesh(
      new THREE.BoxGeometry(2.0, 0.06, 0.55),
      liveryDark
    );
    fwMain.position.set(0, -0.05, 2.55);
    fwMain.castShadow = true;
    group.add(fwMain);
    [-0.9, 0.9].forEach((x) => {
      const endplate = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.3, 0.55),
        liveryAccent
      );
      endplate.position.set(x, 0.05, 2.55);
      endplate.castShadow = true;
      group.add(endplate);
    });

    // Rear wing.
    const rwMain = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.08, 0.45),
      liveryDark
    );
    rwMain.position.set(0, 0.85, -2.0);
    rwMain.castShadow = true;
    group.add(rwMain);
    [-0.55, 0.55].forEach((x) => {
      const endplate = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.55, 0.55),
        liveryAccent
      );
      endplate.position.set(x, 0.65, -2.0);
      endplate.castShadow = true;
      group.add(endplate);
    });
    const rwPillar = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.5, 0.2),
      liveryDark
    );
    rwPillar.position.set(0, 0.55, -2.0);
    group.add(rwPillar);

    // Diffuser hint.
    const diff = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.18, 0.4),
      liveryDark
    );
    diff.position.set(0, -0.1, -1.85);
    group.add(diff);

    // Number/sponsor decal on the airbox (dynamic canvas texture).
    const decalCanvas = document.createElement("canvas");
    decalCanvas.width = 128;
    decalCanvas.height = 64;
    const dctx = decalCanvas.getContext("2d")!;
    dctx.fillStyle = "#c0c8d4";
    dctx.fillRect(0, 0, 128, 64);
    dctx.fillStyle = "#c4112f";
    dctx.font = "bold 48px sans-serif";
    dctx.textAlign = "center";
    dctx.textBaseline = "middle";
    dctx.fillText("07", 64, 36);
    const decalTex = new THREE.CanvasTexture(decalCanvas);
    decalTex.colorSpace = THREE.SRGBColorSpace;
    const decal = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.25),
      new THREE.MeshBasicMaterial({ map: decalTex, transparent: true })
    );
    decal.position.set(0, 0.93, 0.05);
    decal.rotation.x = -Math.PI / 8;
    group.add(decal);

    return group;
  }

  private buildWheelVisual(radius: number, _isFront: boolean): THREE.Group {
    const wheel = new THREE.Group();
    const tireMat = new THREE.MeshStandardMaterial({
      color: 0x0e0e10,
      roughness: 0.95,
    });
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0xb0b6c0,
      roughness: 0.4,
      metalness: 0.7,
    });

    const tire = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius, 0.32, 24),
      tireMat
    );
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    wheel.add(tire);

    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.55, radius * 0.55, 0.34, 16),
      rimMat
    );
    rim.rotation.z = Math.PI / 2;
    wheel.add(rim);

    return wheel;
  }

  // ---------------------------------------------------------------------------
  // Per-step physics update
  // ---------------------------------------------------------------------------

  /** Called from Game on every fixed physics step. */
  update(dt: number, input: Input) {
    this.consumeInputs(input, dt);
    this.applyForces(dt);
  }

  private consumeInputs(input: Input, dt: number) {
    this.throttle = input.throttle;
    this.brake = input.brake;
    this.handbrake = input.handbrake;

    // Speed-sensitive steering: allow large angles at low speed, reduce at high speed.
    const speedFactor = Math.max(
      0.35,
      1 - (this.speedKmh / this.maxSpeedKmh) * (1 - this.steerSpeedFalloff)
    );
    this.steerTarget = input.steer * this.maxSteer * speedFactor;

    // Smooth the steering input (prevent twitchy direction changes).
    const k = 1 - Math.exp(-dt * 12);
    this.smoothedSteer += (this.steerTarget - this.smoothedSteer) * k;

    // DRS: only available above the threshold AND actively requested.
    this.drsArmed = this.speedKmh >= this.drsMinSpeedKmh;
    this.drsActive = this.drsArmed && input.boost;
  }

  private applyForces(dt: number) {
    const body = this.body;
    // Rapier keeps user-added forces/torques until they are explicitly reset.
    // The car controller rebuilds suspension, aero, engine, and drag forces
    // every fixed step, so clear the previous step first to prevent force
    // accumulation from launching the chassis.
    body.resetForces(true);
    body.resetTorques(true);
    body.setAngularDamping(2.0);
    body.setEnabledRotations(false, true, false, true);
    this.keepChassisUpright();

    const t = body.translation();
    const q = body.rotation();
    const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w);
    const pos = new THREE.Vector3(t.x, t.y, t.z);

    const forwardWorld = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
    const rightWorld = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
    const upWorld = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);

    const linvel = body.linvel();
    const angvel = body.angvel();
    const velVec = new THREE.Vector3(linvel.x, linvel.y, linvel.z);
    const angVec = new THREE.Vector3(angvel.x, angvel.y, angvel.z);

    const forwardSpeed = velVec.dot(forwardWorld);
    this.speedKmh = forwardSpeed * 3.6;
    this.isReversing = forwardSpeed < -0.5;
    this.rpm01 = Math.min(1, Math.abs(forwardSpeed) / (this.maxSpeedKmh / 3.6));

    let groundedCount = 0;
    let frontGroundedCount = 0;

    for (const wheel of this.wheels) {
      // World-space anchor at the top of the suspension.
      const anchorWorld = wheel.anchorLocal.clone().applyQuaternion(quat).add(pos);

      // Cast a ray from the anchor downward (along world -Y) through the wheel radius
      // plus the suspension travel.
      const maxToi = wheel.radius + wheel.restLength + 0.4;
      const hit = this.physics.rayCast(
        anchorWorld,
        { x: 0, y: -1, z: 0 },
        maxToi,
        this.collider
      );
      if (!hit) {
        wheel.grounded = false;
        wheel.lastExtension = wheel.restLength;
        // Even airborne, the wheel keeps rolling visually.
        wheel.rollAngle += forwardSpeed * dt;
        this.updateWheelVisual(wheel, anchorWorld, quat);
        continue;
      }
      wheel.grounded = true;
      groundedCount++;
      if (wheel.isFront) frontGroundedCount++;

      const contactDistance = hit.toi; // distance from anchor to ground
      const extension = Math.max(0, contactDistance - wheel.radius);
      const compression = wheel.restLength - extension;

      // Vertical velocity at the wheel anchor for damping (positive = compressing).
      const armWorld = anchorWorld.clone().sub(pos);
      const velAtAnchor = velVec.clone().add(angVec.clone().cross(armWorld));
      const verticalVel = velAtAnchor.y;

      // Suspension force along world up.
      const stiffness = 60000; // N/m
      const damping = 4500; // N·s/m
      const suspensionForce = Math.max(
        0,
        compression * stiffness - verticalVel * damping
      );
      // Apply force at the anchor world position.
      this.applyForceAtPoint(
        new THREE.Vector3(0, suspensionForce, 0),
        anchorWorld
      );

      // Compute the contact point (used for drive/brake/grip impulses).
      const contactPoint = anchorWorld
        .clone()
        .add(new THREE.Vector3(0, -contactDistance, 0));

      // Wheel right axis (world space) — front wheels rotate by smoothedSteer around up.
      const wheelRight = wheel.isFront
        ? rightWorld.clone().applyAxisAngle(upWorld, this.smoothedSteer)
        : rightWorld.clone();
      const wheelForward = wheel.isFront
        ? forwardWorld.clone().applyAxisAngle(upWorld, this.smoothedSteer)
        : forwardWorld.clone();

      const velAtContact = velVec
        .clone()
        .add(angVec.clone().cross(contactPoint.clone().sub(pos)));
      const fwdVel = velAtContact.dot(wheelForward);
      const latVel = velAtContact.dot(wheelRight);

      // ---- Lateral grip ------------------------------------------------
      // Grip "wants" to zero out the lateral velocity at this wheel.
      let grip = wheel.isFront ? this.resetGripFront : this.resetGripRear;
      if (this.handbrake && !wheel.isFront) grip = this.handbrakeRearGrip;
      // Reduce grip slightly at very high lateral velocity to allow drift.
      const slipReduction = Math.min(1, Math.abs(latVel) / 18);
      grip *= 1 - 0.55 * slipReduction;

      const gripResponse = 1 - Math.exp(-grip * dt);
      const gripImpulse = wheelRight
        .clone()
        .multiplyScalar(-latVel * (this.mass / 4) * gripResponse);
      this.applyImpulseAtPoint(gripImpulse, contactPoint);

      // ---- Engine force -----------------------------------------------
      if (wheel.isPowered) {
        // Throttle: forward when going forward / from rest; reverse when S held while ~stopped.
        let drive = 0;
        if (this.throttle > 0) {
          // Power curve: less force as we approach top speed.
          const tNorm = Math.max(
            0,
            1 - Math.max(0, fwdVel) / (this.maxSpeedKmh / 3.6)
          );
          drive = this.throttle * this.maxEngineForce * tNorm;
        } else if (this.brake > 0 && fwdVel > -8) {
          // S is brake while moving forward, then becomes reverse once nearly stopped.
          if (fwdVel < 0.5) {
            drive = -this.brake * this.maxEngineForce * 0.5;
          }
        }
        if (drive !== 0) {
          const driveForce = wheelForward.clone().multiplyScalar(drive);
          this.applyForceAtPoint(driveForce, contactPoint);
        }
      }

      // ---- Brake force -------------------------------------------------
      if (this.brake > 0 && fwdVel > 0.5) {
        const brakeForce = wheelForward
          .clone()
          .multiplyScalar(-this.brake * this.maxBrakeForce * 0.25);
        this.applyForceAtPoint(brakeForce, contactPoint);
      }
      // Implicit rolling resistance: slight drag when not on throttle.
      if (this.throttle === 0 && this.brake === 0) {
        const drag = wheelForward.clone().multiplyScalar(-fwdVel * 80);
        this.applyForceAtPoint(drag, contactPoint);
      }

      // Update wheel visual roll based on forward velocity.
      wheel.rollAngle -= fwdVel * dt;
      wheel.lastExtension = extension;
      this.updateWheelVisual(wheel, anchorWorld, quat);
    }

    // ---- Whole-chassis forces ------------------------------------------
    // Aerodynamic downforce: large pushdown that scales with speed^2.
    if (groundedCount > 0) {
      const speed = velVec.length();
      const downforce = -this.downforceCoefficient * speed * speed;
      this.applyForceAtPoint(
        new THREE.Vector3(0, downforce, 0),
        pos.clone().add(forwardWorld.clone().multiplyScalar(0.5))
      );
    }

    // The tire impulses above do the real steering once the car is moving.
    // This assist gives the chassis enough yaw authority at launch/low speed
    // so A/D and arrow steering feel responsive instead of waiting for speed.
    if (frontGroundedCount > 0 && Math.abs(this.smoothedSteer) > 0.001) {
      const speedAssist = THREE.MathUtils.clamp(Math.abs(forwardSpeed) / 18, 0.25, 1);
      const steeringTorque = upWorld
        .clone()
        .multiplyScalar(this.smoothedSteer * this.lowSpeedSteerAssist * speedAssist);
      body.addTorque(
        { x: steeringTorque.x, y: steeringTorque.y, z: steeringTorque.z },
        true
      );
    }

    // DRS / boost: extra forward thrust on top of engine when armed and held.
    if (this.drsActive) {
      const boost = forwardWorld.clone().multiplyScalar(this.drsBoostForce);
      this.applyForceAtPoint(boost, pos);
    }

    // Air drag: light quadratic drag on the chassis CoM.
    const speedMag = velVec.length();
    if (speedMag > 0.5) {
      const dragCoef = 4.5;
      const drag = velVec
        .clone()
        .multiplyScalar(-dragCoef * speedMag);
      this.applyForceAtPoint(drag, pos);
    }
  }

  /** Move the wheel mesh to its current world transform (anchor + extension + roll + steer). */
  private updateWheelVisual(
    wheel: Wheel,
    anchorWorld: THREE.Vector3,
    chassisQuat: THREE.Quaternion
  ) {
    const downWorld = new THREE.Vector3(0, -1, 0);
    const wheelPos = anchorWorld
      .clone()
      .add(downWorld.multiplyScalar(wheel.lastExtension));
    wheel.visual.position.copy(wheelPos);

    // Build the wheel orientation: chassis × steer (front only) × roll around X axis.
    const wq = chassisQuat.clone();
    if (wheel.isFront) {
      const steerQ = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        this.smoothedSteer
      );
      wq.multiply(steerQ);
    }
    const rollQ = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      wheel.rollAngle
    );
    wq.multiply(rollQ);
    wheel.visual.quaternion.copy(wq);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private applyForceAtPoint(force: THREE.Vector3, point: THREE.Vector3) {
    this.body.addForceAtPoint(
      { x: force.x, y: force.y, z: force.z },
      { x: point.x, y: point.y, z: point.z },
      true
    );
  }

  private applyImpulseAtPoint(impulse: THREE.Vector3, point: THREE.Vector3) {
    this.body.applyImpulseAtPoint(
      { x: impulse.x, y: impulse.y, z: impulse.z },
      { x: point.x, y: point.y, z: point.z },
      true
    );
  }

  /** Sync the visual chassis to the rigid body. Called every render frame. */
  syncVisual() {
    const t = this.body.translation();
    const q = this.body.rotation();
    this.group.position.set(t.x, t.y, t.z);
    this.group.quaternion.set(q.x, q.y, q.z, q.w);
    this.tmpPos.set(t.x, t.y, t.z);
    this.tmpQuat.set(q.x, q.y, q.z, q.w);
  }

  /** Teleport the car back to a known-good pose with zero velocity. */
  resetTo(pos: THREE.Vector3, quat: THREE.Quaternion) {
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    this.body.setRotation(
      { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
      true
    );
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.resetForces(true);
    this.body.resetTorques(true);
    this.body.setAngularDamping(2.0);
    this.body.setEnabledRotations(false, true, false, true);
    this.smoothedSteer = 0;
    this.steerTarget = 0;
    this.offTrackTimer = 0;
  }

  /** Keep the physics chassis upright while preserving its current heading. */
  private keepChassisUpright() {
    const q = this.body.rotation();
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(
      new THREE.Quaternion(q.x, q.y, q.z, q.w)
    );
    forward.y = 0;
    if (forward.lengthSq() < 0.0001) return;

    const yaw = Math.atan2(forward.x, forward.z);
    const upright = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      yaw
    );
    this.body.setRotation(
      { x: upright.x, y: upright.y, z: upright.z, w: upright.w },
      true
    );
  }

  /** Off-track detection and auto-recovery. Called from Game with the circuit reference. */
  trackLimitsTick(dt: number, offDistance: number, onAutoReset: () => void) {
    if (offDistance > 1.0) {
      this.offTrackTimer += dt;
      if (this.offTrackTimer > 3.0) {
        this.offTrackTimer = 0;
        onAutoReset();
      }
    } else {
      this.offTrackTimer = Math.max(0, this.offTrackTimer - dt);
    }
  }

  /** Convenience for the audio module / camera. */
  get position(): THREE.Vector3 {
    return this.tmpPos;
  }
  get orientation(): THREE.Quaternion {
    return this.tmpQuat;
  }
  get gearLabel(): string {
    if (this.isReversing) return "R";
    if (Math.abs(this.speedKmh) < 1) return "N";
    // Simulated gear box: pick a gear from speed for HUD flavor.
    const gears = [40, 90, 140, 190, 240, 290, this.maxSpeedKmh + 1];
    for (let i = 0; i < gears.length; i++) {
      if (Math.abs(this.speedKmh) < gears[i]) return `${i + 1}`;
    }
    return "8";
  }
}
