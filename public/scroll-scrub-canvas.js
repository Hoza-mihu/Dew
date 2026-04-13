/** Shared helpers: scroll-linked canvas image scrub (Apple-style scrollytelling). */

export function padIndex(n, width) {
  const s = String(n);
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

export function parseTemplate(template, indexStr) {
  return template.replace(/\{index\}/g, indexStr);
}

export function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

export function drawCover(ctx, img, cw, ch) {
  if (!img?.naturalWidth) return;
  const ir = img.naturalWidth / img.naturalHeight;
  const cr = cw / ch;
  let dw;
  let dh;
  let ox;
  let oy;
  if (ir > cr) {
    dh = ch;
    dw = dh * ir;
    ox = (cw - dw) / 2;
    oy = 0;
  } else {
    dw = cw;
    dh = dw / ir;
    ox = 0;
    oy = (ch - dh) / 2;
  }
  ctx.drawImage(img, ox, oy, dw, dh);
}

export function fitCanvas(canvas, ctx) {
  const rawDpr = window.devicePixelRatio || 1;
  const dpr = Math.min(Math.max(rawDpr, 1), 3);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w <= 0 || h <= 0) return;
  const nw = Math.max(1, Math.round(w * dpr));
  const nh = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== nw || canvas.height !== nh) {
    canvas.width = nw;
    canvas.height = nh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  if ("imageSmoothingQuality" in ctx) {
    ctx.imageSmoothingQuality = "high";
  }
}

export async function loadImagesBatched(urls, batchSize, onProgress) {
  const images = new Array(urls.length);
  let done = 0;
  for (let i = 0; i < urls.length; i += batchSize) {
    const slice = urls.slice(i, i + batchSize);
    await Promise.all(
      slice.map(async (url, j) => {
        const idx = i + j;
        const img = new Image();
        img.decoding = "async";
        img.src = url;
        await img.decode().catch(() => {});
        images[idx] = img;
        done += 1;
        onProgress?.(done, urls.length);
      }),
    );
  }
  return images;
}

/** Scroll progress 0..1 through a tall track (sticky scrolly pattern). */
export function getScrollProgress01(trackEl) {
  if (!trackEl) return 0;
  const rect = trackEl.getBoundingClientRect();
  const trackTop = window.scrollY + rect.top;
  const travel = Math.max(1, trackEl.offsetHeight - window.innerHeight);
  return clamp((window.scrollY - trackTop) / travel, 0, 1);
}

/**
 * @param {HTMLElement} trackEl - Tall element (height defines scrub travel)
 * @param {HTMLCanvasElement} canvasEl
 * @param {object} opts
 * @param {string[]} opts.urls
 * @param {boolean} opts.reducedMotion
 * @param {(progress01: number, frameIndex: number, frameCount: number) => void} [opts.onScrub]
 * @param {() => void} [opts.onFirstDraw]
 * @returns {() => void} destroy
 */
export function mountCanvasScrollScrub(trackEl, canvasEl, opts) {
  const { urls, reducedMotion, onScrub, onFirstDraw } = opts;
  const ctx = canvasEl.getContext("2d", { alpha: false });
  if (!ctx) return () => {};

  const ac = new AbortController();
  const { signal } = ac;
  let frames = [];
  let ready = false;
  let drewOnce = false;

  const resolveFrameIndex = (idx) => {
    const last = frames.length - 1;
    const safe = clamp(Math.round(idx), 0, Math.max(0, last));
    if (frames[safe]?.naturalWidth) return safe;
    for (let d = 1; d <= frames.length; d += 1) {
      const lo = safe - d;
      const hi = safe + d;
      if (lo >= 0 && frames[lo]?.naturalWidth) return lo;
      if (hi <= last && frames[hi]?.naturalWidth) return hi;
    }
    return safe;
  };

  const renderFrame = (idx) => {
    fitCanvas(canvasEl, ctx);
    const w = canvasEl.clientWidth;
    const h = canvasEl.clientHeight;
    if (w <= 0 || h <= 0) return;
    ctx.clearRect(0, 0, w, h);
    const i = resolveFrameIndex(idx);
    const img = frames[i];
    if (img?.naturalWidth) {
      drawCover(ctx, img, w, h);
      if (!drewOnce) {
        drewOnce = true;
        onFirstDraw?.();
      }
    }
  };

  const tick = () => {
    if (!ready || !frames.length) return;
    const p = getScrollProgress01(trackEl);
    const last = frames.length - 1;
    const idx = reducedMotion ? 0 : Math.round(p * last);
    renderFrame(idx);
    onScrub?.(p, idx, frames.length);
  };

  let raf = 0;
  const onScroll = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  };

  window.addEventListener("scroll", onScroll, { passive: true, signal });
  window.addEventListener(
    "resize",
    () => {
      tick();
    },
    { signal },
  );

  const ro =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          onScroll();
        })
      : null;
  ro?.observe(canvasEl);

  (async () => {
    if (!urls.length) return;
    frames = await loadImagesBatched(urls, 12);
    ready = true;
    requestAnimationFrame(() => requestAnimationFrame(tick));
  })();

  return () => {
    ac.abort();
    ro?.disconnect();
    cancelAnimationFrame(raf);
  };
}

/**
 * Scroll-scrub a &lt;video&gt; via currentTime (marketing / reel-style motion).
 */
export function mountVideoScrollScrub(trackEl, videoEl, opts) {
  const { reducedMotion, onScrub, onReady } = opts;
  const ac = new AbortController();
  const { signal } = ac;
  let raf = 0;

  const apply = () => {
    const p = getScrollProgress01(trackEl);
    onScrub?.(p);
    if (reducedMotion) {
      try {
        videoEl.currentTime = 0;
      } catch (_) {}
      return;
    }
    const d = videoEl.duration;
    if (!d || !isFinite(d)) return;
    const t = clamp(p * d, 0, Math.max(d - 1 / 60, 0));
    try {
      // Tight sync to scroll so motion tracks the source clip smoothly.
      if (Math.abs(videoEl.currentTime - t) > 1 / 120) {
        videoEl.currentTime = t;
      }
    } catch (_) {}
  };

  const tick = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(apply);
  };

  const onMeta = () => {
    try {
      videoEl.pause();
    } catch (_) {}
    onReady?.();
    tick();
  };

  videoEl.addEventListener("loadedmetadata", onMeta, { signal });
  window.addEventListener("scroll", tick, { passive: true, signal });
  window.addEventListener("resize", tick, { signal });

  if (videoEl.readyState >= 1) {
    onMeta();
  } else {
    tick();
  }

  return () => {
    ac.abort();
    cancelAnimationFrame(raf);
  };
}
