// Profile section: view, edit, and save user profile (Supabase Storage for photos)
import { authReady } from "./firebase-config.js";
import { onAuthStateChanged, updateProfile } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  if (plantDetailView) plantDetailView.style.display = v === "plant" ? "block" : "none";
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
      const baseUrl = "/images/plants/";
      grid.innerHTML = list
        .map((p) => {
          const imgSrc = p.image ? baseUrl + encodeURIComponent(p.image) : "";
          const name = escapeHtml(p.name || p.id);
          const species = escapeHtml(p.species || "");
          return `<article class="plant-card" data-plant-id="${escapeHtml(p.id)}">
            <div class="plant-card-img-wrap">
              <img src="${imgSrc}" alt="${name}" class="plant-card-img" loading="lazy" onerror="this.style.display='none';this.nextElementSibling&&(this.nextElementSibling.classList.add('visible'));" />
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
      const baseUrl = "/images/plants/";
      grid.innerHTML = list
        .map((p) => {
          const imgSrc = p.image ? baseUrl + encodeURIComponent(p.image) : "";
          const name = escapeHtml(p.name || p.id);
          const species = escapeHtml(p.species || "");
          return `<article class="plant-card" data-plant-id="${escapeHtml(p.id)}">
            <div class="plant-card-img-wrap">
              <img src="${imgSrc}" alt="${name}" class="plant-card-img" loading="lazy" onerror="this.style.display='none';this.nextElementSibling&&(this.nextElementSibling.classList.add('visible'));" />
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
          const baseUrl = "/images/plants/";
          grid.innerHTML = list
            .map((p) => {
              const imgSrc = p.image ? baseUrl + encodeURIComponent(p.image) : "";
              const name = escapeHtml(p.name || p.id);
              const species = escapeHtml(p.species || "");
              return `<article class="plant-card" data-plant-id="${escapeHtml(p.id)}">
                <div class="plant-card-img-wrap">
                  <button type="button" class="plant-card-fav-remove" data-remove-id="${escapeHtml(
                    p.id
                  )}" aria-label="Remove from favourites"><i class="ri-close-line"></i></button>
                  <img src="${imgSrc}" alt="${name}" class="plant-card-img" loading="lazy" onerror="this.style.display='none';this.nextElementSibling&&(this.nextElementSibling.classList.add('visible'));" />
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
      const imgSrc = p?.image ? `/images/plants/${encodeURIComponent(p.image)}` : "";

      if (nameEl) nameEl.textContent = name;
      if (speciesEl) speciesEl.textContent = species;
      if (summaryEl) summaryEl.textContent = summary;
      if (crumbs) crumbs.textContent = name;
      if (imgEl) {
        imgEl.src = imgSrc;
        imgEl.alt = name;
      }
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

  const communityForm = document.getElementById("communityCreateForm");
  if (communityForm) communityForm.addEventListener("submit", handleCommunityPostSubmit);

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
    const block = document.getElementById("communityCreateBlock");
    if (block) block.style.display = block.style.display === "none" ? "block" : "none";
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
}

let communityCategoryFilter = "all";
let communitySortFilter = "new";
let communitySearchQuery = "";
let communityRecentPosts = [];
let communityList = [];
let communitySelectedSlug = null;
let communityJoinedSlugs = new Set();
let communityMutedSlugs = new Set();
let createCommunityWizard = { step: 1, topic: "Indoor Plants", type: "public", mature: false };

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
  const m = window.location.pathname.match(/^\/community\/r\/([a-z0-9-]+)$/i);
  return m ? m[1].toLowerCase() : null;
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
    const supabase = await getSupabaseClient();
    const { data: communities, error } = await supabase
      .from("communities")
      .select("id,name,slug,description,member_count,post_count,category,banner_url,logo_url,status,creator_firebase_uid")
      .eq("status", "public")
      .order("post_count", { ascending: false })
      .limit(20);
    if (error) throw error;
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
      return `<li data-community-id="${escapeHtml(c.id)}" data-community-slug="${escapeHtml(slug)}"><span>r/${escapeHtml(slug)}</span><span class="pill">${c.post_count ?? 0} posts</span></li>`;
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
  const yourCommunities = communityList.filter((c) => communityJoinedSlugs.has((c.slug || c.id || "").toLowerCase()));
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
  if (!detailCard || !infoCard) return;
  if (!communitySelectedSlug) {
    detailCard.style.display = "none";
    infoCard.style.display = "none";
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
  const titleEl = document.getElementById("communityDetailTitle");
  const descEl = document.getElementById("communityDetailDesc");
  const logoEl = document.getElementById("communityDetailLogo");
  const metaEl = document.getElementById("communityDetailMeta");
  const bannerEl = document.getElementById("communityDetailBanner");
  const joinBtn = document.getElementById("communityJoinBtn");
  const muteBtn = document.getElementById("communityMuteBtn");
  const notifyBtn = document.getElementById("communityNotifyBtn");
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
    } else {
      logoEl.style.backgroundImage = "";
      logoEl.textContent = (comm.slug || slug || "r").slice(0, 1).toLowerCase();
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
    } else {
      bannerEl.style.backgroundImage = "";
      bannerEl.style.background = "linear-gradient(90deg, rgba(67, 199, 122, 0.9), rgba(51, 186, 179, 0.9))";
    }
  }
  if (metaEl) {
    metaEl.innerHTML = `<span>${comm.member_count ?? 0} members</span><span>${comm.post_count ?? 0} posts</span><span>${escapeHtml(comm.category || "Other")}</span>`;
  }
  if (joinBtn) {
    const joined = communityJoinedSlugs.has(slug);
    joinBtn.textContent = joined ? "Joined" : "Join";
    joinBtn.classList.toggle("btn-primary", !joined);
    joinBtn.classList.toggle("btn-ghost", joined);
    joinBtn.onclick = () => {
      if (communityJoinedSlugs.has(slug)) communityJoinedSlugs.delete(slug);
      else communityJoinedSlugs.add(slug);
      saveCommunityPrefs();
      renderCommunityPanels(allPosts);
      loadCommunitiesSidebar();
    };
  }
  if (muteBtn) {
    const muted = communityMutedSlugs.has(slug);
    muteBtn.classList.toggle("btn-danger", muted);
    muteBtn.title = muted ? "Unmute community" : "Mute community";
    muteBtn.onclick = () => {
      if (communityMutedSlugs.has(slug)) communityMutedSlugs.delete(slug);
      else communityMutedSlugs.add(slug);
      saveCommunityPrefs();
      renderCommunityPanels(allPosts);
    };
  }
  if (notifyBtn) notifyBtn.title = "Notifications";
  const editBtn = document.getElementById("communityEditBtn");
  const bannerEditBtn = document.getElementById("communityBannerEditBtn");
  const creatorUid = String(comm.creator_firebase_uid || "").trim();
  // Legacy rows may not have creator_firebase_uid yet; allow signed-in user
  // to open edit once and claim ownership server-side.
  const isCreator = !!(currentProfileUser?.uid && (!creatorUid || currentProfileUser.uid === creatorUid));
  if (editBtn) {
    editBtn.style.display = isCreator ? "inline-flex" : "none";
    editBtn.onclick = () => openEditCommunityModal(slug, comm);
  }
  if (bannerEditBtn) {
    bannerEditBtn.style.display = isCreator ? "inline-flex" : "none";
    bannerEditBtn.onclick = () => openEditCommunityModal(slug, comm);
  }
  if (quickCreateBtn) quickCreateBtn.onclick = () => {
    const block = document.getElementById("communityCreateBlock");
    if (block) block.style.display = "block";
    const sel = document.getElementById("communityCategory");
    if (sel && [...sel.options].some((o) => o.value === slug)) sel.value = slug;
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
    infoGrid.innerHTML = `
      <div class="row"><span>Created</span><strong>${escapeHtml(created)}</strong></div>
      <div class="row"><span>Status</span><strong>${escapeHtml(comm.status || "public")}</strong></div>
      <div class="row"><span>Members</span><strong>${comm.member_count ?? 0}</strong></div>
      <div class="row"><span>Posts</span><strong>${comm.post_count ?? 0}</strong></div>
      <div class="row"><span>Category</span><strong>${escapeHtml(comm.category || "Other")}</strong></div>
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
    modsEl.innerHTML = `<li>${creatorLabel} — Admin</li>`;
  }
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
    const { data: postsData, error: postsError } = await supabase
      .from("posts")
      .select("id,title,body,created_at,author_username,community_id,image_url,tags,score,comment_count")
      .limit(100);
    if (!postsError && Array.isArray(postsData) && postsData.length > 0) {
      posts = postsData.map((p) => ({
        ...p,
        category: communityList.find((c) => c.id === p.community_id)?.slug || p.community_id,
        plant_image_url: p.image_url,
      }));
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
    renderCommunityPanels(posts);
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
        return `<article class="community-post" data-post-id="${escapeHtml(p.id)}">
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
            ${p.plant_image_url || p.image_url ? `<div class="community-post-image"><img src="${escapeHtml(p.plant_image_url || p.image_url)}" alt="" loading="lazy" /></div>` : ""}
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
    });
  } catch {
    if (feed) feed.innerHTML = "<p class=\"plants-list-empty\">Unable to load community posts. Check Supabase config and tables (posts).</p>";
    if (empty) empty.style.display = "block";
  }
}

async function voteOnPost(postId, delta, card) {
  if (!postId) return;
  try {
    const supabase = await getSupabaseClient();
    await supabase.rpc("dew_vote_post", { post_id: postId, delta });
    const scoreEl = card.querySelector(".community-vote-score");
    if (scoreEl) {
      const current = Number(scoreEl.textContent) || 0;
      scoreEl.textContent = current + delta;
    }
  } catch {
    // ignore errors; server-side vote will decide
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
  if (!title || !body) return;
  const category = (catEl && catEl.value) ? catEl.value : "";
  if (!category) {
    showToast("Create a community first, then choose it when posting.", "error");
    return;
  }
  const tags =
    tagsEl && tagsEl.value
      ? tagsEl.value.split(",").map((t) => t.trim()).filter(Boolean)
      : [];
  const file = imgInput && imgInput.files && imgInput.files[0] ? imgInput.files[0] : null;

  try {
    const supabase = await getSupabaseClient();
    let imageUrl = null;
    if (file) {
      const path = `${category}/posts/${Date.now()}_${file.name}`;
      const { error: uploadError } = await supabase.storage
        .from("community-posts")
        .upload(path, file, { upsert: true });
      if (uploadError) throw uploadError;
      const { data } = supabase.storage.from("community-posts").getPublicUrl(path);
      imageUrl = data.publicUrl;
    }
    const comm = communityList.find((c) => (c.slug || "").toLowerCase() === category.toLowerCase());
    const communityId = comm?.id;
    if (!communityId) {
      showToast("Community not found. Pick a community from the list.", "error");
      return;
    }
    const author = currentProfileUser?.displayName || "Warden";
    const { error } = await supabase.from("posts").insert({
      community_id: communityId,
      title,
      body,
      author_username: author,
      image_url: imageUrl,
      tags: tags.length ? tags : [],
    });
    if (error) throw error;
    titleEl.value = "";
    bodyEl.value = "";
    if (tagsEl) tagsEl.value = "";
    if (imgInput) imgInput.value = "";
    loadCommunityView();
  } catch (err) {
    console.error("Failed to create post", err);
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
    const res = await fetch("/api/users/" + encodeURIComponent(uid) + "/location");
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
      const res = await fetch("/api/users/" + encodeURIComponent(uid) + "/location", {
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
  if (initialSlug) {
    communitySelectedSlug = initialSlug;
    communityCategoryFilter = initialSlug;
    showView("community");
  } else if (window.location.pathname === "/community") {
    showView("community");
  } else {
    // New visit to root should open dashboard; reload restores last in-app view.
    showView(isReloadNavigation() ? (getLastView() || "dashboard") : "dashboard");
  }

  onAuthStateChanged(auth, (user) => {
    if (user) {
      currentProfileUser = user;
      renderProfile(user);
      initProfileForm(user);
      refreshProfileStats(user.uid);
    } else {
      currentProfileUser = null;
    }
  });
});
