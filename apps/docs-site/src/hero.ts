import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Clock,
  DirectionalLight,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Points,
  Quaternion,
  Raycaster,
  Scene,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
  WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

// The full hero simulation. Loaded lazily from App.tsx so three.js and this
// file stay out of the critical-path bundle; the prerendered page never
// depends on it.
export function initHero(mount: HTMLDivElement): () => void {
let width = mount.clientWidth || 520;
let height = mount.clientHeight || 500;

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const scene = new Scene();
const camera = new PerspectiveCamera(38, width / height, 0.1, 100);
camera.position.set(0, 0.25, 6.4);
camera.lookAt(0, -0.25, 0);

const renderer = new WebGLRenderer({ antialias: true, alpha: true });
// Narrow (usually mobile) viewports cap the pixel ratio harder: the dots and
// canopy read the same at 1.5x, and the fill-rate cost drops by nearly half.
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.innerWidth < 900 ? 1.5 : 2));
renderer.setSize(width, height);
mount.appendChild(renderer.domElement);

const ambient = new AmbientLight(0xffffff, 0.85);
scene.add(ambient);
const key = new DirectionalLight(0xffffff, 0.95);
key.position.set(3, 5, 4);
scene.add(key);
const rim = new DirectionalLight(0xf6821f, 0.45);
rim.position.set(-4, 2, -3);
scene.add(rim);

const umbrella = new Group();
scene.add(umbrella);

// Load the dark_alice umbrella GLB (recolored on-brand at runtime).
const loader = new GLTFLoader();
// The GLB ships meshopt-compressed (334 KB -> 62 KB); regenerate with
// `npx @gltf-transform/cli optimize <in> <out> --compress meshopt
// --texture-compress false --simplify false`.
loader.setMeshoptDecoder(MeshoptDecoder);
loader.load("/umbrella.glb", (gltf) => {
  const model = gltf.scene;
  model.traverse((obj) => {
    if (obj instanceof Mesh) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      let isCanopy = false;
      for (const m of mats) {
        const mat = m as MeshStandardMaterial;
        const name = mat?.name ?? "";
        if (name.startsWith("canopy_panel")) {
          mat.map = null;
          mat.roughness = 0.65;
          mat.metalness = 0.05;
          (name.endsWith("_b") ? canopyBMats : canopyAMats).push(mat);
          isCanopy = true;
        } else if (name === "wood") {
          mat.map = null;
          mat.roughness = 0.7;
          mat.metalness = 0.25;
          frameMats.push(mat);
        } else if (name === "metal") {
          mat.map = null;
          mat.emissive?.set(0x000000);
          mat.emissiveIntensity = 0;
          mat.roughness = 0.55;
          mat.metalness = 0.5;
          frameMats.push(mat);
        }
        if (mat) mat.needsUpdate = true;
      }
      if (isCanopy) canopyMesh.push(obj);
    }
  });
  // The model already stands tip-up (+Y); keep world up = +Y.
  model.rotation.x = 0;
  model.scale.setScalar(1.45);
  model.position.set(0, -0.1, 0);
  umbrella.add(model);

  buildProfile();
  applyVisuals();
  if (reduce) renderer.render(scene, camera);
});

// Shared canvas used to rasterize each price. The number on screen IS
// particles from the first frame: it falls as a rigid flock that reads
// as text, and individual grains deform only when the canopy reaches
// them.
const labelCanvas = document.createElement("canvas");
labelCanvas.width = 512;
labelCanvas.height = 256;
const labelCtx = labelCanvas.getContext("2d", { willReadFrequently: true })!;
// Rasterized labels are cached per text and sand color: getImageData on a
// respawn caused a small main-thread hitch, and the amounts repeat.
const labelCache = new Map<string, Uint8ClampedArray>();
function rasterizeLabel(text: string): Uint8ClampedArray {
  const vis = activeVis();
  const cacheKey = `${vis.sand}|${text}`;
  const hit = labelCache.get(cacheKey);
  if (hit) return hit;
  const x = labelCtx;
  x.clearRect(0, 0, 512, 256);
  x.font = "800 100px Archivo, Arial, sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillStyle = vis.sand;
  x.shadowColor = hexToRgba(vis.sand, 0.55);
  x.shadowBlur = 18;
  x.fillText(text, 256, 128);
  const data = x.getImageData(0, 0, 512, 256).data;
  labelCache.set(cacheKey, data);
  return data;
}

const AMOUNTS = [
  "-$8,846", "-$16,000", "-$1.7K", "-$22k", "-$91,316", "-$36k", "-$8,241", "-$200K", "-$14,500", "-$3,200",
  "-$473", "-$1,058", "-$2,730", "-$4,912", "-$6,187", "-$7,354", "-$9,412", "-$11,808", "-$12,460", "-$18,275",
  "-$25,341", "-$28k", "-$31,006", "-$42,890", "-$55k", "-$63,114", "-$78,500", "-$104K", "-$128,733", "-$350K",
  "-$540", "-$867", "-$5.4K", "-$19.95", "-$66", "-$2,001", "-$44,041", "-$150K", "-$666", "-$13,370",
];

