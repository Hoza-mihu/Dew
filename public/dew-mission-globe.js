import createGlobe from "cobe";

const CANVAS_ID = "missionGlobe";

function clamp(n, a, b) {
  return Math.min(b, Math.max(a, n));
}

function start() {
  const canvas = document.getElementById(CANVAS_ID);
  if (!(canvas instanceof HTMLCanvasElement)) return;

  let width = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const phiRef = { current: 0 };
  const thetaRef = { current: 0.28 };

  const onResize = () => {
    width = canvas.offsetWidth || 520;
  };
  onResize();
  window.addEventListener("resize", onResize);

  const globe = createGlobe(canvas, {
    devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    width: width * 2,
    height: width * 2,
    phi: 0,
    theta: thetaRef.current,
    dark: 1,
    diffuse: 0.7,
    mapSamples: 24000,
    mapBrightness: 1.25,
    baseColor: [0.95, 0.95, 0.95],
    markerColor: [0.49, 0.95, 0.74],
    glowColor: [1, 1, 1],
    markers: [
      { location: [51.5072, -0.1276], size: 0.07 }, // London
      { location: [40.7128, -74.006], size: 0.09 }, // NYC
      { location: [28.6139, 77.209], size: 0.08 }, // Delhi
      { location: [-1.2921, 36.8219], size: 0.08 }, // Nairobi
    ],
    onRender: (state) => {
      if (!dragging) phiRef.current += 0.0048;
      state.phi = phiRef.current;
      state.theta = thetaRef.current;
      state.width = width * 2;
      state.height = width * 2;
    },
  });

  canvas.style.cursor = "grab";

  const onDown = (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
    canvas.style.cursor = "grabbing";
  };

  const onMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    phiRef.current += dx * 0.005;
    thetaRef.current = clamp(thetaRef.current - dy * 0.003, -0.2, 1.2);
  };

  const onUp = () => {
    dragging = false;
    canvas.style.cursor = "grab";
  };

  const onWheel = (e) => {
    // "zoom" effect by slightly shifting theta; keeps implementation tiny
    e.preventDefault?.();
    thetaRef.current = clamp(thetaRef.current + (e.deltaY > 0 ? 0.04 : -0.04), -0.2, 1.2);
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  return () => {
    globe.destroy();
    window.removeEventListener("resize", onResize);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("wheel", onWheel);
  };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

