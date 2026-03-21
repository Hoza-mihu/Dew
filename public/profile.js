// Profile section: view, edit, and save user profile (Supabase Storage for photos)
import { authReady } from "./firebase-config.js";
import { onAuthStateChanged, updateProfile } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

async function authFetch(url, options = {}) {
  try {
    const auth = await authReady;
    const user = auth.currentUser;
    const headers = new Headers(options.headers || {});
    if (user) {
      const token = await user.getIdToken();
      headers.set("Authorization", `Bearer ${token}`);
    }
    return fetch(url, { ...options, headers });
  } catch (_) {
    return fetch(url, options);
  }
}

/** Single Supabase client instance to avoid "Multiple GoTrueClient instances" warnings and undefined behavior. */
let supabaseClient = null;

async function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;
  const configRes = await fetch("/api/config/supabase");
  if (!configRes.ok) {
    const data = await configRes.json().catch(() => ({}));
    throw new Error(data.message || "Supabase not configured. Add SUPABASE_URL and SUPABASE_ANON_KEY to .env");
  }
  const { url, anonKey } = await configRes.json();
  supabaseClient = createClient(url, anonKey);
  return supabaseClient;
}

const dashboardView = document.getElementById("dashboardView");
const profileView = document.getElementById("profileView");
const alertsView = document.getElementById("alertsView");
const analyticsView = document.getElementById("analyticsView");
const settingsView = document.getElementById("settingsView");
const plantsCatalogView = document.getElementById("plantsCatalogView");
const myPlantsView = document.getElementById("myPlantsView");
const plantDetailView = document.getElementById("plantDetailView");
const aboutView = document.getElementById("aboutView");
const communityView = document.getElementById("communityView");

/** App settings (theme, notifications, profile privacy) */
let dewSettings = {};
try {
  const raw = window.localStorage.getItem("dewSettings");
  if (raw) dewSettings = JSON.parse(raw) || {};
} catch (_) {}

function applyTheme(theme) {
  const body = document.body;
  if (!body) return;
  if (theme === "light") {
    body.classList.add("theme-light");
  } else {
    body.classList.remove("theme-light");
  }
}

applyTheme(dewSettings.theme || "dark");
if (dewSettings.reduceMotion) {
  document.body.classList.add("reduce-motion");
}

/** Current user (set on auth) for refreshing stats when opening profile. */
let currentProfileUser = null;
let lastPlantsSection = "plants";
let currentPlantDetailId = null;
let addFavouriteFromDetail = null;
let suppressCommunityRoutePush = false;
const LAST_VIEW_STORAGE_KEY = "dewLastView";
const PERSISTED_VIEWS = new Set([
  "dashboard",
  "profile",
  "alerts",
  "analytics",
  "settings",
  "plants",
  "myplants",
  "about",
  "community",
]);

async function upsertUserDirectoryEntry(user) {
  if (!user?.uid) return;
  try {
    await fetch("/api/users/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: user.uid,
        displayName: user.displayName || "",
        email: user.email || "",
      }),
    });
  } catch (_) {}
}

function getCommunityNotifyPref(slug) {
  try {
    const raw = window.localStorage.getItem("dewCommunityNotifyPrefs");
    const obj = raw ? JSON.parse(raw) : {};
    const s = String(slug || "").toLowerCase();
    return (obj && s && obj[s]) || "all";
  } catch (_) {
    return "all";
  }
}

function setCommunityNotifyPref(slug, level) {
  try {
    const raw = window.localStorage.getItem("dewCommunityNotifyPrefs");
    const obj = raw ? JSON.parse(raw) : {};
    const s = String(slug || "").toLowerCase();
    if (!s) return;
    obj[s] = level;
    window.localStorage.setItem("dewCommunityNotifyPrefs", JSON.stringify(obj));
  } catch (_) {}
}

function saveLastView(view) {
  if (!PERSISTED_VIEWS.has(view)) return;
  try {
    window.localStorage.setItem(LAST_VIEW_STORAGE_KEY, view);
  } catch (_) {}
}

function getLastView() {
  try {
    const v = window.localStorage.getItem(LAST_VIEW_STORAGE_KEY);
    return PERSISTED_VIEWS.has(v) ? v : null;
  } catch (_) {
    return null;
  }
}

function isReloadNavigation() {
  try {
    const navEntries = performance.getEntriesByType("navigation");
    if (Array.isArray(navEntries) && navEntries[0]?.type) return navEntries[0].type === "reload";
    // Fallback for older browsers.
    if (performance && performance.navigation) return performance.navigation.type === 1;
  } catch (_) {}
  return false;
}

function showToast(message, type = "success") {
  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  // enter
  requestAnimationFrame(() => el.classList.add("toast--show"));
  // exit
  window.setTimeout(() => {
    el.classList.remove("toast--show");
    window.setTimeout(() => el.remove(), 250);
  }, 2200);
}

function bindPlantDetailStaticActions() {
  document.getElementById("plantBackBtn")?.addEventListener("click", () => showView(lastPlantsSection));
  document.getElementById("btnOpenMyPlants")?.addEventListener("click", () => showView("myplants"));
  document.querySelector(".plant-detail-send")?.addEventListener("click", () => showView("community"));
  document.getElementById("btnAddToFavourites")?.addEventListener("click", () => {
    if (typeof addFavouriteFromDetail !== "function" || !currentPlantDetailId) return;
    const added = addFavouriteFromDetail(currentPlantDetailId);
    if (added) showToast("Added to your favourites.", "success");
    else showToast("Already in your favourites.", "info");
  });

  const plantDetailImg = document.getElementById("plantDetailImg");
  const plantDetailZoomBtn = document.getElementById("plantDetailZoomBtn");
  const lightbox = document.getElementById("plantImageLightbox");
  const lightboxImg = document.getElementById("plantImageLightboxImg");
  const lightboxClose = document.getElementById("plantImageLightboxClose");
  const lightboxBackdrop = document.getElementById("plantImageLightboxBackdrop");

  function openPlantImageLightbox() {
    if (!plantDetailImg?.src || !lightbox || !lightboxImg) return;
    lightboxImg.src = plantDetailImg.src;
    lightboxImg.alt = plantDetailImg.alt || "Plant image";
    lightbox.style.display = "flex";
    document.body.style.overflow = "hidden";
    lightboxClose?.focus();
  }

  function closePlantImageLightbox() {
    if (!lightbox) return;
    lightbox.style.display = "none";
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onLightboxKeydown);
  }

  function onLightboxKeydown(e) {
    if (e.key === "Escape") closePlantImageLightbox();
  }

  function openPlantImageLightboxWithListeners() {
    openPlantImageLightbox();
    document.addEventListener("keydown", onLightboxKeydown);
  }

  plantDetailZoomBtn?.addEventListener("click", (e) => { e.stopPropagation(); openPlantImageLightboxWithListeners(); });
  plantDetailImg?.addEventListener("click", () => openPlantImageLightboxWithListeners());
  lightboxClose?.addEventListener("click", closePlantImageLightbox);
  lightboxBackdrop?.addEventListener("click", closePlantImageLightbox);

  // Community banner/logo click-to-view full image (Instagram/Facebook style).
  const communityLightbox = document.getElementById("communityImageLightbox");
  const communityLightboxImg = document.getElementById("communityImageLightboxImg");
  const communityLightboxClose = document.getElementById("communityImageLightboxClose");
  const communityLightboxBackdrop = document.getElementById("communityImageLightboxBackdrop");
  const communityDetailLogo = document.getElementById("communityDetailLogo");
  const communityDetailBanner = document.getElementById("communityDetailBanner");

  function openCommunityImageLightbox(src, alt) {
    if (!src || !communityLightbox || !communityLightboxImg) return;
    communityLightboxImg.src = src;
    communityLightboxImg.alt = alt || "Community image";
    communityLightbox.style.display = "flex";
    document.body.style.overflow = "hidden";
    communityLightboxClose?.focus();
    document.addEventListener("keydown", onCommunityLightboxKeydown);
  }

  function closeCommunityImageLightbox() {
    if (!communityLightbox) return;
    communityLightbox.style.display = "none";
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onCommunityLightboxKeydown);
  }

  function onCommunityLightboxKeydown(e) {
    if (e.key === "Escape") closeCommunityImageLightbox();
  }

  communityLightboxClose?.addEventListener("click", closeCommunityImageLightbox);
  communityLightboxBackdrop?.addEventListener("click", closeCommunityImageLightbox);

  communityDetailLogo?.addEventListener("click", (e) => {
    if (e.target.closest("#communityLogoEditBtn") || e.target.closest(".community-logo-edit-btn")) return;
    const src = (communityDetailLogo.dataset && communityDetailLogo.dataset.imageUrl) || "";
    openCommunityImageLightbox(src, "Community logo");
  });

  communityDetailBanner?.addEventListener("click", (e) => {
    if (e.target.closest("#communityBannerEditBtn") || e.target.closest(".community-banner-edit-btn")) return;
    const src = (communityDetailBanner.dataset && communityDetailBanner.dataset.imageUrl) || "";
    openCommunityImageLightbox(src, "Community banner");
  });
}

function bindCommunityPostMediaLightbox() {
  const lightbox = document.getElementById("communityPostMediaLightbox");
  const lightboxImg = document.getElementById("communityPostMediaLightboxImg");
  const lightboxVideo = document.getElementById("communityPostMediaLightboxVideo");
  const lightboxClose = document.getElementById("communityPostMediaLightboxClose");
  const lightboxBackdrop = document.getElementById("communityPostMediaLightboxBackdrop");
  const thumbsWrap = document.getElementById("communityPostMediaLightboxThumbs");
  const prevBtn = document.getElementById("communityPostMediaLightboxPrevBtn");
  const nextBtn = document.getElementById("communityPostMediaLightboxNextBtn");

  if (!lightbox || !lightboxImg || !lightboxVideo) return;

  let mediaUrls = [];
  let mediaTypes = [];
  let activeIndex = 0;

  function inferKind(url, explicitType) {
    if (explicitType) return explicitType === "video" ? "video" : "image";
    const u = String(url || "").toLowerCase();
    return u.match(/\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/) ? "video" : "image";
  }

  function setMainByIndex(index) {
    if (!mediaUrls.length) return;
    activeIndex = Math.max(0, Math.min(index, mediaUrls.length - 1));
    const url = mediaUrls[activeIndex];
    const type = inferKind(url, mediaTypes[activeIndex]);
    const isVideo = type === "video";

    lightboxImg.style.display = isVideo ? "none" : "block";
    lightboxVideo.style.display = isVideo ? "block" : "none";

    if (isVideo) {
      lightboxVideo.src = url;
      lightboxVideo.load();
    } else {
      try { lightboxVideo.pause(); } catch (_) {}
      lightboxVideo.removeAttribute("src");
      lightboxImg.src = url;
    }

    if (thumbsWrap) {
      thumbsWrap.querySelectorAll(".community-post-media-lightbox-thumb").forEach((btn) => {
        const idx = Number(btn.dataset.index || "0");
        btn.classList.toggle("community-post-media-lightbox-thumb--active", idx === activeIndex);
      });
    }
  }

  function renderThumbs() {
    if (!thumbsWrap) return;
    thumbsWrap.innerHTML = "";
    mediaUrls.forEach((url, idx) => {
      const type = inferKind(url, mediaTypes[idx]);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "community-post-media-lightbox-thumb";
      btn.dataset.index = String(idx);
      if (type === "image") {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "Selected media thumbnail";
        btn.appendChild(img);
      } else {
        const icon = document.createElement("i");
        icon.className = "ri-play-line";
        btn.appendChild(icon);
      }
      btn.addEventListener("click", () => setMainByIndex(idx));
      thumbsWrap.appendChild(btn);
    });

    setMainByIndex(activeIndex);
  }

  function openWithData(urls, types, startIndex = 0) {
    if (!Array.isArray(urls) || !urls.length) return;
    mediaUrls = urls.filter(Boolean);
    mediaTypes = Array.isArray(types) ? types : [];
    activeIndex = startIndex || 0;
    renderThumbs();
    lightbox.style.display = "flex";
    document.body.style.overflow = "hidden";
    lightboxClose?.focus();
  }

  function close() {
    if (!lightbox) return;
    lightbox.style.display = "none";
    document.body.style.overflow = "";
    // Reset media to stop playback.
    try { lightboxVideo.pause(); } catch (_) {}
    lightboxVideo.src = "";
    lightboxImg.src = "";
  }

  function onPostClick(e) {
    // Full-screen media lightbox is disabled for the Reddit-style post page,
    // because it conflicts with the post details modal interaction.
    return;
    const card = e.target.closest(".community-post");
    if (!card) return;
    // The post card now includes an in-place media gallery. Don't open the full lightbox
    // when clicking media elements inside the gallery.
    if (e.target.closest(".community-post-media-gallery")) return;
    if (e.target.closest(".community-post-media-thumb-btn")) return;
    if (e.target.closest("video") || e.target.closest("audio")) return;
    const mediaUrlsRaw = card.dataset.mediaUrls || "";
    const mediaTypesRaw = card.dataset.mediaTypes || "";
    if (!mediaUrlsRaw) return;

    let urls = [];
    let types = [];
    try {
      urls = JSON.parse(mediaUrlsRaw);
    } catch (_) {}
    try {
      types = JSON.parse(mediaTypesRaw);
    } catch (_) {}
    openWithData(urls, types, 0);
  }

  // One-time close bindings.
  lightboxClose?.addEventListener("click", close);
  lightboxBackdrop?.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && lightbox.style.display !== "none") close();
  });

  // Nav buttons.
  prevBtn?.addEventListener("click", () => setMainByIndex(activeIndex - 1));
  nextBtn?.addEventListener("click", () => setMainByIndex(activeIndex + 1));

  // Event delegation from the community feed.
  document.getElementById("communityFeed")?.addEventListener("click", onPostClick);
}

function showView(view) {
  const v = view;
  dashboardView.style.display = v === "dashboard" ? "block" : "none";
  profileView.style.display = v === "profile" ? "block" : "none";
  if (alertsView) alertsView.style.display = v === "alerts" ? "block" : "none";
  if (analyticsView) analyticsView.style.display = v === "analytics" ? "block" : "none";
  if (settingsView) {
    settingsView.style.display = v === "settings" ? "block" : "none";
    if (v === "settings") loadLocationAndDisplay();
  }
  if (plantsCatalogView) plantsCatalogView.style.display = v === "plants" ? "block" : "none";
  if (myPlantsView) myPlantsView.style.display = v === "myplants" ? "block" : "none";
  if (plantDetailView) {
    plantDetailView.style.display = v === "plant" ? "block" : "none";
    if (v !== "plant") plantDetailView.classList.remove("plant-detail-enter");
  }
  if (aboutView) aboutView.style.display = v === "about" ? "block" : "none";
  if (communityView) communityView.style.display = v === "community" ? "block" : "none";
  document.body.classList.toggle("about-page", v === "about");
  document.body.classList.toggle("community-page", v === "community");
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === view);
  });
  if ((v === "profile" || v === "community") && currentProfileUser) refreshProfileStats(currentProfileUser.uid);
  if (v === "community") {
    if (!suppressCommunityRoutePush) setCommunityRoute(communitySelectedSlug);
    loadCommunitiesSidebar();
    const catSel = document.getElementById("communityCategoryFilter");
    if (catSel) catSel.value = communityCategoryFilter;
    loadCommunityView();
  }
  if (v === "alerts") loadAlertsView();
  if (v === "analytics") loadAnalyticsView();
  if (v === "plants") loadPlantsCatalog();
  if (v === "myplants") loadMyPlantsUsed();
  if (v === "about") refreshAboutPlantTypesCount();
  if (v === "dashboard" && typeof window.refreshDashboardWeather === "function") window.refreshDashboardWeather();
  saveLastView(v);
}

function refreshAboutPlantTypesCount() {
  fetch("/api/plants/catalog")
    .then((r) => r.json())
    .then((plants) => {
      const count = Array.isArray(plants) ? plants.filter((p) => p.indoor).length : 0;
      const el = document.getElementById("aboutStatPlants");
      if (el) el.textContent = count;
    })
    .catch(() => {});
}

function applyProfilePrivacyToView() {
  const viewEl = document.getElementById("profileView");
  if (!viewEl) return;
  const privacy = (dewSettings && dewSettings.profilePrivacy) || "public";
  viewEl.classList.toggle("profile-private", privacy === "private");
}

/** Plants catalog view: fetch /api/plants/catalog and render card grid (Explore Our Categories style). */
let plantsListFilter = (dewSettings && dewSettings.defaultPlantsFilter) || "indoor";
let plantsLightFilter = (dewSettings && dewSettings.defaultLightFilter) || "all";
const PLANT_IMAGE_CACHE_BUST = "20260306c";

function buildPlantImageUrl(filename) {
  const trimmed = String(filename || "").trim();
  if (!trimmed) return "";
  return `/images/plants/${encodeURIComponent(trimmed)}?v=${encodeURIComponent(PLANT_IMAGE_CACHE_BUST)}`;
}

function getPlantImageCandidates(imageName, plantId) {
  const candidates = [];
  const seen = new Set();
  const add = (filename) => {
    const src = buildPlantImageUrl(filename);
    if (!src || seen.has(src)) return;
    seen.add(src);
    candidates.push(src);
  };

  const rawImage = String(imageName || "").trim();
  const rawPlantId = String(plantId || "").trim();
  const idAsFile = rawPlantId ? rawPlantId.replace(/-/g, " ") : "";

  if (rawImage) add(rawImage);
  if (rawImage && rawImage.toLowerCase() !== rawImage) add(rawImage.toLowerCase());

  const dot = rawImage.lastIndexOf(".");
  const stem = dot > 0 ? rawImage.slice(0, dot).trim() : rawImage;
  const ext = dot > 0 ? rawImage.slice(dot).trim().toLowerCase() : ".jpg";

  const stemCandidates = [stem, stem.toLowerCase(), idAsFile, idAsFile.toLowerCase()].filter(Boolean);
  const extCandidates = [ext, ".jpg", ".jpeg", ".png", ".webp"];
  stemCandidates.forEach((s) => {
    extCandidates.forEach((e) => add(`${s}${e}`));
  });

  return candidates.slice(0, 10);
}

function bindPlantCardImageFallbacks(scopeEl) {
  const scope = scopeEl || document;
  scope.querySelectorAll("img.plant-card-img[data-image]").forEach((imgEl) => {
    if (imgEl.dataset.fallbackBound === "1") return;
    imgEl.dataset.fallbackBound = "1";
    const fallbackInitial = imgEl.parentElement?.querySelector?.(".plant-card-initial");
    const candidates = getPlantImageCandidates(imgEl.dataset.image || "", imgEl.dataset.plantId || "");
    let idx = 0;

    const tryNext = () => {
      if (idx >= candidates.length) return false;
      const next = candidates[idx];
      idx += 1;
      imgEl.src = next;
      return true;
    };

    imgEl.addEventListener("load", () => {
      imgEl.style.display = "block";
      if (fallbackInitial) fallbackInitial.classList.remove("visible");
    });
    imgEl.addEventListener("error", () => {
      if (tryNext()) return;
      imgEl.style.display = "none";
      if (fallbackInitial) fallbackInitial.classList.add("visible");
    });

    if (!imgEl.getAttribute("src")) {
      if (!tryNext()) {
        imgEl.style.display = "none";
        if (fallbackInitial) fallbackInitial.classList.add("visible");
      }
    }
  });
}

function setPlantDetailImageWithFallback(imgEl, imageName, plantId, altText) {
  if (!imgEl) return;
  const candidates = getPlantImageCandidates(imageName, plantId);
  let idx = 0;

  const tryNext = () => {
    if (idx >= candidates.length) return false;
    imgEl.src = candidates[idx];
    idx += 1;
    return true;
  };

  imgEl.alt = altText || "Plant image";
  imgEl.onerror = () => {
    if (tryNext()) return;
    imgEl.onerror = null;
  };

  if (!tryNext()) imgEl.removeAttribute("src");
}

function animatePlantDetailEntry() {
  if (!plantDetailView) return;
  plantDetailView.classList.remove("plant-detail-enter");
  // Force reflow so repeated opens re-run the entry animation.
  void plantDetailView.offsetWidth;
  plantDetailView.classList.add("plant-detail-enter");
}

function loadPlantsCatalog() {
  const grid = document.getElementById("plantsListGrid");
  const filtersEl = document.getElementById("plantsListFilters");
  const lightFiltersEl = document.getElementById("plantsLightFilters");
  if (!grid) return;
  lastPlantsSection = "plants";
  loadPlantsFavouritesStrip();
  fetch("/api/plants/catalog")
    .then((r) => r.json())
    .then((plants) => {
      const all = Array.isArray(plants) ? plants : [];
      let list = all;
      if (plantsListFilter !== "all") {
        list = list.filter((p) => p.indoor === true);
      }
      if (plantsLightFilter !== "all") {
        list = list.filter((p) => (p.lightCategory || "medium") === plantsLightFilter);
      }
      grid.innerHTML = list
        .map((p) => {
          const imgSrc = getPlantImageCandidates(p.image, p.id)[0] || "";
          const name = escapeHtml(p.name || p.id);
          const species = escapeHtml(p.species || "");
          return `<article class="plant-card" data-plant-id="${escapeHtml(p.id)}">
            <div class="plant-card-img-wrap">
              <img src="${imgSrc}" alt="${name}" class="plant-card-img" data-image="${escapeHtml(p.image || "")}" data-plant-id="${escapeHtml(
                p.id || ""
              )}" loading="lazy" />
              <span class="plant-card-initial" aria-hidden="true">${(p.name || p.id)[0]}</span>
            </div>
            <div class="plant-card-body">
              <h3 class="plant-card-name">${name}</h3>
              <p class="plant-card-species">${species}</p>
              <button type="button" class="plant-card-action" aria-label="View ${name}"><i class="ri-arrow-right-line"></i></button>
            </div>
          </article>`;
        })
        .join("");
      if (filtersEl) {
        filtersEl.querySelectorAll(".tab").forEach((tab) => {
          tab.classList.toggle("active", tab.dataset.filter === plantsListFilter);
          tab.onclick = () => {
            plantsListFilter = tab.dataset.filter || "indoor";
            loadPlantsCatalog();
          };
        });
      }

      if (lightFiltersEl) {
        lightFiltersEl.querySelectorAll(".tab").forEach((tab) => {
          tab.classList.toggle("active", tab.dataset.light === plantsLightFilter);
          tab.onclick = () => {
            plantsLightFilter = tab.dataset.light || "all";
            loadPlantsCatalog();
          };
        });
      }
      bindPlantCardImageFallbacks(grid);

      grid.querySelectorAll(".plant-card").forEach((card) => {
        card.addEventListener("click", (e) => {
          const btn = e.target?.closest?.("button");
          if (btn && btn.classList.contains("plant-card-action")) e.preventDefault();
          openPlantDetail(card.dataset.plantId);
        });
      });
    })
    .catch(() => {
      grid.innerHTML = '<p class="plants-list-empty">Unable to load plants.</p>';
    });
}

/** My Plants view: show plants used by current user (usage-derived). */
function loadMyPlantsUsed() {
  const grid = document.getElementById("myPlantsGrid");
  const empty = document.getElementById("myPlantsEmpty");
  if (!grid) return;
  lastPlantsSection = "myplants";
  if (!currentProfileUser?.uid) {
    grid.innerHTML = "";
    if (empty) { empty.style.display = "block"; empty.textContent = "Sign in to see your plants."; }
    return;
  }
  fetch(`/api/users/${encodeURIComponent(currentProfileUser.uid)}/used-plants`)
    .then((r) => r.json())
    .then((plants) => {
      const list = Array.isArray(plants) ? plants : [];
      if (empty) empty.style.display = list.length ? "none" : "block";
      grid.innerHTML = list
        .map((p) => {
          const imgSrc = getPlantImageCandidates(p.image, p.id)[0] || "";
          const name = escapeHtml(p.name || p.id);
          const species = escapeHtml(p.species || "");
          return `<article class="plant-card" data-plant-id="${escapeHtml(p.id)}">
            <div class="plant-card-img-wrap">
              <img src="${imgSrc}" alt="${name}" class="plant-card-img" data-image="${escapeHtml(p.image || "")}" data-plant-id="${escapeHtml(
                p.id || ""
              )}" loading="lazy" />
              <span class="plant-card-initial" aria-hidden="true">${(p.name || p.id)[0]}</span>
            </div>
            <div class="plant-card-body">
              <h3 class="plant-card-name">${name}</h3>
              <p class="plant-card-species">${species}</p>
              <button type="button" class="plant-card-action" aria-label="View ${name}"><i class="ri-arrow-right-line"></i></button>
            </div>
          </article>`;
        })
        .join("");
      bindPlantCardImageFallbacks(grid);

      grid.querySelectorAll(".plant-card").forEach((card) => {
        card.addEventListener("click", (e) => {
          const btn = e.target?.closest?.("button");
          if (btn && btn.classList.contains("plant-card-action")) e.preventDefault();
          openPlantDetail(card.dataset.plantId);
        });
      });
    })
    .catch(() => {
      grid.innerHTML = '<p class="plants-list-empty">Unable to load your plants.</p>';
      if (empty) empty.style.display = "none";
    });
}

function loadPlantsFavouritesStrip() {
  const wrap = document.getElementById("plantsFavouritesWrap");
  const grid = document.getElementById("plantsFavouritesGrid");
  if (!wrap || !grid) return;
  if (!currentProfileUser?.uid) {
    wrap.style.display = "none";
    return;
  }
  fetch(`/api/users/${encodeURIComponent(currentProfileUser.uid)}/favourites`)
    .then((r) => r.json())
    .then((ids) => {
      const favIds = Array.isArray(ids) ? ids : [];
      if (!favIds.length) {
        wrap.style.display = "none";
        return;
      }
      wrap.style.display = "block";
      document.getElementById("btnGoProfileFavourites")?.addEventListener("click", () => showView("profile"));

      async function saveStripFavourites(nextIds) {
        const res = await fetch(`/api/users/${encodeURIComponent(currentProfileUser.uid)}/favourites`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plantIds: nextIds }),
        });
        if (!res.ok) return;
        refreshProfileStats(currentProfileUser.uid);
        loadPlantsFavouritesStrip();
      }

      return fetch("/api/plants/catalog")
        .then((r) => r.json())
        .then((catalog) => {
          const list = Array.isArray(catalog) ? catalog.filter((p) => favIds.includes(p.id)) : [];
          grid.innerHTML = list
            .map((p) => {
              const imgSrc = getPlantImageCandidates(p.image, p.id)[0] || "";
              const name = escapeHtml(p.name || p.id);
              const species = escapeHtml(p.species || "");
              return `<article class="plant-card" data-plant-id="${escapeHtml(p.id)}">
                <div class="plant-card-img-wrap">
                  <button type="button" class="plant-card-fav-remove" data-remove-id="${escapeHtml(
                    p.id
                  )}" aria-label="Remove from favourites"><i class="ri-close-line"></i></button>
                  <img src="${imgSrc}" alt="${name}" class="plant-card-img" data-image="${escapeHtml(
                    p.image || ""
                  )}" data-plant-id="${escapeHtml(p.id || "")}" loading="lazy" />
                  <span class="plant-card-initial" aria-hidden="true">${(p.name || p.id)[0]}</span>
                </div>
                <div class="plant-card-body">
                  <h3 class="plant-card-name">${name}</h3>
                  <p class="plant-card-species">${species}</p>
                  <button type="button" class="plant-card-action" aria-label="View ${name}"><i class="ri-arrow-right-line"></i></button>
                </div>
              </article>`;
            })
            .join("");
          bindPlantCardImageFallbacks(grid);

          grid.querySelectorAll(".plant-card").forEach((card) => {
            card.addEventListener("click", (e) => {
              const removeBtn = e.target?.closest?.(".plant-card-fav-remove");
              if (removeBtn) return;
              openPlantDetail(card.dataset.plantId);
            });
          });

          grid.querySelectorAll(".plant-card-fav-remove").forEach((btn) => {
            btn.addEventListener("click", (e) => {
              e.stopPropagation();
              const id = btn.dataset.removeId;
              if (!id) return;
              const nextIds = favIds.filter((x) => x !== id);
              saveStripFavourites(nextIds);
            });
          });
        });
    })
    .catch(() => {
      wrap.style.display = "none";
    });
}