// Particle pool: each cloud (one price) owns a fixed slice of the pool.
// pState: 0 = dead, 1 = rigid (falls with its cloud), 2 = loose grain.
const CLOUDS = 10;
const MAX_P = 1800;
const P_COUNT = CLOUDS * MAX_P;
const pGeo = new BufferGeometry();
const pPos = new Float32Array(P_COUNT * 3);
const pVel = new Float32Array(P_COUNT * 3);
const pCol = new Float32Array(P_COUNT * 3);
const pFade = new Float32Array(P_COUNT);
const pBase = new Float32Array(P_COUNT);
const pSize = new Float32Array(P_COUNT);
const pState = new Uint8Array(P_COUNT);
pGeo.setAttribute("position", new BufferAttribute(pPos, 3));
pGeo.setAttribute("aColor", new BufferAttribute(pCol, 3));
pGeo.setAttribute("aFade", new BufferAttribute(pFade, 1));
pGeo.setAttribute("aBase", new BufferAttribute(pBase, 1));
pGeo.setAttribute("aSize", new BufferAttribute(pSize, 1));
const pMat = new ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: { uScale: { value: 1600 } },
  vertexShader: `
    uniform float uScale;
    attribute vec3 aColor;
    attribute float aFade;
    attribute float aBase;
    attribute float aSize;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vColor = aColor;
      vAlpha = aFade * aBase;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * (uScale / -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      float d = length(gl_PointCoord - vec2(0.5));
      float a = smoothstep(0.5, 0.12, d) * vAlpha;
      if (a < 0.01) discard;
      gl_FragColor = vec4(vColor, a);
    }`,
});
const grains = new Points(pGeo, pMat);
grains.frustumCulled = false;
scene.add(grains);
function updatePointScale() {
  pMat.uniforms.uScale!.value = renderer.domElement.height / (2 * Math.tan(MathUtils.degToRad(17.5)));
}
updatePointScale();

type Cloud = { vy: number; alive: number; spawnAt: number; ix: number; iy: number; iz: number; in: number };
const clouds: Cloud[] = [];
// Respawns are metered: each exhausted cloud waits its turn on a shared
// schedule, so numbers feed in a steady drip instead of bursts followed
// by long pauses.
let nextSpawnAt = 0;
// Narrow viewports run fewer simultaneous numbers for GPU headroom.
let cloudLimit = 10;
// Simulation parameters, tuned by hand against the live hero.
const P = {
  gravity: 0.29,
  numberStartVy: 0.3,
  numberTerminal: 1.65,
  looseGravityMult: 4.4,
  looseTerminal: 1.85,
  slideAccMin: 0.8,
  slideAccMax: 5.8,
  slideSlopeMult: 2.7,
  friction: 0.969,
  momentumKeep: 0.6,
  stickyBand: 0,
  pressIn: 0.215,
  slideSpeedCap: 0.3,
  shockRadius: 0.06,
  shockStrength: 0.6,
  fanSpread: 0.19,
  landScatter: 0.8,
  spawnGapMin: 1.3,
  spawnGapVar: 1.8,
  grainSize: 1.55,
  grainSizeVar: 1.85,
};
const raycaster = new Raycaster();
const rayDown = new Vector3(0, -1, 0);

// View framing: keep the umbrella and rain within the frustum; recomputed on resize.
// On desktop shift the whole scene right (into the free space beside the hero text);
// on narrow screens keep it centered.
let viewW = 4, viewH = 4;
const center = new Vector3(1.6, -0.05, 0);
let shiftX = 1.6;
function computeView() {
  const aspect = width / height;
  const stacked = window.innerWidth < 900;
  cloudLimit = stacked ? 4 : CLOUDS;
  const RIMW = 1.6;
  let vh = 4.2;
  let cx = 0;
  if (stacked) {
    // Stacked layout: the canvas is its own block below the text, so
    // center the umbrella and frame it whole, J handle included.
    vh = 3.9;
    const minW = 3.4;
    if (vh * aspect < minW) vh = minW / aspect;
  } else {
    // Place the umbrella in the free column right of the hero text: the
    // left rim always clears the text with a gutter, and on tighter
    // viewports the umbrella stays large and simply clips off the right
    // edge; only ~60% of the canopy needs to fit before the scene zooms
    // out at all.
    const pad = Math.max(24, (width - 1240) / 2);
    const textRight = pad + 640 + 40;
    const freePx = Math.max(width - textRight, 60);
    vh = Math.min(5.5, Math.max(4.2, (1.2 * RIMW * height) / freePx));
    const ppw = height / vh;
    cx = Math.max(0, Math.min((textRight - width / 2) / ppw + RIMW, width / 2 / ppw - 0.6 * RIMW));
  }
  viewH = vh;
  viewW = vh * aspect;
  shiftX = cx;
  const centerY = -0.05;
  const fov = MathUtils.degToRad(35);
  const dist = (vh / 2) / Math.tan(fov / 2);
  camera.fov = 35;
  camera.aspect = aspect;
  // The camera stays at x=0; only the umbrella and rain shift right, so
  // the scene actually lands in the free space beside the hero text.
  camera.position.set(0, centerY, dist);
  camera.lookAt(0, centerY, 0);
  camera.updateProjectionMatrix();
  umbrella.position.x = shiftX;
  umbrella.position.y = centerY + (stacked ? 0.3 : 0.18);
  center.set(shiftX, centerY, 0);
}

