import * as THREE from "three";

/**
 * Procedural, chibi-proportioned ladybug.
 *
 * Model space: 1 unit ≈ the bug's body length, feet rest on y = 0, the head
 * points toward +z and +x is the bug's right-hand side.
 */

const COLORS = {
  shell: "#e5483e",
  spot: "#3a211c",
  dark: "#3b2520",
  cream: "#f7e6cc",
  /** Soft near-black; with a matte finish the pupils read as dull, not glinting. */
  eye: "#2a1a15",
  wing: "#e6f1ff",
  brass: "#d6a446",
  handle: "#6b3f2a",
  glass: "#dcf1ff",
};

const SHELL = { rx: 0.31, ry: 0.25, rz: 0.35, center: new THREE.Vector3(0, 0.17, -0.05) };
const HEAD = { r: 0.165, center: new THREE.Vector3(0, 0.21, 0.31) };
/** Where the wing cases are hinged, at the front of the shell. */
const HINGE = new THREE.Vector3(0, 0.31, 0.24);

type Side = 1 | -1;

export type LadybugRig = {
  /** Yaw + squash. Origin on the ground under the body. */
  root: THREE.Group;
  /** Bob, waddle and breathing. */
  body: THREE.Group;
  head: THREE.Group;
  eyes: THREE.Group[];
  antennae: { pivot: THREE.Group; side: Side }[];
  elytra: { pivot: THREE.Group; side: Side }[];
  wings: { pivot: THREE.Group; side: Side }[];
  legs: { pivot: THREE.Group; side: Side; tripod: 0 | 1 }[];
  /**
   * Magnifying glass, hidden at scale 0. Origin at the lens centre, lens
   * facing +z, handle hanging down and out to +x.
   */
  magnifier: THREE.Group;
  /** Glow the body a colour (alarm flash). amount 0 = off. */
  setTint: (color: THREE.ColorRepresentation, amount: number) => void;
  dispose: () => void;
};

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const dir = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();

/** Point and outward normal on the shell ellipsoid for a direction from its centre. */
function shellSurface(u: THREE.Vector3) {
  const { rx, ry, rz } = SHELL;
  const point = new THREE.Vector3(u.x * rx, u.y * ry, u.z * rz);
  const normal = new THREE.Vector3(u.x / rx, u.y / ry, u.z / rz).normalize();
  return { point, normal };
}

