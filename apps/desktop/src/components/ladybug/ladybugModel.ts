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
  eye: "#140b09",
  blush: "#ff8a86",
  wing: "#e6f1ff",
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
  const eyeMat = mat(new THREE.MeshStandardMaterial({ color: COLORS.eye, roughness: 0.12 }));
  const sparkleMat = mat(new THREE.MeshBasicMaterial({ color: "#ffffff" }));
  const blushMat = mat(
    new THREE.MeshBasicMaterial({ color: COLORS.blush, transparent: true, opacity: 0.75 }),
  );
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

  const eyes: THREE.Group[] = [];
  for (const side of [1, -1] as const) {
    const u = dir(side * 0.42, 0.22, 0.88);

    const patch = ellipsoid(creamMat, 0.062, 0.07, 0.02);
    patch.position.copy(onHead(u, -0.006));
    patch.quaternion.setFromUnitVectors(Z_AXIS, u);
    head.add(patch);

    const eye = new THREE.Group();
    eye.position.copy(onHead(u, 0.008));
    eye.quaternion.setFromUnitVectors(Z_AXIS, u);
    const pupil = ellipsoid(eyeMat, 0.038, 0.045, 0.022);
    eye.add(pupil);
    const sparkle = ellipsoid(sparkleMat, 0.012, 0.012, 0.006, smallSphere);
    sparkle.position.set(0.013, 0.018, 0.02);
    eye.add(sparkle);
    const sparkleSmall = ellipsoid(sparkleMat, 0.006, 0.006, 0.004, smallSphere);
    sparkleSmall.position.set(-0.012, -0.016, 0.019);
    eye.add(sparkleSmall);
    head.add(eye);
    eyes.push(eye);

    const blushDir = dir(side * 0.62, -0.12, 0.78);
    const blush = ellipsoid(blushMat, 0.034, 0.022, 0.008, smallSphere);
    blush.position.copy(onHead(blushDir, 0.001));
    blush.quaternion.setFromUnitVectors(Z_AXIS, blushDir);
    head.add(blush);
  }

  // Little smile.
  const smileGeo = geo(new THREE.TorusGeometry(0.024, 0.0065, 8, 20, Math.PI));
  const smile = new THREE.Mesh(smileGeo, creamMat);
  const smileDir = dir(0, -0.14, 1);
  smile.position.copy(onHead(smileDir, -0.001));
  smile.quaternion.setFromUnitVectors(Z_AXIS, smileDir);
  smile.rotateZ(Math.PI);
  head.add(smile);

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
    dispose: () => {
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
    },
  };
}