function spawnCloud(c: number, initial = false) {
  const text = AMOUNTS[(Math.random() * AMOUNTS.length) | 0]!;
  const img = rasterizeLabel(text);
  const sc = 0.85 + Math.random() * 0.35;
  const w = 1.35 * sc;
  const h = 0.675 * sc;
  // Rain falls across the full disc around the umbrella, in front of and
  // behind it, so the field reads as 3D through perspective and
  // occlusion. Spawn strictly above the canopy so nothing starts under
  // or inside it.
  // Every price lands on the fabric, on the camera-facing half, and
  // biased toward the left or right side of the canopy: side hits pour
  // off the edge dramatically and keep the space under the umbrella
  // empty, where center hits would rain down the middle.
  const sideSign = Math.random() < 0.5 ? -1 : 1;
  const xr = (0.35 + 0.65 * Math.random()) * 1.35 * sideSign;
  // Land clearly forward of the midline so grains rarely spill down the
  // far side of the canopy.
  const zr = (0.3 + 0.7 * Math.random()) * Math.sqrt(Math.max(0, 1.35 * 1.35 - xr * xr));
  const cx = Math.min(Math.max(center.x + xr, center.x - (viewW / 2 - 0.8)), center.x + viewW / 2 - 0.8);
  const cz = center.z + zr;
  const canopyTop = umbrella.position.y + 1.35;
  const cy = initial
    ? canopyTop + 0.2 + Math.random() * viewH
    : Math.max(canopyTop + 0.2, center.y + viewH / 2 + 0.5) + Math.random() * 1.6;
  const base = c * MAX_P;
  // Two passes: count candidates first, then thin uniformly to fit the
  // slot. Filling top-down against a hard cap used to chop off the
  // bottoms of wide numbers.
  let candidates = 0;
  for (let py = 0; py < 256; py += 3) {
    for (let px = 0; px < 512; px += 3) {
      if ((img[(py * 512 + px) * 4 + 3] ?? 0) >= 110) candidates++;
    }
  }
  const accept = Math.min(1, MAX_P / (candidates || 1));
  let n = 0;
  for (let py = 0; py < 256 && n < MAX_P; py += 3) {
    for (let px = 0; px < 512 && n < MAX_P; px += 3) {
      const i4 = (py * 512 + px) * 4;
      const alpha = img[i4 + 3] ?? 0;
      // Solid ink only: the soft glow halo sampled as sparse low-alpha
      // grains is what made numbers read as fuzzy clouds.
      if (alpha < 110 || Math.random() > accept) continue;
      const j = base + n;
      const b = j * 3;
      pPos[b] = cx + (px / 512 - 0.5) * w;
      pPos[b + 1] = cy + (0.5 - py / 256) * h;
      // Slight depth so the number is a slab, not a paper-thin plane;
      // on impact the slab lands as a patch instead of a 1px line. Kept
      // thin enough that the glyph stays crisp head-on.
      pPos[b + 2] = cz + (Math.random() - 0.5) * 0.05;
      pVel[b] = 0;
      pVel[b + 1] = 0;
      pVel[b + 2] = 0;
      pCol[b] = (img[i4] ?? 255) / 255;
      pCol[b + 1] = (img[i4 + 1] ?? 100) / 255;
      pCol[b + 2] = (img[i4 + 2] ?? 90) / 255;
      pBase[j] = alpha / 255;
      pFade[j] = 1;
      pSize[j] = (3 / 512) * w * (P.grainSize + Math.random() * P.grainSizeVar);
      pState[j] = 1;
      n++;
    }
  }
  for (let k = n; k < MAX_P; k++) {
    pState[base + k] = 0;
    pFade[base + k] = 0;
  }
  clouds[c] = { vy: -P.numberStartVy - Math.random() * 0.25, alive: n, spawnAt: -1, ix: 0, iy: 0, iz: 0, in: 0 };
  pGeo.attributes.aColor!.needsUpdate = true;
  pGeo.attributes.aBase!.needsUpdate = true;
}