export function buildLadybug(): LadybugRig {
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const geo = <T extends THREE.BufferGeometry>(g: T) => (geometries.push(g), g);
  const mat = <T extends THREE.Material>(m: T) => (materials.push(m), m);

  const shellMat = mat(
    new THREE.MeshPhysicalMaterial({
      color: COLORS.shell,
      roughness: 0.45,
      clearcoat: 0.6,
      clearcoatRoughness: 0.35,
      side: THREE.DoubleSide,
    }),
  );
  const spotMat = mat(new THREE.MeshStandardMaterial({ color: COLORS.spot, roughness: 0.5 }));
  const darkMat = mat(new THREE.MeshStandardMaterial({ color: COLORS.dark, roughness: 0.6 }));
  const creamMat = mat(new THREE.MeshStandardMaterial({ color: COLORS.cream, roughness: 0.55 }));
  const eyeMat = mat(new THREE.MeshStandardMaterial({ color: COLORS.eye, roughness: 0.9 }));
  const wingMat = mat(
    new THREE.MeshPhysicalMaterial({
      color: COLORS.wing,
      roughness: 0.2,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );

  // Shared unit geometries, scaled per mesh.
  const sphere = geo(new THREE.SphereGeometry(1, 32, 20));
  const smallSphere = geo(new THREE.SphereGeometry(1, 16, 10));

  const ellipsoid = (
    material: THREE.Material,
    rx: number,
    ry: number,
    rz: number,
    geometry: THREE.BufferGeometry = sphere,
  ) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(rx, ry, rz);
    return mesh;
  };

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // Belly: closes the underside of the shell.
  const belly = ellipsoid(darkMat, 0.27, 0.08, 0.31);
  belly.position.set(0, 0.1, -0.04);
  body.add(belly);

  // Pronotum: the dark "collar" between head and shell.
  const pronotum = ellipsoid(darkMat, 0.24, 0.13, 0.13);
  pronotum.position.set(0, 0.22, 0.2);
  body.add(pronotum);

  // Wing cases (elytra): two halves of a slightly-more-than-hemisphere dome,
  // each on a hinge so they can pop open.
  const SPOTS: { u: THREE.Vector3; r: number }[] = [
    { u: dir(0.33, 0.85, 0.42), r: 0.075 },
    { u: dir(0.85, 0.42, 0.08), r: 0.07 },
    { u: dir(0.38, 0.75, -0.55), r: 0.072 },
    { u: dir(0.75, 0.2, -0.62), r: 0.05 },
  ];
  const elytra: LadybugRig["elytra"] = [];
  for (const side of [1, -1] as const) {
    const halfGeo = geo(
      new THREE.SphereGeometry(
        1,
        40,
        24,
        side === 1 ? Math.PI / 2 : -Math.PI / 2,
        Math.PI,
        0,
        Math.PI * 0.62,
      ),
    );
    halfGeo.scale(SHELL.rx, SHELL.ry, SHELL.rz);

    const pivot = new THREE.Group();
    pivot.position.copy(HINGE);
    const half = new THREE.Group();
    // Tiny gap down the middle reads as the seam between the wing cases.
    half.position.copy(SHELL.center).sub(HINGE).add(new THREE.Vector3(side * 0.004, 0, 0));
    half.add(new THREE.Mesh(halfGeo, shellMat));

    for (const { u, r } of SPOTS) {
      const { point, normal } = shellSurface(new THREE.Vector3(u.x * side, u.y, u.z));
      const spot = ellipsoid(spotMat, r, r * 0.16, r);
      spot.position.copy(point);
      spot.quaternion.setFromUnitVectors(Y_AXIS, normal);
      half.add(spot);
    }

    pivot.add(half);
    body.add(pivot);
    elytra.push({ pivot, side });
  }

  // Flight wings, tucked away until the shell opens.
  const wings: LadybugRig["wings"] = [];
  const wingGeo = geo(new THREE.CircleGeometry(1, 32));
  wingGeo.translate(0, 1, 0).scale(0.15, 0.36, 1).rotateX(-Math.PI / 2);
  for (const side of [1, -1] as const) {
    const pivot = new THREE.Group();
    pivot.position.copy(HINGE).add(new THREE.Vector3(side * 0.06, -0.02, -0.02));
    // Spread outward (Y) first, then flap up/down around the body axis (Z).
    pivot.rotation.order = "XZY";
    const wing = new THREE.Mesh(wingGeo, wingMat);
    wing.position.x = side * 0.06;
    wing.renderOrder = 1;
    pivot.add(wing);
    pivot.visible = false;
    body.add(pivot);
    wings.push({ pivot, side });
  }

  // Head.
  const head = new THREE.Group();
  const neck = new THREE.Vector3(0, 0.2, 0.22);
  head.position.copy(neck);
  body.add(head);
  const headCenter = HEAD.center.clone().sub(neck);
  const skull = ellipsoid(darkMat, HEAD.r, HEAD.r * 0.95, HEAD.r);
  skull.position.copy(headCenter);
  head.add(skull);

  const onHead = (u: THREE.Vector3, lift = 0) =>
    headCenter.clone().addScaledVector(u, HEAD.r + lift);

  // Minimal eyes: a cream patch with a small dark dot. The dots sit low in the
  // patch so the bug looks relaxed rather than surprised. The whole eye group
  // squashes when blinking.
  const eyes: THREE.Group[] = [];
  for (const side of [1, -1] as const) {
    const u = dir(side * 0.42, 0.22, 0.88);
    const eye = new THREE.Group();
    eye.position.copy(onHead(u, -0.006));
    eye.quaternion.setFromUnitVectors(Z_AXIS, u);
    eye.add(ellipsoid(creamMat, 0.066, 0.074, 0.02));
    const pupil = ellipsoid(eyeMat, 0.013, 0.015, 0.006, smallSphere);
    pupil.position.set(0, -0.04, 0.016);
    eye.add(pupil);
    head.add(eye);
    eyes.push(eye);
  }

  // Antennae.
  const antennae: LadybugRig["antennae"] = [];
  for (const side of [1, -1] as const) {
    const pivot = new THREE.Group();
    pivot.position.copy(onHead(dir(side * 0.35, 0.85, 0.4), -0.01));
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(side * 0.025, 0.07, 0.03),
      new THREE.Vector3(side * 0.07, 0.13, 0.03),
      new THREE.Vector3(side * 0.125, 0.155, 0.01),
    ]);
    const stalk = new THREE.Mesh(geo(new THREE.TubeGeometry(curve, 16, 0.011, 8)), darkMat);
    pivot.add(stalk);
    const tip = ellipsoid(darkMat, 0.028, 0.028, 0.028, smallSphere);
    tip.position.copy(curve.getPoint(1));
    pivot.add(tip);
    head.add(pivot);
    antennae.push({ pivot, side });
  }

  // Magnifying glass for scans: brass rim, a faint glass disc with a glint,
  // and a wooden handle.
  const magnifier = new THREE.Group();
  const LENS_R = 0.14;
  const brassMat = mat(
    new THREE.MeshStandardMaterial({ color: COLORS.brass, metalness: 0.85, roughness: 0.3 }),
  );
  const handleMat = mat(new THREE.MeshStandardMaterial({ color: COLORS.handle, roughness: 0.55 }));
  const glassMat = mat(
    new THREE.MeshPhysicalMaterial({
      color: COLORS.glass,
      roughness: 0.05,
      clearcoat: 1,
      transparent: true,
      opacity: 0.38,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  const glintMat = mat(
    new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.85 }),
  );
  const rim = new THREE.Mesh(geo(new THREE.TorusGeometry(LENS_R, 0.017, 12, 48)), brassMat);
  magnifier.add(rim);
  const glass = new THREE.Mesh(geo(new THREE.CircleGeometry(LENS_R, 40)), glassMat);
  glass.renderOrder = 2;
  magnifier.add(glass);
  const glint = new THREE.Mesh(
    geo(new THREE.TorusGeometry(LENS_R * 0.68, 0.007, 6, 24, Math.PI * 0.42)),
    glintMat,
  );
  glint.rotation.z = Math.PI * 0.55;
  glint.position.z = 0.004;
  glint.renderOrder = 3;
  magnifier.add(glint);
  const handleDir = dir(0.45, -0.9, 0);
  const collar = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.021, 0.021, 0.035, 12)), brassMat);
  collar.position.copy(handleDir).multiplyScalar(LENS_R + 0.026);
  collar.quaternion.setFromUnitVectors(Y_AXIS, handleDir);
  magnifier.add(collar);
  const handle = new THREE.Mesh(geo(new THREE.CapsuleGeometry(0.019, 0.12, 4, 12)), handleMat);
  handle.position.copy(handleDir).multiplyScalar(LENS_R + 0.11);
  handle.quaternion.setFromUnitVectors(Y_AXIS, handleDir);
  magnifier.add(handle);
  magnifier.scale.setScalar(0);
  magnifier.visible = false;
  root.add(magnifier);

  // Six stubby legs. Tripod gait: front + back on one side move with the
  // middle leg on the other side.
  const legs: LadybugRig["legs"] = [];
  const thighGeo = geo(new THREE.CapsuleGeometry(0.021, 1, 4, 10));
  const footGeo = smallSphere;
  const segment = (from: THREE.Vector3, to: THREE.Vector3) => {
    const delta = to.clone().sub(from);
    const mesh = new THREE.Mesh(thighGeo, darkMat);
    mesh.scale.set(1, delta.length(), 1);
    mesh.position.copy(from).addScaledVector(delta, 0.5);
    mesh.quaternion.setFromUnitVectors(Y_AXIS, delta.normalize());
    return mesh;
  };
  const LEG_ROWS = [
    { z: 0.13, splay: 0.05 },
    { z: -0.02, splay: 0 },
    { z: -0.16, splay: -0.05 },
  ];
  LEG_ROWS.forEach(({ z, splay }, row) => {
    for (const side of [1, -1] as const) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.16, 0.1, z);
      const knee = new THREE.Vector3(side * 0.11, 0.0, splay);
      const foot = new THREE.Vector3(side * 0.16, -0.075, splay * 1.5);
      pivot.add(segment(new THREE.Vector3(0, 0, 0), knee));
      pivot.add(segment(knee, foot));
      const toe = ellipsoid(darkMat, 0.03, 0.025, 0.034, footGeo);
      toe.position.copy(foot);
      pivot.add(toe);
      body.add(pivot);
      legs.push({ pivot, side, tripod: ((row + (side === 1 ? 0 : 1)) % 2) as 0 | 1 });
    }
  });

  return {
    root,
    body,
    head,
    eyes,
    antennae,
    elytra,
    wings,
    legs,
    magnifier,
    setTint: (color, amount) => {
      for (const m of [shellMat, darkMat, creamMat]) {
        m.emissive.set(color);
        m.emissiveIntensity = amount;
      }
    },
    dispose: () => {
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
    },
  };
}
