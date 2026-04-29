import {
  clamp,
  mountCanvasScrollScrub,
  mountVideoScrollScrub,
  padIndex,
  parseTemplate,
} from "./scroll-scrub-canvas.js";

/**
 * Scroll-scrub stills: nature / soil / growth (Unsplash License — unsplash.com/license).
 * Used when no local frame strip is configured (data-about-frame-count="0").
 */
const U = (id) =>
  `https://images.unsplash.com/${id}?ixlib=rb-4.0.3&auto=format&fit=crop&w=1920&q=82`;

const ABOUT_SCRUB_FALLBACK_URLS = [
  U("photo-1523348837708-15d4a09cfac2"),
  U("photo-1574594630333-3a2356d21c7f"),
  U("photo-1625246333195-78d9c38ad449"),
  U("photo-1501004318641-b39e6451bec6"),
  U("photo-1416879595882-3373a0480b5b"),
  U("photo-1516253594035-291b7e07b1c9"),
  U("photo-1470058869956-2c04339b0cc8"),
  U("photo-1591857150577-34012f3df898"),
  U("photo-1518531933037-91b2f5f22859"),
  U("photo-1508610041729-e2938f91e029"),
  U("photo-1483794342453-e9f30c0968e9"),
  U("photo-1530836366830-596c43bcd27f"),
  U("photo-1509228468518-180dd4864904"),
  U("photo-1520412099551-62b6bafb2848"),
  U("photo-1441974231531-c6227db76b6e"),
  U("photo-1466692476868-aef1dfb1e705"),
  U("photo-1464822759023-fed622ff2c3b"),
  U("photo-1442522778948-6fb85d24d4d3"),
  U("photo-1490750967868-88aa4486c946"),
  U("photo-1500382017468-9049fed747ef"),
  U("photo-1528164344705-9ef36c64f30e"),
  U("photo-1421780795338-8133299b0a72"),
  U("photo-1542601906990-b4d3fb778b09"),
  U("photo-1459156212002-57b53387f413"),
  U("photo-1463941308760-bf131141d3a8"),
  U("photo-1563514227147-6d2ff665a1aa"),
  U("photo-1599686307667-67e5ee3fbce4"),
  U("photo-1592150620754-046b9f2a8c5f"),
  U("photo-1530587191325-3db87d004d2b"),
  U("photo-1558618666-fcd25c85cd64"),
  U("photo-1465138439038-449470660da0"),
  U("photo-1491147330743-0c26f4bd168c"),
];