const canopyMesh: Mesh[] = [];
// Radial height profile of the canopy, measured from the real mesh once
// it loads. Particles collide against this analytically (a raycast per
// particle would be too costly), so dust rolls down the slope and spills
// off the rim instead of clipping through the surface.
const PROF_R = 48;
const PROF_A = 48;
const SCAN_R = 2.4;
const prof = new Float32Array(PROF_R * PROF_A);
const rimR = new Float32Array(PROF_A);
let profReady = false;
function buildProfile() {
  // Measure in the umbrella's unrotated local frame; at runtime each
  // particle is transformed into this frame with the live sway
  // quaternion, so the collision surface follows the actual rotation.
  const rx = umbrella.rotation.x;
  const ry = umbrella.rotation.y;
  const rz = umbrella.rotation.z;
  umbrella.rotation.set(0, 0, 0);
  umbrella.updateMatrixWorld(true);
  const ux = umbrella.position.x;
  const uz = umbrella.position.z;
  const probe = new Vector3();
  for (let a = 0; a < PROF_A; a++) {
    const th = (a / PROF_A) * Math.PI * 2;
    let last = 0;
    let rim = 0;
    const cast = (r: number): number | null => {
      probe.set(ux + Math.cos(th) * r, umbrella.position.y + 3, uz + Math.sin(th) * r);
      raycaster.set(probe, rayDown);
      raycaster.far = 8;
      const h = raycaster.intersectObjects(canopyMesh, false);
      return h.length && h[0] ? h[0].point.y - umbrella.position.y : null;
    };
    for (let i = 0; i < PROF_R; i++) {
      const r = (i / (PROF_R - 1)) * SCAN_R;
      const hy = cast(r);
      if (hy !== null) {
        last = hy;
        rim = r;
      }
      prof[a * PROF_R + i] = last;
    }
    // Binary-refine the true fabric edge between the last hit and the
    // next miss; a coarse rim overshoots into an invisible ledge that
    // grains would visibly ride past the scalloped edge.
    let lo = rim;
    let hi = Math.min(rim + SCAN_R / (PROF_R - 1), SCAN_R);
    for (let it = 0; it < 5; it++) {
      const mid = (lo + hi) / 2;
      if (cast(mid) !== null) lo = mid;
      else hi = mid;
    }
    rimR[a] = lo;
    // Continue the fabric's final slope past the edge instead of going
    // flat. A flat extrapolation zeroed the downhill right at the lip,
    // so grains leveled off there and the edge read as a ledge; with
    // the slope carried through, a grain's tangent at the lip matches
    // the fabric and it slides straight off into the air.
    const dr = SCAN_R / (PROF_R - 1);
    const edgeI = Math.min(PROF_R - 2, Math.max(1, Math.round(lo / dr)));
    const edgeH = prof[a * PROF_R + edgeI] ?? 0;
    const slope = (edgeH - (prof[a * PROF_R + edgeI - 1] ?? 0)) / dr;
    for (let i = edgeI + 1; i < PROF_R; i++) {
      prof[a * PROF_R + i] = edgeH + slope * (i - edgeI) * dr;
    }
  }
  umbrella.rotation.set(rx, ry, rz);
  umbrella.updateMatrixWorld(true);
  profReady = true;
}
// Bilinear sample over radius and angle, wrapping the angle, so the
// scalloped dips between ribs are part of the collision surface.
function profileAt(r: number, ang: number): { h: number; rim: number } {
  const af = ((((ang / (Math.PI * 2)) % 1) + 1) % 1) * PROF_A;
  const a0 = Math.floor(af) % PROF_A;
  const a1 = (a0 + 1) % PROF_A;
  const fa = af - Math.floor(af);
  const t = Math.min((r / SCAN_R) * (PROF_R - 1), PROF_R - 2);
  const i0 = Math.floor(t);
  const fr = t - i0;
  const h0 = (prof[a0 * PROF_R + i0] ?? 0) * (1 - fr) + (prof[a0 * PROF_R + i0 + 1] ?? 0) * fr;
  const h1 = (prof[a1 * PROF_R + i0] ?? 0) * (1 - fr) + (prof[a1 * PROF_R + i0 + 1] ?? 0) * fr;
  return { h: h0 * (1 - fa) + h1 * fa, rim: (rimR[a0] ?? 0) * (1 - fa) + (rimR[a1] ?? 0) * fa };
}
const invQ = new Quaternion();
const lv = new Vector3();
const wv = new Vector3();

