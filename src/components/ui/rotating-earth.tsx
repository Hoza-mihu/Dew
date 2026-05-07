"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { cn } from "@/lib/utils";

export interface RotatingEarthProps {
  /** Max canvas CSS width; scales down responsively. */
  maxWidth?: number;
  /** Aspect ratio = width / height */
  aspect?: number;
  className?: string;
}

type LandGeoJson = GeoJSON.FeatureCollection<GeoJSON.Geometry, any>;

const LAND_URL =
  "https://raw.githubusercontent.com/martynafford/natural-earth-geojson/refs/heads/master/110m/physical/ne_110m_land.json";

function clamp(n: number, a: number, b: number) {
  return Math.min(b, Math.max(a, n));
}

function pointInPolygon(point: [number, number], polygon: number[][]) {
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

function pointInFeature(point: [number, number], feature: any) {
  const geometry = feature?.geometry;
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
    return false;
  }

  return false;
}

function generateDotsInPolygon(feature: any, dotSpacing = 16) {
  const dots: [number, number][] = [];
  const bounds = d3.geoBounds(feature as any);
  const [[minLng, minLat], [maxLng, maxLat]] = bounds as any;
  const stepSize = dotSpacing * 0.08;

  for (let lng = minLng; lng <= maxLng; lng += stepSize) {
    for (let lat = minLat; lat <= maxLat; lat += stepSize) {
      const p: [number, number] = [lng, lat];
      if (pointInFeature(p, feature)) dots.push(p);
    }
  }
  return dots;
}

export default function RotatingEarth({ maxWidth = 780, aspect = 1, className }: RotatingEarthProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // Cache fetched land data across mounts.
  const landPromiseRef = useRef<Promise<LandGeoJson> | null>(null);

  const sizeStyle = useMemo(() => {
    // Explicit sizing helps avoid 0px canvas measurements in fixed-position layouts.
    return { width: `min(${maxWidth}px, 78vw)` };
  }, [maxWidth]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 1;
    let h = 1;
    let baseRadius = 220;
    const rotation: [number, number] = [0, 0];
    let autoRotate = true;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startRot: [number, number] = [0, 0];

    const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

    const projection = d3.geoOrthographic().clipAngle(90);
    const path = d3.geoPath(projection as any).context(ctx as any);
    const graticule = d3.geoGraticule();

    let land: LandGeoJson | null = null;
    const dots: [number, number][] = [];

    const render = () => {
      ctx.clearRect(0, 0, w, h);

      const currentScale = projection.scale() as number;
      const scaleFactor = currentScale / baseRadius;

      // Ocean / globe background
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, currentScale, 0, 2 * Math.PI);
      ctx.fillStyle = "#000000";
      ctx.fill();

      // Outer ring
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2 * scaleFactor;
      ctx.globalAlpha = 0.75;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Graticule
      ctx.beginPath();
      path(graticule() as any);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1 * scaleFactor;
      ctx.globalAlpha = 0.25;
      ctx.stroke();
      ctx.globalAlpha = 1;

      if (land) {
        // Land outlines
        ctx.beginPath();
        for (const f of land.features) path(f as any);
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = 1 * scaleFactor;
        ctx.globalAlpha = 0.7;
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Halftone dots
        ctx.fillStyle = "rgba(255,255,255,0.55)";
        for (const d of dots) {
          const p = projection(d as any) as [number, number] | null;
          if (!p) continue;
          const x = p[0];
          const y = p[1];
          if (x < 0 || x > w || y < 0 || y > h) continue;
          ctx.beginPath();
          ctx.arc(x, y, 1.2 * scaleFactor, 0, 2 * Math.PI);
          ctx.fill();
        }
      }

      // Vignette for depth
      const g = ctx.createRadialGradient(w / 2, h / 2, currentScale * 0.65, w / 2, h / 2, currentScale * 1.2);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(0,0,0,0.75)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.fill();
    };

    const resize = () => {
      const rect = host.getBoundingClientRect();
      w = Math.max(1, Math.floor(rect.width));
      h = Math.max(1, Math.floor(w / aspect));

      const px = dpr();
      canvas.width = Math.floor(w * px);
      canvas.height = Math.floor(h * px);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(px, px);

      baseRadius = Math.min(w, h) / 2.2;
      projection.scale(baseRadius).translate([w / 2, h / 2]).rotate(rotation);
      render();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    const timer = d3.timer(() => {
      if (!autoRotate || dragging) return;
      rotation[0] += 0.45;
      projection.rotate(rotation);
      render();
    });

    const onDown = (e: PointerEvent) => {
      autoRotate = false;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startRot = [rotation[0], rotation[1]];
      (e.target as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
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
      setTimeout(() => {
        autoRotate = true;
      }, 10);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const scaleFactor = e.deltaY > 0 ? 0.92 : 1.08;
      const next = clamp((projection.scale() as number) * scaleFactor, baseRadius * 0.7, baseRadius * 2.2);
      projection.scale(next);
      render();
    };

    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const load = async () => {
      try {
        setError(null);
        if (!landPromiseRef.current) {
          landPromiseRef.current = fetch(LAND_URL).then(async (r) => {
            if (!r.ok) throw new Error("Failed to load land data");
            return (await r.json()) as LandGeoJson;
          });
        }
        land = await landPromiseRef.current;
        dots.length = 0;
        for (const f of land.features) {
          const pts = generateDotsInPolygon(f, 16);
          for (const p of pts) dots.push(p);
        }
        render();
      } catch (_) {
        setError("Failed to load Earth visualization");
      }
    };

    load();

    return () => {
      timer.stop();
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [aspect]);

  return (
    <div ref={hostRef} className={cn("relative", className)} style={sizeStyle}>
      <canvas ref={canvasRef} className="block w-full rounded-2xl bg-black" />
      <div className="pointer-events-none absolute bottom-4 left-4 text-xs text-white/70 bg-black/60 border border-white/10 px-2 py-1 rounded-md backdrop-blur">
        Drag to rotate • Scroll to zoom
      </div>
      {error && (
        <div className="absolute inset-0 grid place-items-center rounded-2xl bg-black/80">
          <div className="text-center">
            <p className="text-white font-semibold">Error loading Earth visualization</p>
            <p className="text-white/60 text-sm mt-1">{error}</p>
          </div>
        </div>
      )}
    </div>
  );
}

