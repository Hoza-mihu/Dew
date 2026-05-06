const VIZ_SEL = ".about-globe-2d__viz";

function disposeObject3D(root) {
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
      else obj.material.dispose();
    }
  });
}

/** Deterministic 0..1 pseudo-random for stable plant layout */
function rnd(i, j = 0) {
  const x = Math.sin(i * 12.9898 + j * 78.233 + 91.7) * 43758.5453;
  return x - Math.floor(x);
}

async function mountAboutGlobe3d() {
  const host = document.querySelector(VIZ_SEL);
  if (!host) return () => {};

  const THREE = await import("three");

  const reduced =
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

  host.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.className = "about-globe-3d__canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Animated plant visualization");
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0.15, 0.35, 3.65);
  camera.lookAt(0, 0.55, 0);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene.add(new THREE.AmbientLight(0xb8e0d2, 0.42));
  const key = new THREE.DirectionalLight(0xffffff, 1.05);
  key.position.set(2.2, 5, 3.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xa8d4c8, 0.35);
  fill.position.set(-3, 2, -1);
  scene.add(fill);

  const spinGroup = new THREE.Group();
  const tiltGroup = new THREE.Group();
  const garden = new THREE.Group();
  spinGroup.add(tiltGroup);
  tiltGroup.add(garden);
  scene.add(spinGroup);

  const potMat = new THREE.MeshStandardMaterial({
    color: 0x4a3f3a,
    roughness: 0.85,
    metalness: 0.08,
  });
  const soilMat = new THREE.MeshStandardMaterial({
    color: 0x1f1812,
    roughness: 0.95,
    metalness: 0,
  });
  const stemMat = new THREE.MeshStandardMaterial({
    color: 0x2f5233,
    roughness: 0.72,
    metalness: 0,
  });

  const leafColors = [0x1b4332, 0x2d6a4f, 0x40916c, 0x52b788, 0x74c69d];

  const potGeom = new THREE.CylinderGeometry(0.5, 0.38, 0.42, 28);
  const pot = new THREE.Mesh(potGeom, potMat);
  pot.position.y = 0.21;
  pot.castShadow = false;
  garden.add(pot);

  const soilGeom = new THREE.CylinderGeometry(0.46, 0.49, 0.07, 28);
  const soil = new THREE.Mesh(soilGeom, soilMat);
  soil.position.y = 0.455;
  garden.add(soil);

  const soilTopY = 0.455 + 0.035;

  const sphereLeaf = new THREE.SphereGeometry(1, 10, 8);

  function addStemCluster(baseAngle, radius, stemIndex) {
    const stemCount = 2 + Math.floor(rnd(stemIndex, 1) * 2);
    for (let s = 0; s < stemCount; s += 1) {
      const ang =
        baseAngle + (s / stemCount) * Math.PI * 0.5 + (rnd(stemIndex, s) - 0.5) * 0.4;
      const rx = Math.cos(ang) * radius * 0.92;
      const rz = Math.sin(ang) * radius * 0.92;
      const h = 0.35 + rnd(stemIndex, s + 3) * 0.55;
      const stemGeom = new THREE.CylinderGeometry(0.018, 0.028, h, 8);
      const stem = new THREE.Mesh(stemGeom, stemMat);
      stem.position.set(rx, soilTopY + h * 0.5, rz);
      stem.rotation.z = (rnd(stemIndex, s + 5) - 0.5) * 0.25;
      stem.rotation.x = (rnd(stemIndex, s + 6) - 0.5) * 0.2;
      garden.add(stem);

      const tipY = soilTopY + h;
      const leafN = 4 + Math.floor(rnd(stemIndex, s + 7) * 3);
      for (let L = 0; L < leafN; L += 1) {
        const t = L / leafN;
        const ly = soilTopY + h * (0.35 + t * 0.62);
        const leafMat = new THREE.MeshStandardMaterial({
          color: leafColors[(stemIndex + L + s) % leafColors.length],
          roughness: 0.62,
          metalness: 0.02,
          side: THREE.DoubleSide,
        });
        const leaf = new THREE.Mesh(sphereLeaf, leafMat);
        const spread = 0.14 + rnd(stemIndex, L + 20) * 0.12;
        leaf.position.set(
          rx + (rnd(stemIndex, L) - 0.5) * spread,
          ly,
          rz + (rnd(stemIndex, L + 1) - 0.5) * spread,
        );
        leaf.scale.set(0.11 + rnd(stemIndex, L + 2) * 0.04, 0.04, 0.13);
        leaf.rotation.set(
          (rnd(stemIndex, L + 3) - 0.5) * 1.2,
          rnd(stemIndex, L + 4) * Math.PI * 2,
          (rnd(stemIndex, L + 5) - 0.5) * 0.8,
        );
        leaf.userData.phase = rnd(stemIndex, L + 8) * Math.PI * 2;
        leaf.userData.sway = 0.04 + rnd(stemIndex, L + 9) * 0.05;
        garden.add(leaf);
      }
    }
  }

  const clusters = 5;
  for (let c = 0; c < clusters; c += 1) {
    const baseAngle = (c / clusters) * Math.PI * 2 + rnd(c, 0) * 0.4;
    const radius = 0.08 + rnd(c, 2) * 0.18;
    addStemCluster(baseAngle, radius, c);
  }

  const swayLeaves = [];
  garden.traverse((o) => {
    if (o.userData?.phase != null) swayLeaves.push(o);
  });

  let targetYaw = 0;
  let targetPitch = 0;
  let pointerActive = false;
  const clock = new THREE.Clock();
  let visible = true;
  let raf = 0;
  let tAccum = 0;

  const resize = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(280, host.clientHeight);
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  const onPointerMove = (e) => {
    if (reduced) return;
    const rect = host.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    targetYaw = nx * 0.55;
    targetPitch = -ny * 0.35;
    pointerActive = true;
  };

  const onPointerLeave = () => {
    pointerActive = false;
    targetYaw = 0;
    targetPitch = 0;
  };

  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerleave", onPointerLeave);
  host.addEventListener("pointerdown", () => {
    host.style.cursor = "grabbing";
  });
  host.addEventListener("pointerup", () => {
    host.style.cursor = "grab";
  });

  const io = new IntersectionObserver(
    (entries) => {
      const e = entries[0];
      visible = e?.isIntersecting ?? true;
    },
    { root: null, threshold: 0.01 },
  );
  io.observe(host);

  const spinSpeed = reduced ? 0.04 : 0.22;
  const smooth = reduced ? 14 : 5;

  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!visible) return;

    const dt = Math.min(clock.getDelta(), 0.05);
    tAccum += dt;
    if (!pointerActive && !reduced) {
      spinGroup.rotation.y += dt * spinSpeed;
    }

    const wantYaw = pointerActive ? targetYaw : 0;
    const wantPitch = pointerActive ? targetPitch : 0;
    tiltGroup.rotation.y += (wantYaw - tiltGroup.rotation.y) * smooth * dt;
    tiltGroup.rotation.x += (wantPitch - tiltGroup.rotation.x) * smooth * dt;

    if (!reduced) {
      const w = 0.06 * Math.sin(tAccum * 1.1);
      for (const leaf of swayLeaves) {
        const ph = leaf.userData.phase;
        const sw = leaf.userData.sway;
        leaf.rotation.z = w + sw * Math.sin(tAccum * 2.2 + ph);
      }
    }

    renderer.render(scene, camera);
  };
  tick();

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    io.disconnect();
    host.removeEventListener("pointermove", onPointerMove);
    host.removeEventListener("pointerleave", onPointerLeave);
    disposeObject3D(spinGroup);
    renderer.dispose();
    host.innerHTML = "";
  };
}

let teardown = () => {};

function start() {
  mountAboutGlobe3d()
    .then((fn) => {
      teardown = typeof fn === "function" ? fn : () => {};
    })
    .catch(() => {});
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    teardown();
  });
}