// ---- Visual tuning: per-mode colors, lighting, and the dark-mode
// backlight that silhouettes the canopy.
const canopyAMats: MeshStandardMaterial[] = [];
const canopyBMats: MeshStandardMaterial[] = [];
const frameMats: MeshStandardMaterial[] = [];
const VIS = {
  light: { sand: "#db4d00", canopyA: "#e68128", canopyB: "#e4710c", frame: "#515867", rimColor: "#ffe9d6", emissive: 0.45, ambient: 0.5, key: 1.3, rim: 2, backGlow: 0.16, backGlowSize: 8.6 },
  dark: { sand: "#b32d00", canopyA: "#ae4a13", canopyB: "#a23d06", frame: "#383838", rimColor: "#ff7e29", emissive: 0.72, ambient: 1.65, key: 2, rim: 2, backGlow: 0.12, backGlowSize: 8 },
};
const mql = window.matchMedia("(prefers-color-scheme: light)");
function activeVis() {
  return mql.matches ? VIS.light : VIS.dark;
}
function hexToRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
// Backlight: a soft radial glow sprite behind the umbrella.
const glowCanvas = document.createElement("canvas");
glowCanvas.width = 256;
glowCanvas.height = 256;
const gx = glowCanvas.getContext("2d")!;
const grad = gx.createRadialGradient(128, 128, 0, 128, 128, 128);
grad.addColorStop(0, "rgba(255,255,255,1)");
grad.addColorStop(0.55, "rgba(255,255,255,0.35)");
grad.addColorStop(1, "rgba(255,255,255,0)");
gx.fillStyle = grad;
gx.fillRect(0, 0, 256, 256);
const glowMat = new SpriteMaterial({ map: new CanvasTexture(glowCanvas), transparent: true, depthWrite: false, opacity: 0 });
const glow = new Sprite(glowMat);
scene.add(glow);
function applyVisuals() {
  const v = activeVis();
  ambient.intensity = v.ambient;
  key.intensity = v.key;
  rim.intensity = v.rim;
  rim.color.set(v.rimColor);
  for (const m of canopyAMats) {
    m.color.set(v.canopyA);
    m.emissive.set(v.canopyA);
    m.emissiveIntensity = v.emissive;
  }
  for (const m of canopyBMats) {
    m.color.set(v.canopyB);
    m.emissive.set(v.canopyB);
    m.emissiveIntensity = v.emissive;
  }
  for (const m of frameMats) m.color.set(v.frame);
  glowMat.opacity = v.backGlow;
  glowMat.color.set(v.rimColor);
  glow.scale.set(v.backGlowSize, v.backGlowSize, 1);
  glow.position.set(umbrella.position.x, umbrella.position.y + 0.45, -1.7);
  if (reduce) renderer.render(scene, camera);
}
mql.addEventListener("change", applyVisuals);

// ---- Dev tuning panel (temporary; remove before shipping) ----
const PHYS_DEFS: Array<[string, number, number, number]> = [
  ["gravity", 0.05, 2, 0.01],
  ["numberStartVy", 0, 1.5, 0.05],
  ["numberTerminal", 0.2, 3, 0.05],
  ["looseGravityMult", 0.5, 6, 0.1],
  ["looseTerminal", 0.3, 4, 0.05],
  ["slideAccMin", 0, 6, 0.1],
  ["slideAccMax", 0.5, 12, 0.1],
  ["slideSlopeMult", 0.5, 10, 0.1],
  ["friction", 0.95, 1, 0.001],
  ["momentumKeep", 0, 1.5, 0.05],
  ["stickyBand", 0, 0.3, 0.005],
  ["pressIn", 0, 0.3, 0.005],
  ["slideSpeedCap", 0.3, 4, 0.05],
  ["shockRadius", 0, 1, 0.01],
  ["shockStrength", 0, 3, 0.05],
  ["fanSpread", 0, 0.4, 0.005],
  ["landScatter", 0, 1.2, 0.05],
  ["spawnGapMin", 0, 4, 0.1],
  ["spawnGapVar", 0, 3, 0.1],
  ["grainSize", 0.5, 3, 0.05],
  ["grainSizeVar", 0, 2, 0.05],
];
const VIS_COLOR_KEYS = ["sand", "canopyA", "canopyB", "frame", "rimColor"] as const;
const VIS_NUM_DEFS: Array<[string, number, number, number]> = [
  ["emissive", 0, 1, 0.01],
  ["ambient", 0, 2, 0.05],
  ["key", 0, 2, 0.05],
  ["rim", 0, 2, 0.05],
  ["backGlow", 0, 1, 0.02],
  ["backGlowSize", 2, 10, 0.1],
];
const panel = document.createElement("div");
panel.style.cssText = "position:fixed;right:10px;bottom:10px;z-index:9999;width:270px;max-height:74vh;overflow:auto;background:#0d0f13f2;color:#dde3ea;font:11px/1.5 ui-monospace,monospace;padding:10px;border-radius:10px;border:1px solid #2a2f37";
const dragBar = document.createElement("div");
dragBar.textContent = "⠿ Hero tuning — drag me";
dragBar.style.cssText = "cursor:grab;user-select:none;margin:-10px -10px 6px;padding:8px 10px;background:#161a20;border-bottom:1px solid #2a2f37;border-radius:10px 10px 0 0;font-weight:700;color:#9aa4b0;position:sticky;top:-10px;z-index:1";
dragBar.onpointerdown = (e) => {
  e.preventDefault();
  const rect = panel.getBoundingClientRect();
  const offX = e.clientX - rect.left;
  const offY = e.clientY - rect.top;
  dragBar.style.cursor = "grabbing";
  const move = (ev: PointerEvent) => {
    panel.style.left = `${Math.max(0, Math.min(window.innerWidth - rect.width, ev.clientX - offX))}px`;
    panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - offY))}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  };
  const up = () => {
    dragBar.style.cursor = "grab";
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
};
panel.appendChild(dragBar);
function addSection(title: string) {
  const el = document.createElement("div");
  el.textContent = title;
  el.style.cssText = "margin:8px 0 4px;font-weight:700;color:#9aa4b0;text-transform:uppercase;font-size:10px;letter-spacing:0.06em";
  panel.appendChild(el);
}
function addRange(label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void) {
  const rowEl = document.createElement("label");
  rowEl.style.cssText = "display:flex;align-items:center;gap:6px;margin:2px 0";
  const name = document.createElement("span");
  name.textContent = label;
  name.style.cssText = "flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  const val = document.createElement("span");
  val.textContent = String(get());
  val.style.cssText = "width:46px;text-align:right;color:#8fd3a8";
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(get());
  input.style.cssText = "width:88px;accent-color:#f6821f";
  input.oninput = () => {
    const v = parseFloat(input.value);
    set(v);
    val.textContent = String(v);
  };
  rowEl.appendChild(name);
  rowEl.appendChild(input);
  rowEl.appendChild(val);
  panel.appendChild(rowEl);
}
function addColor(label: string, get: () => string, set: (v: string) => void) {
  const rowEl = document.createElement("label");
  rowEl.style.cssText = "display:flex;align-items:center;gap:6px;margin:2px 0";
  const name = document.createElement("span");
  name.textContent = label;
  name.style.cssText = "flex:1 1 auto";
  const input = document.createElement("input");
  input.type = "color";
  input.value = get();
  input.style.cssText = "width:40px;height:20px;border:none;background:none;padding:0";
  input.oninput = () => set(input.value);
  rowEl.appendChild(name);
  rowEl.appendChild(input);
  panel.appendChild(rowEl);
}
const copyBtn = document.createElement("button");
copyBtn.textContent = "Copy parameters";
copyBtn.style.cssText = "width:100%;margin:2px 0 6px;padding:6px;border-radius:6px;border:1px solid #3a404a;background:#f6821f;color:#fff;font-weight:700;cursor:pointer";
copyBtn.onclick = () => {
  void navigator.clipboard.writeText(JSON.stringify({ physics: P, visual: VIS }, null, 2)).then(() => {
    copyBtn.textContent = "Copied";
    setTimeout(() => {
      copyBtn.textContent = "Copy parameters";
    }, 1200);
  });
};
panel.appendChild(copyBtn);
addSection("Physics");
for (const [k, mn, mx, st] of PHYS_DEFS) {
  addRange(k, mn, mx, st, () => (P as Record<string, number>)[k] ?? 0, (v) => {
    (P as Record<string, number>)[k] = v;
  });
}
for (const mode of ["light", "dark"] as const) {
  addSection(`${mode} mode`);
  for (const ck of VIS_COLOR_KEYS) {
    addColor(ck, () => VIS[mode][ck], (v) => {
      VIS[mode][ck] = v;
      applyVisuals();
    });
  }
  for (const [k, mn, mx, st] of VIS_NUM_DEFS) {
    addRange(k, mn, mx, st, () => (VIS[mode] as unknown as Record<string, number>)[k] ?? 0, (v) => {
      (VIS[mode] as unknown as Record<string, number>)[k] = v;
      applyVisuals();
    });
  }
}
// Hidden by default; open the page with #tune to show it.
if (window.location.hash === "#tune") document.body.appendChild(panel);

