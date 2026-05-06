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
  canvas.setAttribute("aria-label", "Animated data globe");
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 0.28, 4.35);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 0);

  const spinGroup = new THREE.Group();
  const tiltGroup = new THREE.Group();
  const rings = new THREE.Group();
  spinGroup.add(tiltGroup);
  tiltGroup.add(rings);
  scene.add(spinGroup);

  const R = 1;
  const ringCount = 20;
  const segments = 128;

  for (let i = 0; i < ringCount; i += 1) {
    const u = i / (ringCount - 1);
    const phi = (u * 2 - 1) * (Math.PI / 2) * 0.94;
    const y = Math.sin(phi) * R;
    const r = Math.cos(phi) * R;
    const mid = Math.floor(ringCount / 2);
    const isHot = i === mid;
    const isAccent = i % 2 === 1;

    const curve = new THREE.EllipseCurve(0, 0, r, r, 0, Math.PI * 2, false, 0);
    const pts = curve.getPoints(segments);
    const geometry = new THREE.BufferGeometry().setFromPoints(pts);
    let color;
    let opacity;
    if (isHot) {
      color = 0xff6b9d;
      opacity = 1;
    } else if (isAccent) {
      color = 0xf43f5e;
      opacity = 0.92;
    } else {
      color = 0x6b7280;
      opacity = 0.38;
    }

    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
    });
    const line = new THREE.LineLoop(geometry, material);
    line.rotation.x = Math.PI / 2;
    line.position.y = y;
    if (isHot) {
      const glowGeom = geometry.clone();
      const glowMat = new THREE.LineBasicMaterial({
        color: 0xff8fab,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
      });
      const glow = new THREE.LineLoop(glowGeom, glowMat);
      glow.rotation.x = Math.PI / 2;
      glow.position.y = y;
      glow.scale.multiplyScalar(1.04);
      rings.add(glow);
    }
    rings.add(line);
  }

  let targetYaw = 0;
  let targetPitch = 0;
  let pointerActive = false;
  const clock = new THREE.Clock();
  let visible = true;
  let raf = 0;

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
    targetYaw = nx * 0.65;
    targetPitch = -ny * 0.42;
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

  const spinSpeed = reduced ? 0.06 : 0.38;
  const smooth = reduced ? 14 : 5;

  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!visible) return;

    const dt = Math.min(clock.getDelta(), 0.05);
    if (!pointerActive && !reduced) {
      spinGroup.rotation.y += dt * spinSpeed;
    }

    const wantYaw = pointerActive ? targetYaw : 0;
    const wantPitch = pointerActive ? targetPitch : 0;
    tiltGroup.rotation.y += (wantYaw - tiltGroup.rotation.y) * smooth * dt;
    tiltGroup.rotation.x += (wantPitch - tiltGroup.rotation.x) * smooth * dt;

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
