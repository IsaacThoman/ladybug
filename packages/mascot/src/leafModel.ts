import * as THREE from "three";

/**
 * A broad leaf for the ladybug to stand on, in the same model space: the bug's
 * feet are at the origin and the leaf surface sits just under them, so the
 * contact shadow lands on it.
 */

const LENGTH = 1.5;
const HALF_WIDTH = 0.43;
/** Turned so the tip points toward the viewer's front right. */
const YAW = -0.42;
const SEGMENTS_U = 48;
const SEGMENTS_V = 16;

const COLORS = {
  rib: new THREE.Color("#3f7f2e"),
  edge: new THREE.Color("#79ad45"),
  stem: "#4c7a2c",
};

/** Half-width at `u` (0 = stem end, 1 = tip): round near the stem, pointed at the tip. */
const halfWidth = (u: number) => HALF_WIDTH * Math.sin(Math.PI * u ** 0.8) ** 0.85;

/** Surface point for `u` along the leaf and `v` (-1..1) across it. */
function surface(u: number, v: number, target = new THREE.Vector3()) {
  const along = (u - 0.5) * LENGTH;
  const across = v * halfWidth(u);
  // Flat under the bug, the ends droop and the edges curl up a little.
  const droop = -0.06 * (2 * u - 1) ** 2;
  const curl = 0.06 * v ** 4;
  return target.set(along, -0.012 + droop + curl, across);
}

export function buildLeaf() {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const point = new THREE.Vector3();
  const color = new THREE.Color();

  for (let i = 0; i <= SEGMENTS_U; i++) {
    const u = i / SEGMENTS_U;
    for (let j = 0; j <= SEGMENTS_V; j++) {
      const v = (j / SEGMENTS_V) * 2 - 1;
      surface(u, v, point);
      positions.push(point.x, point.y, point.z);
      // Deeper green along the midrib, fresher toward the edges.
      color.copy(COLORS.rib).lerp(COLORS.edge, Math.min(1, Math.abs(v) ** 0.7 + 0.1 * u));
      colors.push(color.r, color.g, color.b);
    }
  }
  const row = SEGMENTS_V + 1;
  for (let i = 0; i < SEGMENTS_U; i++) {
    for (let j = 0; j < SEGMENTS_V; j++) {
      const a = i * row + j;
      indices.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }

  const blade = new THREE.BufferGeometry();
  blade.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  blade.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  blade.setIndex(indices);
  blade.computeVertexNormals();

  const bladeMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.62,
    side: THREE.DoubleSide,
  });
  const veinMat = new THREE.MeshStandardMaterial({ color: "#a9cf72", roughness: 0.5 });
  const stemMat = new THREE.MeshStandardMaterial({ color: COLORS.stem, roughness: 0.6 });

  const root = new THREE.Group();
  root.rotation.y = YAW;
  root.add(new THREE.Mesh(blade, bladeMat));

  const geometries: THREE.BufferGeometry[] = [blade];
  const lift = new THREE.Vector3(0, 0.004, 0);

  // Midrib, running from the stem almost to the tip.
  const ribPoints = [];
  for (let k = 0; k <= 12; k++) ribPoints.push(surface(0.02 + (k / 12) * 0.9, 0).add(lift));
  const rib = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ribPoints), 40, 0.007, 6);
  geometries.push(rib);
  root.add(new THREE.Mesh(rib, veinMat));

  // Side veins, curving out toward the tip.
  for (const u of [0.24, 0.42, 0.6, 0.76]) {
    for (const side of [1, -1]) {
      const points = [0, 0.35, 0.7].map((t) =>
        surface(Math.min(0.97, u + t * 0.16), side * t).add(lift),
      );
      const vein = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 12, 0.004, 5);
      geometries.push(vein);
      root.add(new THREE.Mesh(vein, veinMat));
    }
  }

  // A short stem out of the round end.
  const base = surface(0, 0);
  const stemCurve = new THREE.CatmullRomCurve3([
    base.clone().add(new THREE.Vector3(0.04, 0.004, 0)),
    base.clone().add(new THREE.Vector3(-0.08, -0.012, 0.015)),
    base.clone().add(new THREE.Vector3(-0.2, -0.05, 0.05)),
  ]);
  const stem = new THREE.TubeGeometry(stemCurve, 12, 0.014, 8);
  geometries.push(stem);
  root.add(new THREE.Mesh(stem, stemMat));

  return {
    root,
    dispose: () => {
      geometries.forEach((g) => g.dispose());
      [bladeMat, veinMat, stemMat].forEach((m) => m.dispose());
    },
  };
}