computeView();
applyVisuals();
if (reduce) {
  // Static render: place a full field of numbers for the single frame.
  for (let c = 0; c < CLOUDS; c++) spawnCloud(c, true);
} else {
  // Seed the spawn schedule instead of pre-placing numbers, so the rain
  // starts at the same steady cadence it keeps forever.
  for (let c = 0; c < CLOUDS; c++) {
    clouds[c] = { vy: 0, alive: 0, spawnAt: c * (P.spawnGapMin + P.spawnGapVar * 0.5), ix: 0, iy: 0, iz: 0, in: 0 };
  }
  nextSpawnAt = CLOUDS * (P.spawnGapMin + P.spawnGapVar * 0.5);
}

let raf = 0;
const clock = new Clock();
// Simulation time advances only while ticking and at most one clamped step
// per frame, so a paused or throttled tab never accrues a backlog of due
// spawns that would all fall at once on resume.
let simT = 0;

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  simT += dt;
  const t = simT;

  umbrella.rotation.z = Math.sin(t * 0.5) * 0.04;
  umbrella.rotation.y = Math.sin(t * 0.35) * 0.12;
  umbrella.rotation.x = Math.sin(t * 0.4) * 0.025;
  umbrella.updateMatrixWorld();
  invQ.copy(umbrella.quaternion).invert();
  const ux = umbrella.position.x;
  const uy = umbrella.position.y;
  const uz = umbrella.position.z;

  const bottom = center.y - viewH / 2 - 0.4;
  const side = viewW / 2 + 1.6;
  // Grains fade near both canvas edges: falling numbers ease in at the
  // top instead of popping in over the text, and run-off never visibly
  // piles onto the section below the hero. The umbrella itself is never
  // masked.
  const canvasBottom = center.y - viewH / 2;
  const canvasTop = center.y + viewH / 2;
  const fadeZone = viewH * 0.1;

  for (let c = 0; c < CLOUDS; c++) {
    const cloud = clouds[c]!;
    if (cloud.alive <= 0) {
      if (c >= cloudLimit) continue;
      if (cloud.spawnAt < 0) {
        nextSpawnAt = Math.max(nextSpawnAt, t) + P.spawnGapMin + Math.random() * P.spawnGapVar;
        cloud.spawnAt = nextSpawnAt;
      } else if (t >= cloud.spawnAt) {
        spawnCloud(c);
      }
      continue;
    }
    cloud.vy = Math.max(cloud.vy - P.gravity * dt, -P.numberTerminal);
    const dyR = cloud.vy * dt;
    const baseP = c * MAX_P;
    // Last frame's impact centroid drives a shockwave through the grains
    // that haven't touched down yet.
    const hasWave = cloud.in > 0;
    const wx = hasWave ? cloud.ix / cloud.in : 0;
    const wy = hasWave ? cloud.iy / cloud.in : 0;
    const wz = hasWave ? cloud.iz / cloud.in : 0;
    cloud.ix = 0;
    cloud.iy = 0;
    cloud.iz = 0;
    cloud.in = 0;
    for (let k = 0; k < MAX_P; k++) {
      const j = baseP + k;
      const st = pState[j];
      if (st === 0) continue;
      const b = j * 3;
      let x = pPos[b] ?? 0;
      let y = pPos[b + 1] ?? 0;
      let z = pPos[b + 2] ?? 0;
      let vx = pVel[b] ?? 0;
      let vy = pVel[b + 1] ?? 0;
      let vz = pVel[b + 2] ?? 0;
      if (st === 1) {
        // Rigid grain: falls with its cloud, keeping the glyph shape.
        y += dyR;
        vy = cloud.vy;
        // Shockwave: impacts below push nearby rigid grains loose, so
        // the whole number deforms instead of leaving untouched slabs.
        if (hasWave) {
          const ddx = x - wx;
          const ddy = y - wy;
          const ddz = z - wz;
          const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
          if (dist < P.shockRadius) {
            const s = (1 - dist / P.shockRadius) * (0.3 + Math.random() * 0.3) * P.shockStrength;
            const inv = 1 / (dist || 1e-3);
            // Horizontal push only; an upward component made shocked
            // grains look like they bounced off the fabric.
            pState[j] = 2;
            vx = ddx * inv * s * 0.7;
            vy = cloud.vy * 0.6;
            vz = ddz * inv * s * 0.5;
          }
        }
        // A grain the canopy never reached (outside the silhouette)
        // melts into loose dust as it passes canopy level, so no intact
        // text ever survives below the umbrella.
        if (y < uy + 0.15) {
          pState[j] = 2;
          vx = (Math.random() - 0.5) * 0.18;
          vz = (Math.random() - 0.5) * 0.12;
        }
      } else if (st === 2) {
        // Loose grain: individual sand physics with light dust wander.
        // Grains never fade on the umbrella; they live until they slide
        // off and fall past the bottom of the canvas.
        vx += (Math.random() - 0.5) * 0.18 * dt;
        // Terminal velocity limits acceleration only. Clamping a grain
        // that was already faster snapped its speed upward at the rim,
        // kicking run-off into a flat sideways jet.
        if (vy > -P.looseTerminal) vy = Math.max(vy - P.gravity * P.looseGravityMult * dt, -P.looseTerminal);
        vz += (Math.random() - 0.5) * 0.12 * dt;
        x += vx * dt;
        y += vy * dt;
        z += vz * dt;
      } else {
        // On-surface grain: glued to the fabric and integrated strictly
        // along it in the umbrella's live local frame. No per-frame
        // contact re-detection, so zero forces means zero motion; the
        // grain only leaves this state by crossing the rim.
        lv.set(x - ux, y - uy, z - uz).applyQuaternion(invQ);
        wv.set(vx, vy, vz).applyQuaternion(invQ);
        const r = Math.hypot(lv.x, lv.z) || 1e-3;
        const ang = Math.atan2(lv.z, lv.x);
        const sfc = profileAt(r, ang);
        const downhill = (profileAt(Math.min(r + 0.08, SCAN_R), ang).h - sfc.h) / 0.08;
        const acc = Math.min(P.slideAccMax, Math.max(P.slideAccMin, -downhill * P.slideSlopeMult)) * dt;
        const spreadA = ((j % 9) - 4) * P.fanSpread;
        const ca = Math.cos(spreadA);
        const sa = Math.sin(spreadA);
        const rdx = lv.x / r;
        const rdz = lv.z / r;
        wv.x = wv.x * P.friction + (rdx * ca - rdz * sa) * acc + (Math.random() - 0.5) * 0.015 * dt;
        wv.z = wv.z * P.friction + (rdx * sa + rdz * ca) * acc + (Math.random() - 0.5) * 0.01 * dt;
        const sp = Math.hypot(wv.x, wv.z);
        if (sp > P.slideSpeedCap) {
          wv.x *= P.slideSpeedCap / sp;
          wv.z *= P.slideSpeedCap / sp;
        }
        lv.x += wv.x * dt;
        lv.z += wv.z * dt;
        const r2 = Math.hypot(lv.x, lv.z) || 1e-3;
        const s2 = profileAt(r2, Math.atan2(lv.z, lv.x));
        const radialSpeed = wv.x * (lv.x / r2) + wv.z * (lv.z / r2);
        wv.y = Math.min(0, downhill * radialSpeed) - P.pressIn;
        if (r2 >= s2.rim - 0.03) {
          // Slid off the rim (slightly conservative, so grains never
          // ride past the visible fabric edge): release into free fall
          // with the tangent velocity it had, for a continuous pour.
          pState[j] = 2;
        } else {
          lv.y = s2.h + 0.01;
        }
        wv.applyQuaternion(umbrella.quaternion);
        vx = wv.x;
        vy = wv.y;
        vz = wv.z;
        lv.applyQuaternion(umbrella.quaternion);
        x = lv.x + ux;
        y = lv.y + uy;
        z = lv.z + uz;
      }
      // Contact detection for falling grains only (rigid or loose): on
      // contact the grain converts to the on-surface state, which owns
      // all further sliding. Only grains near the canopy pay for the
      // local-frame transform.
      if (pState[j] !== 3 && profReady && vy < 0.3 && y > uy - 0.6 && y < uy + 1.9 && Math.abs(x - ux) < 2.6 && Math.abs(z - uz) < 2.6) {
        lv.set(x - ux, y - uy, z - uz).applyQuaternion(invQ);
        const r = Math.hypot(lv.x, lv.z);
        const ang = Math.atan2(lv.z, lv.x);
        const sfc = profileAt(r, ang);
        if (r < sfc.rim && lv.y <= sfc.h + P.stickyBand && lv.y > sfc.h - 0.5) {
          lv.y = sfc.h + 0.01;
          wv.set(vx, vy, vz).applyQuaternion(invQ);
          // Landing momentum: the fall speed redirects outward once.
          const redirect = Math.max(0, -wv.y) * P.momentumKeep;
          const inv = 1 / (r || 1e-3);
          wv.x += lv.x * inv * redirect;
          wv.z += lv.z * inv * redirect;
          wv.y = 0;
          if (st === 1) {
            // First contact of a rigid grain: scatter tangentially so
            // the landing slab spreads into a patch, and feed the impact
            // centroid that shocks the rest of the number next frame.
            wv.x += (Math.random() - 0.5) * P.landScatter;
            wv.z += (Math.random() - 0.5) * P.landScatter;
            cloud.ix += x;
            cloud.iy += y;
            cloud.iz += z;
            cloud.in++;
          }
          pState[j] = 3;
          wv.applyQuaternion(umbrella.quaternion);
          vx = wv.x;
          vy = wv.y;
          vz = wv.z;
          lv.applyQuaternion(umbrella.quaternion);
          x = lv.x + ux;
          y = lv.y + uy;
          z = lv.z + uz;
        }
      }
      if (y < bottom || Math.abs(x - center.x) > side) {
        pState[j] = 0;
        pFade[j] = 0;
        cloud.alive--;
      } else {
        pPos[b] = x;
        pPos[b + 1] = y;
        pPos[b + 2] = z;
        pVel[b] = vx;
        pVel[b + 1] = vy;
        pVel[b + 2] = vz;
        pFade[j] = Math.min(
          1,
          Math.max(0, (y - canvasBottom) / fadeZone),
          Math.max(0, (canvasTop - y) / fadeZone),
        );
      }
    }
  }
  pGeo.attributes.position!.needsUpdate = true;
  pGeo.attributes.aFade!.needsUpdate = true;
  pGeo.attributes.aSize!.needsUpdate = true;

  renderer.render(scene, camera);
  raf = requestAnimationFrame(tick);
}