function openPlantDetail(plantId) {
  if (!plantId) return;
  currentPlantDetailId = plantId;
  showView("plant");
  animatePlantDetailEntry();
  // Always open from the top of the page (header), not where the user last scrolled.
  try {
    const main = document.querySelector(".main");
    if (main) main.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: "smooth" });
    plantDetailView?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  } catch (_) {}
  loadPlantDetail(plantId);
}

function clampRating(n) {
  const v = Number(n);
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(5, Math.round(v * 10) / 10));
}

function renderRatings(ratings) {
  const r = ratings || {};
  const rows = [
    ["Ease", clampRating(r.ease)],
    ["Benefits", clampRating(r.benefits)],
    ["Cost", clampRating(r.cost)],
    ["Popularity", clampRating(r.popularity)],
  ];
  return rows
    .map(([k, v]) => {
      const pct = (v / 5) * 100;
      return `<div class="rating-row">
        <div class="rating-k">${escapeHtml(k)}</div>
        <div class="rating-bar"><span style="width:${pct}%;"></span></div>
        <div class="rating-v">${v.toFixed(1)}</div>
      </div>`;
    })
    .join("");
}

function loadPlantDetail(plantId) {
  const nameEl = document.getElementById("plantDetailName");
  const speciesEl = document.getElementById("plantDetailSpecies");
  const summaryEl = document.getElementById("plantDetailSummary");
  const imgEl = document.getElementById("plantDetailImg");
  const crumbs = document.getElementById("plantCrumbName");
  const ratingsEl = document.getElementById("plantDetailRatings");
  const toxEl = document.getElementById("plantDetailToxicity");
  const condEl = document.getElementById("plantDetailConditions");
  const checklistEl = document.getElementById("plantDetailChecklist");
  const factsEl = document.getElementById("plantDetailFacts");
  const benefitsEl = document.getElementById("plantDetailBenefits");
  const tipsEl = document.getElementById("plantDetailTips");
  const sensorEl = document.getElementById("plantDetailSensor");

  fetch(`/api/plants/catalog/${encodeURIComponent(plantId)}`)
    .then((r) => {
      if (!r.ok) throw new Error("not ok");
      return r.json();
    })
    .then((p) => {
      const name = p?.name || p?.id || "Plant";
      const species = p?.species || "—";
      const summary = p?.summary || "";
      if (nameEl) nameEl.textContent = name;
      if (speciesEl) speciesEl.textContent = species;
      if (summaryEl) summaryEl.textContent = summary;
      if (crumbs) crumbs.textContent = name;
      setPlantDetailImageWithFallback(imgEl, p?.image, p?.id || plantId, name);
      if (ratingsEl) ratingsEl.innerHTML = renderRatings(p?.ratings);
      if (toxEl) toxEl.textContent = p?.toxicity || "—";

      const care = p?.care || {};
      if (condEl) {
        const blocks = [
          ["Light", care.light],
          ["Water", care.water],
          ["Soil", care.soil],
          ["Temp", care.temp],
          ["Humidity", care.humidity],
        ].filter(([, v]) => Boolean(v));
        condEl.innerHTML = blocks
          .map(([k, v]) => `<div class="plant-cond"><span class="k">${escapeHtml(k)}</span><div class="v">${escapeHtml(v)}</div></div>`)
          .join("");
      }

      if (checklistEl) {
        const items = [
          care.light ? `Place in ${care.light.toLowerCase()}` : null,
          care.water ? `Watering: ${care.water}` : null,
          care.soil ? `Soil: ${care.soil}` : null,
          care.temp ? `Temperature: ${care.temp}` : null,
          care.humidity ? `Humidity: ${care.humidity}` : null,
          care.fertilizer ? `Fertiliser: ${care.fertilizer}` : null,
          p?.toxicity ? `Safety: ${p.toxicity}` : null,
        ].filter(Boolean);
        checklistEl.innerHTML = items.map((t) => `<li><i class="ri-checkbox-circle-line"></i><span>${escapeHtml(t)}</span></li>`).join("");
      }

      if (factsEl) {
        const facts = Array.isArray(p?.facts) ? p.facts : [];
        factsEl.innerHTML = facts.length
          ? facts.map((f) => `<li><i class="ri-sparkling-2-line"></i><span>${escapeHtml(f)}</span></li>`).join("")
          : '<li><i class="ri-sparkling-2-line"></i><span>No facts available.</span></li>';
      }

      if (benefitsEl) {
        const benefits = Array.isArray(p?.benefits) ? p.benefits : [];
        benefitsEl.innerHTML = benefits.length
          ? benefits.map((b) => `<li><i class="ri-leaf-line"></i><span>${escapeHtml(b)}</span></li>`).join("")
          : '<li><i class="ri-leaf-line"></i><span>No benefits available.</span></li>';
      }

      if (tipsEl) {
        const tips = Array.isArray(p?.tips) ? p.tips : [];
        tipsEl.innerHTML = tips.length
          ? tips
              .map(
                (t) => `<div class="plant-tip">
              <div class="plant-tip-icon" aria-hidden="true"><i class="ri-information-line"></i></div>
              <div class="plant-tip-body">
                <div class="plant-tip-title">${escapeHtml(t.title || "")}</div>
                <div class="plant-tip-text">${escapeHtml(t.text || "")}</div>
              </div>
            </div>`
              )
              .join("")
          : "";
      }

      if (sensorEl) {
        sensorEl.innerHTML = '<p class="plant-detail-sensor-empty">Loading sensor data…</p>';
        fetch("/api/plants")
          .then((r) => r.json())
          .then((plants) => {
            const list = Array.isArray(plants) ? plants : [];
            const live = list.find((pl) => pl.id === plantId);
            if (!live) {
              sensorEl.innerHTML =
                '<p class="plant-detail-sensor-empty">No DEW sensor is currently linked to this plant. Connect a sensor in your dashboard to see live moisture, temperature and light here.</p>';
              return;
            }
            const chips = [];
            if (live.moisture != null) {
              chips.push(
                `<div class="plant-detail-sensor-chip"><span class="plant-detail-sensor-chip-label">Moisture</span><span class="plant-detail-sensor-chip-value">${escapeHtml(
                  String(live.moisture)
                )}%</span></div>`
              );
            }
            if (live.temp != null) {
              chips.push(
                `<div class="plant-detail-sensor-chip"><span class="plant-detail-sensor-chip-label">Temp</span><span class="plant-detail-sensor-chip-value">${escapeHtml(
                  String(live.temp)
                )}°C</span></div>`
              );
            }
            if (live.lux != null) {
              chips.push(
                `<div class="plant-detail-sensor-chip"><span class="plant-detail-sensor-chip-label">Light</span><span class="plant-detail-sensor-chip-value">${escapeHtml(
                  String(live.lux)
                )} lux</span></div>`
              );
            }
            if (live.zone) {
              chips.push(
                `<div class="plant-detail-sensor-chip"><span class="plant-detail-sensor-chip-label">Zone</span><span class="plant-detail-sensor-chip-value">${escapeHtml(
                  String(live.zone)
                )}</span></div>`
              );
            }
            const metricsHtml = chips.length
              ? `<div class="plant-detail-sensor-metrics">${chips.join("")}</div>`
              : "";
            const last = live.updatedAt ? escapeHtml(formatAlertTime(live.updatedAt)) : "Unknown";
            sensorEl.innerHTML = `${metricsHtml}<p class="plant-detail-sensor-meta">Last sensor sync: ${last}</p>`;
          })
          .catch(() => {
            sensorEl.innerHTML =
              '<p class="plant-detail-sensor-empty">Sensor data is temporarily unavailable. Please try again later.</p>';
          });
      }
    })
    .catch(() => {
      if (nameEl) nameEl.textContent = "Plant";
      if (speciesEl) speciesEl.textContent = "—";
      if (summaryEl) summaryEl.textContent = "Unable to load plant details.";
      if (condEl) condEl.innerHTML = "";
      if (checklistEl) checklistEl.innerHTML = "";
    });
}