function readIntAttr(el, name, fallback) {
  if (!el) return fallback;
  const raw = el.getAttribute(name);
  if (raw == null || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function buildHighResUrls(sectionEl) {
  const frameCount = Math.max(0, readIntAttr(sectionEl, "data-about-frame-count", 0));
  if (frameCount <= 0) return [];
  const indexStart = readIntAttr(sectionEl, "data-about-index-start", 1);
  const indexPad = Math.max(1, Math.min(8, readIntAttr(sectionEl, "data-about-index-pad", 3)));
  const urlTemplate =
    sectionEl?.dataset.aboutUrlTemplate || "/about-scroll-frames/ezgif-frame-{index}.png";
  const urls = [];
  for (let i = 0; i < frameCount; i += 1) {
    const n = indexStart + i;
    urls.push(parseTemplate(urlTemplate, padIndex(n, indexPad)));
  }
  return urls;
}

function smoothstep01(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function remap01(x, a, b) {
  if (b === a) return 0;
  return clamp((x - a) / (b - a), 0, 1);
}

function fadeWindow(p, start, end) {
  // 0 → 1 (ease in) then 1 → 0 (ease out) across [start, end]
  const w = Math.max(0.04, end - start);
  const inLen = Math.min(0.16, w * 0.38);
  const outLen = Math.min(0.18, w * 0.42);
  const tIn = smoothstep01(remap01(p, start, start + inLen));
  const tOut = 1 - smoothstep01(remap01(p, end - outLen, end));
  return clamp(Math.min(tIn, tOut), 0, 1);
}

function parseAnchor(raw) {
  const parts = String(raw || "")
    .split(",")
    .map((s) => parseFloat(s.trim()));
  const ax = Number.isFinite(parts[0]) ? parts[0] : 0.5;
  const ay = Number.isFinite(parts[1]) ? parts[1] : 0.5;
  return { ax: clamp(ax, 0, 1), ay: clamp(ay, 0, 1) };
}

function setSvgLinePath(pathEl, fromX, fromY, toX, toY) {
  if (!pathEl) return;
  const mx = fromX + (toX - fromX) * 0.55;
  const my = fromY + (toY - fromY) * 0.18;
  // Single soft curve, “technical” but minimal.
  pathEl.setAttribute("d", `M ${fromX.toFixed(1)} ${fromY.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${toX.toFixed(1)} ${toY.toFixed(1)}`);
}

function subsampleFrameUrls(urls, step) {
  if (!urls.length || step <= 1) return urls;
  return urls.filter((_, i) => i % step === 0);
}

function updateStoryFloats(section, p, reducedMotion) {
  const nodes = section?.querySelectorAll(".about-story-float");
  if (!nodes?.length) return;
  nodes.forEach((el) => {
    if (reducedMotion) {
      el.style.opacity = "0";
      el.style.filter = "none";
      el.style.transform = "translate3d(-50%, -50%, 0)";
      return;
    }
    const c = parseFloat(el.getAttribute("data-float-center") || "0.5");
    const s = Math.max(0.04, parseFloat(el.getAttribute("data-float-span") || "0.12"));
    const px = parseFloat(el.getAttribute("data-float-parallax") || "0");
    const d = Math.abs(p - c);
    const raw = 1 - d / s;
    const o = smoothstep01(raw);
    el.style.opacity = String(o);
    el.style.filter = `blur(${(1 - o) * 9}px)`;
    el.style.transform = `translate3d(-50%, calc(-50% + ${((p - c) * px).toFixed(2)}px), 0)`;
  });
}

function setupRevealAnimations(aboutView) {
  const nodes = aboutView.querySelectorAll(".about-reveal");
  if (!nodes.length) return () => {};

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("about-reveal--visible");
        io.unobserve(e.target);
      }
    },
    { root: null, rootMargin: "0px 0px -10% 0px", threshold: 0.08 },
  );

  let specI = 0;
  let roadI = 0;
  let facI = 0;
  nodes.forEach((el) => {
    if (el.classList.contains("about-spec-card")) {
      el.style.setProperty("--about-reveal-i", String(specI));
      specI += 1;
    } else if (el.classList.contains("about-roadmap-card")) {
      el.style.setProperty("--about-reveal-i", String(roadI));
      roadI += 1;
    } else if (el.classList.contains("about-facility-card")) {
      el.style.setProperty("--about-reveal-i", String(facI));
      facI += 1;
    }
    io.observe(el);
  });

  return () => io.disconnect();
}

/**
 * Call when About view is shown. Returns teardown.
 */
