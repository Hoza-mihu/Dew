"use client";

import createGlobe, { type COBEOptions } from "cobe";
import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const DEFAULT_CONFIG: COBEOptions = {
  width: 600,
  height: 600,
  onRender: () => {},
  devicePixelRatio: Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2),
  phi: 0,
  theta: 0.3,
  dark: 1,
  diffuse: 0.55,
  mapSamples: 16000,
  mapBrightness: 1.2,
  baseColor: [0.95, 0.95, 0.95],
  markerColor: [0.49, 0.95, 0.74],
  glowColor: [1, 1, 1],
  markers: [
    { location: [41.0082, 28.9784], size: 0.06 },
    { location: [40.7128, -74.006], size: 0.1 },
    { location: [34.6937, 135.5022], size: 0.05 },
    { location: [-23.5505, -46.6333], size: 0.1 },
  ],
};

export interface GlobeProps {
  className?: string;
  config?: COBEOptions;
}

export default function Globe({ className, config = DEFAULT_CONFIG }: GlobeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phiRef = useRef(0);
  const widthRef = useRef(0);
  const baseSizeRef = useRef<number>(typeof config.width === "number" ? config.width : 600);

  const onRender = useCallback((state: Record<string, unknown>) => {
    phiRef.current += 0.005;
    (state as any).phi = phiRef.current;
    (state as any).width = widthRef.current * 2;
    (state as any).height = widthRef.current * 2;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleResize = () => {
      const w = canvas.offsetWidth;
      // In some fixed/translated layouts offsetWidth can be 0 briefly.
      // Use a stable fallback size so the globe always renders.
      widthRef.current = Math.max(1, w || baseSizeRef.current || 600);
    };

    handleResize();
    window.addEventListener("resize", handleResize);

    const globe = createGlobe(canvas, {
      ...config,
      width: widthRef.current * 2,
      height: widthRef.current * 2,
      onRender,
    });

    return () => {
      globe.destroy();
      window.removeEventListener("resize", handleResize);
    };
  }, [config, onRender]);

  return (
    <div
      className={cn(
        // Explicit width prevents 0px measurements in fixed-position parents
        "relative aspect-square w-[520px] max-w-[78vw] sm:w-[560px] sm:max-w-[70vw]",
        className
      )}
    >
      <canvas ref={canvasRef} className="size-full [contain:layout_paint_size]" />
    </div>
  );
}