function initNav() {
  document.querySelectorAll(".nav-item[data-view]").forEach((el) => {
    el.addEventListener("click", () => showView(el.dataset.view));
  });
  document.querySelectorAll(".about-nav-link, .about-nav-logo[data-view]").forEach((el) => {
    el.addEventListener("click", (e) => { e.preventDefault(); showView(el.dataset.view); });
  });
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-view]");
    if (a && a.getAttribute("href") === "#") {
      e.preventDefault();
      showView(a.dataset.view);
    }
  });
  document.getElementById("aboutCtaDashboard")?.addEventListener("click", () => showView("dashboard"));
  initAlertsFilters();
  initAnalytics();
  updateAlertsBadge();
  bindPlantDetailStaticActions();
  initSettingsPreferences();
  bindCommunityPostMediaLightbox();
  bindCommunityPostDetailModal();

  const communityForm = document.getElementById("communityCreateForm");
  if (communityForm) communityForm.addEventListener("submit", handleCommunityPostSubmit);

  // Media input used by the inline Create Post preview.
  // (If this is missing, the whole initNav script crashes and buttons won't work.)
  const imgInput = document.getElementById("communityImage");

  // Community post media preview (inline carousel, Reddit-like).
  // Keep this inline (not a full-screen modal) so "Post" stays clickable.
  const previewWrap = document.getElementById("communityPostMediaPreview");
  const previewPrevBtn = document.getElementById("communityPostMediaPrevBtn");
  const previewNextBtn = document.getElementById("communityPostMediaNextBtn");
  const mainImg = document.getElementById("communityPostMediaMainImg");
  const mainVideo = document.getElementById("communityPostMediaMainVideo");
  const mainAudio = document.getElementById("communityPostMediaMainAudio");
  const thumbsWrap = document.getElementById("communityPostMediaThumbs");
  const previewRemoveBtn = document.getElementById("communityPostMediaPreviewRemove");

  let inlineCommunityPostMediaItems = [];
  let inlineCommunityPostMediaActiveIndex = 0;
  // Used by the submit handler (outside initNav scope) to upload selected media.
  window.__dewCommunityInlineMediaItems = inlineCommunityPostMediaItems;

  function inferInlineCommunityMediaKind(file) {
    const type = String(file?.type || "");
    if (type.startsWith("video/")) return "video";
    if (type.startsWith("audio/")) return "audio";
    return "image";
  }

  function revokeInlineCommunityPostMediaPreviewUrls() {
    const previewUrlsRaw = imgInput?.dataset?.previewUrls || "";
    let urls = [];
    try {
      if (previewUrlsRaw) urls = JSON.parse(previewUrlsRaw);
    } catch (_) {}
    urls.forEach((u) => {
      try {
        URL.revokeObjectURL(u);
      } catch (_) {}
    });
    if (imgInput?.dataset) imgInput.dataset.previewUrls = "";
  }

  function setInlineMainByIndex(index) {
    if (!inlineCommunityPostMediaItems.length) return;
    inlineCommunityPostMediaActiveIndex = Math.max(0, Math.min(index, inlineCommunityPostMediaItems.length - 1));
    const item = inlineCommunityPostMediaItems[inlineCommunityPostMediaActiveIndex] || inlineCommunityPostMediaItems[0];
    if (!item) return;

    const kind = item.kind;

    if (mainImg) mainImg.style.display = kind === "image" ? "block" : "none";
    if (mainVideo) mainVideo.style.display = kind === "video" ? "block" : "none";
    if (mainAudio) mainAudio.style.display = kind === "audio" ? "block" : "none";

    if (kind === "image") {
      if (mainImg) mainImg.src = item.url || "";
      if (mainVideo) {
        mainVideo.pause();
        mainVideo.removeAttribute("src");
        mainVideo.load();
      }
      if (mainAudio) {
        mainAudio.pause();
        mainAudio.removeAttribute("src");
        mainAudio.load();
      }
    } else if (kind === "video") {
      if (mainVideo) mainVideo.src = item.url || "";
      if (mainVideo) mainVideo.load();
      if (mainImg) mainImg.src = "";
      if (mainAudio) {
        mainAudio.pause();
        mainAudio.removeAttribute("src");
        mainAudio.load();
      }
    } else if (kind === "audio") {
      if (mainAudio) mainAudio.src = item.url || "";
      if (mainAudio) mainAudio.load();
      if (mainImg) mainImg.src = "";
      if (mainVideo) {
        mainVideo.pause();
        mainVideo.removeAttribute("src");
        mainVideo.load();
      }
    }

    if (thumbsWrap) {
      thumbsWrap.querySelectorAll(".community-post-media-thumb").forEach((el) => {
        const idx = Number(el.dataset.index || "0");
        el.classList.toggle("community-post-media-thumb--active", idx === inlineCommunityPostMediaActiveIndex);
      });
    }
  }

  function removeInlineMediaAtIndex(index) {
    const item = inlineCommunityPostMediaItems[index];
    if (!item) return;

    try {
      URL.revokeObjectURL(item.url);
    } catch (_) {}

    inlineCommunityPostMediaItems.splice(index, 1);
    window.__dewCommunityInlineMediaItems = inlineCommunityPostMediaItems;

    const urls = inlineCommunityPostMediaItems.map((m) => m.url);
    if (imgInput?.dataset) imgInput.dataset.previewUrls = JSON.stringify(urls);

    if (!inlineCommunityPostMediaItems.length) {
      if (previewWrap) previewWrap.style.display = "none";
      if (thumbsWrap) thumbsWrap.innerHTML = "";
      if (mainImg) mainImg.src = "";
      if (mainVideo) {
        mainVideo.pause();
        mainVideo.removeAttribute("src");
        mainVideo.load();
      }
      if (mainAudio) {
        mainAudio.pause();
        mainAudio.removeAttribute("src");
        mainAudio.load();
      }
      inlineCommunityPostMediaActiveIndex = 0;
      return;
    }

    if (inlineCommunityPostMediaActiveIndex === index) {
      inlineCommunityPostMediaActiveIndex = Math.min(index, inlineCommunityPostMediaItems.length - 1);
    } else if (inlineCommunityPostMediaActiveIndex > index) {
      inlineCommunityPostMediaActiveIndex -= 1;
    }

    renderInlineThumbs();
    setInlineMainByIndex(inlineCommunityPostMediaActiveIndex);
  }

  function reorderInlineMedia(fromIndex, toIndex) {
    if (fromIndex === toIndex) return;
    const from = inlineCommunityPostMediaItems[fromIndex];
    if (!from) return;

    const activeUrl = inlineCommunityPostMediaItems[inlineCommunityPostMediaActiveIndex]?.url || null;

    inlineCommunityPostMediaItems.splice(fromIndex, 1);
    inlineCommunityPostMediaItems.splice(toIndex, 0, from);
    window.__dewCommunityInlineMediaItems = inlineCommunityPostMediaItems;

    const urls = inlineCommunityPostMediaItems.map((m) => m.url);
    if (imgInput?.dataset) imgInput.dataset.previewUrls = JSON.stringify(urls);

    if (activeUrl) {
      const newIdx = inlineCommunityPostMediaItems.findIndex((m) => m.url === activeUrl);
      if (newIdx >= 0) inlineCommunityPostMediaActiveIndex = newIdx;
    }

    renderInlineThumbs();
    setInlineMainByIndex(inlineCommunityPostMediaActiveIndex);
  }

  function renderInlineThumbs() {
    if (!thumbsWrap) return;
    thumbsWrap.innerHTML = "";
    inlineCommunityPostMediaItems.forEach((item, idx) => {
      const thumb = document.createElement("div");
      thumb.className = "community-post-media-thumb";
      thumb.dataset.index = String(idx);
      thumb.setAttribute("role", "button");
      thumb.setAttribute("tabindex", "0");
      thumb.draggable = true;

      if (item.kind === "image") {
        const im = document.createElement("img");
        im.src = item.url;
        im.alt = "Selected media thumbnail";
        im.loading = "lazy";
        thumb.appendChild(im);
      } else if (item.kind === "video") {
        const icon = document.createElement("i");
        icon.className = "ri-play-line";
        thumb.appendChild(icon);
      } else {
        const icon = document.createElement("i");
        icon.className = "ri-music-2-line";
        thumb.appendChild(icon);
      }

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "community-post-media-thumb-remove";
      removeBtn.setAttribute("aria-label", "Remove media");
      removeBtn.innerHTML = '<i class="ri-close-line"></i>';
      removeBtn.draggable = false;
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        removeInlineMediaAtIndex(idx);
      });
      thumb.appendChild(removeBtn);

      thumb.addEventListener("click", () => setInlineMainByIndex(idx));
      thumb.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") setInlineMainByIndex(idx);
      });

      thumb.addEventListener("dragstart", (e) => {
        try {
          e.dataTransfer.setData("text/plain", String(idx));
          e.dataTransfer.effectAllowed = "move";
        } catch (_) {}
      });
      thumb.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      });
      thumb.addEventListener("drop", (e) => {
        e.preventDefault();
        const fromRaw = e.dataTransfer.getData("text/plain");
        const from = Number(fromRaw);
        const to = idx;
        if (Number.isFinite(from) && from >= 0) reorderInlineMedia(from, to);
      });

      thumbsWrap.appendChild(thumb);
    });

    setInlineMainByIndex(inlineCommunityPostMediaActiveIndex || 0);
  }

  function fileSignature(file) {
    // Best-effort duplicate prevention across selections.
    return `${String(file?.name || "")}|${file?.size || 0}|${file?.lastModified || 0}|${String(file?.type || "")}`;
  }

  function setInlinePreviewFromFiles(files) {
    // "Accumulate" behavior: appends newly selected files instead of replacing.
    const list = Array.isArray(files) ? files.filter(Boolean) : [];
    if (!list.length) return;

    const maxItems = 8;
    const existingSigs = new Set(inlineCommunityPostMediaItems.map((m) => m.signature));
    const beforeLen = inlineCommunityPostMediaItems.length;
    const toAdd = [];

    for (const file of list) {
      if (inlineCommunityPostMediaItems.length + toAdd.length >= maxItems) break;
      const sig = fileSignature(file);
      if (existingSigs.has(sig)) continue;

      const kind = inferInlineCommunityMediaKind(file);
      const mime = String(file?.type || "");
      const allowed =
        kind === "image" || (kind === "video" && mime.startsWith("video/")) || (kind === "audio" && mime.startsWith("audio/"));

      if (!allowed) {
        showToast("Unsupported media type.", "error");
        continue;
      }

      toAdd.push({
        file,
        kind,
        signature: sig,
        url: URL.createObjectURL(file),
      });
      existingSigs.add(sig);
    }

    if (!toAdd.length) return;

    inlineCommunityPostMediaItems.push(...toAdd);
    window.__dewCommunityInlineMediaItems = inlineCommunityPostMediaItems;

    // Keep dataset in sync (cleanup + submit fallback).
    const urls = inlineCommunityPostMediaItems.map((m) => m.url);
    if (imgInput?.dataset) imgInput.dataset.previewUrls = JSON.stringify(urls);

    if (previewWrap) previewWrap.style.display = "flex";
    if (beforeLen === 0) inlineCommunityPostMediaActiveIndex = 0;
    renderInlineThumbs();
    setInlineMainByIndex(inlineCommunityPostMediaActiveIndex);
  }

  function clearInlinePreviewUI() {
    revokeInlineCommunityPostMediaPreviewUrls();
    inlineCommunityPostMediaItems.length = 0;
    inlineCommunityPostMediaActiveIndex = 0;
    if (imgInput) imgInput.value = "";
    if (previewWrap) previewWrap.style.display = "none";
    if (thumbsWrap) thumbsWrap.innerHTML = "";
    if (mainImg) mainImg.src = "";
    if (mainVideo) {
      mainVideo.pause();
      mainVideo.removeAttribute("src");
      mainVideo.load();
    }
    if (mainAudio) {
      mainAudio.pause();
      mainAudio.removeAttribute("src");
      mainAudio.load();
    }
  }

  imgInput?.addEventListener("change", () => {
    const files = Array.from(imgInput?.files || []);
    setInlinePreviewFromFiles(files);
    // Allows selecting the same file(s) again.
    try {
      if (imgInput) imgInput.value = "";
    } catch (_) {}
  });

  previewRemoveBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    clearInlinePreviewUI();
  });

  previewPrevBtn?.addEventListener("click", () => {
    if (!inlineCommunityPostMediaItems.length) return;
    const nextIdx =
      (inlineCommunityPostMediaActiveIndex - 1 + inlineCommunityPostMediaItems.length) % inlineCommunityPostMediaItems.length;
    setInlineMainByIndex(nextIdx);
  });
  previewNextBtn?.addEventListener("click", () => {
    if (!inlineCommunityPostMediaItems.length) return;
    const nextIdx = (inlineCommunityPostMediaActiveIndex + 1) % inlineCommunityPostMediaItems.length;
    setInlineMainByIndex(nextIdx);
  });

  // Post type tabs (Text / Images&Video / Link / Poll)
  const postTabsWrap = document.getElementById("communityPostTypeTabs");
  const postMediaInputWrap = document.getElementById("communityPostMediaInputWrap");
  const postLinkFields = document.getElementById("communityPostLinkFields");
  const postPollFields = document.getElementById("communityPostPollFields");

  const postTitleInput = document.getElementById("communityPostTitle");
  const postTitleCount = document.getElementById("communityPostTitleCount");
  if (postTitleInput && postTitleCount) {
    const updateTitleCounter = () => {
      const len = (postTitleInput.value || "").length;
      postTitleCount.textContent = `${len}/300`;
    };
    postTitleInput.addEventListener("input", updateTitleCounter);
    updateTitleCounter();
  }

  function applyPostTypeUI(postType) {
    const tabs = postTabsWrap?.querySelectorAll(".community-post-tab") || [];
    tabs.forEach((t) => {
      const active = t.dataset.postType === postType;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });

    const isMedia = postType === "media";
    if (postMediaInputWrap) postMediaInputWrap.style.display = isMedia ? "inline-flex" : "none";
    if (previewWrap) previewWrap.style.display = isMedia ? (inlineCommunityPostMediaItems.length ? "flex" : "none") : "none";

    if (postLinkFields) postLinkFields.style.display = postType === "link" ? "block" : "none";
    if (postPollFields) postPollFields.style.display = postType === "poll" ? "block" : "none";

    // If the user leaves media tab, clear media selection to match UX expectations.
    if (!isMedia) clearInlinePreviewUI();
  }

  postTabsWrap?.querySelectorAll(".community-post-tab").forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      applyPostTypeUI(tabBtn.dataset.postType || "media");
    });
  });

  // Default UI based on initial active tab.
  const defaultType = postTabsWrap?.querySelector(".community-post-tab.active")?.dataset?.postType || "media";
  applyPostTypeUI(defaultType);

  // Modal actions
  document.getElementById("communityPostCancelBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    closeCommunityCreatePostModal();
  });

  document.getElementById("communityPostSaveDraftBtn")?.addEventListener("click", () => {
    try {
      const activeTab = postTabsWrap?.querySelector(".community-post-tab.active")?.dataset?.postType || "media";
      const payload = {
        postType: activeTab,
        title: document.getElementById("communityPostTitle")?.value || "",
        body: document.getElementById("communityPostBody")?.value || "",
        tags: document.getElementById("communityTags")?.value || "",
        linkUrl: document.getElementById("communityPostLinkUrl")?.value || "",
        pollQuestion: document.getElementById("communityPostPollQuestion")?.value || "",
        pollOption1: document.getElementById("communityPostPollOption1")?.value || "",
        pollOption2: document.getElementById("communityPostPollOption2")?.value || "",
        pollOption3: document.getElementById("communityPostPollOption3")?.value || "",
      };
      localStorage.setItem("dewCommunityCreatePostDraft", JSON.stringify(payload));
      showToast("Draft saved.", "success");
    } catch (_) {}
    closeCommunityCreatePostModal();
  });

  // Community post media picker (Reddit-like pop-over).
  // imgInput is already defined above for inline preview.

  const pickerModal = document.getElementById("communityPostMediaPicker");
  const pickerCloseBtn = document.getElementById("communityPostMediaPickerClose");
  const pickerBackdrop = document.getElementById("communityPostMediaPickerBackdrop");

  const pickerPrevBtn = document.getElementById("communityPostMediaPickerPrevBtn");
  const pickerNextBtn = document.getElementById("communityPostMediaPickerNextBtn");
  const pickerRemoveBtn = document.getElementById("communityPostMediaPickerRemove");

  const pickerMainImg = document.getElementById("communityPostMediaPickerMainImg");
  const pickerMainVideo = document.getElementById("communityPostMediaPickerMainVideo");
  const pickerThumbsWrap = document.getElementById("communityPostMediaPickerThumbs");

  const chipWrap = document.getElementById("communityPostMediaChip");
  const chipImg = document.getElementById("communityPostMediaChipImg");
  const chipIcon = document.getElementById("communityPostMediaChipIcon");
  const chipText = document.getElementById("communityPostMediaChipText");
  const chipPreviewBtn = document.getElementById("communityPostMediaChipPreviewBtn");
  const chipRemoveBtn = document.getElementById("communityPostMediaChipRemove");

  let communityPostMediaItems = [];
  let communityPostMediaActiveIndex = 0;

  function inferCommunityMediaKind(file) {
    const type = String(file?.type || "");
    if (type.startsWith("video/")) return "video";
    return "image";
  }

  function revokeCommunityPostMediaPreviewUrls() {
    // Safety: fetch input inside the function so this block can't crash
    // if outer-scope variables differ across builds.
    const mi = document.getElementById("communityImage");
    const previewUrlsRaw = mi?.dataset?.previewUrls || "";
    const urls = [];
    try {
      if (previewUrlsRaw) urls.push(...JSON.parse(previewUrlsRaw));
    } catch (_) {}
    urls.forEach((u) => {
      try { URL.revokeObjectURL(u); } catch (_) {}
    });
    if (mi?.dataset) mi.dataset.previewUrls = "";
  }

  function updateChipUI() {
    if (!chipWrap) return;
    const count = communityPostMediaItems.length;
    if (!count) {
      chipWrap.style.display = "none";
      return;
    }
    chipWrap.style.display = "flex";
    if (chipText) chipText.textContent = `${count} media selected`;

    const first = communityPostMediaItems[0];
    if (!first) return;
    if (first.kind === "image") {
      if (chipIcon) chipIcon.style.display = "none";
      if (chipImg) {
        chipImg.style.display = "block";
        chipImg.src = first.url;
      }
    } else {
      if (chipIcon) chipIcon.style.display = "inline-flex";
      if (chipImg) {
        chipImg.style.display = "none";
        chipImg.src = "";
      }
    }
  }

  function setPickerMainByIndex(index) {
    if (!communityPostMediaItems.length) return;
    communityPostMediaActiveIndex = Math.max(0, Math.min(index, communityPostMediaItems.length - 1));
    const item = communityPostMediaItems[communityPostMediaActiveIndex];
    if (!item) return;

    const isImage = item.kind === "image";
    if (pickerMainImg) pickerMainImg.style.display = isImage ? "block" : "none";
    if (pickerMainVideo) pickerMainVideo.style.display = isImage ? "none" : "block";

    if (isImage) {
      if (pickerMainImg) pickerMainImg.src = item.url || "";
      if (pickerMainVideo) {
        pickerMainVideo.pause();
        pickerMainVideo.removeAttribute("src");
        pickerMainVideo.load();
      }
    } else {
      if (pickerMainVideo) {
        pickerMainVideo.src = item.url || "";
        pickerMainVideo.load();
      }
      if (pickerMainImg) pickerMainImg.src = "";
    }

    if (pickerThumbsWrap) {
      pickerThumbsWrap.querySelectorAll(".community-post-media-lightbox-thumb").forEach((el) => {
        const idx = Number(el.dataset.index || "0");
        el.classList.toggle("community-post-media-lightbox-thumb--active", idx === communityPostMediaActiveIndex);
      });
    }
  }

  function renderPickerThumbs() {
    if (!pickerThumbsWrap) return;
    pickerThumbsWrap.innerHTML = "";
    communityPostMediaItems.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "community-post-media-lightbox-thumb";
      btn.dataset.index = String(idx);

      if (item.kind === "image") {
        const im = document.createElement("img");
        im.src = item.url;
        im.alt = "Selected media thumbnail";
        btn.appendChild(im);
      } else {
        const icon = document.createElement("i");
        icon.className = "ri-play-line";
        btn.appendChild(icon);
      }

      btn.addEventListener("click", () => setPickerMainByIndex(idx));
      pickerThumbsWrap.appendChild(btn);
    });

    setPickerMainByIndex(0);
  }

  function openPicker() {
    if (!pickerModal) return;
    pickerModal.style.display = "flex";
    document.body.style.overflow = "hidden";
  }

  function closePicker() {
    if (!pickerModal) return;
    pickerModal.style.display = "none";
    document.body.style.overflow = "";
    if (pickerMainVideo) {
      pickerMainVideo.pause();
      pickerMainVideo.removeAttribute("src");
      pickerMainVideo.load();
    }
    if (pickerMainImg) pickerMainImg.src = "";
  }

  function setCommunityPostMediaPickerFromFiles(files) {
    // Disabled for now: we use inline preview (communityPostMediaPreview) so
    // the user can always press "Post" like Reddit/Google UI.
    // The modal picker is still present in HTML/CSS but not driven here.
    return;
  }

  function clearCommunityPostMediaPickerUI() {
    // Not used while modal picker is disabled.
    // Kept for future re-enable.
    try {
      const mi = document.getElementById("communityImage");
      if (mi) mi.value = "";
    } catch (_) {}
  }

  const miForPicker = document.getElementById("communityImage");
  if (miForPicker) {
    miForPicker.addEventListener("change", () => {
      const files = Array.from(miForPicker.files || []);
      setCommunityPostMediaPickerFromFiles(files);
    });
  }

  chipPreviewBtn?.addEventListener("click", () => {
    if (!communityPostMediaItems.length) return;
    // openPicker();
  });
  chipRemoveBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    clearCommunityPostMediaPickerUI();
  });
  pickerRemoveBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    clearCommunityPostMediaPickerUI();
  });

  pickerCloseBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    closePicker();
  });
  pickerBackdrop?.addEventListener("click", closePicker);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pickerModal?.style.display !== "none") closePicker();
  });

  pickerPrevBtn?.addEventListener("click", () => {
    if (!communityPostMediaItems.length) return;
    setPickerMainByIndex(communityPostMediaActiveIndex - 1);
  });
  pickerNextBtn?.addEventListener("click", () => {
    if (!communityPostMediaItems.length) return;
    setPickerMainByIndex(communityPostMediaActiveIndex + 1);
  });

  const sortTabs = document.getElementById("communitySortTabs");
  if (sortTabs) {
    sortTabs.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        communitySortFilter = tab.dataset.sort || "new";
        sortTabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        loadCommunityView();
      });
    });
  }
  const categorySelect = document.getElementById("communityCategoryFilter");
  if (categorySelect) {
    categorySelect.addEventListener("change", () => {
      communityCategoryFilter = categorySelect.value || "all";
      loadCommunityView();
    });
  }
  document.getElementById("communitySearchBtn")?.addEventListener("click", () => {
    communitySearchQuery = (document.getElementById("communitySearch")?.value || "").trim();
    loadCommunityView();
  });
  document.getElementById("communitySearch")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      communitySearchQuery = (e.target.value || "").trim();
      loadCommunityView();
    }
  });
  document.getElementById("communityCreatePostBtn")?.addEventListener("click", () => {
    openCommunityCreatePostModal();
  });
  document.getElementById("communityStartCommunityBtn")?.addEventListener("click", () => {
    openCreateCommunityModal();
  });
  document.getElementById("createCommunityModalClose")?.addEventListener("click", closeCreateCommunityModal);
  document.getElementById("createCommunityCancel")?.addEventListener("click", closeCreateCommunityModal);
  document.getElementById("createCommunityModalBackdrop")?.addEventListener("click", closeCreateCommunityModal);
  document.getElementById("createCommunityForm")?.addEventListener("submit", handleCreateCommunitySubmit);
  document.getElementById("editCommunityModalClose")?.addEventListener("click", closeEditCommunityModal);
  document.getElementById("editCommunityCancel")?.addEventListener("click", closeEditCommunityModal);
  document.getElementById("editCommunityModalBackdrop")?.addEventListener("click", closeEditCommunityModal);
  document.getElementById("editCommunityForm")?.addEventListener("submit", handleEditCommunitySubmit);
  document.getElementById("editCommunityBannerPreviewBtn")?.addEventListener("click", () => {
    document.getElementById("editCommunityBanner")?.click();
  });
  document.getElementById("editCommunityLogoPreviewBtn")?.addEventListener("click", () => {
    document.getElementById("editCommunityLogo")?.click();
  });
  document.getElementById("editCommunityBanner")?.addEventListener("change", (e) => {
    const modal = document.getElementById("editCommunityModal");
    updateEditCommunityImagePreview("banner", e?.target?.files?.[0] || null, modal?.dataset?.bannerUrl || "", "");
  });
  document.getElementById("editCommunityLogo")?.addEventListener("change", (e) => {
    const modal = document.getElementById("editCommunityModal");
    updateEditCommunityImagePreview("logo", e?.target?.files?.[0] || null, modal?.dataset?.logoUrl || "", modal?.dataset?.logoLabel || "r");
  });
  document.getElementById("createCommunityNext")?.addEventListener("click", () => {
    if (createCommunityWizard.step === 1 && !createCommunityWizard.topic) {
      showToast("Please choose a topic.", "error");
      return;
    }
    if (createCommunityWizard.step === 2) {
      createCommunityWizard.type = document.querySelector('input[name="createCommunityType"]:checked')?.value || "public";
      createCommunityWizard.mature = !!document.getElementById("createCommunityMature")?.checked;
    }
    createCommunityWizard.step = Math.min(3, createCommunityWizard.step + 1);
    renderCreateCommunityWizard();
  });
  document.getElementById("createCommunityBack")?.addEventListener("click", () => {
    createCommunityWizard.step = Math.max(1, createCommunityWizard.step - 1);
    renderCreateCommunityWizard();
  });
  document.querySelectorAll(".community-topic-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      createCommunityWizard.topic = chip.dataset.topic || "Indoor Plants";
      renderCreateCommunityWizard();
    });
  });
  document.querySelectorAll('input[name="createCommunityType"]').forEach((el) => {
    el.addEventListener("change", () => {
      createCommunityWizard.type = el.value || "public";
    });
  });
  document.getElementById("createCommunityMature")?.addEventListener("change", (e) => {
    createCommunityWizard.mature = !!e.target.checked;
  });
  document.getElementById("createCommunityName")?.addEventListener("input", (e) => {
    const slugEl = document.getElementById("createCommunitySlug");
    if (!slugEl || slugEl.dataset.touched === "true") return;
    slugEl.value = _slugifyCommunityName(e.target.value || "");
    updateCreateCommunityPreview();
  });
  document.getElementById("createCommunitySlug")?.addEventListener("input", (e) => {
    e.target.dataset.touched = "true";
    updateCreateCommunityPreview();
  });
  document.getElementById("createCommunityDescription")?.addEventListener("input", updateCreateCommunityPreview);
  document.getElementById("communityRecentClear")?.addEventListener("click", (e) => {
    e.preventDefault();
    communityRecentPosts = [];
    renderCommunityRecentList();
  });
  document.querySelectorAll(".community-top-nav .community-nav-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      if (link.dataset.communityHome === "true") {
        communitySelectedSlug = null;
        showView("community");
        communityCategoryFilter = "all";
        communitySortFilter = "new";
        communitySearchQuery = "";
        const catSel = document.getElementById("communityCategoryFilter");
        if (catSel) catSel.value = "all";
        const sortTabs = document.getElementById("communitySortTabs");
        if (sortTabs) {
          sortTabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
          const newTab = sortTabs.querySelector(".tab[data-sort=\"new\"]");
          if (newTab) newTab.classList.add("active");
        }
        const searchInput = document.getElementById("communitySearch");
        if (searchInput) searchInput.value = "";
        setCommunityRoute(null);
        loadCommunitiesSidebar();
        loadCommunityView();
        return;
      }
      const v = link.getAttribute("data-view");
      if (v) showView(v);
    });
  });
  window.addEventListener("popstate", () => {
    const slug = parseCommunitySlugFromPath();
    if (window.location.pathname === "/community" || slug) {
      communitySelectedSlug = slug;
      communityCategoryFilter = slug || "all";
      suppressCommunityRoutePush = true;
      showView("community");
      suppressCommunityRoutePush = false;
    }
  });

  const refreshAlertsBtn = document.getElementById("btnRefreshAlerts");
  refreshAlertsBtn?.addEventListener("click", () => {
    refreshAlertsBtn.classList.add("btn-refresh--spinning");
    loadAlertsView(refreshAlertsBtn);
  });

  // Community admin modals + controls
  document.getElementById("communitySymbolModalClose")?.addEventListener("click", closeCommunitySymbolModal);
  document.getElementById("communitySymbolCancel")?.addEventListener("click", closeCommunitySymbolModal);
  document.getElementById("communitySymbolSave")?.addEventListener("click", saveCommunitySymbolFromModal);

  document.getElementById("communityModsModalClose")?.addEventListener("click", closeCommunityModsModal);
  document.getElementById("communityModsCancel")?.addEventListener("click", closeCommunityModsModal);
  document.getElementById("communityModsSave")?.addEventListener("click", saveModeratorsFromModal);
  document.getElementById("communityModsSearch")?.addEventListener("input", () => {
    clearTimeout(window.__dewModsSearchTimer);
    window.__dewModsSearchTimer = setTimeout(searchUsersForMods, 250);
  });

  document.getElementById("communityMessageSendBtn")?.addEventListener("click", async () => {
    const input = document.getElementById("communityMessageInput");
    const target = document.getElementById("communityMessageTarget");
    const slug = String(communitySelectedSlug || "").trim();
    const body = String(input?.value || "").trim();
    const sel = String(target?.value || "mods");
    if (!slug || !body || !currentProfileUser?.uid) return;
    let toKind = "mods";
    let toUid = null;
    if (sel === "admin") toKind = "admin";
    else if (sel.startsWith("user:")) { toKind = "user"; toUid = sel.slice(5); }
    try {
      const auth = await authReady;
      const token = await auth.currentUser?.getIdToken?.();
      if (!token) return;
      const res = await fetch(`/api/communities/${encodeURIComponent(slug)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ toKind, toUid, body }),
      });
      if (!res.ok) throw new Error("not ok");
      if (input) input.value = "";
      showToast("Message sent.", "success");
    } catch (_) {
      showToast("Could not send message.", "error");
    }
  });
}

let communityCategoryFilter = "all";
let communitySortFilter = "new";
let communitySearchQuery = "";
let communityRecentPosts = [];
let communityList = [];
let communitySelectedSlug = null;
let communityJoinedSlugs = new Set();
let communityMutedSlugs = new Set();
let communityPostDetailOpenPostId = null;
let createCommunityWizard = { step: 1, topic: "Indoor Plants", type: "public", mature: false };

function openCommunityCreatePostModal() {
  const block = document.getElementById("communityCreateBlock");
  const backdrop = document.getElementById("communityCreatePostBackdrop");
  const closeBtn = document.getElementById("communityCreatePostModalClose");
  if (!block) return;

  // If we already know the current community, preselect it.
  const sel = document.getElementById("communityCategory");
  if (sel && communitySelectedSlug) sel.value = communitySelectedSlug;

  block.style.display = "block";
  block.setAttribute("aria-hidden", "false");
  if (backdrop) {
    backdrop.classList.add("is-open");
    backdrop.style.display = "block";
    backdrop.onclick = () => closeCommunityCreatePostModal();
  }

  // Next frame so transitions apply.
  requestAnimationFrame(() => {
    block.classList.add("is-open");
  });

  closeBtn?.addEventListener("click", closeCommunityCreatePostModal, { once: true });

  // Close on Escape (attach once per open).
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") closeCommunityCreatePostModal();
    },
    { once: true }
  );
}

function closeCommunityCreatePostModal() {
  const block = document.getElementById("communityCreateBlock");
  const backdrop = document.getElementById("communityCreatePostBackdrop");
  if (!block) return;

  block.classList.remove("is-open");
  if (backdrop) backdrop.classList.remove("is-open");

  // Reset form + media state so next open starts clean.
  try {
    const imgInput = document.getElementById("communityImage");
    const previewWrap = document.getElementById("communityPostMediaPreview");
    const previewThumbs = document.getElementById("communityPostMediaThumbs");
    const previewMainImg = document.getElementById("communityPostMediaMainImg");
    const previewMainVideo = document.getElementById("communityPostMediaMainVideo");
    const previewMainAudio = document.getElementById("communityPostMediaMainAudio");

    const titleEl = document.getElementById("communityPostTitle");
    const bodyEl = document.getElementById("communityPostBody");
    const tagsEl = document.getElementById("communityTags");

    const linkUrlEl = document.getElementById("communityPostLinkUrl");
    const pollQEl = document.getElementById("communityPostPollQuestion");
    const pollOpt1El = document.getElementById("communityPostPollOption1");
    const pollOpt2El = document.getElementById("communityPostPollOption2");
    const pollOpt3El = document.getElementById("communityPostPollOption3");

    const linkFields = document.getElementById("communityPostLinkFields");
    const pollFields = document.getElementById("communityPostPollFields");
    const mediaInputWrap = document.getElementById("communityPostMediaInputWrap");
    const postTabsWrap = document.getElementById("communityPostTypeTabs");

    if (imgInput?.dataset?.previewUrls) {
      try {
        const urls = JSON.parse(imgInput.dataset.previewUrls || "[]");
        urls.forEach((u) => {
          try {
            URL.revokeObjectURL(u);
          } catch (_) {}
        });
      } catch (_) {}
    }
    if (imgInput?.dataset) imgInput.dataset.previewUrls = "";
    if (imgInput) imgInput.value = "";

    if (previewWrap) previewWrap.style.display = "none";
    if (previewThumbs) previewThumbs.innerHTML = "";

    if (previewMainImg) {
      previewMainImg.src = "";
      previewMainImg.style.display = "none";
    }
    if (previewMainVideo) {
      previewMainVideo.pause();
      previewMainVideo.removeAttribute("src");
      previewMainVideo.load();
      previewMainVideo.style.display = "none";
    }
    if (previewMainAudio) {
      previewMainAudio.pause();
      previewMainAudio.removeAttribute("src");
      previewMainAudio.load();
      previewMainAudio.style.display = "none";
    }

    // Clear global media state used by submit.
    try {
      if (window.__dewCommunityInlineMediaItems) window.__dewCommunityInlineMediaItems.length = 0;
    } catch (_) {}

    // Reset inputs.
    if (titleEl) titleEl.value = "";
    if (bodyEl) bodyEl.value = "";
    if (tagsEl) tagsEl.value = "";
    const titleCountEl = document.getElementById("communityPostTitleCount");
    if (titleCountEl) titleCountEl.textContent = "0/300";
    if (linkUrlEl) linkUrlEl.value = "";
    if (pollQEl) pollQEl.value = "";
    if (pollOpt1El) pollOpt1El.value = "";
    if (pollOpt2El) pollOpt2El.value = "";
    if (pollOpt3El) pollOpt3El.value = "";

    // Reset tabs to "media".
    if (postTabsWrap) {
      postTabsWrap.querySelectorAll(".community-post-tab").forEach((t) => {
        const active = t.dataset.postType === "media";
        t.classList.toggle("active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      });
    }
    if (linkFields) linkFields.style.display = "none";
    if (pollFields) pollFields.style.display = "none";
    if (mediaInputWrap) mediaInputWrap.style.display = "inline-flex";
  } catch (_) {}

  // Wait for transition before hiding (avoid jank).
  window.setTimeout(() => {
    block.style.display = "none";
    block.setAttribute("aria-hidden", "true");
    if (backdrop) backdrop.style.display = "none";
  }, 170);
}

try {
  const joinedRaw = localStorage.getItem("communityJoinedSlugs");
  const mutedRaw = localStorage.getItem("communityMutedSlugs");
  if (joinedRaw) communityJoinedSlugs = new Set(JSON.parse(joinedRaw));
  if (mutedRaw) communityMutedSlugs = new Set(JSON.parse(mutedRaw));
} catch (_) {}

function saveCommunityPrefs() {
  try {
    localStorage.setItem("communityJoinedSlugs", JSON.stringify(Array.from(communityJoinedSlugs)));
    localStorage.setItem("communityMutedSlugs", JSON.stringify(Array.from(communityMutedSlugs)));
  } catch (_) {}
}

function updateCreateCommunityPreview() {
  const name = (document.getElementById("createCommunityName")?.value || "").trim();
  const slug = _slugifyCommunityName(document.getElementById("createCommunitySlug")?.value || name || "communityname");
  const desc = (document.getElementById("createCommunityDescription")?.value || "").trim();
  const nameEl = document.getElementById("createCommunityPreviewName");
  const descEl = document.getElementById("createCommunityPreviewDesc");
  const metaEl = document.getElementById("createCommunityPreviewMeta");
  if (nameEl) nameEl.textContent = `r/${slug || "communityname"}`;
  if (descEl) descEl.textContent = desc || "Your community description";
  if (metaEl) metaEl.textContent = `${createCommunityWizard.topic || "Other"} · ${(createCommunityWizard.type || "public").toUpperCase()}`;
}

function renderCreateCommunityWizard() {
  const step = createCommunityWizard.step;
  const titleEl = document.getElementById("createCommunityWizardTitle");
  const subtitleEl = document.getElementById("createCommunityWizardSubtitle");
  const step1 = document.getElementById("createCommunityStep1");
  const step2 = document.getElementById("createCommunityStep2");
  const step3 = document.getElementById("createCommunityStep3");
  const btnBack = document.getElementById("createCommunityBack");
  const btnNext = document.getElementById("createCommunityNext");
  const btnSubmit = document.getElementById("createCommunitySubmit");
  if (step1) step1.style.display = step === 1 ? "block" : "none";
  if (step2) step2.style.display = step === 2 ? "block" : "none";
  if (step3) step3.style.display = step === 3 ? "block" : "none";
  if (btnBack) btnBack.style.display = step > 1 ? "inline-flex" : "none";
  if (btnNext) btnNext.style.display = step < 3 ? "inline-flex" : "none";
  if (btnSubmit) btnSubmit.style.display = step === 3 ? "inline-flex" : "none";
  if (titleEl) {
    titleEl.innerHTML = step === 1
      ? '<i class="ri-add-circle-line"></i> What will your community be about?'
      : step === 2
      ? '<i class="ri-shield-line"></i> What kind of community is this?'
      : '<i class="ri-edit-2-line"></i> Tell us about your community';
  }
  if (subtitleEl) {
    subtitleEl.textContent = step === 1
      ? "Choose a topic to help people discover your community."
      : step === 2
      ? "Decide who can view and contribute in your community."
      : "A name and description help people understand your community.";
  }
  document.querySelectorAll(".community-create-wizard-dots .dot").forEach((d) => {
    d.classList.toggle("active", Number(d.dataset.stepDot) === step);
  });
  document.querySelectorAll(".community-topic-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.topic === createCommunityWizard.topic);
  });
  const selectedType = document.querySelector(`input[name="createCommunityType"][value="${createCommunityWizard.type}"]`);
  if (selectedType) selectedType.checked = true;
  const matureEl = document.getElementById("createCommunityMature");
  if (matureEl) matureEl.checked = !!createCommunityWizard.mature;
  updateCreateCommunityPreview();
}

function parseCommunitySlugFromPath() {
  const path = String(window.location.pathname || "");
  const canonical = path.match(/^\/community\/r\/([a-z0-9-]+)$/i);
  if (canonical) return canonical[1].toLowerCase();
  // Backward compatible slug route: /community/<slug>
  const legacy = path.match(/^\/community\/([a-z0-9-]+)$/i);
  if (legacy) return legacy[1].toLowerCase();
  return null;
}

function setCommunityRoute(slug) {
  if (typeof history === "undefined" || !history.pushState) return;
  if (slug) history.pushState({ view: "community", slug }, "", `/community/r/${encodeURIComponent(slug)}`);
  else history.pushState({ view: "community" }, "", "/community");
}

async function loadCommunitiesSidebar() {
  const yourEl = document.getElementById("communityYourList");
  const popularEl = document.getElementById("communityPopularList");
  const categorySelect = document.getElementById("communityCategory");
  const feedCategorySelect = document.getElementById("communityCategoryFilter");
  try {
    const uid = currentProfileUser?.uid || "";
    const res = await fetch("/api/communities" + (uid ? "?uid=" + encodeURIComponent(uid) : ""));
    if (!res.ok) throw new Error("Failed to load communities");
    const communities = await res.json();
    communityList = Array.isArray(communities) ? communities : [];
  } catch {
    communityList = [];
  }
  const renderList = (list, el, prefix) => {
    if (!el) return;
    if (!list.length) { el.innerHTML = "<li class=\"community-list-loading\">None yet</li>"; return; }
    el.innerHTML = list.map((c) => {
      const name = c.name || c.slug || c.id;
      const slug = c.slug || c.id;
      const symbol = String(c.logo_symbol || "").trim();
      const label = symbol ? `${symbol} r/${slug}` : `r/${slug}`;
      return `<li data-community-id="${escapeHtml(c.id)}" data-community-slug="${escapeHtml(slug)}"><span>${escapeHtml(label)}</span><span class="pill">${c.post_count ?? 0} posts</span></li>`;
    }).join("");
    el.querySelectorAll("li[data-community-id]").forEach((li) => {
      li.addEventListener("click", () => {
        const slug = (li.dataset.communitySlug || "all").toLowerCase();
        communitySelectedSlug = slug === "all" ? null : slug;
        communityCategoryFilter = slug;
        setCommunityRoute(communitySelectedSlug);
        const sel = document.getElementById("communityCategoryFilter");
        if (sel) sel.value = communityCategoryFilter;
        loadCommunityView();
      });
    });
  };
  const yourCommunities = communityList.filter((c) => c.joined);
  renderList(yourCommunities.length ? yourCommunities : communityList.slice(0, 6), yourEl);
  renderList(communityList, popularEl);
  if (categorySelect) {
    const opts = communityList.map((c) => `<option value="${escapeHtml(c.slug || c.id)}">r/${escapeHtml(c.slug || c.id)}</option>`).join("");
    categorySelect.innerHTML = opts || "<option value=\"\">No communities yet — create one first</option>";
  }
  if (feedCategorySelect) {
    const opts = communityList.map((c) => `<option value="${escapeHtml(c.slug || c.id)}">r/${escapeHtml(c.slug || c.id)}</option>`).join("");
    feedCategorySelect.innerHTML = `<option value="all">All Categories</option>${opts}`;
    if ([...feedCategorySelect.options].some((o) => o.value === communityCategoryFilter)) {
      feedCategorySelect.value = communityCategoryFilter;
    } else {
      feedCategorySelect.value = "all";
      communityCategoryFilter = "all";
    }
  }
}

function renderCommunityRecentList() {
  const el = document.getElementById("communityRecentList");
  if (!el) return;
  if (!communityRecentPosts.length) { el.innerHTML = "<li>No recent posts</li>"; return; }
  el.innerHTML = communityRecentPosts.slice(0, 10).map((p) => {
    const title = (p.title || "").slice(0, 40) + ((p.title || "").length > 40 ? "…" : "");
    const score = p.score ?? 0;
    const comments = p.comment_count ?? 0;
    return `<li>${escapeHtml(title)} — ${score} upvotes ${comments} comments</li>`;
  }).join("");
}

function renderCommunityPanels(allPosts) {
  const detailCard = document.getElementById("communityDetailCard");
  const infoCard = document.getElementById("communityInfoCard");
  const controls = document.getElementById("communityControls");
  const highlightsWrap = document.getElementById("communityHighlightsCards");
  if (!detailCard || !infoCard) return;
  if (!communitySelectedSlug) {
    detailCard.style.display = "none";
    infoCard.style.display = "none";
    if (highlightsWrap) highlightsWrap.style.display = "none";
    // keep controls at top when no community selected
    if (controls && controls.parentElement?.firstElementChild !== controls) {
      const main = document.querySelector(".community-main");
      if (main) main.insertBefore(controls, main.firstElementChild);
    }
    return;
  }
  const slug = communitySelectedSlug;
  const comm = communityList.find((c) => (c.slug || c.id || "").toLowerCase() === slug);
  if (!comm) {
    detailCard.style.display = "none";
    infoCard.style.display = "none";
    communitySelectedSlug = null;
    communityCategoryFilter = "all";
    if (typeof setCommunityRoute === "function") setCommunityRoute(null);
    const catSel = document.getElementById("communityCategoryFilter");
    if (catSel) catSel.value = "all";
    loadCommunityView();
    return;
  }
  detailCard.style.display = "block";
  infoCard.style.display = "block";
  // Move the search/sort controls below the header card (like your reference).
  try {
    if (controls && controls.parentElement && controls.parentElement !== detailCard.parentElement) {
      // noop
    }
    if (controls) detailCard.insertAdjacentElement("afterend", controls);
  } catch (_) {}
  const titleEl = document.getElementById("communityDetailTitle");
  const descEl = document.getElementById("communityDetailDesc");
  const logoEl = document.getElementById("communityDetailLogo");
  const metaEl = document.getElementById("communityDetailMeta");
  const bannerEl = document.getElementById("communityDetailBanner");
  const joinBtn = document.getElementById("communityJoinBtn");
  const muteBtn = document.getElementById("communityMuteBtn");
  const notifyBtn = document.getElementById("communityNotifyBtn");
  const notifyMenu = document.getElementById("communityNotifyMenu");
  const quickCreateBtn = document.getElementById("communityCreatePostQuickBtn");
  const latestEl = document.getElementById("communityLatestList");
  const topEl = document.getElementById("communityTopList");
  const infoGrid = document.getElementById("communityInfoGrid");
  const modsEl = document.getElementById("communityModeratorsList");
  if (titleEl) titleEl.textContent = `r/${comm.slug || slug}`;
  if (descEl) descEl.textContent = comm.description || "A place for eco and plant discussions.";
  if (logoEl) {
    const logoUrl = comm.logo_url && String(comm.logo_url).trim();
    if (logoUrl && (logoUrl.startsWith("http://") || logoUrl.startsWith("https://"))) {
      logoEl.textContent = "";
      logoEl.style.backgroundImage = `url(${logoUrl.replace(/\)/g, "%29")})`;
      logoEl.style.backgroundSize = "cover";
      logoEl.style.backgroundPosition = "center";
      logoEl.style.backgroundRepeat = "no-repeat";
      logoEl.dataset.imageUrl = logoUrl;
      logoEl.style.cursor = "pointer";
    } else {
      logoEl.style.backgroundImage = "";
      logoEl.textContent = (comm.slug || slug || "r").slice(0, 1).toLowerCase();
      logoEl.dataset.imageUrl = "";
      logoEl.style.cursor = "";
    }
  }
  if (bannerEl) {
    const bannerUrl = comm.banner_url && String(comm.banner_url).trim();
    if (bannerUrl && (bannerUrl.startsWith("http://") || bannerUrl.startsWith("https://"))) {
      bannerEl.style.backgroundImage = `url(${bannerUrl.replace(/\)/g, "%29")})`;
      bannerEl.style.backgroundSize = "cover";
      bannerEl.style.backgroundPosition = "center";
      bannerEl.style.backgroundRepeat = "no-repeat";
      bannerEl.style.backgroundColor = "rgba(0,0,0,0.2)";
      bannerEl.dataset.imageUrl = bannerUrl;
      bannerEl.style.cursor = "pointer";
    } else {
      bannerEl.style.backgroundImage = "";
      bannerEl.style.background = "linear-gradient(90deg, rgba(67, 199, 122, 0.9), rgba(51, 186, 179, 0.9))";
      bannerEl.dataset.imageUrl = "";
      bannerEl.style.cursor = "";
    }
  }
  if (metaEl) {
    const members = comm.members_count ?? comm.member_count ?? 0;
    metaEl.innerHTML = `<span>${members} members</span><span>${comm.post_count ?? 0} posts</span><span>${escapeHtml(comm.category || "Other")}</span>`;
  }

  // Symbol next to title (admin editable)
  const symbolEl = document.getElementById("communityDetailSymbol");
  const symbolBtn = document.getElementById("communitySymbolBtn");
  const currentSymbol = String(comm.logo_symbol || "").trim();
  if (symbolEl) symbolEl.textContent = currentSymbol || "";

  if (joinBtn) {
    const isModerator =
      !!(
        currentProfileUser?.uid &&
        Array.isArray(comm.moderators) &&
        comm.moderators.some((m) => String(m?.uid || "") === String(currentProfileUser.uid))
      );
    const joined = !!comm.joined || isModerator;
    joinBtn.textContent = joined ? "Joined" : "Join";
    joinBtn.classList.toggle("btn-primary", joined);
    joinBtn.classList.toggle("btn-ghost", !joined);
    joinBtn.onclick = async () => {
      if (!currentProfileUser?.uid) return;
      try {
        const auth = await authReady;
        const token = await auth.currentUser?.getIdToken?.();
        if (!token) return;
        const endpoint = joined ? `/api/communities/${encodeURIComponent(slug)}/leave` : `/api/communities/${encodeURIComponent(slug)}/join`;
        const res = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error("not ok");
        const out = await res.json();
        comm.joined = !!out.joined;
        if (typeof out.members === "number") comm.members_count = out.members;
        loadCommunitiesSidebar();
        loadCommunityView();
      } catch (_) {}
    };
  }
  // Mute is now inside the bell dropdown (like your reference).
  if (notifyBtn) notifyBtn.title = "Notifications";
  const editBtn = document.getElementById("communityEditBtn");
  const bannerEditBtn = document.getElementById("communityBannerEditBtn");
  const manageModsBtn = document.getElementById("communityManageModsBtn");
  const creatorUid = String(comm.creator_firebase_uid || "").trim();
  // Legacy rows may not have creator_firebase_uid yet; allow signed-in user
  // to open edit once and claim ownership server-side.
  const isCreator = !!(currentProfileUser?.uid && (!creatorUid || currentProfileUser.uid === creatorUid));
  if (editBtn) editBtn.style.display = "none";
  if (bannerEditBtn) {
    bannerEditBtn.style.display = isCreator ? "inline-flex" : "none";
    bannerEditBtn.onclick = () => openEditCommunityModal(slug, comm);
  }
  const logoEditBtn = document.getElementById("communityLogoEditBtn");
  if (logoEditBtn) {
    logoEditBtn.style.display = isCreator ? "inline-flex" : "none";
    logoEditBtn.onclick = () => openEditCommunityModal(slug, comm);
  }
  const descEditBtn = document.getElementById("communityDescEditBtn");
  if (descEditBtn) {
    descEditBtn.style.display = isCreator ? "inline-flex" : "none";
    descEditBtn.onclick = () => openEditCommunityModal(slug, comm);
  }
  if (symbolBtn) {
    symbolBtn.style.display = isCreator ? "inline-flex" : "none";
    symbolBtn.onclick = () => openCommunitySymbolModal(slug, comm);
  }
  if (manageModsBtn) {
    manageModsBtn.style.display = isCreator ? "inline-flex" : "none";
    manageModsBtn.onclick = () => openCommunityModsModal(slug, comm);
  }

  // Admin/creator can delete the entire community.
  const deleteCommunityBtn = document.getElementById("communityDeleteBtn");
  if (deleteCommunityBtn) {
    deleteCommunityBtn.style.display = isCreator ? "inline-flex" : "none";
    deleteCommunityBtn.onclick = async () => {
      if (!confirm("Delete this community? This will also delete its posts and comments.")) return;
      if (!currentProfileUser?.uid) return;
      try {
        const auth = await authReady;
        const token = await auth.currentUser?.getIdToken?.();
        if (!token) return;
        const delRes = await fetch(`/api/communities/${encodeURIComponent(slug)}/delete`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        const j = await delRes.json().catch(() => ({}));
        if (!delRes.ok) throw new Error(j.error || "Delete failed");

        // Navigate away from the deleted community.
        communitySelectedSlug = null;
        communityCategoryFilter = "all";
        setCommunityRoute(null);
        await loadCommunitiesSidebar();
        loadCommunityView();
      } catch (e) {
        showToast(e?.message || "Could not delete community.", "error");
      }
    };
  }

  // Bell dropdown (saved per community, stored locally + in backend)
  const setNotifyUI = (level) => {
    if (!notifyBtn) return;
    notifyBtn.dataset.level = level;
    notifyBtn.title =
      level === "off"
        ? "Notifications: Off"
        : level === "high"
        ? "Notifications: Popular posts"
        : "Notifications: All new posts";
  };

  const initialLevel = String(comm.notify_level || getCommunityNotifyPref(slug) || "all");
  setNotifyUI(initialLevel);
  if (notifyMenu) notifyMenu.dataset.openFor = slug;
  if (notifyBtn && notifyMenu) {
    notifyBtn.onclick = (e) => {
      e.stopPropagation();
      notifyMenu.classList.toggle("open");
    };
    const setChecks = (level) => {
      notifyMenu.querySelectorAll("[data-notify-level]").forEach((btn) => {
        btn.classList.toggle("selected", String(btn.dataset.notifyLevel) === level);
      });
    };
    setChecks(initialLevel);

    notifyMenu.querySelectorAll("[data-notify-level]").forEach((opt) => {
      opt.onclick = async () => {
        const level = String(opt.dataset.notifyLevel || "all");
        setCommunityNotifyPref(slug, level);
        setNotifyUI(level);
        setChecks(level);
        notifyMenu.classList.remove("open");
        try {
          const auth = await authReady;
          const token = await auth.currentUser?.getIdToken?.();
          if (token) {
            await fetch(`/api/communities/${encodeURIComponent(slug)}/notify`, {
              method: "PUT",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ level }),
            });
          }
        } catch (_) {}
        loadCommunitiesSidebar();
      };
    });
    notifyMenu.querySelectorAll("[data-notify-mute]").forEach((opt) => {
      opt.onclick = () => {
        if (communityMutedSlugs.has(slug)) communityMutedSlugs.delete(slug);
        else communityMutedSlugs.add(slug);
        saveCommunityPrefs();
        notifyMenu.classList.remove("open");
        renderCommunityPanels(allPosts);
      };
    });
    document.addEventListener(
      "click",
      () => {
        notifyMenu.classList.remove("open");
      },
      { once: true }
    );
  }
  if (quickCreateBtn) quickCreateBtn.onclick = () => {
    const sel = document.getElementById("communityCategory");
    if (sel && [...sel.options].some((o) => o.value === slug)) sel.value = slug;
    openCommunityCreatePostModal();
  };
  const communityPosts = (allPosts || []).filter((p) => (p.category || "").toLowerCase() === slug);
  if (latestEl) {
    const latest = communityPosts.slice().sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)).slice(0, 4);
    latestEl.innerHTML = latest.length ? latest.map((p) => `<li>${escapeHtml(p.title || "")}</li>`).join("") : "<li>No recent posts</li>";
  }
  if (topEl) {
    const top = communityPosts.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 4);
    topEl.innerHTML = top.length ? top.map((p) => `<li>${escapeHtml(p.title || "")}</li>`).join("") : "<li>No top posts yet</li>";
  }
  if (infoGrid) {
    const created = comm.created_at ? new Date(comm.created_at).toLocaleDateString() : "—";
    const members = comm.members_count ?? comm.member_count ?? 0;
    const weeklyVisitors = comm.weekly_visitors ?? 0;
    const weeklyContrib = comm.weekly_contributors ?? 0;
    infoGrid.innerHTML = `
      <div class="row"><span>Created</span><strong>${escapeHtml(created)}</strong></div>
      <div class="row"><span>Status</span><strong>${escapeHtml(comm.status || "public")}</strong></div>
      <div class="row"><span>Members</span><strong>${members}</strong></div>
      <div class="row"><span>Posts</span><strong>${comm.post_count ?? 0}</strong></div>
      <div class="row"><span>Category</span><strong>${escapeHtml(comm.category || "Other")}</strong></div>
      <div class="row"><span>Weekly visitors</span><strong>${weeklyVisitors}</strong></div>
      <div class="row"><span>Weekly contributions</span><strong>${weeklyContrib}</strong></div>
    `;
  }
  if (modsEl) {
    const creatorUid = String(comm.creator_firebase_uid || "").trim();
    const creatorIsCurrentUser = !!(creatorUid && currentProfileUser?.uid && creatorUid === currentProfileUser.uid);
    const creatorLabel = creatorIsCurrentUser
      ? `u/${escapeHtml(currentProfileUser?.displayName || "you")}`
      : creatorUid
      ? `u/${escapeHtml(creatorUid.slice(0, 10))}`
      : "u/creator";
    const rows = [`<li>${creatorLabel} — Admin</li>`];
    const mods = Array.isArray(comm.moderators) ? comm.moderators : [];
    mods.forEach((m) => {
      if (!m?.uid || m.uid === creatorUid) return;
      const label = m.displayName ? `u/${escapeHtml(m.displayName)}` : `u/${escapeHtml(String(m.uid).slice(0, 10))}`;
      rows.push(`<li>${label} — Mod</li>`);
    });
    modsEl.innerHTML = rows.join("");
  }

  // Achievements (earned + available)
  const achCard = document.getElementById("communityAchievementsCard");
  const achList = document.getElementById("communityAchievementsList");
  if (achCard && achList) {
    achCard.style.display = "block";
    const createdAt = comm.created_at ? new Date(comm.created_at) : null;
    const ageDays = createdAt ? Math.floor((Date.now() - createdAt.getTime()) / 86400000) : 0;
    const achievements = [
      // Weekly contributor streaks
      { id: "rising_star", icon: "ri-star-line", title: "Rising Star", desc: "New community that’s getting active.", earned: (comm.weekly_contributors ?? 0) >= 2 },
      { id: "repeat_contributor", icon: "ri-refresh-line", title: "Repeat Contributor", desc: "5+ weekly contributors.", earned: (comm.weekly_contributors ?? 0) >= 5 },
      { id: "super_contributor", icon: "ri-flashlight-line", title: "Super Contributor", desc: "10+ weekly contributors.", earned: (comm.weekly_contributors ?? 0) >= 10 },
      { id: "legendary_contributor", icon: "ri-trophy-line", title: "Legendary Contributor", desc: "20+ weekly contributors.", earned: (comm.weekly_contributors ?? 0) >= 20 },

      // Visitors / traffic
      { id: "popular_hub", icon: "ri-group-line", title: "Popular Hub", desc: "25+ weekly visitors.", earned: (comm.weekly_visitors ?? 0) >= 25 },
      { id: "thriving_hub", icon: "ri-rocket-line", title: "Thriving Hub", desc: "60+ weekly visitors.", earned: (comm.weekly_visitors ?? 0) >= 60 },
      { id: "buzzing_community", icon: "ri-sparkling-fill", title: "Buzzing Community", desc: "120+ weekly visitors.", earned: (comm.weekly_visitors ?? 0) >= 120 },

      // Posts / content volume
      { id: "new_posts", icon: "ri-file-add-line", title: "New Posts", desc: "1+ community post.", earned: (comm.post_count ?? 0) >= 1 },
      { id: "content_connoisseur", icon: "ri-file-list-3-line", title: "Content Connoisseur", desc: "10+ total posts in the community.", earned: (comm.post_count ?? 0) >= 10 },
      { id: "active_discussion", icon: "ri-message-2-line", title: "Active Discussion", desc: "25+ total posts in the community.", earned: (comm.post_count ?? 0) >= 25 },
      { id: "mega_archive", icon: "ri-archive-line", title: "Mega Archive", desc: "50+ total posts in the community.", earned: (comm.post_count ?? 0) >= 50 },

      // Community age
      { id: "elder", icon: "ri-user-star-line", title: "Elder", desc: "Community is 30+ days old.", earned: ageDays >= 30 },
      { id: "veteran", icon: "ri-award-line", title: "Veteran", desc: "Community is 90+ days old.", earned: ageDays >= 90 },
      { id: "legend", icon: "ri-medal-line", title: "Legend", desc: "Community is 180+ days old.", earned: ageDays >= 180 },
    ];

    const toggleBtn = document.getElementById("communityAchievementsToggle");
    const maxCollapsed = 4;
    const hasAnyEarned = achievements.some((a) => a.earned);
    let expanded = false;

    // Render all achievements once; visibility is controlled below.
    achList.innerHTML = achievements
      .map((a) => {
        return `<li class="community-achievement ${a.earned ? "" : "locked"}" data-achievement-id="${escapeHtml(a.id)}">
          <div class="community-achievement-icon"><i class="${a.icon}"></i></div>
          <div>
            <div class="community-achievement-title">${escapeHtml(a.title)}</div>
            <div class="community-achievement-desc">${escapeHtml(a.desc)}</div>
          </div>
        </li>`;
      })
      .join("");

    const applyVisibility = () => {
      const items = Array.from(achList.querySelectorAll(".community-achievement"));
      const emptyEl = achList.querySelector(".community-achievements-empty");

      // Reset
      if (emptyEl) emptyEl.remove();
      achList.classList.toggle("is-expanded", expanded);

      const setShown = (el, idx) => {
        const show =
          expanded ||
          (hasAnyEarned ? idx < maxCollapsed : false);
        el.style.display = show ? "" : "none";
      };

      items.forEach(setShown);

      // Reddit-style behavior: if nothing earned, show an empty hint until "View All".
      if (!expanded && !hasAnyEarned) {
        const li = document.createElement("li");
        li.className = "community-achievements-empty";
        li.textContent = 'No achievements unlocked yet. Click "View All" to see available badges.';
        achList.prepend(li);
      }

      if (toggleBtn) {
        toggleBtn.textContent = expanded ? "Show less" : "View All";
        toggleBtn.setAttribute("aria-expanded", String(expanded));
      }
    };

    // Default: collapsed.
    applyVisibility();

    // Wire up show less / more toggle.
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        expanded = !expanded;
        applyVisibility();
      });
    }
  }

  // Message admin/mods box recipient options
  const msgTarget = document.getElementById("communityMessageTarget");
  if (msgTarget) {
    const opts = [];
    opts.push(`<option value="mods">Mods</option>`);
    opts.push(`<option value="admin">Admin</option>`);
    const mods = Array.isArray(comm.moderators) ? comm.moderators : [];
    mods.forEach((m) => {
      if (!m?.uid) return;
      const label = m.displayName ? `Mod: ${m.displayName}` : `Mod: ${String(m.uid).slice(0, 10)}`;
      opts.push(`<option value="user:${escapeHtml(m.uid)}">${escapeHtml(label)}</option>`);
    });
    msgTarget.innerHTML = opts.join("");
  }

  // Load and render community highlights based on DB-backed popularity score (upvotes + comments + shares).
  (async () => {
    if (!highlightsWrap) return;
    try {
      const res = await fetch(`/api/communities/${encodeURIComponent(slug)}/highlights`);
      if (!res.ok) throw new Error("not ok");
      const data = await res.json();
      const top = Array.isArray(data?.top) ? data.top : [];
      const recent = Array.isArray(data?.recent) ? data.recent : [];
      const topEl = document.getElementById("communityHighlightsTop");
      const recEl = document.getElementById("communityHighlightsRecent");
      if (topEl) {
        topEl.innerHTML = top.length
          ? top
              .map(
                (p) =>
                  `<li><span>${escapeHtml((p.title || "").slice(0, 40))}${(p.title || "").length > 40 ? "…" : ""}</span><span class="meta">${escapeHtml(
                    String(p.popularity ?? 0)
                  )}</span></li>`
              )
              .join("")
          : "<li><span>No posts yet</span><span class=\"meta\">—</span></li>";
      }
      if (recEl) {
        recEl.innerHTML = recent.length
          ? recent
              .map(
                (p) =>
                  `<li><span>${escapeHtml((p.title || "").slice(0, 40))}${(p.title || "").length > 40 ? "…" : ""}</span><span class="meta">${escapeHtml(
                    String(p.popularity ?? 0)
                  )}</span></li>`
              )
              .join("")
          : "<li><span>No posts yet</span><span class=\"meta\">—</span></li>";
      }
      highlightsWrap.style.display = "block";
    } catch (_) {
      highlightsWrap.style.display = "none";
    }
  })();
}

function openCommunitySymbolModal(slug, comm) {
  const modal = document.getElementById("communitySymbolModal");
  if (!modal) return;
  modal.dataset.slug = slug;
  const current = document.getElementById("communitySymbolCurrent");
  if (current) current.textContent = String(comm.logo_symbol || "✦");
  const input = document.getElementById("communitySymbolInput");
  if (input) input.value = String(comm.logo_symbol || "").trim();
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
}

function closeCommunitySymbolModal() {
  const modal = document.getElementById("communitySymbolModal");
  if (!modal) return;
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
}

async function saveCommunitySymbolFromModal() {
  const modal = document.getElementById("communitySymbolModal");
  const slug = String(modal?.dataset?.slug || "").trim();
  const input = document.getElementById("communitySymbolInput");
  const symbol = String(input?.value || "").trim().slice(0, 6);
  if (!slug || !currentProfileUser?.uid) return;
  try {
    const auth = await authReady;
    const token = await auth.currentUser?.getIdToken?.();
    if (!token) return;
    const res = await fetch(`/api/communities/${encodeURIComponent(slug)}/meta`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ logoSymbol: symbol }),
    });
    if (!res.ok) throw new Error("not ok");
    closeCommunitySymbolModal();
    await loadCommunitiesSidebar();
    await loadCommunityView();
  } catch (_) {}
}

function openCommunityModsModal(slug, comm) {
  const modal = document.getElementById("communityModsModal");
  if (!modal) return;
  modal.dataset.slug = slug;
  const list = document.getElementById("communityModsPicked");
  if (list) list.innerHTML = "";
  const picked = new Set(
    (Array.isArray(comm.moderators) ? comm.moderators : []).map((m) => String(m?.uid || "").trim()).filter(Boolean)
  );
  modal.dataset.picked = JSON.stringify(Array.from(picked));
  const input = document.getElementById("communityModsSearch");
  if (input) input.value = "";
  const results = document.getElementById("communityModsResults");
  if (results) results.innerHTML = "";
  renderPickedMods();
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
}

function closeCommunityModsModal() {
  const modal = document.getElementById("communityModsModal");
  if (!modal) return;
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
}

function getPickedMods() {
  const modal = document.getElementById("communityModsModal");
  try {
    return new Set(JSON.parse(modal?.dataset?.picked || "[]"));
  } catch (_) {
    return new Set();
  }
}

function setPickedMods(set) {
  const modal = document.getElementById("communityModsModal");
  if (!modal) return;
  modal.dataset.picked = JSON.stringify(Array.from(set));
}

function renderPickedMods() {
  const list = document.getElementById("communityModsPicked");
  if (!list) return;
  const picked = Array.from(getPickedMods());
  list.innerHTML = picked.length
    ? picked
        .map(
          (u) =>
            `<li class="mod-chip"><span>${escapeHtml(u)}</span><button type="button" class="mod-chip-x" data-remove-uid="${escapeHtml(
              u
            )}"><i class="ri-close-line"></i></button></li>`
        )
        .join("")
    : `<li class="mod-empty">No moderators selected yet.</li>`;
  list.querySelectorAll("[data-remove-uid]").forEach((btn) => {
    btn.onclick = () => {
      const uid = String(btn.dataset.removeUid || "").trim();
      const set = getPickedMods();
      set.delete(uid);
      setPickedMods(set);
      renderPickedMods();
    };
  });
}

