import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import type { Physics } from "./Physics";
import type { Checkpoint } from "./LapSystem";

type TrackSample = { p: THREE.Vector3; t: THREE.Vector3; n: THREE.Vector3 };

interface TrackIntersection {
  offset: number;
  aIndex: number;
  bIndex: number;
}

/**
 * The Circuit owns:
 *   1. A parametric closed centerline (Catmull-Rom) defining the racing line.
 *   2. The asphalt mesh (triangle strip) plus painted lines and start/finish stripe.
 *   3. Painted red/white curbs at high-curvature points.
 *   4. Visual + physics barriers along the outer (and selectively inner) edges.
 *   5. Decorative grandstands, pit wall, sponsor boards, tire stacks.
 *   6. Lap-system checkpoints distributed around the loop.
 *   7. A helper to test "is this world position on the asphalt?".
 */
export class Circuit {
  readonly trackWidth = 14;
  readonly samples: TrackSample[];
  readonly curve: THREE.CatmullRomCurve3;
  readonly checkpoints: Checkpoint[] = [];
  /** Pose for spawning the player at the start line. */
  readonly spawnPosition: THREE.Vector3;
  readonly spawnQuaternion: THREE.Quaternion;

  constructor(
    private scene: THREE.Scene,
    private physics: Physics
  ) {
    // Hand-tuned waypoints for an interesting GP-style layout: a long main straight,
    // fast esses, a long sweeping right, hairpin, back straight, chicane, final loop.
    const waypoints: [number, number][] = [
      [0, 0],
      [0, 90],
      [0, 180],
      [20, 240],
      [80, 280],
      [150, 270],
      [220, 220],
      [260, 140],
      [240, 70],
      [190, 20],
      [120, 0],
      [80, -50],
      [20, -80],
      [-60, -70],
      [-130, -35],
      [-150, 30],
      [-110, 75],
      [-70, 45],
      [-50, -5],
      [-20, -35],
      [5, -20],
    ];

    const points = waypoints.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.curve = new THREE.CatmullRomCurve3(points, true, "centripetal");

    const SAMPLES = 480;
    this.samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const u = i / SAMPLES;
      const p = this.curve.getPointAt(u);
      const t = this.curve.getTangentAt(u).normalize();
      // Side normal: tangent rotated 90° around world up, pointing to track right.
      const n = new THREE.Vector3(t.z, 0, -t.x).normalize();
      this.samples.push({ p, t, n });
    }
    this.validateTrackDoesNotOverlap();

    this.spawnPosition = this.samples[2].p
      .clone()
      .add(new THREE.Vector3(0, 1.0, 0));
    // Face along the tangent at the spawn sample (start of main straight).
    this.spawnQuaternion = new THREE.Quaternion();
    const t0 = this.samples[2].t;
    const yaw = Math.atan2(t0.x, t0.z);
    this.spawnQuaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