export function mountAboutPage() {
  const aboutView = document.getElementById("aboutView");
  const track = document.getElementById("aboutScrollySpacer");
  const canvas = document.getElementById("aboutSeqCanvas");
  const video = document.getElementById("aboutRefVideo");
  const section = document.getElementById("aboutScrolly");
  const sticky = document.getElementById("aboutScrollySticky");
  const stage = document.getElementById("aboutScrollyStage");
  const annotOverlay = document.getElementById("aboutAnnotOverlay");
  const annotSvg = document.getElementById("aboutAnnotLines");
  const fallbackBg = document.querySelector(".about-scrolly-fallback-bg");
  const hint = document.querySelector(".about-scrolly-hint");
  const progressBar = document.getElementById("aboutScrollyProgress");
  const heroBlock = section?.querySelector(".about-dew-story-hero");
  const phases = section ? Array.from(section.querySelectorAll(".about-story-phase")) : [];
  const floatNodes = section ? Array.from(section.querySelectorAll(".about-story-float")) : [];
  const callouts = annotOverlay ? Array.from(annotOverlay.querySelectorAll(".about-annot")) : [];
  const linePaths = annotSvg ? Array.from(annotSvg.querySelectorAll(".about-annot-line")) : [];

  if (!aboutView || !track) {
    return () => {};
  }

  const cleanups = [];

  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

  const scrollVh = Math.max(120, readIntAttr(section, "data-about-scroll-vh", 360));
  track.style.setProperty("--about-scrolly-vh", reducedMotion ? "115vh" : `${scrollVh}vh`);

  const media = (section?.getAttribute("data-about-media") || "frames").toLowerCase();
  const videoSrc = section?.getAttribute("data-about-video-src")?.trim() || "";
  const useVideo = media === "video" && video instanceof HTMLVideoElement && Boolean(videoSrc);

  if (fallbackBg) {
    fallbackBg.style.opacity = "1";
    fallbackBg.style.transition = "opacity 0.6s ease";
  }

  const onScrubUi = (p) => {
    if (section) section.style.setProperty("--about-awaken-p", String(p));

    if (!reducedMotion && sticky) {
      // Scroll + cursor-driven “3D” tilt (CSS perspective on .about-scrolly-stage).
      const rotY = (p - 0.5) * 18; // degrees
      const rotX = (0.5 - p) * 8; // degrees
      const z = p * -22; // px
      sticky.style.setProperty("--about-rot-y", `${rotY.toFixed(3)}deg`);
      sticky.style.setProperty("--about-rot-x", `${rotX.toFixed(3)}deg`);
      sticky.style.setProperty("--about-z", `${z.toFixed(2)}px`);
    } else if (sticky) {
      sticky.style.removeProperty("--about-rot-y");
      sticky.style.removeProperty("--about-rot-x");
      sticky.style.removeProperty("--about-z");
    }

    const heroFade = 1 - clamp((p - 0.035) * 2.65, 0, 1);
    if (heroBlock) {
      heroBlock.style.opacity = String(Math.max(0.12, heroFade));
      const lift = reducedMotion ? 0 : p * -20;
      heroBlock.style.transform = `translate3d(0, ${lift.toFixed(2)}px, 0)`;
    }

    const n = phases.length || 5;
    const phaseIdx = reducedMotion
      ? n - 1
      : Math.min(n - 1, Math.floor(clamp(p, 0, 0.999) * n));
    phases.forEach((el, i) => {
      el.classList.toggle("about-story-phase--active", i === phaseIdx);
    });

    updateStoryFloats(section, p, reducedMotion);

    // Callouts: fade/slide in windows + draw hairline connectors to the “object”.
    if (annotOverlay && !reducedMotion) {
      annotOverlay.style.opacity = String(clamp((p - 0.14) * 6.5, 0, 1));
      const viewW = 1000;
      const viewH = 1000;
      callouts.forEach((el) => {
        const start = parseFloat(el.getAttribute("data-annot-start") || "0");
        const end = parseFloat(el.getAttribute("data-annot-end") || "0");
        const o = fadeWindow(p, start, end);
        el.style.setProperty("--annot-o", o.toFixed(4));
        el.style.opacity = String(o);
        el.style.pointerEvents = o > 0.2 ? "auto" : "none";
      });

      // Update SVG paths only when at least one callout is visible.
      const any = callouts.some((el) => parseFloat(el.style.opacity || "0") > 0.05);
      if (any) {
        linePaths.forEach((pathEl) => {
          const id = pathEl.getAttribute("data-line-for") || "";
          const target = id ? document.getElementById(id) : null;
          if (!target) return;
          const o = parseFloat(target.style.opacity || "0") || 0;
          pathEl.style.opacity = String(clamp(o * 1.05, 0, 1));

          // Anchor (object-space) in normalized 0..1; convert to SVG viewbox.
          const { ax, ay } = parseAnchor(target.getAttribute("data-annot-anchor"));
          const fromX = ax * viewW;
          const fromY = ay * viewH;

          // To-point: approximate to left/right edge band + vertical center of callout
          const right = target.classList.contains("about-annot--right");
          const rect = target.getBoundingClientRect();
          const stickyRect = sticky?.getBoundingClientRect?.() || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
          const cy = rect.height ? (rect.top + rect.height / 2 - stickyRect.top) / Math.max(1, stickyRect.height) : 0.5;
          const toY = clamp(cy, 0.08, 0.92) * viewH;
          const toX = right ? 760 : 240;
          setSvgLinePath(pathEl, fromX, fromY, toX, toY);
        });
      } else {
        linePaths.forEach((pEl) => {
          pEl.style.opacity = "0";
        });
      }
    } else if (annotOverlay) {
      annotOverlay.style.opacity = "";
      callouts.forEach((el) => {
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
        el.style.removeProperty("--annot-o");
      });
      linePaths.forEach((pEl) => {
        pEl.style.opacity = "0";
        pEl.removeAttribute("d");
      });
    }

    if (sticky) {
      sticky.classList.toggle("about-scrolly--presence", !reducedMotion && p > 0.76);
    }

    if (hint) hint.style.opacity = String(1 - clamp(p * 4, 0, 1));

    if (progressBar) {
      const pct = Math.round(clamp(p, 0, 1) * 100);
      progressBar.setAttribute("aria-valuenow", String(pct));
    }
  };

  onScrubUi(0);

  if (useVideo) {
    video.src = videoSrc;
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    try {
      video.pause();
    } catch (_) {}
    if (canvas instanceof HTMLCanvasElement) {
      canvas.style.display = "none";
    }
    const destroyScrub = mountVideoScrollScrub(track, video, {
      reducedMotion,
      onReady: () => {
        if (fallbackBg) fallbackBg.style.opacity = "0";
      },
      onScrub: onScrubUi,
    });
    cleanups.push(destroyScrub);
  } else {
    if (!(canvas instanceof HTMLCanvasElement)) {
      return () => {};
    }
    canvas.style.display = "";
    if (video instanceof HTMLVideoElement) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch (_) {}
    }

    let hiRes = buildHighResUrls(section);
    const mobileStep = readIntAttr(section, "data-about-mobile-frame-step", 1);
    if (
      hiRes.length > 48 &&
      typeof window !== "undefined" &&
      window.innerWidth < 768 &&
      mobileStep > 1
    ) {
      hiRes = subsampleFrameUrls(hiRes, mobileStep);
    }
    const urls = hiRes.length ? hiRes : ABOUT_SCRUB_FALLBACK_URLS;

    canvas.style.opacity = "0";
    const destroyScrub = mountCanvasScrollScrub(track, canvas, {
      urls,
      reducedMotion,
      onFirstDraw: () => {
        canvas.style.opacity = "1";
        if (fallbackBg) fallbackBg.style.opacity = "0";
      },
      onScrub: (p) => onScrubUi(p),
    });
    cleanups.push(destroyScrub);
  }

  cleanups.push(setupRevealAnimations(aboutView));

  if (sticky && !reducedMotion) {
    const onMove = (e) => {
      const r = sticky.getBoundingClientRect();
      const x = r.width > 0 ? (e.clientX - r.left) / r.width - 0.5 : 0;
      const y = r.height > 0 ? (e.clientY - r.top) / r.height - 0.5 : 0;
      sticky.style.setProperty("--about-cursor-x", x.toFixed(4));
      sticky.style.setProperty("--about-cursor-y", y.toFixed(4));
    };
    sticky.addEventListener("pointermove", onMove, { passive: true });
    cleanups.push(() => sticky.removeEventListener("pointermove", onMove));
  }

  return () => {
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch (_) {}
    });
    if (fallbackBg) fallbackBg.style.opacity = "1";
    if (canvas instanceof HTMLCanvasElement) {
      canvas.style.display = "";
      canvas.style.opacity = "";
    }
    if (video instanceof HTMLVideoElement) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch (_) {}
    }
    if (section) section.style.removeProperty("--about-awaken-p");
    sticky?.style.removeProperty("--about-rot-y");
    sticky?.style.removeProperty("--about-rot-x");
    sticky?.style.removeProperty("--about-z");
    if (progressBar) progressBar.setAttribute("aria-valuenow", "0");
    if (heroBlock) {
      heroBlock.style.opacity = "";
      heroBlock.style.transform = "";
    }
    phases.forEach((el) => el.classList.remove("about-story-phase--active"));
    floatNodes.forEach((el) => {
      el.style.opacity = "";
      el.style.filter = "";
      el.style.transform = "";
    });
    sticky?.classList.remove("about-scrolly--presence");
    aboutView.querySelectorAll(".about-reveal--visible").forEach((el) => {
      el.classList.remove("about-reveal--visible");
    });
  };
}