async function searchUsersForMods() {
  const input = document.getElementById("communityModsSearch");
  const results = document.getElementById("communityModsResults");
  if (!input || !results) return;
  const q = String(input.value || "").trim();
  if (!q) {
    results.innerHTML = "";
    return;
  }
  try {
    const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
    const rows = res.ok ? await res.json() : [];
    const list = Array.isArray(rows) ? rows : [];
    results.innerHTML = list
      .map((u) => {
        const label = u.displayName ? `${u.displayName} (${u.uid.slice(0, 10)}…)` : u.uid;
        return `<li><button type="button" class="mod-result" data-pick-uid="${escapeHtml(u.uid)}">${escapeHtml(
          label
        )}</button></li>`;
      })
      .join("");
    results.querySelectorAll("[data-pick-uid]").forEach((btn) => {
      btn.onclick = () => {
        const uid = String(btn.dataset.pickUid || "").trim();
        const set = getPickedMods();
        if (uid) set.add(uid);
        setPickedMods(set);
        renderPickedMods();
      };
    });
  } catch (_) {
    results.innerHTML = "<li>Search failed.</li>";
  }
}

async function saveModeratorsFromModal() {
  const modal = document.getElementById("communityModsModal");
  const slug = String(modal?.dataset?.slug || "").trim();
  if (!slug || !currentProfileUser?.uid) return;
  try {
    const auth = await authReady;
    const token = await auth.currentUser?.getIdToken?.();
    if (!token) return;
    const set = Array.from(getPickedMods());
    const res = await fetch(`/api/communities/${encodeURIComponent(slug)}/moderators`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ moderatorUids: set }),
    });
    if (!res.ok) throw new Error("not ok");
    closeCommunityModsModal();
    await loadCommunitiesSidebar();
    await loadCommunityView();
  } catch (_) {}
}

function updateEditCommunityImagePreview(kind, file, fallbackUrl, fallbackLabel) {
  const isBanner = kind === "banner";
  const previewEl = document.getElementById(isBanner ? "editCommunityBannerPreview" : "editCommunityLogoPreview");
  if (!previewEl) return;
  const defaultLabel = fallbackLabel || "r";
  if (previewEl.dataset.objectUrl) {
    URL.revokeObjectURL(previewEl.dataset.objectUrl);
    delete previewEl.dataset.objectUrl;
  }
  if (file) {
    const objectUrl = URL.createObjectURL(file);
    previewEl.dataset.objectUrl = objectUrl;
    previewEl.style.backgroundImage = `url(${objectUrl.replace(/\)/g, "%29")})`;
    previewEl.textContent = "";
    return;
  }
  const src = String(fallbackUrl || "").trim();
  if (src && /^https?:\/\//i.test(src)) {
    previewEl.style.backgroundImage = `url(${src.replace(/\)/g, "%29")})`;
    previewEl.textContent = "";
  } else {
    previewEl.style.backgroundImage = "";
    previewEl.textContent = isBanner ? "" : defaultLabel.slice(0, 1).toLowerCase();
  }
}

function openEditCommunityModal(slug, comm) {
  const modal = document.getElementById("editCommunityModal");
  if (!modal || !slug) return;
  if (modal.parentElement !== document.body) document.body.appendChild(modal);
  modal.dataset.editSlug = slug;
  modal.dataset.bannerUrl = (comm?.banner_url || "").trim();
  modal.dataset.logoUrl = (comm?.logo_url || "").trim();
  modal.dataset.logoLabel = (comm?.slug || slug || "r").slice(0, 1).toLowerCase();
  const descEl = document.getElementById("editCommunityDescription");
  if (descEl) descEl.value = comm?.description || "";
  const bannerEl = document.getElementById("editCommunityBanner");
  const logoEl = document.getElementById("editCommunityLogo");
  if (bannerEl) bannerEl.value = "";
  if (logoEl) logoEl.value = "";
  updateEditCommunityImagePreview("banner", null, comm?.banner_url || "", "");
  updateEditCommunityImagePreview("logo", null, comm?.logo_url || "", modal.dataset.logoLabel || "r");
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
}

function closeEditCommunityModal() {
  const modal = document.getElementById("editCommunityModal");
  if (!modal) return;
  updateEditCommunityImagePreview("banner", null, "", "");
  updateEditCommunityImagePreview("logo", null, "", "r");
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
}

