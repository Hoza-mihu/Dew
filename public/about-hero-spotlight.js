const CARD_SEL = ".about-globe-2d__card";

function clamp(n, a, b) {
  return Math.min(b, Math.max(a, n));
}

function mountAboutHeroSpotlight() {
  const cards = Array.from(document.querySelectorAll(CARD_SEL));
  if (!cards.length) return () => {};

  const reduced =
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

  const cleanups = [];

  for (const card of cards) {
    const defaultX = 32;
    const defaultY = 48;
    let targetX = defaultX;
    let targetY = defaultY;
    let currentX = defaultX;
    let currentY = defaultY;
    let rafId = 0;

    const apply = () => {
      card.style.setProperty("--spotlight-x", `${currentX}%`);
      card.style.setProperty("--spotlight-y", `${currentY}%`);
    };

    const tick = () => {
      currentX += (targetX - currentX) * 0.12;
      currentY += (targetY - currentY) * 0.12;
      apply();
      if (
        Math.abs(targetX - currentX) > 0.15 ||
        Math.abs(targetY - currentY) > 0.15
      ) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = 0;
      }
    };

    const schedule = () => {
      if (reduced) {
        currentX = targetX;
        currentY = targetY;
        apply();
        return;
      }
      if (!rafId) rafId = requestAnimationFrame(tick);
    };

    const onPointerMove = (e) => {
      const r = card.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      targetX = clamp(((e.clientX - r.left) / r.width) * 100, 5, 95);
      targetY = clamp(((e.clientY - r.top) / r.height) * 100, 5, 95);
      if (reduced) {
        currentX = targetX;
        currentY = targetY;
        apply();
        return;
      }
      schedule();
    };

    const onPointerLeave = () => {
      targetX = defaultX;
      targetY = defaultY;
      schedule();
    };

    apply();
    card.addEventListener("pointermove", onPointerMove);
    card.addEventListener("pointerleave", onPointerLeave);

    cleanups.push(() => {
      if (rafId) cancelAnimationFrame(rafId);
      card.removeEventListener("pointermove", onPointerMove);
      card.removeEventListener("pointerleave", onPointerLeave);
    });
  }

  return () => {
    for (const fn of cleanups) fn();
  };
}

let teardown = () => {};

function start() {
  teardown = mountAboutHeroSpotlight();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    teardown();
  });
}

