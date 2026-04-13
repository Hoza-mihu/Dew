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
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w <= 0 || h <= 0) return;
  const nw = Math.max(1, Math.floor(w * dpr));
  const nh = Math.max(1, Math.floor(h * dpr));
  if (canvas.width !== nw || canvas.height !== nh) {
    canvas.width = nw;
    canvas.height = nh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
  const ctx = canvasEl.getContext("2d");
  if (!ctx) return () => {};

  const ac = new AbortController();
  const { signal } = ac;
  let frames = [];
  let ready = false;
  let drewOnce = false;

  const renderFrame = (idx) => {
    fitCanvas(canvasEl, ctx);
    const w = canvasEl.clientWidth;
    const h = canvasEl.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const img = frames[idx];
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

  (async () => {
    if (!urls.length) return;
    frames = await loadImagesBatched(urls, 12);
    ready = true;
    tick();
  })();

  return () => {
    ac.abort();
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
    const t = clamp(p * d, 0, Math.max(d - 1 / 24, 0));
    try {
      if (Math.abs(videoEl.currentTime - t) > 1 / 48) {
        videoEl.currentTime = t;
      }
    } catch (_) {}
  };

  const tick = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(apply);
  };

  const onMeta = () => {
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