function openCreateCommunityModal() {
  const modal = document.getElementById("createCommunityModal");
  if (!modal) return;
  if (modal.parentElement !== document.body) document.body.appendChild(modal);
  createCommunityWizard = { step: 1, topic: "Indoor Plants", type: "public", mature: false };
  const slugEl = document.getElementById("createCommunitySlug");
  if (slugEl) slugEl.dataset.touched = "false";
  renderCreateCommunityWizard();
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
}

function closeCreateCommunityModal() {
  const modal = document.getElementById("createCommunityModal");
  if (!modal) return;
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
}

function _slugifyCommunityName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function handleEditCommunitySubmit(e) {
  e.preventDefault();
  const modal = document.getElementById("editCommunityModal");
  const slug = modal?.dataset?.editSlug;
  if (!slug) return;
  const user = currentProfileUser;
  if (!user?.uid) {
    showToast("Sign in to edit the community.", "error");
    return;
  }
  let token;
  try {
    token = await user.getIdToken();
  } catch (err) {
    showToast("Could not verify your account. Try signing in again.", "error");
    return;
  }
  const form = document.getElementById("editCommunityForm");
  const descEl = document.getElementById("editCommunityDescription");
  const bannerEl = document.getElementById("editCommunityBanner");
  const logoEl = document.getElementById("editCommunityLogo");
  const formData = new FormData();
  if (descEl) formData.append("description", descEl.value.trim());
  if (bannerEl?.files?.[0]) formData.append("banner", bannerEl.files[0]);
  if (logoEl?.files?.[0]) formData.append("logo", logoEl.files[0]);
  try {
    const res = await fetch(`/api/communities/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.message || data.error || "Could not update community.", "error");
      return;
    }
    showToast("Community updated.", "success");
    closeEditCommunityModal();
    await loadCommunitiesSidebar();
    await loadCommunityView();
  } catch (err) {
    console.error("Edit community failed", err);
    showToast("Could not update community.", "error");
  }
}

async function handleCreateCommunitySubmit(e) {
  e.preventDefault();
  if (createCommunityWizard.step !== 3) {
    createCommunityWizard.step = 3;
    renderCreateCommunityWizard();
    return;
  }
  const nameEl = document.getElementById("createCommunityName");
  const slugEl = document.getElementById("createCommunitySlug");
  const descEl = document.getElementById("createCommunityDescription");
  if (!nameEl || !slugEl) return;
  const name = nameEl.value.trim();
  const slug = _slugifyCommunityName(slugEl.value || name);
  const baseDescription = (descEl?.value || "").trim();
  const category = createCommunityWizard.topic || "Other";
  const status = createCommunityWizard.type === "private" ? "private" : createCommunityWizard.type === "restricted" ? "restricted" : "public";
  const isMature = !!createCommunityWizard.mature;
  const description = [baseDescription, createCommunityWizard.type === "restricted" ? "Community type: Restricted (approval needed to post)." : "", createCommunityWizard.mature ? "Mature (18+): Enabled." : ""].filter(Boolean).join("\n");
  if (!name || !slug) {
    showToast("Community name and valid slug are required.", "error");
    return;
  }
  try {
    const bannerInput = document.getElementById("createCommunityBanner");
    const logoInput = document.getElementById("createCommunityLogo");
    const bannerFile = bannerInput?.files?.[0];
    const logoFile = logoInput?.files?.[0];
    let createdCommunityId = null;

    const formData = new FormData();
    formData.append("name", name);
    formData.append("slug", slug);
    formData.append("description", description);
    formData.append("category", category);
    formData.append("status", status);
    formData.append("is_mature", isMature);
    if (currentProfileUser?.uid) formData.append("creator_firebase_uid", currentProfileUser.uid);
    if (bannerFile) formData.append("banner", bannerFile);
    if (logoFile) formData.append("logo", logoFile);
    try {
      const token = currentProfileUser ? await currentProfileUser.getIdToken() : null;
      if (token) formData.append("firebase_id_token", token);
    } catch (_) {}
    const createRes = await fetch("/api/communities", { method: "POST", body: formData });
    if (createRes.status === 201) {
      const data = await createRes.json().catch(() => ({}));
      createdCommunityId = data?.id || null;
    } else if (createRes.status === 503) {
    } else if (createRes.status === 409) {
      showToast("A community with this name or slug already exists. Try a different slug.", "error");
      return;
    } else {
      const data = await createRes.json().catch(() => ({}));
      showToast(data?.error || data?.message || "Could not create community.", "error");
      return;
    }

    if (createdCommunityId === null) {
      const supabase = await getSupabaseClient();
      let bannerUrl = null;
      let logoUrl = null;
      if (bannerFile) {
        const ext = (bannerFile.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "jpg");
        const path = `${slug}/banner.${ext}`;
        const { error: upErr } = await supabase.storage.from("community-assets").upload(path, bannerFile, { upsert: true });
        if (!upErr) {
          const { data: urlData } = supabase.storage.from("community-assets").getPublicUrl(path);
          bannerUrl = urlData?.publicUrl || null;
        }
      }
      if (logoFile) {
        const ext = (logoFile.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "jpg");
        const path = `${slug}/logo.${ext}`;
        const { error: upErr } = await supabase.storage.from("community-assets").upload(path, logoFile, { upsert: true });
        if (!upErr) {
          const { data: urlData } = supabase.storage.from("community-assets").getPublicUrl(path);
          logoUrl = urlData?.publicUrl || null;
        }
      }
      const creatorFirebaseUid = currentProfileUser?.uid || null;
      const { data: rpcData, error: rpcError } = await supabase.rpc("create_community", {
      p_name: name,
      p_slug: slug,
      p_description: description || null,
      p_category: category,
      p_banner_url: bannerUrl,
      p_logo_url: logoUrl,
      p_status: status,
      p_is_mature: isMature,
      p_creator_firebase_uid: creatorFirebaseUid,
    });
    if (!rpcError) {
      createdCommunityId = rpcData;
    } else {
      const { data: inserted, error: insertError } = await supabase
        .from("communities")
        .insert({
          name,
          slug,
          description: description || null,
          category,
          status,
          is_mature: isMature,
          created_by: null,
          banner_url: bannerUrl,
          logo_url: logoUrl,
          creator_firebase_uid: currentProfileUser?.uid || null,
        })
        .select("id")
        .single();
      if (insertError) {
        const msg = insertError.message || String(insertError);
        console.error("Create community insert failed", insertError);
        if (msg.includes("creator_firebase_uid")) {
          const { data: retryData, error: retryErr } = await supabase
            .from("communities")
            .insert({
              name,
              slug,
              description: description || null,
              category,
              status,
              is_mature: isMature,
              created_by: null,
              banner_url: bannerUrl,
              logo_url: logoUrl,
            })
            .select("id")
            .single();
          if (!retryErr) {
            createdCommunityId = retryData?.id || null;
            showToast("Community created. Run supabase/add_creator_firebase_uid.sql in Supabase to enable Edit for creators.", "info");
          } else {
            showToast("Run supabase/add_creator_firebase_uid.sql in Supabase SQL Editor, then try again.", "error");
            return;
          }
        } else if (msg.includes("duplicate") || msg.includes("unique") || msg.includes("slug")) {
          showToast("A community with this name or slug already exists. Try a different slug.", "error");
          return;
        } else if (msg.includes("does not exist") || msg.includes("relation")) {
          showToast("Communities table not set up. Run supabase/community_schema.sql in Supabase SQL Editor.", "error");
          return;
        } else {
          showToast("Could not create community. " + (msg.length > 60 ? msg.slice(0, 60) + "…" : msg), "error");
          return;
        }
      } else {
        createdCommunityId = inserted?.id || null;
      }
    }
    }
    if (!createdCommunityId) {
      showToast("Community created, but we couldn't fetch its ID.", "info");
    } else {
      showToast(`Community created: r/${slug}`, "success");
    }
    nameEl.value = "";
    slugEl.value = "";
    if (descEl) descEl.value = "";
    if (bannerInput) bannerInput.value = "";
    if (logoInput) logoInput.value = "";
    closeCreateCommunityModal();
    await loadCommunitiesSidebar();
    const filterSel = document.getElementById("communityCategoryFilter");
    if (filterSel) {
      const opt = Array.from(filterSel.options).find((o) => o.value === slug);
      if (!opt) {
        const newOpt = document.createElement("option");
        newOpt.value = slug;
        newOpt.textContent = `r/${slug}`;
        filterSel.appendChild(newOpt);
      }
      filterSel.value = slug;
    }
    communityCategoryFilter = slug;
    loadCommunityView();
  } catch (err) {
    console.error("Failed to create community", err);
    const msg = err?.message || String(err);
    if (msg.includes("Supabase not configured")) {
      showToast("Supabase is not configured. Add SUPABASE_URL and SUPABASE_ANON_KEY to .env.", "error");
    } else {
      showToast("Could not create community. " + (msg.length > 80 ? msg.slice(0, 80) + "…" : msg), "error");
    }
  }
}

async function loadCommunityView() {
  const feed = document.getElementById("communityFeed");
  const empty = document.getElementById("communityFeedEmpty");
  if (!feed) return;
  const routeSlug = parseCommunitySlugFromPath();
  if (routeSlug && !communitySelectedSlug) {
    communitySelectedSlug = routeSlug;
    communityCategoryFilter = routeSlug;
  }
  try {
    const supabase = await getSupabaseClient();
    let posts = [];
    const selectBase = "id,title,body,created_at,author_username,community_id,image_url,tags,score,comment_count";
    const selectWithMedia = "id,title,body,created_at,author_username,community_id,image_url,media_urls,media_types,tags,score,comment_count";
    let postsData = [];
    let postsError = null;
    const trySelect = async (sel) => {
      const { data, error } = await supabase.from("posts").select(sel).limit(100);
      return { data, error };
    };

    const attemptWithMedia = await trySelect(selectWithMedia);
    if (attemptWithMedia.error) {
      const msg = String(attemptWithMedia.error?.message || "").toLowerCase();
      if (msg.includes("media_urls") || msg.includes("media_types") || msg.includes("column")) {
        const attemptBase = await trySelect(selectBase);
        postsData = attemptBase.data || [];
        postsError = attemptBase.error || null;
      } else {
        postsData = [];
        postsError = attemptWithMedia.error;
      }
    } else {
      postsData = attemptWithMedia.data || [];
      postsError = null;
    }

    if (!postsError && Array.isArray(postsData) && postsData.length > 0) {
      posts = postsData.map((p) => {
        const mediaUrls = Array.isArray(p.media_urls) ? p.media_urls : p.image_url ? [p.image_url] : [];
        const mediaTypes = Array.isArray(p.media_types) ? p.media_types : [];
        const mediaCount = mediaUrls.length || 0;
        const primary_media_url = mediaUrls[0] || null;
        const primary_media_type = mediaTypes[0] || "image";

        return {
          ...p,
          category: communityList.find((c) => c.id === p.community_id)?.slug || p.community_id,
          plant_image_url: primary_media_type === "image" ? primary_media_url : null,
          primary_media_url,
          primary_media_type,
          media_count: mediaCount,
          media_urls: mediaUrls,
          media_types: mediaTypes,
        };
      });
    }
    if (communityCategoryFilter && communityCategoryFilter !== "all") {
      posts = posts.filter((p) => (p.category || "").toLowerCase() === communityCategoryFilter.toLowerCase());
    }
    if (communitySearchQuery) {
      const q = communitySearchQuery.toLowerCase();
      posts = posts.filter((p) => (p.title || "").toLowerCase().includes(q) || (p.body || "").toLowerCase().includes(q) || (p.category || "").toLowerCase().includes(q));
    }
    const sort = communitySortFilter || "new";
    if (sort === "new") posts.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    else if (sort === "old") posts.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
    else if (sort === "top") posts.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    else if (sort === "best") posts.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    else if (sort === "hot") posts.sort((a, b) => { const sa = (b.score ?? 0) + (b.comment_count ?? 0) * 2; const sb = (a.score ?? 0) + (a.comment_count ?? 0) * 2; return sa - sb; });
    else if (sort === "controversial") posts.sort((a, b) => (b.comment_count ?? 0) - (a.comment_count ?? 0));
    else if (sort === "qa") posts = posts.filter((p) => (p.title || "").includes("?") || (p.body || "").includes("?"));

    // Ensure `communityList` is populated before rendering.
    // Otherwise creator/mod data may be missing and "Delete" buttons won't appear.
    if (currentProfileUser?.uid && (!Array.isArray(communityList) || communityList.length === 0)) {
      try {
        await loadCommunitiesSidebar();
      } catch (_) {}
    }

    renderCommunityPanels(posts);
    // Record weekly visitor (DB-backed) when user is viewing a community.
    try {
      if (currentProfileUser?.uid && communitySelectedSlug) {
        const auth = await authReady;
        const token = await auth.currentUser?.getIdToken?.();
        if (token) {
          await fetch(`/api/communities/${encodeURIComponent(communitySelectedSlug)}/visit`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          });
        }
      }
    } catch (_) {}
    posts = posts.slice(0, 50);
    communityRecentPosts = posts.slice(0, 10);
    renderCommunityRecentList();
    if (!posts.length) {
      feed.innerHTML = "";
      if (empty) empty.style.display = "block";
      return;
    }
    if (empty) empty.style.display = "none";
    feed.innerHTML = posts
      .map((p) => {
        const tags = Array.isArray(p.tags) ? p.tags : typeof p.tags === "string" && p.tags ? p.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
        const created = p.created_at ? new Date(p.created_at).toLocaleString() : "";
        const commName = p.community_name || p.category || "general";
        const commSlug = String(p.category || "general").toLowerCase();
        const mediaUrls = Array.isArray(p.media_urls) ? p.media_urls : (Array.isArray(p.media_urls) ? p.media_urls : []);
        const mediaTypes = Array.isArray(p.media_types) ? p.media_types : [];
        // Safe UI fallback so authors still see Delete even if server-side
        // can-delete helper fails (server still enforces on click).
        const authorUsername = String(p.author_username || "").trim().toLowerCase();
        const myDisplayName = String(currentProfileUser?.displayName || "").trim().toLowerCase();
        const myEmail = String(currentProfileUser?.email || "").trim().toLowerCase();
        const showDeleteByAuthor =
          !!authorUsername &&
          ((myDisplayName && myDisplayName === authorUsername) || (myEmail && myEmail === authorUsername));

        // Optional: if communityList is available, also show for creator/mod quickly.
        const comm = communityList.find((c) => String(c.slug || c.id || "").toLowerCase() === commSlug) || {};
        const creatorUid = String(comm.creator_firebase_uid || "").trim();
        const isCreator = !!(currentProfileUser?.uid && creatorUid && currentProfileUser.uid === creatorUid);
        const mods = Array.isArray(comm.moderators) ? comm.moderators : [];
        const isModerator = !!(currentProfileUser?.uid && mods.some((m) => String(m?.uid || m || "").trim() === String(currentProfileUser.uid)));
        const showDeleteByAdminMod = isCreator || isModerator;
        const showDeleteInitial = showDeleteByAuthor || showDeleteByAdminMod;

        return `<article class="community-post" data-post-id="${escapeHtml(p.id)}" data-media-urls="${escapeHtml(
          JSON.stringify(mediaUrls)
        )}" data-media-types="${escapeHtml(JSON.stringify(mediaTypes))}">
          <div class="community-vote">
            <button type="button" data-vote="up"><i class="ri-arrow-up-s-line"></i></button>
            <div class="community-vote-score">${p.score ?? 0}</div>
            <button type="button" data-vote="down"><i class="ri-arrow-down-s-line"></i></button>
          </div>
          <div class="community-post-main">
            <div class="community-post-header">
              <div>
                <div class="community-post-title">${escapeHtml(p.title || "")}</div>
                <div class="community-post-meta">
                  <button type="button" class="community-link-btn" data-open-community="${escapeHtml(commSlug)}">r/${escapeHtml(commName)}</button>
                  <span>u/${escapeHtml(p.author_username || "warden")}</span>
                  <span>${escapeHtml(created)}</span>
                  <button type="button" class="community-post-community" data-open-community="${escapeHtml(commSlug)}">${escapeHtml(commName)}</button>
                </div>
              </div>
            </div>
            ${(() => {
              const safeMediaUrls = (mediaUrls || []).filter((u) => !!u);
              const safeMediaTypes = Array.isArray(mediaTypes) ? mediaTypes : [];
              const hasMedia = safeMediaUrls.length > 0;
              if (!hasMedia) return "";

              const inferKind = (url, explicitType) => {
                if (explicitType === "video" || explicitType === "audio") return explicitType;
                const u = String(url || "").toLowerCase();
                if (u.match(/\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/)) return "video";
                if (u.match(/\.(mp3|wav|m4a|aac|flac|ogg)(\?.*)?$/)) return "audio";
                return "image";
              };

              const slidesHtml = safeMediaUrls
                .map((url, idx) => {
                  const kind = inferKind(url, safeMediaTypes[idx]);
                  if (kind === "video") {
                    return `<div class="community-post-media-slide" data-slide-index="${idx}">
                      <video src="${escapeHtml(url)}" controls preload="metadata" playsinline></video>
                    </div>`;
                  }
                  if (kind === "audio") {
                    return `<div class="community-post-media-slide community-post-media-slide--audio" data-slide-index="${idx}">
                      <audio src="${escapeHtml(url)}" controls preload="metadata"></audio>
                    </div>`;
                  }
                  return `<div class="community-post-media-slide" data-slide-index="${idx}">
                    <img src="${escapeHtml(url)}" alt="Post media ${idx + 1}" loading="lazy" />
                  </div>`;
                })
                .join("");

              const showThumbs = safeMediaUrls.length > 1;
              const thumbsHtml = showThumbs
                ? `<div class="community-post-media-thumb-row">
                    <div class="community-post-media-thumb-strip" role="tablist" aria-label="Post media thumbnails">
                      ${safeMediaUrls
                        .map((url, idx) => {
                          const kind = inferKind(url, safeMediaTypes[idx]);
                          const inner =
                            kind === "image"
                              ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" />`
                              : `<i class="${kind === "video" ? "ri-play-line" : "ri-music-2-line"}"></i>`;
                          return `<button type="button" class="community-post-media-thumb-btn" data-media-slide-index="${idx}">
                            ${inner}
                          </button>`;
                        })
                        .join("")}
                    </div>
                  </div>`
                : "";

              return `<div class="community-post-media-gallery" aria-label="Post media gallery">
                <div class="community-post-media-scroller" role="region" aria-label="Post media scroller">
                  ${slidesHtml}
                </div>
                ${thumbsHtml}
              </div>`;
            })()}
            <div class="community-post-body">${escapeHtml(p.body || "")}</div>
            ${tags.length ? `<div class="community-post-tags">${tags.map((t) => `<span class="community-post-tag">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
            <div class="community-post-footer">
              <div class="community-post-actions">
                <button type="button" data-action="comments"><i class="ri-chat-1-line"></i> ${p.comment_count ?? 0} comments</button>
                <button type="button" data-action="award"><i class="ri-medal-line"></i> Award</button>
                <button type="button" data-action="share"><i class="ri-share-line"></i> Share</button>
              </div>
              <div class="community-post-actions">
                <button type="button" data-action="report"><i class="ri-flag-line"></i> Report</button>
                <button
                  type="button"
                  data-action="delete"
                  class="community-post-delete-btn"
                    style="display:${showDeleteInitial ? 'inline-flex' : 'none'}"
                  title="Delete post"
                >
                  <i class="ri-delete-bin-line"></i> Delete
                </button>
              </div>
            </div>
          </div>
        </article>`;
      })
      .join("");
    feed.querySelectorAll(".community-post").forEach((card) => {
      const postId = card.dataset.postId;
      card.querySelectorAll("[data-vote]").forEach((btn) => {
        btn.addEventListener("click", () => { const dir = btn.dataset.vote === "up" ? 1 : -1; voteOnPost(postId, dir, card); });
      });
      card.querySelectorAll("[data-open-community]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const slug = (btn.getAttribute("data-open-community") || "").toLowerCase();
          if (!slug) return;
          communitySelectedSlug = slug;
          communityCategoryFilter = slug;
          const sel = document.getElementById("communityCategoryFilter");
          if (sel && [...sel.options].some((o) => o.value === slug)) sel.value = slug;
          setCommunityRoute(slug);
          loadCommunityView();
        });
      });

      // Open Reddit-style post details modal
      const commentsBtn = card.querySelector('[data-action="comments"]');
      commentsBtn?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openCommunityPostDetail(postId);
      });

      const deleteBtn = card.querySelector('[data-action="delete"]');
      deleteBtn?.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!confirm("Delete this post?")) return;
        try {
          const auth = await authReady;
          const token = await auth.currentUser?.getIdToken?.();
          if (!token) throw new Error("Not signed in");
          const res = await fetch(`/api/posts/${encodeURIComponent(postId)}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            throw new Error(j.error || j.message || "Delete failed");
          }
          showToast("Post deleted.", "success");
          loadCommunityView();
        } catch (e) {
          showToast(e?.message || "Could not delete post.", "error");
        }
      });

      card.addEventListener("click", (ev) => {
        const voteBtn = ev.target.closest("[data-vote]");
        if (voteBtn) return;
        const actionEl = ev.target.closest("[data-action]");
        if (actionEl && actionEl.dataset.action !== "comments") return;
        openCommunityPostDetail(postId);
      });

      // In-card media gallery UX (thumb -> scroll)
      const scroller = card.querySelector(".community-post-media-scroller");
      const thumbBtns = Array.from(card.querySelectorAll(".community-post-media-thumb-btn"));
      if (scroller && thumbBtns.length) {
        const slides = Array.from(card.querySelectorAll(".community-post-media-slide"));
        const updateActive = () => {
          const idx = Math.round(scroller.scrollLeft / Math.max(1, scroller.clientWidth));
          thumbBtns.forEach((b) => {
            const bi = Number(b.dataset.mediaSlideIndex || "0");
            b.classList.toggle("community-post-media-thumb-btn--active", bi === idx);
          });
        };
        thumbBtns.forEach((btn) => {
          btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const idx = Number(btn.dataset.mediaSlideIndex || "0");
            const slide = slides.find((s) => Number(s.dataset.slideIndex || "0") === idx);
            slide?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
          });
        });
        scroller.addEventListener("scroll", () => {
          window.requestAnimationFrame(updateActive);
        });
        updateActive();
      }

      // Track shares + mirror score/comment counts to backend for popularity scoring.
      const shareBtn = card.querySelector('[data-action="share"]');
      if (shareBtn) {
        shareBtn.addEventListener("click", async () => {
          try {
            const slug = String(communitySelectedSlug || "").toLowerCase();
            if (!slug) return;
            const auth = await authReady;
            const token = await auth.currentUser?.getIdToken?.();
            if (!token) return;
            await fetch(`/api/posts/${encodeURIComponent(postId)}/share`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ communitySlug: slug }),
            });
            // Basic share UX
            try {
              await navigator.clipboard?.writeText?.(window.location.href);
            } catch (_) {}
            showToast("Link copied. Shared!", "success");
            loadCommunityView();
          } catch (_) {
            showToast("Could not share.", "error");
          }
        });
      }

      (async () => {
        try {
          const slug = String(communitySelectedSlug || "").toLowerCase();
          if (!slug || !currentProfileUser?.uid) return;
          const auth = await authReady;
          const token = await auth.currentUser?.getIdToken?.();
          if (!token) return;
          const score = Number(card.querySelector(".community-vote-score")?.textContent || 0);
          const comments = Number(
            String(card.querySelector('[data-action="comments"]')?.textContent || "").match(/(\d+)/)?.[1] || 0
          );
          await fetch(`/api/posts/${encodeURIComponent(postId)}/metrics`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ communitySlug: slug, score, comments }),
          });
        } catch (_) {}
      })();
    });

    // Server-authoritative visibility: show Delete only when allowed.
    (async () => {
      try {
        if (!currentProfileUser?.uid) return;
        const auth = await authReady;
        const token = await auth.currentUser?.getIdToken?.();
        if (!token) return;

        const deleteButtons = Array.from(feed.querySelectorAll(".community-post-delete-btn"));
        await Promise.all(
          deleteButtons.map(async (btn) => {
            const card = btn.closest(".community-post");
            const pid = card?.dataset?.postId;
            if (!pid) return;
            try {
              const res = await fetch(`/api/posts/${encodeURIComponent(pid)}/can-delete`, {
                method: "GET",
                headers: { Authorization: `Bearer ${token}` },
              });
              if (!res.ok) return;
              const j = await res.json().catch(() => ({}));
              // Never auto-hide the button: backend enforces on click.
              if (j?.canDelete) btn.style.display = "inline-flex";
            } catch (_) {}
          })
        );
      } catch (_) {}
    })();
  } catch {
    if (feed) feed.innerHTML = "<p class=\"plants-list-empty\">Unable to load community posts. Check Supabase config and tables (posts).</p>";
    if (empty) empty.style.display = "block";
  }
}

// ============================================================
// Reddit-style Post Details Modal (post + comments + votes)
// ============================================================

let __communityPostDetail = null;

function bindCommunityPostDetailModal() {
  const modal = document.getElementById("communityPostDetailModal");
  if (!modal) return;

  const closeBtn = document.getElementById("communityPostDetailCloseBtn");
  const backdrop = document.getElementById("communityPostDetailBackdrop");
  const deleteBtn = document.getElementById("communityPostDetailDeleteBtn");
  const voteUpBtn = document.getElementById("communityPostDetailVoteUpBtn");
  const voteDownBtn = document.getElementById("communityPostDetailVoteDownBtn");

  const form = document.getElementById("communityCommentForm");
  const bodyEl = document.getElementById("communityCommentBody");
  const parentIdEl = document.getElementById("communityCommentParentId");
  const emptyEl = document.getElementById("communityPostCommentsEmpty");
  const listEl = document.getElementById("communityPostCommentsList");

  __communityPostDetail = {
    modal,
    closeBtn,
    backdrop,
    deleteBtn,
    voteUpBtn,
    voteDownBtn,
    form,
    bodyEl,
    parentIdEl,
    emptyEl,
    listEl,
  };

  function close() {
    closeCommunityPostDetailModal();
  }

  closeBtn?.addEventListener("click", close);
  backdrop?.addEventListener("click", close);
}

function closeCommunityPostDetailModal() {
  if (!__communityPostDetail?.modal) return;
  __communityPostDetail.modal.style.display = "none";
  try {
    document.body.style.overflow = "";
  } catch (_) {}
  communityPostDetailOpenPostId = null;
}

function computeCanComment(commObj) {
  if (!commObj) return true;
  if (commObj.status === "public") return true;
  // Restricted/private: only joined members (and mods/creator).
  return !!commObj.joined || !!commObj.isModerator || !!commObj.isCreator;
}

function safeToDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch (_) {
    return iso;
  }
}

async function openCommunityPostDetail(postId) {
  if (!postId) return;
  if (!__communityPostDetail?.modal) bindCommunityPostDetailModal();
  if (!__communityPostDetail?.modal) return;

  communityPostDetailOpenPostId = postId;

  const token = await (async () => {
    if (!currentProfileUser?.uid) return null;
    const auth = await authReady;
    return await auth.currentUser?.getIdToken?.();
  })();

  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`/api/posts/${encodeURIComponent(postId)}`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || "Unable to open post.", "error");
    return;
  }

  const post = data.post || {};
  const comm = data.community || {};
  const commObj =
    (Array.isArray(communityList) ? communityList.find((c) => String(c.slug || "").toLowerCase() === String(comm.slug || "").toLowerCase()) : null) ||
    {};
  commObj.slug = comm.slug || commObj.slug;
  commObj.status = comm.status || commObj.status;
  commObj.creator_firebase_uid = comm.creator_firebase_uid || commObj.creator_firebase_uid;

  const uid = currentProfileUser?.uid || null;
  const isCreator = !!uid && String(commObj.creator_firebase_uid) === String(uid);
  const isModerator = !!uid && Array.isArray(commObj.moderators) && commObj.moderators.some((m) => String(m.uid) === String(uid));
  commObj.isCreator = isCreator;
  commObj.isModerator = isModerator;
  const canComment = computeCanComment(commObj);

  // Show modal
  __communityPostDetail.modal.style.display = "block";
  try {
    document.body.style.overflow = "hidden";
  } catch (_) {}

  // Header
  const titleEl = document.getElementById("communityPostDetailTitle");
  const metaEl = document.getElementById("communityPostDetailMeta");
  if (titleEl) titleEl.textContent = post.title || "";
  if (metaEl) {
    const author = post.author_username ? `u/${post.author_username}` : "u/unknown";
    metaEl.textContent = `${author} • ${safeToDate(post.created_at)}`;
  }

  // Delete button (server enforces; this is only UI visibility)
  if (__communityPostDetail.deleteBtn) {
    // Post author is stored in Supabase as `author_username` (created from displayName in the submit handler).
    // Some accounts may have displayName casing/whitespace differences, so normalize before comparing.
    const authorUsername = String(post.author_username || "").trim().toLowerCase();
    const myDisplayName = String(currentProfileUser?.displayName || "").trim().toLowerCase();
    const myEmail = String(currentProfileUser?.email || "").trim().toLowerCase();
    const isPostAuthor =
      (myDisplayName && authorUsername && myDisplayName === authorUsername) ||
      (myEmail && authorUsername && myEmail === authorUsername);
    const canDelete = !!isCreator || !!isModerator || isPostAuthor;
    __communityPostDetail.deleteBtn.style.display = canDelete ? "inline-flex" : "none";
  }

  // Votes
  const scoreEl = document.getElementById("communityPostDetailScore");
  if (scoreEl) scoreEl.textContent = String(Number(post.score ?? 0));

  // Media
  const mediaHost = document.getElementById("communityPostDetailMedia");
  if (mediaHost) {
    const mediaUrls = Array.isArray(post.media_urls) ? post.media_urls.filter(Boolean) : [];
    const mediaTypes = Array.isArray(post.media_types) ? post.media_types : [];
    const fallback = post.image_url ? [post.image_url] : [];
    const safeUrls = mediaUrls.length ? mediaUrls : fallback;
    const safeTypes = mediaUrls.length ? mediaTypes : (post.media_types || []);
    const inferKind = (explicitType, url) => {
      if (explicitType === "video" || explicitType === "audio") return explicitType;
      const u = String(url || "").toLowerCase();
      if (u.match(/\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/)) return "video";
      if (u.match(/\.(mp3|wav|m4a|aac|flac|ogg)(\?.*)?$/)) return "audio";
      return "image";
    };

    const slidesHtml = safeUrls
      .map((url, idx) => {
        const kind = inferKind(safeTypes[idx], url);
        if (kind === "video") return `<div class="community-post-media-slide" data-slide-index="${idx}"><video src="${escapeHtml(url)}" controls preload="metadata" playsinline></video></div>`;
        if (kind === "audio") return `<div class="community-post-media-slide community-post-media-slide--audio" data-slide-index="${idx}"><audio src="${escapeHtml(url)}" controls preload="metadata"></audio></div>`;
        return `<div class="community-post-media-slide" data-slide-index="${idx}"><img src="${escapeHtml(url)}" alt="Post media ${idx + 1}" loading="lazy" /></div>`;
      })
      .join("");

    const thumbsHtml = safeUrls.length > 1
      ? `<div class="community-post-media-thumb-row">
          <div class="community-post-media-thumb-strip" role="tablist" aria-label="Post media thumbnails">
            ${safeUrls
              .map((url, idx) => {
                const kind = inferKind(safeTypes[idx], url);
                const inner = kind === "image" ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" />` : `<i class="${kind === "video" ? "ri-play-line" : "ri-music-2-line"}"></i>`;
                return `<button type="button" class="community-post-media-thumb-btn" data-media-slide-index="${idx}">${inner}</button>`;
              })
              .join("")}
          </div>
        </div>`
      : "";

    mediaHost.innerHTML = `<div class="community-post-media-gallery" aria-label="Post media gallery">
      <div class="community-post-media-scroller" role="region" aria-label="Post media scroller">${slidesHtml}</div>
      ${thumbsHtml}
    </div>`;

    // Attach scroll + thumb UX (lightweight)
    const scroller = mediaHost.querySelector(".community-post-media-scroller");
    const thumbBtns = Array.from(mediaHost.querySelectorAll(".community-post-media-thumb-btn"));
    if (scroller && thumbBtns.length) {
      const slides = Array.from(mediaHost.querySelectorAll(".community-post-media-slide"));
      const updateActive = () => {
        const idx = Math.round(scroller.scrollLeft / Math.max(1, scroller.clientWidth));
        thumbBtns.forEach((b) => {
          const bi = Number(b.dataset.mediaSlideIndex || "0");
          b.classList.toggle("community-post-media-thumb-btn--active", bi === idx);
        });
      };
      thumbBtns.forEach((btn) => {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const idx = Number(btn.dataset.mediaSlideIndex || "0");
          const slide = slides.find((s) => Number(s.dataset.slideIndex || "0") === idx);
          slide?.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" });
        });
      });
      scroller.addEventListener("scroll", () => window.requestAnimationFrame(updateActive));
      updateActive();
    }
  }

  // Comment form visibility
  const form = document.getElementById("communityCommentForm");
  if (form) form.style.display = canComment ? "flex" : "none";

  if (__communityPostDetail.voteUpBtn) {
    __communityPostDetail.voteUpBtn.onclick = () => voteOnPostDetail(postId, 1);
  }
  if (__communityPostDetail.voteDownBtn) {
    __communityPostDetail.voteDownBtn.onclick = () => voteOnPostDetail(postId, -1);
  }

  if (__communityPostDetail.deleteBtn) {
    __communityPostDetail.deleteBtn.onclick = async () => {
      if (!confirm("Delete this post?")) return;
      try {
        const token2 = await (async () => {
          const auth = await authReady;
          return await auth.currentUser?.getIdToken?.();
        })();
        const delRes = await fetch(`/api/posts/${encodeURIComponent(postId)}`, {
          method: "DELETE",
          headers: token2 ? { Authorization: `Bearer ${token2}` } : {},
        });
        const j = await delRes.json().catch(() => ({}));
        if (!delRes.ok) throw new Error(j.error || "Delete failed");
        closeCommunityPostDetailModal();
        loadCommunityView();
      } catch (e) {
        showToast(e?.message || "Could not delete.", "error");
      }
    };
  }

  // Comments
  if (form) {
    // Reset reply state
    const parentIdEl = document.getElementById("communityCommentParentId");
    const bodyEl = document.getElementById("communityCommentBody");
    if (parentIdEl) parentIdEl.value = "";
    if (bodyEl) bodyEl.value = "";
  }

  // Wire comment actions (delegated) once per open
  const listEl = document.getElementById("communityPostCommentsList");
  const emptyEl = document.getElementById("communityPostCommentsEmpty");
  if (listEl && !listEl.__dewDelegated) {
    listEl.__dewDelegated = true;
    listEl.addEventListener("click", async (ev) => {
      const replyBtn = ev.target.closest(".community-comment-reply-btn");
      if (replyBtn) {
        ev.preventDefault();
        const cid = replyBtn.dataset.replyCommentId;
        const parentIdEl = document.getElementById("communityCommentParentId");
        const bodyEl = document.getElementById("communityCommentBody");
        if (parentIdEl) parentIdEl.value = String(cid || "");
        if (bodyEl) {
          bodyEl.focus();
          bodyEl.placeholder = "Write a reply…";
        }
        return;
      }

      const delBtn = ev.target.closest(".community-comment-delete-btn");
      if (delBtn) {
        ev.preventDefault();
        const cid = delBtn.dataset.deleteCommentId;
        if (!cid) return;
        if (!confirm("Delete this comment (and its replies)?")) return;
        try {
          const auth = await authReady;
          const token2 = await auth.currentUser?.getIdToken?.();
          const delRes = await fetch(`/api/posts/${encodeURIComponent(communityPostDetailOpenPostId)}/comments/${encodeURIComponent(cid)}`, {
            method: "DELETE",
            headers: token2 ? { Authorization: `Bearer ${token2}` } : {},
          });
          const j = await delRes.json().catch(() => ({}));
          if (!delRes.ok) throw new Error(j.error || "Delete failed");
          await renderCommunityPostComments(communityPostDetailOpenPostId);
        } catch (e) {
          showToast(e?.message || "Could not delete.", "error");
        }
        return;
      }

      const voteBtn = ev.target.closest("[data-comment-vote]");
      if (voteBtn) {
        ev.preventDefault();
        const cid = voteBtn.dataset.commentId;
        const v = Number(voteBtn.dataset.commentVote);
        if (!cid || ![1, -1].includes(v)) return;
        try {
          const auth = await authReady;
          const token2 = await auth.currentUser?.getIdToken?.();
          const voteRes = await fetch(`/api/comments/${encodeURIComponent(cid)}/vote`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token2}` },
            body: JSON.stringify({ value: v }),
          });
          const j = await voteRes.json().catch(() => ({}));
          if (!voteRes.ok) throw new Error(j.error || "Vote failed");
          await renderCommunityPostComments(communityPostDetailOpenPostId);
        } catch (e) {
          showToast(e?.message || "Could not vote.", "error");
        }
      }
    });
  }

  // Comment submit handler (set once)
  if (form && !form.__dewCommentSubmit) {
    form.__dewCommentSubmit = true;
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const bodyEl = document.getElementById("communityCommentBody");
      const parentIdEl = document.getElementById("communityCommentParentId");
      if (!bodyEl) return;
      const body = String(bodyEl.value || "").trim();
      if (!body) return;
      const parentCommentId = parentIdEl?.value ? String(parentIdEl.value) : null;

      try {
        const auth = await authReady;
        const token2 = await auth.currentUser?.getIdToken?.();
        const createRes = await fetch(`/api/posts/${encodeURIComponent(communityPostDetailOpenPostId)}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token2}` },
          body: JSON.stringify({ body, parentCommentId }),
        });
        const j = await createRes.json().catch(() => ({}));
        if (!createRes.ok) throw new Error(j.error || "Comment failed");

        bodyEl.value = "";
        if (parentIdEl) parentIdEl.value = "";
        if (bodyEl) bodyEl.placeholder = "Add a comment…";
        await renderCommunityPostComments(communityPostDetailOpenPostId);
      } catch (e) {
        showToast(e?.message || "Could not comment.", "error");
      }
    });
  }

  await renderCommunityPostComments(postId);
}

