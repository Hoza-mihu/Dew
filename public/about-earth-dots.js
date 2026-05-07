import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

const HOST_SEL = ".about-globe-2d__earth";
const LAND_URL =
  "https://raw.githubusercontent.com/martynafford/natural-earth-geojson/refs/heads/master/110m/physical/ne_110m_land.json";

function clamp(n, a, b) {
  return Math.min(b, Math.max(a, n));
}

function pointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInFeature(point, feature) {
  const geometry = feature.geometry;
  if (!geometry) return false;

  if (geometry.type === "Polygon") {
    const coordinates = geometry.coordinates;
    if (!pointInPolygon(point, coordinates[0])) return false;
    for (let i = 1; i < coordinates.length; i++) {
      if (pointInPolygon(point, coordinates[i])) return false;
    }
    return true;
  }

  if (geometry.type === "MultiPolygon") {
    for (const polygon of geometry.coordinates) {
      if (pointInPolygon(point, polygon[0])) {
        let inHole = false;
        for (let i = 1; i < polygon.length; i++) {
          if (pointInPolygon(point, polygon[i])) {
            inHole = true;
            break;
          }
        }
        if (!inHole) return true;
      }
    }
  }
  return false;
}

function generateDotsInPolygon(feature, dotSpacing = 16) {
  const dots = [];
  const bounds = d3.geoBounds(feature);
  const [[minLng, minLat], [maxLng, maxLat]] = bounds;

  // Smaller step -> denser dots. Chosen to match the “wireframe dotted globe” look.
  const stepSize = dotSpacing * 0.08;

  for (let lng = minLng; lng <= maxLng; lng += stepSize) {
    for (let lat = minLat; lat <= maxLat; lat += stepSize) {
      const point = [lng, lat];
      if (pointInFeature(point, feature)) dots.push(point);
    }
  }
  return dots;
}

async function mountEarth(host) {
  host.innerHTML = "";
  host.style.position = "relative";

  const canvas = document.createElement("canvas");
  canvas.className = "about-earth__canvas";
  host.appendChild(canvas);

  const hint = document.createElement("div");
  hint.className = "about-earth__hint";
  hint.textContent = "Drag to rotate • Scroll to zoom";
  host.appendChild(hint);

  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};

  const state = {
    w: 1,
    h: 1,
    radius: 220,
    dpr: 1,
    rotation: [0, 0],
    scaleBase: 220,
    autoRotate: true,
    dragging: false,
    startX: 0,
    startY: 0,
    startRotation: [0, 0],
  };

  const projection = d3.geoOrthographic().clipAngle(90);
  const path = d3.geoPath(projection).context(ctx);

  let landFeatures = null;
  const allDots = [];

  const resize = () => {
    const rect = host.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    state.w = w;
    state.h = h;
    state.dpr = dpr;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    // Reset transform before scaling (avoids compounding on repeated resizes).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    const radius = Math.min(w, h) / 2.35;
    state.radius = radius;
    state.scaleBase = radius;

    projection.scale(state.scaleBase).translate([w / 2, h / 2]);
    render();
  };

  const render = () => {
    const { w, h } = state;
    ctx.clearRect(0, 0, w, h);

    const currentScale = projection.scale();
    const scaleFactor = currentScale / state.scaleBase;

    // Globe background
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, currentScale, 0, 2 * Math.PI);
    ctx.fillStyle = "#000000";
    ctx.fill();

    // Subtle rim
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = 2 * scaleFactor;
    ctx.stroke();

    // Graticule (wireframe)
    const graticule = d3.geoGraticule();
    ctx.beginPath();
    path(graticule());
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1 * scaleFactor;
    ctx.stroke();

    if (landFeatures) {
      // Land outlines
      ctx.beginPath();
      landFeatures.features.forEach((feature) => path(feature));
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 1 * scaleFactor;
      ctx.stroke();

      // Halftone dots
      for (const dot of allDots) {
        const projected = projection([dot[0], dot[1]]);
        if (!projected) continue;
        const x = projected[0];
        const y = projected[1];
        if (x < 0 || x > w || y < 0 || y > h) continue;

        ctx.beginPath();
        ctx.arc(x, y, 1.05 * scaleFactor, 0, 2 * Math.PI);
        ctx.fillStyle = "rgba(255,255,255,0.42)";
        ctx.fill();
      }
    }
  };

  const loadWorldData = async () => {
    const res = await fetch(LAND_URL);
    if (!res.ok) throw new Error("Failed to load land data");
    landFeatures = await res.json();
    allDots.length = 0;
    for (const feature of landFeatures.features) {
      const dots = generateDotsInPolygon(feature, 16);
      for (const d of dots) allDots.push(d);
    }
    render();
  };

  const onPointerDown = (e) => {
    state.autoRotate = false;
    state.dragging = true;
    state.startX = e.clientX;
    state.startY = e.clientY;
    state.startRotation = [...state.rotation];
    host.style.cursor = "grabbing";
    try {
      host.setPointerCapture?.(e.pointerId);
    } catch {}
  };

  const onPointerMove = (e) => {
    if (!state.dragging) return;
    const sensitivity = 0.45;
    const dx = e.clientX - state.startX;
    const dy = e.clientY - state.startY;
    state.rotation[0] = state.startRotation[0] + dx * sensitivity;
    state.rotation[1] = clamp(state.startRotation[1] - dy * sensitivity, -90, 90);
    projection.rotate(state.rotation);
    render();
  };

  const onPointerUp = () => {
    state.dragging = false;
    host.style.cursor = "grab";
    // Resume auto-rotate almost immediately (feels like the reference component)
    setTimeout(() => {
      state.autoRotate = true;
    }, 10);
  };

  const onWheel = (e) => {
    e.preventDefault?.();
    const scaleFactor = e.deltaY > 0 ? 0.92 : 1.08;
    const next = clamp(
      projection.scale() * scaleFactor,
      state.scaleBase * 0.7,
      state.scaleBase * 1.8,
    );
    projection.scale(next);
    render();
  };

  const rotationSpeed = 0.35;
  const timer = d3.timer(() => {
    if (!state.autoRotate || state.dragging) return;
    state.rotation[0] += rotationSpeed;
    projection.rotate(state.rotation);
    render();
  });

  const ro = new ResizeObserver(resize);
  ro.observe(host);

  host.style.cursor = "grab";
  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("pointermove", onPointerMove);
  host.addEventListener("pointerup", onPointerUp);
  host.addEventListener("pointercancel", onPointerUp);
  host.addEventListener("wheel", onWheel, { passive: false });

  resize();
  loadWorldData().catch(() => {});

  return () => {
    timer.stop();
    ro.disconnect();
    host.removeEventListener("pointerdown", onPointerDown);
    host.removeEventListener("pointermove", onPointerMove);
    host.removeEventListener("pointerup", onPointerUp);
    host.removeEventListener("pointercancel", onPointerUp);
    host.removeEventListener("wheel", onWheel);
    host.innerHTML = "";
  };
}

async function start() {
  const hosts = Array.from(document.querySelectorAll(HOST_SEL));
  if (!hosts.length) return;
  const teardowns = [];
  for (const host of hosts) {
    // eslint-disable-next-line no-await-in-loop
    const td = await mountEarth(host);
    teardowns.push(td);
  }
  if (import.meta?.hot) {
    import.meta.hot.dispose(() => {
      for (const td of teardowns) td?.();
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

