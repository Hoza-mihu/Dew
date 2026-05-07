const CARD_SEL = '[data-spotlight="true"]';

function clamp(n, a, b) {
  return Math.min(b, Math.max(a, n));
}

function mountSpotlight(card) {
  const reduced =
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

  let active = false;
  let raf = 0;

  const setA = (a) => {
    card.style.setProperty("--spotlight-a", `${a}`);
  };

  const onEnter = () => {
    active = true;
    setA(1);
  };

  const onLeave = () => {
    active = false;
    setA(0);
  };

  const onMove = (e) => {
    if (!active) return;
    const r = card.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;

    const x = clamp(((e.clientX - r.left) / r.width) * 100, 0, 100);
    const y = clamp(((e.clientY - r.top) / r.height) * 100, 0, 100);

    if (reduced) {
      card.style.setProperty("--spotlight-x", `${x}%`);
      card.style.setProperty("--spotlight-y", `${y}%`);
      return;
    }

    const tx = x;
    const ty = y;
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      card.style.setProperty("--spotlight-x", `${tx}%`);
      card.style.setProperty("--spotlight-y", `${ty}%`);
      raf = 0;
    });
  };

  card.addEventListener("pointerenter", onEnter);
  card.addEventListener("pointerleave", onLeave);
  card.addEventListener("pointermove", onMove);

  return () => {
    if (raf) cancelAnimationFrame(raf);
    card.removeEventListener("pointerenter", onEnter);
    card.removeEventListener("pointerleave", onLeave);
    card.removeEventListener("pointermove", onMove);
  };
}

function start() {
  const cards = Array.from(document.querySelectorAll(CARD_SEL));
  const teardowns = cards.map(mountSpotlight);
  if (import.meta?.hot) {
    import.meta.hot.dispose(() => teardowns.forEach((fn) => fn?.()));
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