async function voteOnPostDetail(postId, delta) {
  try {
    if (!currentProfileUser?.uid) {
      showToast("Please log in to vote.", "error");
      return;
    }
    const auth = await authReady;
    const token2 = await auth.currentUser?.getIdToken?.();
    if (!token2) return;
    const voteRes = await fetch(`/api/posts/${encodeURIComponent(postId)}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token2}` },
      body: JSON.stringify({ value: Number(delta) }),
    });
    const j = await voteRes.json().catch(() => ({}));
    if (!voteRes.ok) throw new Error(j.error || "Vote failed");
    const scoreEl = document.getElementById("communityPostDetailScore");
    if (scoreEl) scoreEl.textContent = String(Number(j.score ?? 0));
    // Feed metrics mirror is updated server-side via the voting endpoint itself.
  } catch (e) {
    showToast(e?.message || "Could not vote.", "error");
  }
}

async function renderCommunityPostComments(postId) {
  const listEl = document.getElementById("communityPostCommentsList");
  const emptyEl = document.getElementById("communityPostCommentsEmpty");
  if (!listEl) return;

  const token = await (async () => {
    if (!currentProfileUser?.uid) return null;
    const auth = await authReady;
    return await auth.currentUser?.getIdToken?.();
  })();

  listEl.innerHTML = "";
  if (emptyEl) emptyEl.style.display = "none";

  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`/api/posts/${encodeURIComponent(postId)}/comments`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.error || "Could not load comments.", "error");
    return;
  }

  const comments = Array.isArray(data.comments) ? data.comments : [];
  if (!comments.length) {
    if (emptyEl) emptyEl.style.display = "block";
    return;
  }

  // Build thread tree by parent_comment_id
  const byId = new Map(comments.map((c) => [String(c.id), c]));
  const childrenByParent = new Map();
  const roots = [];
  comments.forEach((c) => {
    const pid = c.parent_comment_id ? String(c.parent_comment_id) : "";
    if (!pid) roots.push(c);
    else {
      const arr = childrenByParent.get(pid) || [];
      arr.push(c);
      childrenByParent.set(pid, arr);
    }
  });

  const canDelete = (() => {
    // UI permission is a best-effort guess; server enforces.
    const uid = currentProfileUser?.uid || null;
    return async () => {
      if (!uid) return false;
      // Mods/creator delete all in this modal (based on current communityList entry).
      const commObj = (Array.isArray(communityList) ? communityList.find((c) => String(c.slug || "").toLowerCase() === String(data.community_slug || "").toLowerCase()) : null) || null;
      return !!commObj;
    };
  })();

  const currentUserDisplayName = currentProfileUser?.displayName ? String(currentProfileUser.displayName) : "";
  const uid = currentProfileUser?.uid || null;

  // Determine can-delete heuristically:
  const modalPostId = postId;
  // We'll compute comment delete permission per comment while rendering.
  const escapeBody = (txt) => escapeHtml(String(txt || ""));
  const renderNode = (c, depth) => {
    const commentId = String(c.id);
    const authorName = c.author_display_name || "Unknown";
    const created = safeToDate(c.created_at);
    const score = Number(c.score ?? 0);
    const myVote = Number(c.my_vote ?? 0);

    const canDeleteComment =
      (!!uid && Array.isArray(communityList) && communityList.some((comm) => {
        const isCreator = comm.creator_firebase_uid && String(comm.creator_firebase_uid) === String(uid);
        const isMod = Array.isArray(comm.moderators) && comm.moderators.some((m) => String(m.uid) === String(uid));
        const isInThisModal = comm.id && comm.id; // no-op; kept for readability
        return isCreator || isMod || false;
      })) || (currentUserDisplayName && authorName === currentUserDisplayName) || String(c.uid) === String(uid);

    const replyBtn = `<button type="button" class="community-comment-reply-btn" data-reply-comment-id="${escapeHtml(commentId)}">
        Reply</button>`;
    const deleteBtn = canDeleteComment
      ? `<button type="button" class="community-comment-delete-btn" data-delete-comment-id="${escapeHtml(commentId)}">
          Delete</button>`
      : "";

    const voteUpActive = myVote === 1;
    const voteDownActive = myVote === -1;
    const liClass = "community-comment" + (depth > 0 ? " community-comment--reply" : "");

    const children = childrenByParent.get(commentId) || [];
    const childHtml = children.length ? `<ul class="community-post-comments-list" style="margin-top:10px">${children.map((ch) => renderNode(ch, depth + 1)).join("")}</ul>` : "";

    return `
      <li class="${liClass}">
        <div class="community-comment-header">
          <div><strong>${escapeHtml(authorName)}</strong> <span>• ${escapeHtml(created)}</span></div>
          <div>${deleteBtn}</div>
        </div>
        <div class="community-comment-body">${escapeBody(c.body)}</div>
        <div class="community-comment-actions">
          <button type="button" class="community-comment-vote-btn" data-comment-vote="1" data-comment-id="${escapeHtml(commentId)}" aria-label="Upvote" ${voteUpActive ? 'style="border-color: rgba(126,242,191,0.55)"' : ''}>
            <i class="ri-arrow-up-s-line"></i>
          </button>
          <div class="community-comment-score">${score}</div>
          <button type="button" class="community-comment-vote-btn" data-comment-vote="-1" data-comment-id="${escapeHtml(commentId)}" aria-label="Downvote" ${voteDownActive ? 'style="border-color: rgba(255,120,120,0.55)"' : ''}>
            <i class="ri-arrow-down-s-line"></i>
          </button>
          ${replyBtn}
        </div>
        ${childHtml}
      </li>
    `;
  };

  const html = `<ul class="community-post-comments-list">${roots.map((r) => renderNode(r, 0)).join("")}</ul>`;
  listEl.innerHTML = html;
}


async function voteOnPost(postId, delta, card) {
  if (!postId) return;
  try {
    if (!currentProfileUser?.uid) {
      showToast("Please log in to vote.", "error");
      return;
    }
    const auth = await authReady;
    const token = await auth.currentUser?.getIdToken?.();
    if (!token) return;

    const res = await fetch(`/api/posts/${encodeURIComponent(postId)}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ value: Number(delta) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Vote failed");

    const scoreEl = card.querySelector(".community-vote-score");
    if (scoreEl) scoreEl.textContent = String(Number(data.score ?? 0));
  } catch (e) {
    showToast(e?.message || "Could not vote.", "error");
  }
}

async function handleCommunityPostSubmit(e) {
  e.preventDefault();
  const titleEl = document.getElementById("communityPostTitle");
  const bodyEl = document.getElementById("communityPostBody");
  const catEl = document.getElementById("communityCategory");
  const tagsEl = document.getElementById("communityTags");
  const imgInput = document.getElementById("communityImage");
  if (!titleEl || !bodyEl || !catEl) return;
  const title = titleEl.value.trim();
  const body = bodyEl.value.trim();
  // Body/description is optional (match Reddit "post" feel).
  if (!title) return;
  const category = (catEl && catEl.value) ? catEl.value : "";
  if (!category) {
    showToast("Create a community first, then choose it when posting.", "error");
    return;
  }
  const tags =
    tagsEl && tagsEl.value
      ? tagsEl.value.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

  const postType = document.querySelector("#communityPostTypeTabs .community-post-tab.active")?.dataset?.postType || "media";
  const mediaItems = (window.__dewCommunityInlineMediaItems || []).slice(0, 8);

  const linkUrlEl = document.getElementById("communityPostLinkUrl");
  const linkUrl = (linkUrlEl?.value || "").trim();

  const pollQEl = document.getElementById("communityPostPollQuestion");
  const pollQuestion = (pollQEl?.value || "").trim();
  const pollOpt1 = (document.getElementById("communityPostPollOption1")?.value || "").trim();
  const pollOpt2 = (document.getElementById("communityPostPollOption2")?.value || "").trim();
  const pollOpt3 = (document.getElementById("communityPostPollOption3")?.value || "").trim();

  let finalBody = body;
  if (postType === "link") {
    if (!linkUrl) {
      showToast("Paste a link URL for Link posts.", "error");
      return;
    }
    finalBody = `Link: ${linkUrl}${finalBody ? `\n\n${finalBody}` : ""}`;
  } else if (postType === "poll") {
    if (!pollOpt1 || !pollOpt2) {
      showToast("Poll needs at least two options.", "error");
      return;
    }
    const opts = [pollOpt1, pollOpt2, pollOpt3].filter(Boolean).map((o, i) => `Option ${i + 1}: ${o}`);
    finalBody = `Poll${pollQuestion ? `: ${pollQuestion}` : ""}\n${opts.join("\n")}${finalBody ? `\n\n${finalBody}` : ""}`;
  }

  if (postType === "media") {
    if (!mediaItems.length) {
      showToast("Add at least one image, video, or audio to your post.", "error");
      return;
    }
  }

  const submitBtn = document.querySelector("#communityCreateForm .btn-community-post");
  const originalSubmitHtml = submitBtn?.innerHTML;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="ri-loader-4-line"></i> Posting...';
  }

  try {
    const supabase = await getSupabaseClient();
    const mediaUrls = [];
    const mediaTypes = []; // "image" | "video" | "audio"
    let imageUrl = null;

    async function compressImageToWebp(file) {
      const maxWidth = 1280;
      const quality = 0.84;
      try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, maxWidth / Math.max(bitmap.width, 1));
        const width = Math.max(1, Math.round(bitmap.width * scale));
        const height = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return file;
        ctx.drawImage(bitmap, 0, 0, width, height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
        return blob || file;
      } catch (_) {
        return file;
      }
    }

    const itemsToUpload = postType === "media" ? mediaItems : [];
    for (const [idx, item] of itemsToUpload.entries()) {
      const file = item?.file;
      if (!file) continue;

      const kind = item?.kind || (String(file?.type || "").startsWith("video/") ? "video" : String(file?.type || "").startsWith("audio/") ? "audio" : "image");
      const mime = String(file?.type || "");
      if (kind === "video" && !mime.startsWith("video/")) continue;
      if (kind === "audio" && !mime.startsWith("audio/")) continue;
      if (kind === "image" && !mime.startsWith("image/")) continue;

      const baseName = String(file.name || "media");
      const safeBase = baseName.replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_\-\.]/g, "");
      const ext = kind === "image" ? "webp" : (safeBase.split(".").pop() || "bin");
      const path = `${category}/posts/${Date.now()}_${idx}_${safeBase}.${ext}`;

      let payload = file;
      if (kind === "image") payload = await compressImageToWebp(file);

      const bucketCandidates = ["community-posts", "community-assets"];
      let uploadedUrl = null;
      let lastUploadErr = null;

      for (const bucket of bucketCandidates) {
        try {
          // We generate unique paths with Date.now(), so upsert isn't required.
          // Avoiding upsert reduces the need for UPDATE permissions in Storage policies.
          const { error: uploadError } = await supabase.storage.from(bucket).upload(path, payload, { upsert: false });
          if (uploadError) {
            lastUploadErr = uploadError;
            continue;
          }
          const { data } = supabase.storage.from(bucket).getPublicUrl(path);
          uploadedUrl = data?.publicUrl || null;
          if (uploadedUrl) break;
        } catch (err) {
          lastUploadErr = err;
        }
      }

      if (!uploadedUrl) {
        // Surface last error message to toast handler.
        throw lastUploadErr || new Error("Storage upload failed for all buckets.");
      }

      mediaUrls.push(uploadedUrl);
      mediaTypes.push(kind);
      if (!imageUrl && kind === "image") imageUrl = uploadedUrl;
    }

    // Backward compatibility: keep `image_url` set to the first image (or first media item).
    if (!imageUrl) imageUrl = mediaUrls[0] || null;
    const comm = communityList.find((c) => (c.slug || "").toLowerCase() === category.toLowerCase());
    const communityId = comm?.id;
    if (!communityId) {
      showToast("Community not found. Pick a community from the list.", "error");
      return;
    }
    const author = currentProfileUser?.displayName || "Warden";
    const commonPayload = {
      community_id: communityId,
      title,
      body: finalBody || null,
      author_username: author,
      image_url: imageUrl,
      tags: tags.length ? tags : [],
    };

    // If your DB schema supports it, store all media.
    try {
      const { error } = await supabase.from("posts").insert({
        ...commonPayload,
        media_urls: mediaUrls,
        media_types: mediaTypes,
      });
      if (error) throw error;
    } catch (err) {
      // Fallback for older schema: store only `image_url`.
      console.error("Media insert failed; falling back to image_url only.", err);
      // This is important for debugging: otherwise the post succeeds but only
      // a single image is displayed in the community gallery.
      showToast(
        "Saved post, but media gallery couldn't be saved (media_urls/media_types insert failed). Re-run `supabase/community_schema.sql` so the posts table supports media arrays.",
        "error"
      );
      const { error } = await supabase.from("posts").insert(commonPayload);
      if (error) throw error;
    }
    // Record weekly contributor for this community (DB-backed).
    try {
      const auth = await authReady;
      const token = await auth.currentUser?.getIdToken?.();
      if (token) {
        await fetch(`/api/communities/${encodeURIComponent(String(category).toLowerCase())}/contribute`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch (_) {}
    titleEl.value = "";
    bodyEl.value = "";
    if (tagsEl) tagsEl.value = "";
    if (imgInput) imgInput.value = "";

    // Clear preview + revoke object URL after submit.
    try {
      const previewUrlsRaw = imgInput?.dataset?.previewUrls || "";
      let urls = [];
      try {
        if (previewUrlsRaw) urls = JSON.parse(previewUrlsRaw);
      } catch (_) {}
      urls.forEach((u) => {
        try { URL.revokeObjectURL(u); } catch (_) {}
      });
      if (imgInput?.dataset) imgInput.dataset.previewUrls = "";

      // Reset inline preview carousel UI (and stop any playing video).
      const previewWrap = document.getElementById("communityPostMediaPreview");
      const previewThumbs = document.getElementById("communityPostMediaThumbs");
      const previewMainImg = document.getElementById("communityPostMediaMainImg");
      const previewMainVideo = document.getElementById("communityPostMediaMainVideo");
      const previewMainAudio = document.getElementById("communityPostMediaMainAudio");

      if (previewWrap) previewWrap.style.display = "none";
      if (previewThumbs) previewThumbs.innerHTML = "";
      if (previewMainImg) {
        previewMainImg.src = "";
        previewMainImg.style.display = "none";
      }
      if (previewMainVideo) {
        previewMainVideo.pause();
        previewMainVideo.removeAttribute("src");
        previewMainVideo.load();
        previewMainVideo.style.display = "none";
      }
      if (previewMainAudio) {
        previewMainAudio.pause();
        previewMainAudio.removeAttribute("src");
        previewMainAudio.load();
        previewMainAudio.style.display = "none";
      }

      // Also hide the (unused) modal picker if it exists.
      const pickerModal = document.getElementById("communityPostMediaPicker");
      const pickerImg = document.getElementById("communityPostMediaPickerMainImg");
      const pickerVideo = document.getElementById("communityPostMediaPickerMainVideo");
      const pickerThumbs = document.getElementById("communityPostMediaPickerThumbs");
      if (pickerModal) pickerModal.style.display = "none";
      if (pickerImg) pickerImg.src = "";
      if (pickerVideo) {
        pickerVideo.pause();
        pickerVideo.removeAttribute("src");
        pickerVideo.load();
      }
      if (pickerThumbs) pickerThumbs.innerHTML = "";

      // Clear submit media state array (keeps object URL revocation consistent).
      try {
        if (window.__dewCommunityInlineMediaItems) window.__dewCommunityInlineMediaItems.length = 0;
      } catch (_) {}
    } catch (_) {}
    loadCommunityView();
    closeCommunityCreatePostModal();
  } catch (err) {
    console.error("Failed to create post", err);
    // Surface the reason to user (helps with RLS / schema / upload problems).
    const msg = err?.message ? String(err.message) : String(err);
    const lower = msg.toLowerCase();
    if (lower.includes("row-level security") || lower.includes("rls") || lower.includes("permission")) {
      showToast("Couldn't post (permission denied). If the community is restricted/private, you must join.", "error");
    } else if (lower.includes("storage") || lower.includes("upload") || lower.includes("community-posts") || lower.includes("bucket")) {
      showToast("Couldn't post: media upload to storage failed. Check storage policies.", "error");
    } else if (lower.includes("column") || lower.includes("media_urls") || lower.includes("media_types")) {
      showToast("Couldn't post: database schema mismatch (media fields). Re-run SQL schema if needed.", "error");
    } else {
      showToast("Couldn't post. " + (msg.length > 120 ? msg.slice(0, 120) + "…" : msg), "error");
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      if (originalSubmitHtml !== undefined) submitBtn.innerHTML = originalSubmitHtml;
    }
  }
}

function initSettingsPreferences() {
  const alertsCb = document.getElementById("settingsNotifyAlerts");
  const tipsCb = document.getElementById("settingsNotifyTips");
  const darkBtn = document.getElementById("settingsThemeDark");
  const lightBtn = document.getElementById("settingsThemeLight");
  const plantsFilterSel = document.getElementById("settingsPlantsFilter");
  const lightFilterSel = document.getElementById("settingsLightFilter");
  const reduceMotionCb = document.getElementById("settingsReduceMotion");
  const profilePublicBtn = document.getElementById("settingsProfilePublic");
  const profilePrivateBtn = document.getElementById("settingsProfilePrivate");
  const profileOptionsWrap = document.getElementById("settingsProfileOptions");
  const showContactCb = document.getElementById("settingsShowContact");
  const allowMessagesCb = document.getElementById("settingsAllowMessages");
  const showAchievementsCb = document.getElementById("settingsShowAchievements");
  const showTopPostsCb = document.getElementById("settingsShowTopPosts");
  const showFavouritesCb = document.getElementById("settingsShowFavourites");
  if (
    !alertsCb &&
    !tipsCb &&
    !darkBtn &&
    !lightBtn &&
    !plantsFilterSel &&
    !lightFilterSel &&
    !reduceMotionCb &&
    !profilePublicBtn &&
    !profilePrivateBtn &&
    !profileOptionsWrap
  ) {
    return;
  }

  const prefs = dewSettings || {};

  if (alertsCb) alertsCb.checked = prefs.notifyAlerts !== false;
  if (tipsCb) tipsCb.checked = prefs.notifyTips !== false;
  if (plantsFilterSel) plantsFilterSel.value = prefs.defaultPlantsFilter || "indoor";
  if (lightFilterSel) lightFilterSel.value = prefs.defaultLightFilter || "all";
  if (reduceMotionCb) reduceMotionCb.checked = !!prefs.reduceMotion;

  const initialPrivacy = prefs.profilePrivacy === "private" ? "private" : "public";
  const initialShowContact = prefs.profileShowContact !== false;
  const initialAllowMessages = prefs.profileAllowMessages !== false;
  const initialShowAchievements = prefs.profileShowAchievements !== false;
  const initialShowTopPosts = prefs.profileShowTopPosts !== false;
  const initialShowFavourites = prefs.profileShowFavourites !== false;

  if (showContactCb) showContactCb.checked = initialShowContact;
  if (allowMessagesCb) allowMessagesCb.checked = initialAllowMessages;
  if (showAchievementsCb) showAchievementsCb.checked = initialShowAchievements;
  if (showTopPostsCb) showTopPostsCb.checked = initialShowTopPosts;
  if (showFavouritesCb) showFavouritesCb.checked = initialShowFavourites;

  dewSettings = {
    ...(dewSettings || {}),
    profilePrivacy: initialPrivacy,
    profileShowContact: initialShowContact,
    profileAllowMessages: initialAllowMessages,
    profileShowAchievements: initialShowAchievements,
    profileShowTopPosts: initialShowTopPosts,
    profileShowFavourites: initialShowFavourites,
  };

  function updateProfilePrivacyUI() {
    const privacy = (dewSettings && dewSettings.profilePrivacy) || "public";
    if (profilePublicBtn && profilePrivateBtn) {
      profilePublicBtn.classList.toggle("settings-privacy-pill--active", privacy === "public");
      profilePrivateBtn.classList.toggle("settings-privacy-pill--active", privacy === "private");
    }
    const isPrivate = privacy === "private";
    if (profileOptionsWrap) {
      profileOptionsWrap.classList.toggle("settings-profile-options--disabled", isPrivate);
    }
    [showContactCb, allowMessagesCb, showAchievementsCb, showTopPostsCb, showFavouritesCb].forEach((cb) => {
      if (!cb) return;
      cb.disabled = isPrivate;
    });
  }

  function saveAndApply(next) {
    dewSettings = { ...(dewSettings || {}), ...next };
    applyTheme(dewSettings.theme || "dark");
    if (reduceMotionCb) {
      document.body.classList.toggle("reduce-motion", !!dewSettings.reduceMotion);
    }
    try {
      window.localStorage.setItem("dewSettings", JSON.stringify(dewSettings));
    } catch (_) {}
    if (darkBtn && lightBtn) {
      darkBtn.classList.toggle("settings-theme-button--active", (dewSettings.theme || "dark") === "dark");
      lightBtn.classList.toggle("settings-theme-button--active", dewSettings.theme === "light");
    }
    updateProfilePrivacyUI();
    applyProfilePrivacyToView();
  }

  alertsCb?.addEventListener("change", () => {
    saveAndApply({ notifyAlerts: !!alertsCb.checked });
  });
  tipsCb?.addEventListener("change", () => {
    saveAndApply({ notifyTips: !!tipsCb.checked });
  });

  darkBtn?.addEventListener("click", () => {
    saveAndApply({ theme: "dark" });
  });
  lightBtn?.addEventListener("click", () => {
    saveAndApply({ theme: "light" });
  });

  plantsFilterSel?.addEventListener("change", () => {
    saveAndApply({ defaultPlantsFilter: plantsFilterSel.value || "indoor" });
  });
  lightFilterSel?.addEventListener("change", () => {
    saveAndApply({ defaultLightFilter: lightFilterSel.value || "all" });
  });
  reduceMotionCb?.addEventListener("change", () => {
    saveAndApply({ reduceMotion: !!reduceMotionCb.checked });
  });

  profilePublicBtn?.addEventListener("click", () => {
    saveAndApply({ profilePrivacy: "public" });
  });
  profilePrivateBtn?.addEventListener("click", () => {
    saveAndApply({
      profilePrivacy: "private",
      profileShowContact: false,
      profileAllowMessages: false,
      profileShowAchievements: false,
      profileShowTopPosts: false,
      profileShowFavourites: false,
    });
  });

  showContactCb?.addEventListener("change", () => {
    saveAndApply({ profileShowContact: !!showContactCb.checked });
  });
  allowMessagesCb?.addEventListener("change", () => {
    saveAndApply({ profileAllowMessages: !!allowMessagesCb.checked });
  });
  showAchievementsCb?.addEventListener("change", () => {
    saveAndApply({ profileShowAchievements: !!showAchievementsCb.checked });
  });
  showTopPostsCb?.addEventListener("change", () => {
    saveAndApply({ profileShowTopPosts: !!showTopPostsCb.checked });
  });
  showFavouritesCb?.addEventListener("change", () => {
    saveAndApply({ profileShowFavourites: !!showFavouritesCb.checked });
  });

  // initial button state
  updateProfilePrivacyUI();
  saveAndApply({});

  initLocationSettings();
}

const NOMINATIM_UA = "DEW-EcoWarden/1.0 (plant monitoring app)";

function showViewIfDefined(view) {
  const v = typeof view === "string" ? view : null;
  if (v === "settings" && settingsView) settingsView.style.display = "block";
}

/** Reverse geocode: coords -> city, state, country using OpenStreetMap Nominatim. */
async function reverseGeocode(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&format=json`;
  const res = await fetch(url, { headers: { "Accept-Language": "en", "User-Agent": NOMINATIM_UA } });
  if (!res.ok) throw new Error("Geocoding failed");
  const data = await res.json();
  const addr = data.address || {};
  return {
    city: addr.city || addr.town || addr.village || addr.municipality || addr.county || "",
    state: addr.state || "",
    country: addr.country || "",
    latitude: lat,
    longitude: lon,
  };
}

/** Forward geocode: city, country -> coords using OpenStreetMap Nominatim. */
async function forwardGeocode(city, country, postal) {
  const q = [city, country].filter(Boolean).join(", ");
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { "Accept-Language": "en", "User-Agent": NOMINATIM_UA } });
  if (!res.ok) throw new Error("Geocoding failed");
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error("Location not found. Try a different city or country.");
  const first = arr[0];
  const lat = parseFloat(first.lat);
  const lon = parseFloat(first.lon);
  const addr = first.address || {};
  return {
    city: addr.city || addr.town || addr.village || first.name || city,
    state: addr.state || "",
    country: addr.country || country,
    latitude: lat,
    longitude: lon,
  };
}

