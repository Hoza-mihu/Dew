/** Shared helpers: scroll-linked canvas image scrub (Apple-style scrollytelling). */

/** Edge color sampled from sequence (seamless with frame backgrounds). */
const SCRUB_CANVAS_BG = "#050908";

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
  const narrow = typeof window !== "undefined" && window.innerWidth < 768;
  const dpr = Math.min(Math.max(rawDpr, 1), narrow ? 2 : 3);
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

function loadImageElement(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    try {
      if (/^https?:\/\//i.test(url)) {
        img.crossOrigin = "anonymous";
      }
    } catch (_) {}
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(img);
    };
    img.onload = finish;
    img.onerror = finish;
    img.src = url;
    if (img.complete) finish();
  });
}

export async function loadImagesBatched(urls, batchSize, onProgress) {
  const images = new Array(urls.length);
  let done = 0;
  for (let i = 0; i < urls.length; i += batchSize) {
    const slice = urls.slice(i, i + batchSize);
    await Promise.all(
      slice.map(async (url, j) => {
        const idx = i + j;
        const img = await loadImageElement(url);
        try {
          if (img.decode) await img.decode();
        } catch (_) {}
        images[idx] = img;
        done += 1;
        onProgress?.(done, urls.length);
      }),
    );
  }
  return images;
}

/** Root scroll offset (body `display:flex` / Safari can make `window.scrollY` stale). */
export function getDocumentScrollY() {
  const sc = document.scrollingElement || document.documentElement || document.body;
  const y = sc?.scrollTop ?? 0;
  if (y) return y;
  return window.scrollY || window.pageYOffset || document.body?.scrollTop || 0;
}

/** Scroll progress 0..1 through a tall track (sticky scrolly pattern). */
export function getScrollProgress01(trackEl) {
  if (!trackEl) return 0;
  const scrollY = getDocumentScrollY();
  const rect = trackEl.getBoundingClientRect();
  const trackTop = scrollY + rect.top;
  const travel = Math.max(1, trackEl.offsetHeight - window.innerHeight);
  return clamp((scrollY - trackTop) / travel, 0, 1);
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

  /** Fractional scrub + crossfade between frames (smooth bidirectional scroll). */
  const renderFrame = (p) => {
    fitCanvas(canvasEl, ctx);
    const w = canvasEl.clientWidth;
    const h = canvasEl.clientHeight;
    if (w <= 0 || h <= 0) return;
    ctx.fillStyle = SCRUB_CANVAS_BG;
    ctx.fillRect(0, 0, w, h);

    const last = Math.max(0, frames.length - 1);
    if (last < 0) return;

    if (reducedMotion) {
      const i = resolveFrameIndex(0);
      const img = frames[i];
      if (img?.naturalWidth) {
        drawCover(ctx, img, w, h);
        if (!drewOnce) {
          drewOnce = true;
          onFirstDraw?.();
        }
      }
      return;
    }

    const fi = clamp(p, 0, 1) * last;
    const i0 = Math.floor(fi);
    const i1 = Math.min(i0 + 1, last);
    const t = fi - i0;

    const idx0 = resolveFrameIndex(i0);
    const idx1 = resolveFrameIndex(i1);
    const img0 = frames[idx0];
    const img1 = frames[idx1];

    if (img0?.naturalWidth) {
      drawCover(ctx, img0, w, h);
      if (!drewOnce) {
        drewOnce = true;
        onFirstDraw?.();
      }
    }
    if (img1?.naturalWidth && t > 0.008 && idx1 !== idx0) {
      ctx.save();
      ctx.globalAlpha = clamp(t, 0, 1);
      drawCover(ctx, img1, w, h);
      ctx.restore();
    }
  };

  const tick = () => {
    if (!ready || !frames.length) return;
    const p = getScrollProgress01(trackEl);
    const last = frames.length - 1;
    const idx = reducedMotion ? 0 : Math.round(p * last);
    renderFrame(p);
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
  ro?.observe(trackEl);

  let io;
  if (typeof IntersectionObserver !== "undefined") {
    io = new IntersectionObserver(
      () => {
        onScroll();
      },
      { root: null, threshold: [0, 0.01, 0.25, 0.5, 0.75, 1] },
    );
    io.observe(trackEl);
  }

  (async () => {
    if (!urls.length) return;
    frames = new Array(urls.length);
    const prime = Math.min(28, urls.length);
    for (let i = 0; i < prime; i += 1) {
      const img = await loadImageElement(urls[i]);
      try {
        if (img.decode) await img.decode();
      } catch (_) {}
      frames[i] = img;
    }
    ready = true;
    requestAnimationFrame(() => requestAnimationFrame(tick));
    const batch = 12;
    for (let i = prime; i < urls.length; i += batch) {
      const slice = urls.slice(i, i + batch);
      await Promise.all(
        slice.map(async (url, j) => {
          const idx = i + j;
          const img = await loadImageElement(url);
          try {
            if (img.decode) await img.decode();
          } catch (_) {}
          frames[idx] = img;
        }),
      );
    }
  })();

  return () => {
    ac.abort();
    ro?.disconnect();
    io?.disconnect();
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
