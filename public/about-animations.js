import {
  clamp,
  mountCanvasScrollScrub,
  mountVideoScrollScrub,
  padIndex,
  parseTemplate,
} from "./scroll-scrub-canvas.js";

/** Curated stills — scroll scrub until you add a Whisk/Veo/EZGif sequence. */
const ABOUT_SCRUB_FALLBACK_URLS = [
  "/images/about%20us/plants%20%26%20beyond.jpg",
  "/images/about%20us/the%20platform.jpg",
  "/images/about%20us/why%20dew.jpg",
  "/images/about%20us/our%20vision.jpg",
  "/images/about%20us/data.jpg",
  "/images/about%20us/hardware.jpg",
  "/images/about%20us/alerts.jpg",
  "/images/about%20us/dashboard.jpg",
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
  const fallbackBg = document.querySelector(".about-scrolly-fallback-bg");
  const hint = document.querySelector(".about-scrolly-hint");
  const heroBlock = section?.querySelector(".about-dew-story-hero");
  const phases = section ? Array.from(section.querySelectorAll(".about-story-phase")) : [];
  const floatNodes = section ? Array.from(section.querySelectorAll(".about-story-float")) : [];

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

    if (sticky) {
      sticky.classList.toggle("about-scrolly--presence", !reducedMotion && p > 0.76);
    }

    if (hint) hint.style.opacity = String(1 - clamp(p * 4, 0, 1));
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

    const destroyScrub = mountCanvasScrollScrub(track, canvas, {
      urls,
      reducedMotion,
      onFirstDraw: () => {
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
    }
    if (video instanceof HTMLVideoElement) {
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch (_) {}
    }
    if (section) section.style.removeProperty("--about-awaken-p");
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
