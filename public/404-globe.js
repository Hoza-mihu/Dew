import createGlobe from "cobe";

const CANVAS_ID = "notfoundGlobe";

function start() {
  const canvas = document.getElementById(CANVAS_ID);
  if (!(canvas instanceof HTMLCanvasElement)) return;

  let width = 0;
  const phiRef = { current: 0 };

  const onResize = () => {
    width = canvas.offsetWidth || 420;
  };
  onResize();
  window.addEventListener("resize", onResize);

  const globe = createGlobe(canvas, {
    devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    width: width * 2,
    height: width * 2,
    phi: 0,
    theta: 0.28,
    dark: 1,
    diffuse: 0.55,
    mapSamples: 16000,
    mapBrightness: 1.2,
    baseColor: [0.95, 0.95, 0.95],
    markerColor: [0.49, 0.95, 0.74],
    glowColor: [1, 1, 1],
    markers: [
      { location: [41.0082, 28.9784], size: 0.06 },
      { location: [40.7128, -74.006], size: 0.09 },
      { location: [34.6937, 135.5022], size: 0.05 },
      { location: [-23.5505, -46.6333], size: 0.08 },
    ],
    onRender: (state) => {
      phiRef.current += 0.005;
      state.phi = phiRef.current;
      state.width = width * 2;
      state.height = width * 2;
    },
  });

  // Improve canvas crispness and pointer feel
  canvas.style.cursor = "grab";
  canvas.addEventListener("pointerdown", () => {
    canvas.style.cursor = "grabbing";
  });
  window.addEventListener("pointerup", () => {
    canvas.style.cursor = "grab";
  });

  return () => {
    globe.destroy();
    window.removeEventListener("resize", onResize);
  };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

