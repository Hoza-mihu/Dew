/**
 * Scroll-scrubbed image sequence → canvas (Apple-style “scrollytelling”).
 * Drop Whisk/Veo/EZGif frames into /scroll-sequence-frames/ and set data-* on #sequence.
 */

import {
  padIndex,
  parseTemplate,
  clamp,
  drawCover,
  fitCanvas,
  loadImagesBatched,
  getScrollProgress01,
} from "./scroll-scrub-canvas.js";

function main() {
  const section = document.getElementById("sequence");
  const canvas = document.getElementById("seq-canvas");
  const hud = document.getElementById("seq-hud");
  const progressEl = document.getElementById("seq-progress");
  const statusEl = document.getElementById("seq-status");
  const heroText = document.getElementById("seq-hero-text");

  if (!section || !canvas || !(canvas instanceof HTMLCanvasElement)) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

  const frameCount = Math.max(0, parseInt(section.dataset.frameCount || "0", 10) || 0);
  const indexStart = Math.max(0, parseInt(section.dataset.indexStart || "1", 10) || 0);
  const indexPad = Math.max(1, Math.min(8, parseInt(section.dataset.indexPad || "3", 10) || 3));
  const urlTemplate = section.dataset.urlTemplate || "/scroll-sequence-frames/{index}.png";
  const scrollVh = Math.max(100, parseInt(section.dataset.scrollVh || "450", 10) || 450);

  section.style.setProperty("--sequence-scroll-vh", `${scrollVh}vh`);

  if (reducedMotion) {
    section.style.setProperty("--sequence-scroll-vh", "120vh");
    if (heroText) heroText.textContent = "Reduced motion: static preview.";
  }

  let frames = [];
  let ready = false;

  const renderFrame = (idx) => {
    fitCanvas(canvas, ctx);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const img = frames[idx];
    if (img?.naturalWidth) drawCover(ctx, img, w, h);
  };

  const onScroll = () => {
    if (!ready || frameCount <= 0) return;
    const p = getScrollProgress01(section);
    const last = frameCount - 1;
    const idx = reducedMotion ? 0 : Math.round(p * last);
    renderFrame(idx);
    if (heroText && !reducedMotion) {
      const o = 1 - clamp(p * 2.2, 0, 1);
      heroText.style.opacity = String(o);
    }
  };

  let raf = 0;
  const onScrollRaf = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(onScroll);
  };

  window.addEventListener("scroll", onScrollRaf, { passive: true });
  window.addEventListener("resize", () => {
    fitCanvas(canvas, ctx);
    onScroll();
  });

  const boot = async () => {
    if (frameCount <= 0) {
      if (statusEl) statusEl.textContent = "Set data-frame-count and add frames (see HTML comment).";
      if (hud) hud.hidden = false;
      return;
    }

    const urls = [];
    for (let i = 0; i < frameCount; i += 1) {
      const n = indexStart + i;
      urls.push(parseTemplate(urlTemplate, padIndex(n, indexPad)));
    }

    if (statusEl) statusEl.textContent = "Loading frames…";
    if (hud) hud.hidden = false;

    try {
      frames = await loadImagesBatched(urls, 12, (done, total) => {
        if (progressEl) progressEl.textContent = `${done} / ${total}`;
      });
    } catch {
      if (statusEl) statusEl.textContent = "Some frames failed to decode; check paths and names.";
    }

    ready = true;
    if (statusEl) statusEl.textContent = "Scroll to scrub.";
    onScroll();
  };

  boot();
}

main();