function getLocationUid() {
  return window.__dewUid || currentProfileUser?.uid || null;
}

function showLocationMessage(text, type) {
  const el = document.getElementById("locationMessage");
  if (!el) return;
  el.textContent = text;
  el.className = "location-message" + (type === "error" ? " location-message--error" : type === "success" ? " location-message--success" : "");
  el.style.display = text ? "block" : "none";
}

function updateLocationDisplay(loc) {
  const display = document.getElementById("locationCurrentDisplay");
  const meta = document.getElementById("locationCurrentMeta");
  if (!display) return;
  if (!loc) {
    display.textContent = "Not set";
    if (meta) meta.textContent = "Add a location to see weather on your dashboard.";
    return;
  }
  const parts = [loc.city, loc.state, loc.country].filter(Boolean);
  display.textContent = parts.length ? parts.join(", ") : `${loc.latitude?.toFixed(2)}°, ${loc.longitude?.toFixed(2)}°`;
  if (meta) meta.textContent = loc.last_updated ? "Updated " + new Date(loc.last_updated).toLocaleDateString() : "";
}

async function loadLocationAndDisplay() {
  const uid = getLocationUid();
  if (!uid) return;
  try {
    const res = await authFetch("/api/users/" + encodeURIComponent(uid) + "/location");
    const loc = await res.json();
    updateLocationDisplay(loc);
  } catch (_) {
    updateLocationDisplay(null);
  }
}

function initLocationSettings() {
  const btnDetect = document.getElementById("locationBtnDetect");
  const btnManual = document.getElementById("locationBtnManual");
  const manualForm = document.getElementById("locationManualForm");
  const btnCancelManual = document.getElementById("locationBtnCancelManual");
  const btnSaveManual = document.getElementById("locationBtnSaveManual");
  const inputCity = document.getElementById("locationInputCity");
  const inputCountry = document.getElementById("locationInputCountry");
  const inputPostal = document.getElementById("locationInputPostal");
  const useDeviceCb = document.getElementById("locationUseDevice");

  if (!btnDetect && !btnManual) return;

  loadLocationAndDisplay();

  btnDetect?.addEventListener("click", async () => {
    const uid = getLocationUid();
    if (!uid) {
      showLocationMessage("Please sign in to save your location.", "error");
      return;
    }
    showLocationMessage("Detecting your location…");
    if (!navigator.geolocation) {
      showLocationMessage("Your browser does not support location. Set location manually.", "error");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const data = await reverseGeocode(latitude, longitude);
          const res = await fetch("/api/users/" + encodeURIComponent(uid) + "/location", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
          if (!res.ok) throw new Error("Failed to save");
          const saved = await res.json();
          updateLocationDisplay(saved);
          showLocationMessage("Location saved. Weather will update on the dashboard.", "success");
          if (typeof window.refreshDashboardWeather === "function") window.refreshDashboardWeather();
        } catch (e) {
          showLocationMessage(e.message || "Could not resolve or save location. Try manual entry.", "error");
        }
      },
      (err) => {
        if (err.code === 1) showLocationMessage("Location permission denied. You can set your location manually.", "error");
        else if (err.code === 2) showLocationMessage("Location unavailable. Try setting your location manually.", "error");
        else showLocationMessage("Could not detect location. Try manual entry.", "error");
      },
      { timeout: 12000, maximumAge: 60000 }
    );
  });

  btnManual?.addEventListener("click", () => {
    manualForm?.style && (manualForm.style.display = manualForm.style.display === "none" ? "block" : "none");
    showLocationMessage("");
  });

  btnCancelManual?.addEventListener("click", () => {
    if (manualForm) manualForm.style.display = "none";
    showLocationMessage("");
  });

  btnSaveManual?.addEventListener("click", async () => {
    const uid = getLocationUid();
    const city = inputCity?.value?.trim();
    const country = inputCountry?.value?.trim();
    if (!uid) {
      showLocationMessage("Please sign in to save your location.", "error");
      return;
    }
    if (!city || !country) {
      showLocationMessage("Please enter city and country.", "error");
      return;
    }
    showLocationMessage("Looking up location…");
    try {
      const data = await forwardGeocode(city, country, inputPostal?.value?.trim());
      const res = await authFetch("/api/users/" + encodeURIComponent(uid) + "/location", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to save");
      const saved = await res.json();
      updateLocationDisplay(saved);
      if (manualForm) manualForm.style.display = "none";
      if (inputCity) inputCity.value = "";
      if (inputCountry) inputCountry.value = "";
      if (inputPostal) inputPostal.value = "";
      showLocationMessage("Location saved. Weather will update on the dashboard.", "success");
      if (typeof window.refreshDashboardWeather === "function") window.refreshDashboardWeather();
    } catch (e) {
      showLocationMessage(e.message || "Could not find or save location.", "error");
    }
  });

  if (useDeviceCb) {
    useDeviceCb.checked = !!(dewSettings && dewSettings.useDeviceLocation);
    useDeviceCb.addEventListener("change", () => {
      dewSettings = { ...(dewSettings || {}), useDeviceLocation: !!useDeviceCb.checked };
      try {
        window.localStorage.setItem("dewSettings", JSON.stringify(dewSettings));
      } catch (_) {}
    });
  }
}

function renderProfile(user) {
  const photoEl = document.getElementById("profilePhoto");
  const nameEl = document.getElementById("profileDisplayName");
  const emailEl = document.getElementById("profileEmail");
  const nameInput = document.getElementById("profileDisplayNameInput");
  const emailDisplay = document.getElementById("profileEmailDisplay");

  const displayName = user.displayName || "Warden";
  const email = user.email || "—";
  const photoURL = user.photoURL || "";

  if (photoEl) {
    const src = photoURL || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='50' fill='%2363d9a0'/%3E%3Ctext x='50' y='58' font-size='40' fill='white' text-anchor='middle' font-family='sans-serif'%3E" + (displayName[0] || "W").toUpperCase() + "%3C/text%3E%3C/svg%3E";
    photoEl.src = photoURL && photoURL.includes("supabase") ? src + (src.includes("?") ? "&" : "?") + "v=" + Date.now() : src;
    photoEl.alt = displayName;
  }
  if (nameEl) nameEl.textContent = displayName;
  if (emailEl) emailEl.textContent = email;
  if (nameInput) nameInput.value = displayName;
  if (emailDisplay) emailDisplay.value = email;
  applyProfilePrivacyToView();
}

/** Alerts view: fetch and render sensor + weather alerts; update nav badge. */
const ALERT_DISPLAY_LIMIT = 10;

const ALERT_ICONS = {
  moisture: "ri-drop-line",
  temp: "ri-temp-hot-line",
  light: "ri-sun-line",
  battery: "ri-battery-low-line",
  sensor: "ri-sensor-line",
  warning: "ri-error-warning-line",
  error: "ri-close-circle-line",
};
const WEATHER_ALERT_ICONS = {
  weather_sunny: "ri-sun-line",
  weather_rain: "ri-rainy-line",
  weather_cold: "ri-snowflake-line",
  weather_cloudy: "ri-cloud-line",
  weather_storm: "ri-thunderstorms-line",
  weather_high_temp: "ri-temp-hot-line",
  weather_high_humidity: "ri-drop-line",
};
function formatAlertTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}
let alertsViewFilter = "active";

async function patchAlert(id, body) {
  const res = await fetch("/api/alerts/" + encodeURIComponent(id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok ? res.json() : null;
}

async function patchWeatherAlertRead(uid, id) {
  const res = await fetch("/api/users/" + encodeURIComponent(uid) + "/alerts/" + encodeURIComponent(id) + "/read", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
  });
  return res.ok;
}

async function loadAlertsView(spinnerBtn) {
  const listEl = document.getElementById("alertsList");
  const emptyEl = document.getElementById("alertsEmpty");
  if (!listEl) return;
  const uid = window.__dewUid || (typeof getLocationUid === "function" ? getLocationUid() : null);
  try {
    const weatherFilter = alertsViewFilter === "snoozed" ? "active" : alertsViewFilter;
    const fetchWeather = uid && alertsViewFilter !== "snoozed";
    const [sensorRes, weatherRes] = await Promise.all([
      fetch("/api/alerts?filter=" + encodeURIComponent(alertsViewFilter)),
      fetchWeather ? fetch("/api/users/" + encodeURIComponent(uid) + "/alerts?filter=" + encodeURIComponent(weatherFilter)) : Promise.resolve(null),
    ]);
    let sensorAlerts = await sensorRes.json();
    if (!Array.isArray(sensorAlerts)) sensorAlerts = [];
    let weatherAlerts = [];
    if (weatherRes && weatherRes.ok) {
      const w = await weatherRes.json();
      if (Array.isArray(w)) weatherAlerts = w;
    }
    const sensorNormalized = sensorAlerts.map((a) => ({ ...a, source: "sensor", sortAt: a.at }));
    const weatherNormalized = weatherAlerts.map((a) => ({ ...a, source: "weather", sortAt: a.at || a.created_at }));

    let combined = [];
    if (alertsViewFilter === "snoozed") {
      combined = sensorNormalized.sort((x, y) => new Date(y.sortAt) - new Date(x.sortAt));
    } else if (alertsViewFilter === "active") {
      const activeSensor = sensorNormalized.filter((a) => !a.resolved && !(a.snoozedUntil && new Date(a.snoozedUntil) > new Date()));
      const activeWeather = weatherNormalized.filter((a) => a.status !== "resolved" && !a.read);
      combined = [...activeSensor, ...activeWeather].sort((x, y) => new Date(y.sortAt) - new Date(x.sortAt));
    } else if (alertsViewFilter === "resolved") {
      const resolvedSensor = sensorNormalized.filter((a) => a.resolved);
      const resolvedWeather = weatherNormalized.filter((a) => a.status === "resolved" || a.read);
      combined = [...resolvedSensor, ...resolvedWeather].sort((x, y) => new Date(y.sortAt) - new Date(x.sortAt));
    } else {
      combined = [...sensorNormalized, ...weatherNormalized].sort((x, y) => new Date(y.sortAt) - new Date(x.sortAt));
    }
    combined = combined.slice(0, ALERT_DISPLAY_LIMIT);
    listEl.innerHTML = "";
    if (combined.length === 0) {
      listEl.style.display = "none";
      if (emptyEl) {
        emptyEl.style.display = "block";
        const p = emptyEl.querySelector("p");
        const span = emptyEl.querySelector("span");
        if (p) {
          if (alertsViewFilter === "active") p.textContent = "No alerts yet. Weather and sensor alerts will appear here.";
          else if (alertsViewFilter === "snoozed") p.textContent = "No alerts saved for later.";
          else if (alertsViewFilter === "all") p.textContent = "No alerts yet.";
          else p.textContent = "No alerts in this list.";
        }
        if (span) span.textContent = alertsViewFilter === "active" ? "Set your location for weather alerts; sensor alerts appear when your devices send them." : "";
      }
    } else {
      listEl.style.display = "block";
      if (emptyEl) emptyEl.style.display = "none";
      combined.forEach((a) => {
        if (a.source === "weather") {
          const icon = WEATHER_ALERT_ICONS[a.alert_type] || "ri-cloud-line";
          const isResolved = a.status === "resolved" || a.read;
          const li = document.createElement("li");
          li.className = "alert-item alert-item--weather" + (isResolved ? " alert-item--resolved" : " alert-item--unread");
          li.dataset.alertId = a.id;
          li.dataset.source = "weather";
          li.innerHTML = `
            <div class="alert-icon alert-icon--weather"><i class="${icon}"></i></div>
            <div class="alert-content">
              <div class="alert-body">
                <strong>${escapeHtml(a.message)}</strong>
                ${a.weather_condition ? '<span class="alert-weather-condition">' + escapeHtml(a.weather_condition) + "</span>" : ""}
                ${isResolved ? '<span class="alert-tag alert-tag--resolved">Resolved</span>' : ""}
              </div>
            </div>
            <div class="alert-meta">
              <span class="alert-time">Generated ${formatAlertTime(a.at || a.created_at)}</span>
              ${isResolved ? "" : '<span class="alert-dot"></span>'}
            </div>
          `;
          listEl.appendChild(li);
          if (!isResolved && uid) {
            li.style.cursor = "pointer";
            li.addEventListener("click", async () => {
              const ok = await patchWeatherAlertRead(uid, a.id);
              if (ok) {
                alertsViewFilter = "resolved";
                document.querySelectorAll(".alerts-filters .tab").forEach((t) => t.classList.toggle("active", t.dataset.filter === "resolved"));
                loadAlertsView();
              }
            });
          }
          return;
        }
        const icon = ALERT_ICONS[a.type] || ALERT_ICONS[a.severity] || "ri-notification-3-line";
        const severityClass =
          a.severity === "error" || a.severity === "critical" ? "alert-item--danger" : "alert-item--warning";
        const resolvedClass = a.resolved ? " alert-item--resolved" : "";
        const snoozedUntil = a.snoozedUntil && new Date(a.snoozedUntil) > new Date();
        const li = document.createElement("li");
        li.className = "alert-item " + severityClass + resolvedClass;
        li.dataset.alertId = a.id;
        const actions =
          alertsViewFilter !== "resolved" && !a.resolved
            ? `
          <div class="alert-actions">
            <button type="button" class="btn-alert-action" data-action="resolve" title="Mark as resolved"><i class="ri-checkbox-circle-line"></i> Resolved</button>
            <button type="button" class="btn-alert-action btn-alert-snooze" data-action="snooze" title="For later (24h)"><i class="ri-time-line"></i> For later</button>
          </div>`
            : "";
        li.innerHTML = `
          <div class="alert-icon"><i class="${icon}"></i></div>
          <div class="alert-content">
            <div class="alert-body">
              <strong>${escapeHtml(a.message)}</strong>
              <span>${escapeHtml(a.plantName || a.plantId)}${a.plantId ? " · " + escapeHtml(a.plantId) : ""}</span>
              ${a.resolved ? '<span class="alert-tag alert-tag--resolved">Resolved</span>' : ""}
              ${snoozedUntil && a.snoozedUntil ? '<span class="alert-tag alert-tag--snoozed">For later</span>' : ""}
            </div>
            ${actions}
          </div>
          <div class="alert-meta">
            <span class="alert-time">${formatAlertTime(a.at)}</span>
            ${a.read ? "" : '<span class="alert-dot"></span>'}
          </div>
        `;
        listEl.appendChild(li);
        if (actions) {
          li.querySelector('[data-action="resolve"]')?.addEventListener("click", async (e) => {
            e.stopPropagation();
            const ok = await patchAlert(a.id, { resolved: true, read: true });
            if (ok) {
              alertsViewFilter = "resolved";
              document.querySelectorAll(".alerts-filters .tab").forEach((t) => t.classList.toggle("active", t.dataset.filter === "resolved"));
              loadAlertsView();
            }
          });
          li.querySelector('[data-action="snooze"]')?.addEventListener("click", async (e) => {
            e.stopPropagation();
            const until = new Date();
            until.setHours(until.getHours() + 24);
            const ok = await patchAlert(a.id, { snoozedUntil: until.toISOString(), read: true });
            if (ok) {
              alertsViewFilter = "snoozed";
              document.querySelectorAll(".alerts-filters .tab").forEach((t) => t.classList.toggle("active", t.dataset.filter === "snoozed"));
              loadAlertsView();
            }
          });
        }
      });
    }
    updateAlertsBadge();
  } catch (_) {
    listEl.innerHTML = '<li class="alert-item">Failed to load alerts.</li>';
  } finally {
    if (spinnerBtn) spinnerBtn.classList.remove("btn-refresh--spinning");
  }
}

function initAlertsFilters() {
  const filtersEl = document.getElementById("alertsFilters");
  if (!filtersEl) return;
  filtersEl.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      alertsViewFilter = tab.dataset.filter || "active";
      filtersEl.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      loadAlertsView();
    });
  });
}

