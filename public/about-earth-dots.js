import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

const HOST_SEL = ".about-earth";
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
  const stepSize = dotSpacing * 0.08;

  for (let lng = minLng; lng <= maxLng; lng += stepSize) {
    for (let lat = minLat; lat <= maxLat; lat += stepSize) {
      const p = [lng, lat];
      if (pointInFeature(p, feature)) dots.push(p);
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

  let w = 1;
  let h = 1;
  let baseRadius = 220;
  const rotation = [0, 0];

  const projection = d3.geoOrthographic().clipAngle(90);
  const path = d3.geoPath(projection).context(ctx);

  let landFeatures = null;
  const allDots = [];

  const render = () => {
    ctx.clearRect(0, 0, w, h);
    const currentScale = projection.scale();
    const scaleFactor = currentScale / baseRadius;

    // Ocean / globe
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, currentScale, 0, 2 * Math.PI);
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fill();

    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 2 * scaleFactor;
    ctx.stroke();

    // Graticule
    const graticule = d3.geoGraticule();
    ctx.beginPath();
    path(graticule());
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1 * scaleFactor;
    ctx.stroke();

    if (landFeatures) {
      // Land outlines
      ctx.beginPath();
      for (const feature of landFeatures.features) path(feature);
      ctx.strokeStyle = "rgba(255,255,255,0.52)";
      ctx.lineWidth = 1 * scaleFactor;
      ctx.stroke();

      // Halftone dots
      for (const d of allDots) {
        const p = projection(d);
        if (!p) continue;
        const x = p[0];
        const y = p[1];
        if (x < 0 || x > w || y < 0 || y > h) continue;
        ctx.beginPath();
        ctx.arc(x, y, 1.15 * scaleFactor, 0, 2 * Math.PI);
        ctx.fillStyle = "rgba(255,255,255,0.38)";
        ctx.fill();
      }
    }
  };

  const resize = () => {
    const rect = host.getBoundingClientRect();
    w = Math.max(1, Math.floor(rect.width));
    h = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    baseRadius = Math.min(w, h) / 2.22;
    projection.scale(baseRadius).translate([w / 2, h / 2]);
    projection.rotate(rotation);
    render();
  };

  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  let autoRotate = true;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startRot = [0, 0];

  const onDown = (e) => {
    autoRotate = false;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startRot = [...rotation];
    host.style.cursor = "grabbing";
  };

  const onMove = (e) => {
    if (!dragging) return;
    const sensitivity = 0.5;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    rotation[0] = startRot[0] + dx * sensitivity;
    rotation[1] = clamp(startRot[1] - dy * sensitivity, -90, 90);
    projection.rotate(rotation);
    render();
  };

  const onUp = () => {
    dragging = false;
    host.style.cursor = "grab";
    setTimeout(() => {
      autoRotate = true;
    }, 10);
  };

  const onWheel = (e) => {
    e.preventDefault?.();
    const scaleFactor = e.deltaY > 0 ? 0.92 : 1.08;
    const next = clamp(projection.scale() * scaleFactor, baseRadius * 0.7, baseRadius * 1.9);
    projection.scale(next);
    render();
  };

  host.style.cursor = "grab";
  host.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  host.addEventListener("wheel", onWheel, { passive: false });

  const timer = d3.timer(() => {
    if (!autoRotate || dragging) return;
    rotation[0] += 0.45;
    projection.rotate(rotation);
    render();
  });

  fetch(LAND_URL)
    .then((r) => {
      if (!r.ok) throw new Error("Failed to load land data");
      return r.json();
    })
    .then((json) => {
      landFeatures = json;
      allDots.length = 0;
      for (const f of landFeatures.features) {
        const dots = generateDotsInPolygon(f, 16);
        for (const d of dots) allDots.push(d);
      }
      render();
    })
    .catch(() => {});

  return () => {
    timer.stop();
    ro.disconnect();
    host.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    host.removeEventListener("wheel", onWheel);
    host.innerHTML = "";
  };
}

function start() {
  const hosts = Array.from(document.querySelectorAll(HOST_SEL));
  const teardowns = hosts.map((h) => mountEarth(h));
  if (import.meta?.hot) {
    import.meta.hot.dispose(() => teardowns.forEach((t) => t?.()));
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