// Pause the simulation entirely while the hero is scrolled out of view; the
// clock's delta clamp keeps the resume step small, so nothing jumps.
let visible = true;
let running = false;
function setRunning(next: boolean) {
  if (next === running) return;
  running = next;
  if (running) {
    clock.getDelta();
    raf = requestAnimationFrame(tick);
  } else {
    cancelAnimationFrame(raf);
  }
}
const io = new IntersectionObserver((entries) => {
  visible = entries.some((e) => e.isIntersecting);
  if (!reduce) setRunning(visible);
});
io.observe(mount);

if (reduce) {
  renderer.render(scene, camera);
} else {
  running = true;
  raf = requestAnimationFrame(tick);
}

function onResize() {
  width = mount!.clientWidth || width;
  height = mount!.clientHeight || height;
  renderer.setSize(width, height);
  computeView();
  updatePointScale();
  // setSize clears the drawing buffer; paint immediately so resizing never
  // shows a blank frame.
  renderer.render(scene, camera);
}
const ro = new ResizeObserver(onResize);
ro.observe(mount);

return () => {
  cancelAnimationFrame(raf);
  io.disconnect();
  ro.disconnect();
  mql.removeEventListener("change", applyVisuals);
  panel.remove();
  glowMat.map?.dispose();
  glowMat.dispose();
  pGeo.dispose();
  pMat.dispose();
  renderer.dispose();
  if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
};
}