/** Analytics view: plants with devices, detail modal with charts */
let analyticsDetailCharts = [];
let currentAnalyticsPlant = null;
let analyticsPollingInterval = null;
function formatTimeAgo(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}
async function loadAnalyticsView(spinnerBtn) {
  const cardsEl = document.getElementById("analyticsPlantCards");
  const emptyEl = document.getElementById("analyticsEmpty");
  if (!cardsEl) return;
  try {
    const res = await fetch("/api/plants");
    const plants = await res.json();
    if (!Array.isArray(plants) || plants.length === 0) {
      cardsEl.innerHTML = "";
      if (emptyEl) emptyEl.style.display = "block";
      return;
    }
    if (emptyEl) emptyEl.style.display = "none";
    const SENSOR_LABELS = ["Temperature", "Humidity", "Soil moisture", "Light"];
    cardsEl.innerHTML = plants.map((p) => {
      const img = p.image ? `/images/plants/${encodeURIComponent(p.image)}` : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect fill='%231a2e28' width='64' height='64'/%3E%3Ctext x='32' y='38' font-size='24' fill='%237ef2bf' text-anchor='middle'%3E🌱%3C/text%3E%3C/svg%3E";
      return `
        <div class="analytics-card" data-plant-id="${escapeHtml(p.id)}" data-plant-name="${escapeHtml(p.name || p.id)}">
          <img class="analytics-card-image" src="${img}" alt="" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Crect fill=%22%231a2e28%22 width=%2264%22 height=%2264%22/%3E%3Ctext x=%2232%22 y=%2238%22 font-size=%2224%22 fill=%22%237ef2bf%22 text-anchor=%22middle%22%3E🌱%3C/text%3E%3C/svg%3E'">
          <div class="analytics-card-body">
            <div class="analytics-card-name">${escapeHtml(p.name || p.id)}</div>
            <div class="analytics-card-device">Device: ESP32 Sensor Hub</div>
            <div class="analytics-card-meta">
              <span class="analytics-card-status">Sensors: ${SENSOR_LABELS.join(", ")}</span>
              <span>Updated ${formatTimeAgo(p.updatedAt)}</span>
            </div>
          </div>
        </div>
      `;
    }).join("");
    cardsEl.querySelectorAll(".analytics-card").forEach((card) => {
      card.addEventListener("click", () => {
        const id = card.dataset.plantId;
        const name = card.dataset.plantName;
        const plant = plants.find((p) => p.id === id);
        if (plant) openAnalyticsDetail(plant);
      });
    });
  } catch (_) {
    cardsEl.innerHTML = "";
    if (emptyEl) emptyEl.style.display = "block";
  } finally {
    if (spinnerBtn) spinnerBtn.classList.remove("btn-refresh--spinning");
  }
}
function openAnalyticsDetail(plant) {
  const modal = document.getElementById("analyticsDetailModal");
  const nameEl = document.getElementById("analyticsDetailPlantName");
  const liveBar = document.getElementById("analyticsLiveBar");
  if (!modal || !nameEl) return;
  currentAnalyticsPlant = { id: plant.id, name: plant.name || plant.id, optimal: plant.optimal || null };
  nameEl.textContent = currentAnalyticsPlant.name;
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
  if (liveBar) liveBar.style.display = "flex";
  if (analyticsPollingInterval) clearInterval(analyticsPollingInterval);
  const hours = document.querySelector("#analyticsTimeTabs .tab.active")?.dataset.hours || "24";
  loadAnalyticsDetail(plant.id, currentAnalyticsPlant.name, hours);
  analyticsPollingInterval = setInterval(() => {
    if (!currentAnalyticsPlant) return;
    const h = document.querySelector("#analyticsTimeTabs .tab.active")?.dataset.hours || "24";
    loadAnalyticsDetail(currentAnalyticsPlant.id, currentAnalyticsPlant.name, h);
  }, 3600000);
  document.getElementById("analyticsModalBackdrop")?.addEventListener("click", closeAnalyticsModal, { once: true });
  document.getElementById("analyticsModalClose")?.addEventListener("click", closeAnalyticsModal, { once: true });
}
function closeAnalyticsModal() {
  const modal = document.getElementById("analyticsDetailModal");
  const liveBar = document.getElementById("analyticsLiveBar");
  if (modal) {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }
  if (liveBar) liveBar.style.display = "none";
  if (analyticsPollingInterval) { clearInterval(analyticsPollingInterval); analyticsPollingInterval = null; }
  currentAnalyticsPlant = null;
  analyticsDetailCharts.forEach((c) => { if (c && c.destroy) c.destroy(); });
  analyticsDetailCharts = [];
}
function _analyticsStat(key, arr) {
  const vals = arr.map((r) => r[key]).filter((v) => v != null && !Number.isNaN(Number(v)));
  const avg = vals.length ? vals.reduce((s, v) => s + Number(v), 0) / vals.length : null;
  const min = vals.length ? Math.min(...vals) : null;
  const max = vals.length ? Math.max(...vals) : null;
  const current = vals.length ? Number(arr[arr.length - 1][key]) : null;
  return { current, avg, min, max };
}
function _analyticsOptimalRanges() {
  const def = {
    temp: { min: 18, max: 30 },
    humidity: { min: 40, max: 70 },
    moisture: { min: 30, max: 60 },
    lux: { min: 200, max: 1500 },
  };
  const opt = currentAnalyticsPlant && currentAnalyticsPlant.optimal ? currentAnalyticsPlant.optimal : {};
  return {
    temp: opt.temp || def.temp,
    humidity: opt.humidity || def.humidity,
    moisture: opt.moisture || def.moisture,
    lux: opt.lux || def.lux,
  };
}
function _analyticsSummaryLabels(hours) {
  const h = String(hours);
  if (h === "24") return { avgTemp: "Average temperature (last 24 hours)", avgHum: "Average humidity (last 24 hours)", avgMoist: "Average soil moisture (last 24 hours)", readings: "Readings (last 24 hours)" };
  if (h === "168") return { avgTemp: "Average temperature this week", avgHum: "Average humidity this week", avgMoist: "Average soil moisture this week", readings: "Total readings this week" };
  if (h === "720") return { avgTemp: "Average temperature this month", avgHum: "Average humidity this month", avgMoist: "Average soil moisture this month", readings: "Total readings this month" };
  return { avgTemp: "Average temperature (all time)", avgHum: "Average humidity (all time)", avgMoist: "Average soil moisture (all time)", readings: "Total readings (all time)" };
}
function _analyticsAggregate(arr, hours) {
  const num = (r, k) => r[k] != null && !Number.isNaN(Number(r[k])) ? Number(r[k]) : null;
  if (hours === "24") {
    const threeHourLabels = ["00:00", "03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00"];
    const buckets = threeHourLabels.map(() => []);
    arr.forEach((r) => {
      const d = new Date(r.at);
      const h = d.getHours();
      const idx = Math.min(Math.floor(h / 3), 7);
      buckets[idx].push(r);
    });
    const labels = threeHourLabels;
    const rawDates = threeHourLabels.map((_, i) => (buckets[i] && buckets[i][0] ? buckets[i][0].at : null));
    const getSeries = (k) => buckets.map((b) => { const vals = b.map((r) => num(r, k)).filter((v) => v != null); return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null; });
    return { labels, rawDates, getSeries, xTitle: "Time of day" };
  }
  if (hours === "168") {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const byDay = {};
    arr.forEach((r) => {
      const d = new Date(r.at);
      const dayKey = d.toISOString().slice(0, 10);
      if (!byDay[dayKey]) byDay[dayKey] = { date: d, readings: [] };
      byDay[dayKey].readings.push(r);
    });
    const sortedDays = Object.keys(byDay).sort();
    const labels = sortedDays.map((d) => dayNames[new Date(d).getDay()]);
    const rawDates = sortedDays;
    const series = (k) => sortedDays.map((d) => { const vals = (byDay[d].readings || []).map((r) => num(r, k)).filter((v) => v != null); return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null; });
    return { labels, rawDates, getSeries: series, xTitle: "Day" };
  }
  if (hours === "720") {
    const byDay = {};
    arr.forEach((r) => {
      const d = new Date(r.at);
      const dayKey = d.toISOString().slice(0, 10);
      if (!byDay[dayKey]) byDay[dayKey] = [];
      byDay[dayKey].push(r);
    });
    const sortedDays = Object.keys(byDay).sort();
    const step = Math.max(1, Math.floor(sortedDays.length / 6));
    const indices = [0];
    for (let i = step; i < sortedDays.length; i += step) indices.push(i);
    if (indices[indices.length - 1] !== sortedDays.length - 1) indices.push(sortedDays.length - 1);
    const labels = indices.map((i) => "Day " + (i + 1));
    const rawDates = indices.map((i) => sortedDays[i] || null);
    const series = (k) => indices.map((i) => { const day = sortedDays[i]; const vals = (byDay[day] || []).map((r) => num(r, k)).filter((v) => v != null); return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null; });
    return { labels, rawDates, getSeries: series, xTitle: "Day" };
  }
  if (hours === "all") {
    const byMonth = {};
    arr.forEach((r) => {
      const d = new Date(r.at);
      const monthKey = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      if (!byMonth[monthKey]) byMonth[monthKey] = [];
      byMonth[monthKey].push(r);
    });
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const sortedMonths = Object.keys(byMonth).sort();
    const labels = sortedMonths.map((m) => { const [y, mo] = m.split("-"); return monthNames[parseInt(mo, 10) - 1]; });
    const rawDates = sortedMonths;
    const series = (k) => sortedMonths.map((m) => { const vals = (byMonth[m] || []).map((r) => num(r, k)).filter((v) => v != null); return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null; });
    return { labels, rawDates, getSeries: series, xTitle: "Month" };
  }
  const labels = arr.map((r) => new Date(r.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
  const rawDates = arr.map((r) => r.at);
  return { labels, rawDates, getSeries: (k) => arr.map((r) => num(r, k)), xTitle: "Time" };
}
function _analyticsYAxisOptions(key) {
  if (key === "temp") return { suggestedMin: 0, suggestedMax: 40, ticks: { stepSize: 10 } };
  if (key === "humidity" || key === "moisture") return { suggestedMin: 0, suggestedMax: 100, ticks: { stepSize: 20 } };
  if (key === "lux") return { suggestedMin: 0, suggestedMax: 2000, ticks: { stepSize: 500 } };
  return {};
}
async function loadAnalyticsDetail(plantId, plantName, hours) {
  const summaryEl = document.getElementById("analyticsSummary");
  const sectionsEl = document.getElementById("analyticsSensorSections");
  const timelineEl = document.getElementById("analyticsTimeline");
  if (!sectionsEl) return;
  try {
    const res = await fetch(`/api/plants/${encodeURIComponent(plantId)}/telemetry?hours=${hours === "all" ? "all" : hours}`);
    const readings = await res.json();
    if (!Array.isArray(readings)) return;
    const arr = readings.slice().sort((a, b) => new Date(a.at) - new Date(b.at));
    const tStat = _analyticsStat("temp", arr);
    const hStat = _analyticsStat("humidity", arr);
    const mStat = _analyticsStat("moisture", arr);
    const summaryLabels = _analyticsSummaryLabels(hours);
    const avgTempVal = tStat.avg != null ? tStat.avg.toFixed(1) : "—";
    const avgHumVal = hStat.avg != null ? hStat.avg.toFixed(0) : "—";
    const avgMoistVal = mStat.avg != null ? mStat.avg.toFixed(0) : "—";
    const readingsCount = arr.length;
    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="analytics-summary-item"><strong>${tStat.current != null ? tStat.current.toFixed(1) : "—"}°C</strong><span>Current temperature</span></div>
        <div class="analytics-summary-item"><strong>${avgTempVal}°C</strong><span>${escapeHtml(summaryLabels.avgTemp)}</span></div>
        <div class="analytics-summary-item"><strong>${avgHumVal}%</strong><span>${escapeHtml(summaryLabels.avgHum)}</span></div>
        <div class="analytics-summary-item"><strong>${avgMoistVal}%</strong><span>${escapeHtml(summaryLabels.avgMoist)}</span></div>
        <div class="analytics-summary-item"><strong>${readingsCount}</strong><span>${escapeHtml(summaryLabels.readings)}</span></div>
      `;
    }
    const agg = _analyticsAggregate(arr, hours);
    const optimal = _analyticsOptimalRanges();
    const chartConfigs = [
      { key: "temp", title: "Temperature sensor", yLabel: "Temperature (°C)", unit: "°C", color: "#7ef2bf", useArea: false },
      { key: "humidity", title: "Humidity sensor", yLabel: "Humidity (%)", unit: "%", color: "#6bc2ff", useArea: false },
      { key: "moisture", title: "Soil moisture sensor", yLabel: "Soil moisture (%)", unit: "%", color: "#65d9a5", useArea: true },
      { key: "lux", title: "Light sensor", yLabel: "Light intensity (lx)", unit: " lx", color: "#ffb86b", useArea: false },
    ];
    analyticsDetailCharts.forEach((c) => { if (c && c.destroy) c.destroy(); });
    analyticsDetailCharts = [];
    sectionsEl.innerHTML = chartConfigs.map((cfg, i) => {
      const s = _analyticsStat(cfg.key, arr);
      const fmt = (v) => v == null ? "—" : (cfg.key === "lux" ? Math.round(v).toString() : (cfg.key === "temp" ? v.toFixed(1) : v.toFixed(0)));
      const cur = fmt(s.current);
      const av = fmt(s.avg);
      const mn = fmt(s.min);
      const mx = fmt(s.max);
      const unit = cfg.unit;
      const opt = optimal[cfg.key];
      const optMin = opt?.min;
      const optMax = opt?.max;
      const yScaleCfg = _analyticsYAxisOptions(cfg.key);
      const scaleMin = typeof yScaleCfg.suggestedMin === "number" ? yScaleCfg.suggestedMin : 0;
      const scaleMax = typeof yScaleCfg.suggestedMax === "number" ? yScaleCfg.suggestedMax : (cfg.key === "lux" ? 2000 : 100);
      const range = Math.max(scaleMax - scaleMin, 1);
      const avgVal = s.avg != null ? s.avg : null;
      const pct = avgVal == null ? null : Math.max(0, Math.min(100, ((avgVal - scaleMin) / range) * 100));
      const optStart = optMin == null ? null : Math.max(0, Math.min(100, ((optMin - scaleMin) / range) * 100));
      const optEnd = optMax == null ? null : Math.max(0, Math.min(100, ((optMax - scaleMin) / range) * 100));
      return `
        <section class="analytics-sensor-section" data-sensor="${cfg.key}">
          <h3 class="analytics-sensor-title">${escapeHtml(cfg.title)}</h3>
          <div class="analytics-sensor-stats">
            <span><strong>Current</strong> ${cur}${unit}</span>
            <span><strong>Average</strong> ${av}${unit}</span>
            <span><strong>Min</strong> ${mn}${unit}</span>
            <span><strong>Max</strong> ${mx}${unit}</span>
          </div>
          <div class="analytics-health">
            <div class="analytics-health-label-row">
              <span class="analytics-health-label">Condition</span>
              <span class="analytics-health-range">
                Optimal: ${optMin != null ? optMin : "?"}${unit} – ${optMax != null ? optMax : "?"}${unit}
              </span>
            </div>
            <div class="analytics-health-bar">
              <div class="analytics-health-track"></div>
              ${optStart != null && optEnd != null ? `<div class="analytics-health-opt-range" style="left:${optStart}%;width:${Math.max(optEnd - optStart, 4)}%;"></div>` : ""}
              ${pct != null ? `<div class="analytics-health-indicator" style="left:${pct}%;"></div>` : ""}
            </div>
            <div class="analytics-health-scale">
              <span>Low</span><span>Optimal</span><span>High</span>
            </div>
            <div class="analytics-health-values">
              <span>Average (${escapeHtml(summaryLabels.avgTemp.includes("last 24") || summaryLabels.avgTemp.includes("week") || summaryLabels.avgTemp.includes("month") || summaryLabels.avgTemp.includes("all time") ? "selected range" : "range")}): ${av}${unit}</span>
            </div>
          </div>
          <div class="analytics-chart-wrap">
            <p class="analytics-chart-axes">X-axis: ${escapeHtml(agg.xTitle)} · Y-axis: ${escapeHtml(cfg.yLabel)}</p>
            <canvas id="analyticsChart${i}" role="img" aria-label="${escapeHtml(cfg.yLabel)} over time"></canvas>
          </div>
        </section>
      `;
    }).join("");
    if (typeof window.Chart !== "undefined") {
      const yOpts = _analyticsYAxisOptions;
      chartConfigs.forEach((cfg, i) => {
        const ctx = document.getElementById(`analyticsChart${i}`)?.getContext("2d");
        if (!ctx) return;
        const data = agg.getSeries(cfg.key);
        const timeLabels = agg.rawDates;
        const yScale = yOpts(cfg.key);
        const chart = new window.Chart(ctx, {
          type: "line",
          data: {
            labels: agg.labels,
            datasets: [{ label: cfg.yLabel, data, borderColor: cfg.color, backgroundColor: cfg.color + "44", tension: 0.35, fill: true, borderWidth: 2, pointRadius: 3, pointHoverRadius: 8 }],
          },
          options: {
            animation: { duration: 400 },
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: "index" },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  title: function (items) {
                    const idx = items[0]?.dataIndex;
                    if (idx == null || !timeLabels[idx]) return "";
                    const d = timeLabels[idx];
                    const date = d.length <= 10 ? new Date(d + "T12:00:00") : new Date(d);
                    return date.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: d.length > 10 ? "numeric" : undefined, hour: "numeric", minute: "2-digit" });
                  },
                  label: function (item) {
                    const v = item.raw;
                    return (cfg.yLabel.split(" ")[0] + ": " + (v != null ? v + cfg.unit.trim() : "—"));
                  },
                },
              },
            },
            scales: {
              x: {
                title: { display: true, text: agg.xTitle, color: "#8fa99f", font: { size: 11 } },
                ticks: { color: "#8fa99f", font: { size: 10 }, maxRotation: 45 },
                grid: { color: "rgba(126, 242, 191, 0.08)" },
              },
              y: {
                ...yScale,
                title: { display: true, text: cfg.yLabel, color: "#8fa99f", font: { size: 11 } },
                ticks: { color: "#8fa99f", font: { size: 10 } },
                grid: { color: "rgba(126, 242, 191, 0.08)" },
              },
            },
          },
        });
        analyticsDetailCharts.push(chart);
      });
    }
    if (timelineEl) {
      const recent = arr.slice(-15).reverse();
      timelineEl.innerHTML = recent.map((r) => {
        const t = new Date(r.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        const parts = [];
        if (r.temp != null) parts.push("Temp: " + r.temp + "°C");
        if (r.humidity != null) parts.push("Hum: " + r.humidity + "%");
        if (r.moisture != null) parts.push("Moist: " + r.moisture + "%");
        if (r.lux != null) parts.push("Light: " + r.lux + " lx");
        return "<li>" + t + " → " + parts.join(" · ") + "</li>";
      }).join("");
    }
  } catch (_) {
    if (summaryEl) summaryEl.innerHTML = "<p class=\"analytics-error\">No sensor data for this period.</p>";
    if (sectionsEl) sectionsEl.innerHTML = "";
    if (timelineEl) timelineEl.innerHTML = "";
  }
}
function initAnalyticsTimeTabs() {
  const tabs = document.getElementById("analyticsTimeTabs");
  const modal = document.getElementById("analyticsDetailModal");
  if (!tabs || !modal) return;
  tabs.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (!currentAnalyticsPlant || modal.style.display === "none") return;
      tabs.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const hours = tab.dataset.hours || "24";
      loadAnalyticsDetail(currentAnalyticsPlant.id, currentAnalyticsPlant.name, hours);
    });
  });
}
function initAnalytics() {
  const btn = document.getElementById("btnRefreshAnalytics");
  if (btn) btn.addEventListener("click", function () { this.classList.add("btn-refresh--spinning"); loadAnalyticsView(this); });
  initAnalyticsTimeTabs();
}

function escapeHtml(s) {
  if (s == null) return "";
  const div = document.createElement("div");
  div.textContent = String(s);
  return div.innerHTML;
}
async function updateAlertsBadge() {
  const badge = document.getElementById("navAlertsCount");
  if (!badge) return;
  try {
    const uid = window.__dewUid || (typeof getLocationUid === "function" ? getLocationUid() : null);
    const [sensorRes, weatherRes] = await Promise.all([
      fetch("/api/alerts/count"),
      uid ? fetch("/api/users/" + encodeURIComponent(uid) + "/alerts/count") : Promise.resolve(null),
    ]);
    const sensorData = await sensorRes.json().catch(() => ({}));
    let weatherUnread = 0;
    if (weatherRes && weatherRes.ok) {
      const w = await weatherRes.json().catch(() => ({}));
      weatherUnread = w.unread != null ? w.unread : 0;
    }
    const total = (sensorData.unread != null ? sensorData.unread : 0) + weatherUnread;
    badge.textContent = total > 0 ? total : "";
  } catch (_) {
    badge.textContent = "";
  }
}
window.updateAlertsBadge = updateAlertsBadge;

/** Fetch and display profile stats (plants, followers, following). Used for DEW Community. */
async function refreshProfileStats(uid) {
  const plantsEl = document.getElementById("profilePlantsCount");
  const followersEl = document.getElementById("profileFollowersCount");
  const followingEl = document.getElementById("profileFollowingCount");
  if (!plantsEl && !followersEl && !followingEl) return;
  try {
    const res = await fetch(`/api/users/${encodeURIComponent(uid)}/stats`);
    if (!res.ok) return;
    const stats = await res.json();
    if (plantsEl) plantsEl.textContent = stats.plantsCount ?? 0;
    if (followersEl) followersEl.textContent = stats.followersCount ?? 0;
    if (followingEl) followingEl.textContent = stats.followingCount ?? 0;
  } catch (_) {}
}

function initProfileForm(user) {
  const btnEdit = document.getElementById("btnEditProfile");
  const btnCancel = document.getElementById("btnCancelEdit");
  const form = document.getElementById("profileForm");
  const nameInput = document.getElementById("profileDisplayNameInput");
  const actions = document.getElementById("profileActions");
  const btnEditPhoto = document.getElementById("btnEditPhoto");
  const photoInput = document.getElementById("photoInput");

  function setEditMode(editing) {
    nameInput.disabled = !editing;
    actions.style.display = editing ? "flex" : "none";
    btnEdit.style.display = editing ? "none" : "inline-flex";
  }

  const btnEditHeader = document.getElementById("btnEditProfileHeader");
  btnEdit?.addEventListener("click", () => setEditMode(true));
  btnEditHeader?.addEventListener("click", () => setEditMode(true));
  btnCancel?.addEventListener("click", () => {
    setEditMode(false);
    nameInput.value = user.displayName || "Warden";
  });

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const newName = nameInput.value.trim();
    if (!newName) return;
    try {
      const auth = await authReady;
      await updateProfile(user, { displayName: newName });
      user.displayName = newName;
      renderProfile(user);
      setEditMode(false);
    } catch (err) {
      alert(err.message || "Failed to update profile.");
    }
  });

  initFavouritePlants(user);

  btnEditPhoto?.addEventListener("click", () => photoInput?.click());
  photoInput?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    const btn = btnEditPhoto;
    const originalHtml = btn?.innerHTML;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="ri-loader-4-line" style="animation:spin 0.8s linear infinite"></i>';
    }
    try {
      const supabase = await getSupabaseClient();

      const resizedBlob = await resizeImage(file, 400);
      const path = `${user.uid}/avatar.jpg`;
      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(path, resizedBlob, { contentType: "image/jpeg", upsert: true });
      if (uploadError) throw new Error(uploadError.message);

      const { data: urlData } = supabase.storage.from("avatars").getPublicUrl(path);
      const photoURL = urlData.publicUrl;

      const auth = await authReady;
      await updateProfile(user, { photoURL });
      user.photoURL = photoURL;
      renderProfile(user);
    } catch (err) {
      alert(err.message || "Failed to upload photo. Check Supabase setup (bucket 'avatars', policies).");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalHtml || '<i class="ri-camera-line"></i>';
      }
      photoInput.value = "";
    }
  });
}

/** Load and render favourite plants; wire add/remove. Based on /api/plants and /api/users/:uid/favourites. */
async function initFavouritePlants(user) {
  const listEl = document.getElementById("profileFavouritesList");
  const selectEl = document.getElementById("favouritePlantSelect");
  const btnAdd = document.getElementById("btnAddFavourite");
  if (!listEl || !selectEl) return;

  let plants = [];
  let favouriteIds = [];

  async function loadPlants() {
    const res = await fetch("/api/plants/catalog");
    if (res.ok) plants = await res.json();
  }

  async function loadFavourites() {
    const res = await fetch(`/api/users/${encodeURIComponent(user.uid)}/favourites`);
    if (res.ok) favouriteIds = await res.json();
  }

  function plantImageUrl(p) {
    if (!p || !p.image) return null;
    return "/images/plants/" + encodeURIComponent(p.image);
  }

  function renderFavourites() {
    const favPlants = favouriteIds
      .map((id) => plants.find((p) => p.id === id))
      .filter(Boolean);
    listEl.innerHTML = favPlants.length
      ? favPlants
          .map(
            (p) => {
              const imgSrc = plantImageUrl(p);
              const imgHtml = imgSrc
                ? `<img class="profile-favourite-plant-photo" src="${imgSrc}" alt="${escapeHtml(p.name || p.id)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling&&(this.nextElementSibling.style.display='flex');" /><span class="profile-favourite-plant-initial" style="display:none;">${escapeHtml((p.name || p.id)[0])}</span>`
                : `<span class="profile-favourite-plant-initial">${escapeHtml((p.name || p.id)[0])}</span>`;
              return `<li data-plant-id="${p.id}">
                <div class="profile-favourite-plant-info">
                  <div class="profile-favourite-plant-thumb">${imgHtml}</div>
                  <span><span class="plant-name">${escapeHtml(p.name || p.id)}</span> <span class="plant-species">${escapeHtml(p.species || "")}</span></span>
                </div>
                <button type="button" class="btn-remove-favourite" data-plant-id="${p.id}" title="Remove">${"\u2715"}</button>
              </li>`;
            }
          )
          .join("")
      : '<li class="empty-msg">No favourite indoor plants yet. Add some from the list above.</li>';
    listEl.querySelectorAll(".btn-remove-favourite").forEach((btn) => {
      btn.addEventListener("click", () => removeFavourite(btn.dataset.plantId));
    });
  }

  function fillSelect() {
    const indoorOnly = plants.filter((p) => p.indoor === true);
    const notFav = indoorOnly.filter((p) => !favouriteIds.includes(p.id));
    selectEl.innerHTML =
      '<option value="">Add an indoor plant…</option>' +
      notFav.map((p) => `<option value="${p.id}">${escapeHtml(p.name || p.id)}</option>`).join("");
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  async function saveFavouritesAndRefreshStats() {
    const res = await fetch(`/api/users/${encodeURIComponent(user.uid)}/favourites`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plantIds: favouriteIds }),
    });
    if (!res.ok) return;
    favouriteIds = await res.json();
    renderFavourites();
    fillSelect();
    refreshProfileStats(user.uid);
    // Keep Plants view "My favourites" strip in sync with profile changes.
    try {
      loadPlantsFavouritesStrip();
    } catch (_) {
      // ignore if plants view is not mounted
    }
  }

  function addFavourite(plantId) {
    if (!plantId) return false;
    if (favouriteIds.includes(plantId)) return false;
    favouriteIds = [...favouriteIds, plantId];
    selectEl.value = "";
    saveFavouritesAndRefreshStats();
    return true;
  }

  // Allow plant detail page to add favourites.
  addFavouriteFromDetail = addFavourite;

  function removeFavourite(plantId) {
    favouriteIds = favouriteIds.filter((id) => id !== plantId);
    saveFavouritesAndRefreshStats();
  }

  btnAdd?.addEventListener("click", () => addFavourite(selectEl.value));
  selectEl.addEventListener("change", () => {
    if (selectEl.value) addFavourite(selectEl.value);
  });

  await loadPlants();
  await loadFavourites();
  renderFavourites();
  fillSelect();
}

async function resizeImage(file, maxSize = 400) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      let w = img.width, h = img.height;
      if (w > maxSize || h > maxSize) {
        if (w > h) {
          h = (h / w) * maxSize;
          w = maxSize;
        } else {
          w = (w / h) * maxSize;
          h = maxSize;
        }
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(img.src);
          resolve(blob || new Blob());
        },
        mime,
        0.85
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error("Could not load image"));
    };
    img.src = URL.createObjectURL(file);
  });
}

authReady.then((auth) => {
  initNav();
  const initialSlug = parseCommunitySlugFromPath();
  // Always land on dashboard after refresh, even if user refreshed /community.
  // (Direct community links will still work when navigating normally.)
  if (isReloadNavigation() && window.location.pathname.startsWith("/community")) {
    try {
      history.replaceState({ view: "dashboard" }, "", "/");
    } catch (_) {}
    showView("dashboard");
  } else if (window.location.pathname.startsWith("/community") && initialSlug) {
    communitySelectedSlug = initialSlug;
    communityCategoryFilter = initialSlug;
    showView("community");
  } else if (window.location.pathname === "/community") {
    // Non-reload direct visit to /community
    showView("community");
  } else {
    showView("dashboard");
  }

  onAuthStateChanged(auth, (user) => {
    if (user) {
      currentProfileUser = user;
      upsertUserDirectoryEntry(user);
      renderProfile(user);
      initProfileForm(user);
      refreshProfileStats(user.uid);
    } else {
      currentProfileUser = null;
    }
  });
});