    this.buildGround();
    this.buildTrackSurface();
    this.buildCurbs();
    this.buildBarriers();
    this.buildStartFinish();
    this.buildScenery();
    this.buildCheckpoints();
  }

  private validateTrackDoesNotOverlap() {
    const half = this.trackWidth / 2;
    const barrierOffset = half + 2.5;
    const intersections = this.findTrackIntersections([
      0,
      half,
      -half,
      barrierOffset,
      -barrierOffset,
    ]);

    if (intersections.length === 0) return;

    const first = intersections[0];
    throw new Error(
      `Invalid circuit geometry: offset ${first.offset} intersects between samples ${first.aIndex} and ${first.bIndex}.`
    );
  }

  private findTrackIntersections(offsets: number[]): TrackIntersection[] {
    const intersections: TrackIntersection[] = [];
    const N = this.samples.length;
    const localSegmentSkip = 4;

    for (const offset of offsets) {
      for (let i = 0; i < N; i++) {
        const a1 = this.offsetSamplePoint(i, offset);
        const a2 = this.offsetSamplePoint((i + 1) % N, offset);

        for (let j = i + 1; j < N; j++) {
          const separation = Math.abs(i - j);
          if (
            separation <= localSegmentSkip ||
            separation >= N - localSegmentSkip
          ) {
            continue;
          }

          const b1 = this.offsetSamplePoint(j, offset);
          const b2 = this.offsetSamplePoint((j + 1) % N, offset);
          if (Circuit.segmentsIntersect2D(a1, a2, b1, b2)) {
            intersections.push({ offset, aIndex: i, bIndex: j });
          }
        }
      }
    }

    return intersections;
  }

  private offsetSamplePoint(index: number, offset: number) {
    const s = this.samples[index];
    return new THREE.Vector2(
      s.p.x + s.n.x * offset,
      s.p.z + s.n.z * offset
    );
  }

  private static segmentsIntersect2D(
    a: THREE.Vector2,
    b: THREE.Vector2,
    c: THREE.Vector2,
    d: THREE.Vector2
  ) {
    const epsilon = 1e-6;
    const abC = Circuit.orientation2D(a, b, c);
    const abD = Circuit.orientation2D(a, b, d);
    const cdA = Circuit.orientation2D(c, d, a);
    const cdB = Circuit.orientation2D(c, d, b);

    if (Math.abs(abC) < epsilon && Circuit.pointOnSegment2D(a, b, c)) return true;
    if (Math.abs(abD) < epsilon && Circuit.pointOnSegment2D(a, b, d)) return true;
    if (Math.abs(cdA) < epsilon && Circuit.pointOnSegment2D(c, d, a)) return true;
    if (Math.abs(cdB) < epsilon && Circuit.pointOnSegment2D(c, d, b)) return true;

    return abC * abD < 0 && cdA * cdB < 0;
  }

  private static orientation2D(
    a: THREE.Vector2,
    b: THREE.Vector2,
    c: THREE.Vector2
  ) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  private static pointOnSegment2D(
    a: THREE.Vector2,
    b: THREE.Vector2,
    p: THREE.Vector2
  ) {
    const epsilon = 1e-6;
    return (
      p.x >= Math.min(a.x, b.x) - epsilon &&
      p.x <= Math.max(a.x, b.x) + epsilon &&
      p.y >= Math.min(a.y, b.y) - epsilon &&
      p.y <= Math.max(a.y, b.y) + epsilon
    );
  }

  // ---------------------------------------------------------------------------
  // Surface building
  // ---------------------------------------------------------------------------

  private buildGround() {
    // Visual grass plane.
    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(2000, 2000),
      new THREE.MeshStandardMaterial({
        color: 0x2f6b2a,
        roughness: 1,
        metalness: 0,
      })
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -0.02;
    grass.receiveShadow = true;
    this.scene.add(grass);

    // Static physics ground: a thin huge cuboid whose top sits at y=0.
    const groundDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0);
    const groundBody = this.physics.world.createRigidBody(groundDesc);
    const groundCol = RAPIER.ColliderDesc.cuboid(1000, 0.5, 1000)
      .setFriction(1.2)
      .setRestitution(0.05);
    this.physics.world.createCollider(groundCol, groundBody);
  }

  private buildTrackSurface() {
    const N = this.samples.length;
    const positions: number[] = [];
    const indices: number[] = [];
    const uvs: number[] = [];
    const half = this.trackWidth / 2;

    for (let i = 0; i < N; i++) {
      const s = this.samples[i];
      const left = s.p.clone().add(s.n.clone().multiplyScalar(-half));
      const right = s.p.clone().add(s.n.clone().multiplyScalar(half));
      // Tiny lift to prevent z-fighting with the grass.
      const y = 0.01;
      positions.push(left.x, y, left.z);
      positions.push(right.x, y, right.z);
      uvs.push(0, i / 8);
      uvs.push(1, i / 8);
    }
    for (let i = 0; i < N; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = ((i + 1) % N) * 2;
      const d = ((i + 1) % N) * 2 + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const trackMat = new THREE.MeshStandardMaterial({
      color: 0x2a2c30,
      roughness: 0.95,
      metalness: 0,
    });
    const trackMesh = new THREE.Mesh(geom, trackMat);
    trackMesh.receiveShadow = true;
    this.scene.add(trackMesh);

    // Painted edge lines (white)
    this.buildEdgeLine(half - 0.25, 0xffffff);
    this.buildEdgeLine(-(half - 0.25), 0xffffff);
    // Subtle dashed center reference (very dark gray) — purely visual aid.
    this.buildCenterDashes();
  }

  private buildEdgeLine(offset: number, color: number) {
    const N = this.samples.length;
    const positions: number[] = [];
    const indices: number[] = [];
    const lineHalfWidth = 0.18;
    for (let i = 0; i < N; i++) {
      const s = this.samples[i];
      const center = s.p.clone().add(s.n.clone().multiplyScalar(offset));
      const inner = center.clone().add(s.n.clone().multiplyScalar(-lineHalfWidth));
      const outer = center.clone().add(s.n.clone().multiplyScalar(lineHalfWidth));
      const y = 0.02;
      positions.push(inner.x, y, inner.z);
      positions.push(outer.x, y, outer.z);
    }
    for (let i = 0; i < N; i++) {
      const a = i * 2;
      const b = i * 2 + 1;
      const c = ((i + 1) % N) * 2;
      const d = ((i + 1) % N) * 2 + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geom, mat);
    this.scene.add(mesh);
  }

  private buildCenterDashes() {
    const dashGeom = new THREE.PlaneGeometry(0.2, 1.5);
    const dashMat = new THREE.MeshBasicMaterial({ color: 0x404040 });
    const N = this.samples.length;
    for (let i = 0; i < N; i += 6) {
      const s = this.samples[i];
      const m = new THREE.Mesh(dashGeom, dashMat);
      m.position.copy(s.p);
      m.position.y = 0.025;
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = -Math.atan2(s.t.x, s.t.z);
      this.scene.add(m);
    }
  }

  // ---------------------------------------------------------------------------
  // Curbs
  // ---------------------------------------------------------------------------

  private buildCurbs() {
    const N = this.samples.length;
    const half = this.trackWidth / 2;
    const curbWidth = 1.3;
    const segLen = 1.6; // length of one red/white block

    // Detect curvature by comparing tangents of adjacent samples.
    for (let i = 0; i < N; i++) {
      const a = this.samples[i].t;
      const b = this.samples[(i + 1) % N].t;
      // Cross-product Y component is signed curvature (positive = right turn).
      const curl = a.x * b.z - a.z * b.x;
      if (Math.abs(curl) < 0.018) continue;

      const insideSign = curl > 0 ? 1 : -1; // inside of the corner
      const s = this.samples[i];
      const sNext = this.samples[(i + 1) % N];
      const center = s.p
        .clone()
        .lerp(sNext.p, 0.5)
        .add(s.n.clone().multiplyScalar(insideSign * (half + curbWidth / 2)));

      const segment = new THREE.Mesh(
        new THREE.BoxGeometry(curbWidth, 0.12, segLen),
        new THREE.MeshStandardMaterial({
          color: i % 2 === 0 ? 0xff3030 : 0xffffff,
          roughness: 0.7,
        })
      );
      segment.position.copy(center);
      segment.position.y = 0.06;
      segment.rotation.y = -Math.atan2(s.t.x, s.t.z);
      segment.receiveShadow = true;
      this.scene.add(segment);
    }
  }

  // ---------------------------------------------------------------------------
  // Barriers (visual + physics)
  // ---------------------------------------------------------------------------

  private buildBarriers() {
    const N = this.samples.length;
    const half = this.trackWidth / 2;
    const barrierOffset = half + 2.5;
    const barrierHeight = 1.2;
    const sponsorPalette = [0x1f8efa, 0xfa1f4b, 0xfac81f, 0x1ffaa3, 0xa31ffa];

    const buildSide = (sign: number, sponsorEvery: number) => {
      const segCount = Math.floor(N / 2);
      for (let i = 0; i < segCount; i++) {
        const idx = i * 2;
        const s = this.samples[idx % N];
        const sNext = this.samples[(idx + 2) % N];
        const aPos = s.p
          .clone()
          .add(s.n.clone().multiplyScalar(sign * barrierOffset));
        const bPos = sNext.p
          .clone()
          .add(sNext.n.clone().multiplyScalar(sign * barrierOffset));
        const mid = aPos.clone().lerp(bPos, 0.5);
        const dir = bPos.clone().sub(aPos);
        const len = dir.length();
        const yaw = Math.atan2(dir.x, dir.z);

        const isSponsor = i % sponsorEvery === 0;
        const color = isSponsor
          ? sponsorPalette[i % sponsorPalette.length]
          : 0xffffff;
        const mat = new THREE.MeshStandardMaterial({
          color,
          roughness: 0.4,
          metalness: 0.05,
        });
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.4, barrierHeight, len),
          mat
        );
        mesh.position.set(mid.x, barrierHeight / 2, mid.z);
        mesh.rotation.y = yaw;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);

        // Physics: a thin tall cuboid using the same transform.
        const bodyDesc = RAPIER.RigidBodyDesc.fixed()
          .setTranslation(mid.x, barrierHeight / 2, mid.z)
          .setRotation({
            x: 0,
            y: Math.sin(yaw / 2),
            z: 0,
            w: Math.cos(yaw / 2),
          });
        const body = this.physics.world.createRigidBody(bodyDesc);
        const colDesc = RAPIER.ColliderDesc.cuboid(0.2, barrierHeight / 2, len / 2)
          .setFriction(0.4)
          .setRestitution(0.2);
        this.physics.world.createCollider(colDesc, body);
      }
    };

    buildSide(+1, 4); // outer
    buildSide(-1, 6); // inner

    // Tire stacks at a few sharp apexes for added flavor.
    this.buildTireStacks();
  }

  private buildTireStacks() {
    const N = this.samples.length;
    const half = this.trackWidth / 2;
    const tireMat = new THREE.MeshStandardMaterial({
      color: 0x101010,
      roughness: 0.9,
    });
    const tireGeom = new THREE.CylinderGeometry(0.4, 0.4, 0.35, 16);

    for (let i = 0; i < N; i += 4) {
      const a = this.samples[i].t;
      const b = this.samples[(i + 2) % N].t;
      const curl = a.x * b.z - a.z * b.x;
      if (Math.abs(curl) < 0.05) continue;
      const insideSign = curl > 0 ? 1 : -1;
      const s = this.samples[i];
      const base = s.p
        .clone()
        .add(s.n.clone().multiplyScalar(insideSign * (half + 4.2)));

      for (let stack = 0; stack < 3; stack++) {
        const offset = (stack - 1) * 0.85;
        for (let h = 0; h < 3; h++) {
          const tire = new THREE.Mesh(tireGeom, tireMat);
          tire.position.set(
            base.x + s.t.x * offset,
            0.18 + h * 0.34,
            base.z + s.t.z * offset
          );
          tire.castShadow = true;
          this.scene.add(tire);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Start / finish stripe + pit lane
  // ---------------------------------------------------------------------------

  private buildStartFinish() {
    const s = this.samples[0];
    const half = this.trackWidth / 2;

    // Black-and-white checkered stripe across the track.
    const stripGeom = new THREE.PlaneGeometry(this.trackWidth, 1.8);
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 32;
    const ctx = canvas.getContext("2d")!;
    const cells = 16;
    const cw = canvas.width / cells;
    const ch = canvas.height / 2;
    for (let x = 0; x < cells; x++) {
      for (let y = 0; y < 2; y++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? "#ffffff" : "#000000";
        ctx.fillRect(x * cw, y * ch, cw, ch);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const stripMat = new THREE.MeshBasicMaterial({ map: tex });
    const strip = new THREE.Mesh(stripGeom, stripMat);
    strip.rotation.x = -Math.PI / 2;
    strip.rotation.z = -Math.atan2(s.t.x, s.t.z);
    strip.position.copy(s.p);
    strip.position.y = 0.03;
    this.scene.add(strip);

    // Pit wall (visual only) parallel to the start straight.
    const wallGroup = new THREE.Group();
    for (let i = 0; i < 16; i++) {
      const pos = this.samples[Math.floor(i * 2)].p.clone();
      const n = this.samples[Math.floor(i * 2)].n.clone();
      const mid = pos.add(n.multiplyScalar(half + 7));
      const yaw = -Math.atan2(this.samples[Math.floor(i * 2)].t.x, this.samples[Math.floor(i * 2)].t.z);
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 1.4, 3.5),
        new THREE.MeshStandardMaterial({
          color: i % 2 === 0 ? 0xffffff : 0xff1f4b,
          roughness: 0.5,
        })
      );
      block.position.set(mid.x, 0.7, mid.z);
      block.rotation.y = yaw;
      block.castShadow = true;
      wallGroup.add(block);
    }
    this.scene.add(wallGroup);
  }

  // ---------------------------------------------------------------------------
  // Decorative scenery
  // ---------------------------------------------------------------------------

  private buildScenery() {
    // Grandstand near the main straight.
    const standMat = new THREE.MeshStandardMaterial({
      color: 0x4a5566,
      roughness: 0.9,
    });
    const standRoofMat = new THREE.MeshStandardMaterial({
      color: 0xff1f4b,
      roughness: 0.6,
    });

    const buildStand = (
      pos: THREE.Vector3,
      yaw: number,
      length = 28,
      depth = 9
    ) => {
      const tiers = 6;
      for (let i = 0; i < tiers; i++) {
        const tier = new THREE.Mesh(
          new THREE.BoxGeometry(length, 0.6, 1.4),
          standMat
        );
        tier.position.set(0, 0.3 + i * 0.6, -depth / 2 + i * 1.3);
        tier.castShadow = false;
        tier.receiveShadow = true;
        const tierGroup = new THREE.Group();
        tierGroup.add(tier);
        tierGroup.position.copy(pos);
        tierGroup.rotation.y = yaw;
        this.scene.add(tierGroup);
      }
      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(length, 0.5, depth + 2),
        standRoofMat
      );
      roof.position.set(pos.x, tiers * 0.6 + 1, pos.z);
      roof.rotation.y = yaw;
      roof.translateZ(1);
      roof.castShadow = true;
      this.scene.add(roof);
    };

    // Place grandstands at a few spots around the circuit.
    [
      { i: 4, side: -1 },
      { i: 200, side: 1 },
      { i: 320, side: -1 },
    ].forEach(({ i, side }) => {
      const s = this.samples[i % this.samples.length];
      const pos = s.p
        .clone()
        .add(s.n.clone().multiplyScalar(side * (this.trackWidth / 2 + 18)));
      const yaw = -Math.atan2(s.t.x, s.t.z) + (side > 0 ? Math.PI : 0);
      buildStand(pos, yaw);
    });

    // Sky dome (gradient).
    const skyGeom = new THREE.SphereGeometry(1500, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        topColor: { value: new THREE.Color(0x87b7ff) },
        bottomColor: { value: new THREE.Color(0xe6f0ff) },
      },
      vertexShader: `varying vec3 vWorld;
        void main(){ vWorld = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
      fragmentShader: `uniform vec3 topColor; uniform vec3 bottomColor; varying vec3 vWorld;
        void main(){ float h = normalize(vWorld).y * 0.5 + 0.5; gl_FragColor = vec4(mix(bottomColor, topColor, smoothstep(0.0,1.0,h)),1.0);} `,
    });
    const sky = new THREE.Mesh(skyGeom, skyMat);
    this.scene.add(sky);
  }

  // ---------------------------------------------------------------------------
  // Lap-system checkpoints
  // ---------------------------------------------------------------------------

  private buildCheckpoints() {
    const COUNT = 10;
    const N = this.samples.length;
    const half = this.trackWidth / 2 + 2;
    for (let i = 0; i < COUNT; i++) {
      const sIdx = Math.floor((i / COUNT) * N);
      const s = this.samples[sIdx];
      const right = new THREE.Vector3(s.t.z, 0, -s.t.x).normalize();
      this.checkpoints.push({
        index: i,
        position: s.p.clone().setY(1.0),
        forward: s.t.clone(),
        right,
        halfWidth: half,
        halfHeight: 5,
        hit: false,
        lastSigned: 0,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Track-limits helper
  // ---------------------------------------------------------------------------

  /**
   * Returns roughly how far (m) the given world XZ point is from the asphalt edge.
   * Negative means "inside the track". Positive means "off track by N meters".
   * Implementation: search the closest centerline sample and use perpendicular distance.
   */
  distanceOffTrack(worldX: number, worldZ: number): number {
    let bestDist2 = Infinity;
    let bestIdx = 0;
    const N = this.samples.length;
    for (let i = 0; i < N; i++) {
      const s = this.samples[i];
      const dx = worldX - s.p.x;
      const dz = worldZ - s.p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        bestIdx = i;
      }
    }
    const s = this.samples[bestIdx];
    const dx = worldX - s.p.x;
    const dz = worldZ - s.p.z;
    const lateral = Math.abs(dx * s.n.x + dz * s.n.z);
    return lateral - this.trackWidth / 2;
  }
}
