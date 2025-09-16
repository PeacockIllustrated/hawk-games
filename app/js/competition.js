// /app/js/competition.js
// Full file — integrated with Trust Payments (HPP) + site credit, defensive against null data.
// Uses Firebase v9 modular CDN (9.23.0). Depends on /app/js/auth.js and /app/js/payments.js.

// --- Firebase Imports ---
import { getAuth } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  // (Keep these around for future features; do NOT call collection() with a plain object)
  collection,
  query,
  where,
  getDocs,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

// --- App glue ---
import { app, requireVerifiedEmail } from "./auth.js";
import { payByCard, payByCredit } from "./payments.js";
import { renderGalleryForCompetition } from "./gallery.js";
import { computeState, resolveCloseMode, startCountdown, formatLeft } from "/app/js/lib/comp-state.js";

// --- Firebase instances ---
const auth = getAuth(app);
const db = getFirestore(app);

// --- Module state ---
let currentCompetitionData = null;
let competitionId = null;

// --- PRIZE ANGLE CONFIGURATION (Instant Win wheel) ---
const PRIZE_ANGLES = {
  "cash-1000": 150,
  "cash-500": 210,
  "cash-250": 300,
  "cash-100": 0,
  "cash-50": 60,
  "credit-20": 30,
  "credit-10": 270,
  "credit-5": 120,
  "no-win": [90, 180, 240, 330],
};

// -------------------- Small utilities --------------------
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const toNumber = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function safeGet(obj, path, fallback = undefined) {
  try {
    return path.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), obj) ?? fallback;
  } catch {
    return fallback;
  }
}

function isTimestampLike(x) {
  return x && typeof x.toDate === "function";
}

function toDateUTC(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  if (isTimestampLike(val)) return val.toDate();
  // Allow ISO strings or millis
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d;
}

// --- SECURITY: Safe element creation helper ---
function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(options).forEach(([key, value]) => {
    if (key === "class") {
      const classes = Array.isArray(value) ? value : String(value).split(" ");
      classes.forEach((c) => c && node.classList.add(c));
    } else if (key === "textContent") {
      node.textContent = value;
    } else if (key === "style" && value && typeof value === "object") {
      Object.assign(node.style, value);
    } else {
      node.setAttribute(key, value);
    }
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => c && node.append(c));
  return node;
}

function mountPlaceholder(target, text = "Loading…") {
  target.innerHTML = "";
  target.append(
    el("main", {}, [el("div", { class: "container" }, [el("div", { class: "hawk-card placeholder", textContent: text })])])
  );
}

function showError(target, text) {
  target.innerHTML = "";
  target.append(
    el("main", {}, [
      el("div", { class: "container" }, [
        el("div", {
          class: "hawk-card placeholder",
          style: { borderColor: "red" },
          textContent: text,
        }),
      ]),
    ])
  );
}

// --- Price helpers ---
function pricePerTicket(data) {
  // Prefer tiers if present; fallback to ticketPricePence/pricePence; else £1.00
  const tiers = Array.isArray(data?.ticketTiers) ? data.ticketTiers : [];
  if (tiers.length > 0 && tiers[0]?.price && tiers[0]?.amount) {
    const unit = Number(tiers[0].price) / Number(tiers[0].amount);
    if (Number.isFinite(unit) && unit > 0) return unit;
  }
  if (typeof data?.ticketPricePence === "number") return data.ticketPricePence / 100;
  if (typeof data?.pricePence === "number") return data.pricePence / 100;
  return 1.0;
}

// -------------------- DOMContentLoaded bootstrap --------------------
document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  // Be liberal in what we accept for the competition id
  competitionId =
    params.get("id") ||
    params.get("cid") ||
    params.get("rid") ||
    params.get("compId") ||
    params.get("competitionId") ||
    document.querySelector("[data-comp-id]")?.getAttribute("data-comp-id") ||
    null;

  const pageContent = document.getElementById("competition-page-content");
  if (!pageContent) {
    console.warn("[competition.js] Missing #competition-page-content container.");
    return;
  }

  if (competitionId) {
    loadCompetitionDetails(competitionId);
  } else {
    showError(pageContent, "Error: No competition specified.");
  }
});

// -------------------- Main data loader --------------------
async function loadCompetitionDetails(id) {
  const pageContent = document.getElementById("competition-page-content");
  if (!pageContent) return;

  mountPlaceholder(pageContent, "Loading competition…");

  try {
    const compRef = doc(db, "competitions", id);
    const compSnap = await getDoc(compRef);

    if (!compSnap.exists()) {
      showError(pageContent, "Error: Competition not found.");
      return;
    }

    currentCompetitionData = compSnap.data() || {};
    document.title = `${currentCompetitionData.title || "Competition"} | The Hawk Games`;

    // Assemble page
    pageContent.innerHTML = "";
    pageContent.append(...createHeroPageElements(currentCompetitionData));

    // Render gallery if applicable
    const mount = document.getElementById("compGallery");
    if (mount) {
      await renderGalleryForCompetition(currentCompetitionData, mount);
    }

    // Behaviours
    hydrateCloseUi(currentCompetitionData);

    // Countdown
    if (resolveCloseMode(currentCompetitionData) === 'date') {
        const endDateRaw =
        currentCompetitionData.endDate ??
        currentCompetitionData.endsAt ??
        currentCompetitionData.closesAt;
        const endDate = toDateUTC(endDateRaw);
        if (endDate) setupCountdown(endDate);
    }

    // Skill Q: handle both shapes {text, answers, correctAnswer} and {questionText, answers, correctAnswer}
    const correctAnswer =
      safeGet(currentCompetitionData, "skillQuestion.correctAnswer") ??
      safeGet(currentCompetitionData, "skillQuestion.answer") ??
      null;
    setupEntryLogic(correctAnswer);
  } catch (error) {
    console.error("Error fetching competition details:", error);
    showError(pageContent, "Could not load competition details.");
  }
}

// -------------------- Entry logic --------------------
function setupEntryLogic(correctAnswer) {
  const entryButton = document.getElementById("enterBtn");
  if (!entryButton) return;

  let isAnswerCorrect = false;

  // Multi-choice answers (if present)
  const answersWrap = document.querySelector(".answer-options");
  if (answersWrap) {
    answersWrap.addEventListener("click", (e) => {
      const button = e.target.closest(".answer-btn");
      if (!button) return;
      document.querySelectorAll(".answer-options .answer-btn").forEach((btn) => btn.classList.remove("selected"));
      button.classList.add("selected");
      // The dataset uses the key string (e.g., "A" / "B" / "C")
      isAnswerCorrect = button.dataset.answer === String(correctAnswer || "");
      // NOTE: We still validate correctness when the user clicks "Enter Now".
    });
  }

  // Slider live price preview
  const slider = document.getElementById("ticket-slider");
  if (slider) {
    const ticketCountDisplay = document.getElementById("ticket-count-display");
    const priceDisplay = document.getElementById("ticket-price-display-value");
    const unit = pricePerTicket(currentCompetitionData);

    const sync = () => {
      const qty = clamp(parseInt(slider.value, 10) || 1, 1, toNumber(slider.max, 100));
      if (ticketCountDisplay) ticketCountDisplay.textContent = String(qty);
      if (priceDisplay) priceDisplay.textContent = `£${(qty * unit).toFixed(2)}`;
    };
    slider.addEventListener("input", sync);
    // Initial render
    sync();

    // Entry button can be enabled (terms & correctness are re-validated at click time)
    entryButton.disabled = false;
  }

  // Click → show confirmation modal, re-validate auth and correctness
  entryButton.addEventListener("click", async () => {
    const isVerified = await requireVerifiedEmail();
    if (!isVerified) {
        return; // Gate is shown by requireVerifiedEmail function
    }

    if (!isAnswerCorrect) {
      openModal(
        el("div", {}, [
          el("h2", { textContent: "Incorrect Answer" }),
          el("p", { textContent: "You must select the correct answer to enter." }),
          el("button", { "data-close-modal": true, class: "btn" }, ["Try Again"]),
        ])
      );
      return;
    }

    showConfirmationModal();
  });
}

// -------------------- Confirmation modal --------------------
function showConfirmationModal() {
  const slider = document.getElementById("ticket-slider");
  if (!slider) {
    openModal(
      el("div", {}, [
        el("h2", { textContent: "Error" }),
        el("p", { textContent: "Could not find ticket slider." }),
        el("button", { "data-close-modal": true, class: "btn" }, ["OK"]),
      ])
    );
    return;
  }

  const tickets = clamp(parseInt(slider.value, 10) || 1, 1, 999);
  const unit = pricePerTicket(currentCompetitionData);
  const price = tickets * unit;

  const payByCardBtn = el("button", { id: "pay-card-btn", class: "btn", disabled: true }, ["Pay by Card"]);
  const payByCreditBtn = el("button", { id: "pay-credit-btn", class: ["btn", "btn-secondary"], disabled: true }, [
    "Pay with Credit",
  ]);

  const termsCheckbox = el("input", {
    type: "checkbox",
    id: "modal-terms-checkbox",
    style: {
      marginRight: "0.75rem",
      accentColor: "var(--primary-gold)",
      width: "18px",
      height: "18px",
      marginTop: "2px",
      flexShrink: "0",
    },
  });

  const termsLabel = el(
    "label",
    {
      for: "modal-terms-checkbox",
      style: {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        marginBottom: "1.5rem",
        fontSize: "0.9rem",
        color: "#ccc",
        maxWidth: "380px",
        margin: "1rem auto 0 auto",
        textAlign: "left",
        lineHeight: "1.5",
        cursor: "pointer",
      },
    },
    [
      termsCheckbox,
      el("span", {}, [
        "I confirm I am 18+ and have read the ",
        el(
          "a",
          { href: "terms-and-conditions.html", target: "blank", style: { color: "var(--primary-gold)" } },
          ["Terms & Conditions."]
        ),
      ]),
    ]
  );

  const content = el("div", {}, [
    el("h2", { textContent: "Confirm Your Entry" }),
    el("p", {}, [
      `You are about to purchase `,
      el("strong", { textContent: `${tickets}` }),
      ` entr${tickets === 1 ? "y" : "ies"} for `,
      el("strong", { textContent: `£${price.toFixed(2)}` }),
      `.`,
    ]),
    termsLabel,
    el(
      "div",
      { class: "modal-actions", style: { marginTop: "1.5rem", display: "flex", gap: "1rem", justifyContent: "center" } },
      [el("button", { "data-close-modal": true, class: ["btn", "btn-secondary"] }, ["Cancel"]), payByCardBtn, payByCreditBtn]
    ),
  ]);

  openModal(content);

  const modalCheckbox = document.getElementById("modal-terms-checkbox");
  modalCheckbox.addEventListener("change", () => {
    payByCardBtn.disabled = !modalCheckbox.checked;
    payByCreditBtn.disabled = !modalCheckbox.checked;
  });

  payByCardBtn.addEventListener("click", async () => {
    await handleEntryCard(tickets);
  });

  payByCreditBtn.addEventListener("click", async () => {
    await handleEntryCredit(tickets);
  });
}

// -------------------- Entry handlers --------------------
async function handleEntryCard(ticketsBought) {
  openModal(
    el("div", {}, [
      el("h2", { textContent: "Redirecting to Secure Payment…" }),
      el("div", { class: "loader" }),
      el("p", { textContent: "Please wait, do not close this window." }),
    ])
  );

  try {
    await payByCard({ compId: competitionId, qty: ticketsBought }); // navigates to Trust HPP
  } catch (error) {
    console.error("Card checkout failed:", error);
    openModal(
      el("div", {}, [
        el("h2", { textContent: "Error" }),
        el("p", { textContent: error?.message || "Could not start card payment." }),
        el("button", { "data-close-modal": true, class: "btn" }, ["Close"]),
      ])
    );
  }
}

async function handleEntryCredit(ticketsBought) {
  openModal(
    el("div", {}, [
      el("h2", { textContent: "Processing Credit Payment…" }),
      el("div", { class: "loader" }),
      el("p", { textContent: "Please wait, do not close this window." }),
    ])
  );

  try {
    const data = await payByCredit({ compId: competitionId, ticketsBought });
    if (data?.awardedTokens && data.awardedTokens.length > 0) {
      showInstantWinModal(data.awardedTokens.length);
    } else {
      const successMessage = `Your tickets #${data.ticketStart} to #${data.ticketStart + data.ticketsBought - 1} have been successfully registered. Good luck!`;
      const doneBtn = el("button", { "data-close-modal": true, class: "btn", style: { marginTop: "1rem" } }, ["Done"]);
      doneBtn.onclick = () => window.location.reload();
      openModal(
        el("div", { class: "celebration-modal" }, [
          el("div", { class: "modal-icon-success", textContent: "✓" }),
          el("h2", { textContent: "Entry Successful!" }),
          el("p", { textContent: successMessage }),
          doneBtn,
        ])
      );
    }
  } catch (error) {
    console.error("Credit checkout failed:", error);
    openModal(
      el("div", {}, [
        el("h2", { textContent: "Error" }),
        el("p", { textContent: error?.message || "Could not complete credit payment." }),
        el("button", { "data-close-modal": true, class: "btn" }, ["Close"]),
      ])
    );
  }
}

// -------------------- Modal helpers --------------------
function openModal(contentElement) {
  const modal = document.getElementById("modal-container");
  const modalContent = document.getElementById("modal-content");
  if (!modal || !modalContent) return;
  modalContent.innerHTML = "";
  modalContent.append(contentElement);
  modal.classList.add("show");
}

function closeModal() {
  const modal = document.querySelector(".modal-container.show");
  if (modal) modal.classList.remove("show");
}

document.addEventListener("click", (e) => {
  if (e.target.matches("[data-close-modal]")) {
    closeModal();
  }
});

// -------------------- Countdown --------------------
function setupCountdown(endDate) {
  const timerElement = document.getElementById("timer");
  if (!timerElement) return;

  const interval = setInterval(() => {
    const distance = endDate.getTime() - Date.now();
    timerElement.innerHTML = "";

    if (distance < 0) {
      clearInterval(interval);
      timerElement.textContent = "COMPETITION CLOSED";
      document
        .querySelectorAll("#enterBtn, .answer-btn, .ticket-option")
        .forEach((el) => (el.disabled = true));
      return;
    }

    const d = String(Math.floor(distance / (1000 * 60 * 60 * 24)));
    const h = String(Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))).padStart(2, "0");
    const m = String(Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60))).padStart(2, "0");
    const s = String(Math.floor((distance % (1000 * 60)) / 1000)).padStart(2, "0");

    if (timerElement.classList.contains("hero-digital-timer")) {
      timerElement.textContent = `${d}:${h}:${m}:${s}`;
    } else {
      timerElement.append(
        d,
        el("small", { textContent: "d" }),
        ` : ${h}`,
        el("small", { textContent: "h" }),
        ` : ${m}`,
        el("small", { textContent: "m" }),
        ` : ${s}`,
        el("small", { textContent: "s" })
      );
    }
  }, 1000);
}

// -------------------- Page builder --------------------
function createHeroPageElements(data) {
  const isTrueHero = Boolean(data?.isHeroComp && data?.hasParallax);

  // --- 1. Header ---
  const header = isTrueHero
    ? el("header", {
        class: "hero-comp-header",
        style: { backgroundImage: data?.imageSet?.background ? `url('${data.imageSet.background}')` : "" },
      })
    : el("header"); // Empty header keeps structure for non-hero comps

  // --- 2. Main Content ---
  const mainContentSections = [];

  // --- 2a. Prize Visuals (for non-hero) ---
  const prizeVisualsPanel = !isTrueHero ? createPrizeVisuals(data) : null;

  // --- 2b. Intro Details (shared logic) ---
  const introDetails = createIntroDetails(data, isTrueHero);

  // --- 2c. Main Layout Section ---
  const introSectionClass = isTrueHero ? "hero-comp-title-section" : "main-comp-layout";
  const introSectionChildren = isTrueHero ? introDetails : [prizeVisualsPanel, introDetails];
  mainContentSections.push(el("section", { class: introSectionClass }, introSectionChildren));

  // --- 2d. Entry Flow (shared) ---
  mainContentSections.push(createEntryFlow(data));

  // --- 2e. Confirm Button (shared) ---
  mainContentSections.push(
    el("section", { class: "hero-comp-confirm-section" }, [
      el("button", { id: "enterBtn", class: ["btn", "hero-cta-btn"], disabled: true }, [
        "Enter Now",
        el("span", { textContent: "Secure Your Chance" }),
      ]),
    ])
  );

  // --- 2f. At a Glance (hero-only) ---
  if (isTrueHero) {
    mainContentSections.push(createGlanceSection(data));
  }

  // --- 2g. Trust Badges (shared) ---
  mainContentSections.push(createTrustBadges());

  // --- 3. Final Assembly ---
  const main = el("main", { class: "hero-comp-main" }, [el("div", { class: "container" }, mainContentSections)]);
  return [header, main];
}

function createPrizeVisuals(data) {
  const prizeImage = data?.prizeImage || data?.imageSet?.foreground || "";
  const photoView = el("div", { class: "view-panel photo-view active" }, [
    el("img", { src: prizeImage, alt: data?.title || "Competition", style: { width: "100%" } }),
  ]);
  const threeDView = el("div", { class: "view-panel spline-view" });
  const viewsContainer = el("div", { class: "views-container" }, [photoView, threeDView]);

  const photosButton = el("button", { class: ["btn", "btn-small", "active"], textContent: "Photos" });
  const threeDButton = el("button", { class: ["btn", "btn-small"], textContent: "3D View", style: { display: "none" } });
  const viewToggle = el("div", { class: "view-toggle-buttons" }, [photosButton, threeDButton]);

  if (data?.splineUrl) {
    threeDButton.style.display = "inline-block";
    const splineViewer = el("spline-viewer", { url: data.splineUrl, "loading-anim": "true" });
    threeDView.append(splineViewer);

    photosButton.addEventListener("click", () => {
      photosButton.classList.add("active");
      threeDButton.classList.remove("active");
      photoView.classList.add("active");
      threeDView.classList.remove("active");
    });

    threeDButton.addEventListener("click", () => {
      threeDButton.classList.add("active");
      photosButton.classList.remove("active");
      threeDView.classList.add("active");
      photoView.classList.remove("active");
    });
  }

  return el("div", { class: "prize-visuals-panel" }, [viewToggle, viewsContainer]);
}

function createIntroDetails(data, isTrueHero) {
  const total = toNumber(data?.totalTickets, 0);
  const sold = toNumber(data?.ticketsSold, 0);
  const progressPercent = total > 0 ? clamp(Math.round((sold / total) * 100), 0, 100) : 0;

  const title = el("h1", { textContent: `Win a ${data?.title || "Top Prize"}` });
  const cashAltVal = toNumber(data?.cashAlternative, 0);
  const cashAlternative = el("p", { class: "cash-alternative-hero" }, [
    "Or take ",
    el("span", { textContent: `£${cashAltVal.toLocaleString()}` }),
    " Cash Alternative",
  ]);
  const timeRemaining = el("div", { class: "time-remaining" }, [
      el("span", { id: "compEndChip", class: "badge" })
  ]);

  const timer = el("div", { id: "timer", class: "hero-digital-timer" });
  const progressLabel = el("label", { textContent: `Tickets Sold: ${sold} / ${total}` });
  const progressBar = el("div", { class: "progress-bar" }, [
    el("div", { class: "progress-bar-fill", style: { width: `${progressPercent}%` } }),
  ]);
  const progressSection = el("div", { class: "hero-comp-progress-section" }, [progressLabel, progressBar]);

  if (isTrueHero) {
    return [title, cashAlternative, timeRemaining, timer, progressSection];
  } else {
    const container = el("div", { class: "intro-details-panel" });
    container.append(title, cashAlternative, timeRemaining, timer, progressSection);
    return container;
  }
}

function createEntryFlow(data) {
  // Skill Question (support both shapes)
  const qText = safeGet(data, "skillQuestion.text") ?? safeGet(data, "skillQuestion.questionText") ?? "Answer the skill question:";
  const answersObj = safeGet(data, "skillQuestion.answers") ?? {};
  const answers = Object.entries(answersObj).map(([key, value]) =>
    el("div", { class: "answer-btn", "data-answer": key, textContent: String(value ?? key) })
  );
  const questionStep = el("div", { class: "entry-step question-step" }, [
    el("h2", { textContent: "1. Answer The Question" }),
    el("p", { class: "question-text", textContent: qText }),
    el("div", { class: "answer-options" }, answers),
  ]);

  // Ticket Slider
  const total = toNumber(data?.totalTickets, 0);
  const sold = toNumber(data?.ticketsSold, 0);
  const ticketsRemaining = Math.max(0, total - sold);
  const userLimit = toNumber(data?.userEntryLimit, 75);
  const maxTickets = clamp(ticketsRemaining, 0, userLimit);
  const basePricePerTicket = pricePerTicket(data);

  const sliderContainer = el("div", { class: "ticket-slider-container" });
  if (maxTickets > 0) {
    const sliderLabel = el("div", { class: "ticket-slider-label" }, [
      el("span", { textContent: "Number of entries:" }),
      el("span", { id: "ticket-count-display", textContent: "1" }),
    ]);
    const slider = el("input", {
      type: "range",
      id: "ticket-slider",
      min: "1",
      max: String(maxTickets),
      value: "1",
      class: "ticket-slider",
    });
    const priceDisplay = el("div", { class: "ticket-price-display" }, [
      el("span", { textContent: "Total Price: " }),
      el("span", { id: "ticket-price-display-value", textContent: `£${basePricePerTicket.toFixed(2)}` }),
    ]);
    sliderContainer.append(sliderLabel, slider, priceDisplay);
  } else {
    sliderContainer.append(el("p", { textContent: "No tickets available." }));
  }

  const ticketsStep = el("div", { class: "entry-step tickets-step" }, [el("h2", { textContent: "2. Choose Your Tickets" }), sliderContainer]);
  return el("section", { class: "hero-comp-entry-flow" }, [questionStep, ticketsStep]);
}

function createGlanceSection(data) {
  // This section is now hardcoded for the Mercedes-Benz E220d AMG Line hero competition.
  // The `el` helper is used for safe DOM element creation.
  return el(
    "section",
    {
      id: "prize-at-a-glance",
      class: "glance",
      "aria-label": "Prize at a glance",
    },
    [
      el("h2", { class: "glance__title", textContent: "3. PRIZE AT A GLANCE" }),
      el("div", { class: "glance__inner" }, [
        // Left: visual
        el("div", { class: "glance__visual" }, [
          el("img", {
            class: "glance__img",
            src: "/app/assets/merc-e220d-hero.jpg",
            alt: "Mercedes-Benz E220d AMG",
            loading: "lazy",
          }),
          el("div", { class: "glance__badges" }, [
            el("span", { class: "glance-badge", textContent: "AMG Line" }),
            el("span", { class: "glance-badge", textContent: "9G-TRONIC" }),
            el("span", { class: "glance-badge", textContent: "LED Headlights" }),
          ]),
        ]),
        // Right: spec panel
        el("div", { class: "glance__specs" }, [
          el("div", { class: "spec-grid" }, [
            el("div", { class: "spec" }, [
              el("span", { class: "spec__label", textContent: "Model" }),
              el("b", { class: "spec__value", textContent: "Mercedes-Benz E220d AMG Line" }),
            ]),
            el("div", { class: "spec" }, [
              el("span", { class: "spec__label", textContent: "Engine" }),
              el("b", { class: "spec__value", textContent: "2.0-litre OM654 turbo-diesel" }),
            ]),
            el("div", { class: "spec" }, [
              el("span", { class: "spec__label", textContent: "Power" }),
              el("b", { class: "spec__value", textContent: "~191 bhp (194 PS)" }),
            ]),
            el("div", { class: "spec" }, [
              el("span", { class: "spec__label", textContent: "Torque" }),
              el("b", { class: "spec__value", textContent: "~400 Nm (295 lb-ft)" }),
            ]),
            el("div", { class: "spec" }, [
              el("span", { class: "spec__label", textContent: "0–62 mph" }),
              el("b", { class: "spec__value", textContent: "~7.3–7.5 s" }),
            ]),
            el("div", { class: "spec" }, [
              el("span", { class: "spec__label", textContent: "Top speed" }),
              el("b", { class: "spec__value", textContent: "~149 mph" }),
            ]),
            el("div", { class: "spec" }, [
              el("span", { class: "spec__label", textContent: "Transmission" }),
              el("b", { class: "spec__value", textContent: "9G-TRONIC automatic" }),
            ]),
            el("div", { class: "spec" }, [
              el("span", { class: "spec__label", textContent: "Drive" }),
              el("b", { class: "spec__value", textContent: "Rear-wheel drive (4MATIC optional)" }),
            ]),
            el("div", { class: "spec" }, [
              el("span", { class: "spec__label", textContent: "Fuel economy" }),
              el("b", { class: "spec__value", textContent: "up to ~60 mpg (WLTP)" }),
            ]),
          ]),
          el("ul", { class: "feature-list" }, [
            el("li", { textContent: "AMG Line exterior & interior styling" }),
            el("li", { textContent: "MBUX infotainment with Apple CarPlay / Android Auto" }),
            el("li", { textContent: 'Digital cockpit (12.3" display cluster)' }),
            el("li", { textContent: "LED High Performance headlamps" }),
            el("li", { textContent: "Parking sensors & reversing camera" }),
            el("li", { textContent: "Heated front seats; Artico/leather-look upholstery" }),
            el("li", { textContent: "AMG alloy wheels & sport suspension" }),
          ]),
          el("p", {
            class: "glance__note",
            textContent: "Figures are indicative and vary by model year, options and exact vehicle supplied.",
          }),
        ]),
      ]),
    ]
  );
}

function createTrustBadges() {
  const badges = [
    { icon: "🛡️", text: "100% Secure Payments" },
    { icon: "⚖️", text: "Licensed & Fully Compliant" },
    { icon: "🏆", text: "Real Winners Every Week" },
  ];
  const badgeElements = badges.map((badge) =>
    el("div", { class: "trust-badge" }, [el("span", { class: "trust-icon", textContent: badge.icon }), el("h3", { textContent: badge.text })])
  );
  return el("section", { class: "hero-comp-trust-section" }, badgeElements);
}

// -------------------- Instant Win (Spin) --------------------
function hydrateCloseUi(comp){
  const state = computeState(comp);
  const mode = resolveCloseMode(comp);
  const chip = document.querySelector("#compEndChip");
  const cta  = document.querySelector("#enterBtn");

  if (chip){
    if (mode === "sellout"){
      const left = formatLeft(comp);
      chip.textContent = (state === "sold_out") ? "Sold out" : `Ends when sold out · ${left} left`;
      chip.className = "badge " + (state === "sold_out" ? "bad" : "pending");
    } else {
      chip.className = "badge pending";
      startCountdown(comp.closeAt, chip, "Ends in ");
    }
  }

  if (cta){
    if (state === "live"){ cta.disabled = false; cta.textContent = "Enter now"; }
    else if (state === "sold_out"){ cta.disabled = true; cta.textContent = "Sold out"; }
    else { cta.disabled = true; cta.textContent = "Closed"; }
  }
}
function showInstantWinModal(tokenCount) {
  const modal = document.getElementById("instant-win-modal");
  if (!modal) return;

  const titleEl = document.getElementById("spin-modal-title");
  if (titleEl) titleEl.textContent = `You've Unlocked ${tokenCount} Instant Win Spin${tokenCount > 1 ? "s" : ""}!`;

  const spinButton = document.getElementById("spin-button");
  const spinResultContainer = document.getElementById("spin-result");
  const wheel = document.getElementById("wheel");

  spinButton.disabled = false;
  spinButton.textContent = "SPIN THE WHEEL";
  spinButton.onclick = handleSpinButtonClick;
  spinResultContainer.innerHTML = "";
  wheel.style.transition = "none";
  wheel.style.transform = "rotate(0deg)";

  modal.classList.add("show");

  if (!modal.dataset.initialized) {
    setupSpinWheel();
    modal.dataset.initialized = "true";
  }
}

function setupSpinWheel() {
  const wheel = document.getElementById("wheel");
  const segmentCount = 12;
  wheel.innerHTML = "";
  for (let i = 0; i < segmentCount; i++) {
    const segment = document.createElement("div");
    segment.className = "wheel-segment";
    wheel.appendChild(segment);
  }
}

async function handleSpinButtonClick() {
  const spinButton = document.getElementById("spin-button");
  const spinResultContainer = document.getElementById("spin-result");
  const wheel = document.getElementById("wheel");

  const user = auth.currentUser;
  if (!user) {
    spinResultContainer.innerHTML = `<p class="spin-error">Please log in to play.</p>`;
    return;
  }

  const userDocRef = doc(db, "users", user.uid);
  const userDocSnap = await getDoc(userDocRef);
  const userTokens = (userDocSnap.exists() ? userDocSnap.data().spinTokens || [] : []) || [];

  if (userTokens.length === 0 || spinButton.disabled) return;

  spinButton.disabled = true;
  spinButton.textContent = "SPINNING...";
  spinResultContainer.innerHTML = "";

  wheel.style.transition = "none";
  wheel.style.transform = "rotate(0deg)";
  void wheel.offsetWidth;

  // Oldest token first (Timestamp-compatible)
  const sorted = userTokens
    .map((t) => ({
      ...t,
      _ts:
        (t?.earnedAt?.seconds ? t.earnedAt.seconds * 1000 : null) ??
        (t?.earnedAt ? new Date(t.earnedAt).getTime() : Date.now()),
    }))
    .sort((a, b) => (a._ts || 0) - (b._ts || 0));
  const tokenToSpend = sorted[0];

  try {
    // Spend token via CF
    const fnMod = await import("https://www.gstatic.com/firebasejs/9.23.0/firebase-functions.js");
    const functions = fnMod.getFunctions(app, "us-central1");
    const spendTokenFunc = fnMod.httpsCallable(functions, "spendSpinToken");

    const result = await spendTokenFunc({ tokenId: tokenToSpend.tokenId });
    const { won, prizeType, value } = result.data || {};

    let targetAngle;
    if (won) {
      const prizeKey = `${prizeType}-${value}`;
      targetAngle = PRIZE_ANGLES[prizeKey];
    }

    if (targetAngle === undefined) {
      const noWinAngles = PRIZE_ANGLES["no-win"];
      targetAngle = noWinAngles[Math.floor(Math.random() * noWinAngles.length)];
    }

    const baseSpins = 360 * 8;
    const randomOffsetInSegment = (Math.random() - 0.5) * 20;
    const finalAngle = baseSpins + (360 - targetAngle) + randomOffsetInSegment;

    wheel.style.transition = "transform 8s cubic-bezier(0.25, 0.1, 0.25, 1)";
    wheel.style.transform = `rotate(${finalAngle}deg)`;

    setTimeout(() => {
      if (won) {
        const prizeValue = typeof value === "number" ? value.toFixed(2) : "0.00";
        const prizeText = prizeType === "credit" ? `£${prizeValue} SITE CREDIT` : `£${prizeValue} CASH`;
        spinResultContainer.innerHTML = `<p class="spin-win">🎉 YOU WON ${prizeText}! 🎉</p>`;
      } else {
        spinResultContainer.innerHTML = `<p>Better luck next time!</p>`;
      }

      spinButton.textContent = "GO TO INSTANT GAMES";
      spinButton.onclick = () => (window.location.href = "instant-games.html");
      spinButton.disabled = false;

      const closeBtn = document.createElement("button");
      closeBtn.className = "btn btn-secondary";
      closeBtn.textContent = "Close";
      closeBtn.style.marginTop = "1rem";
      closeBtn.onclick = () => {
        document.getElementById("instant-win-modal").classList.remove("show");
        window.location.reload();
      };
      spinResultContainer.appendChild(closeBtn);
    }, 8500);
  } catch (error) {
    console.error("Error spending token:", error);
    spinResultContainer.innerHTML = `<p class="spin-error">Error: ${error?.message || "Unknown error"}</p>`;
    spinButton.disabled = false;
    spinButton.textContent = "SPIN THE WHEEL";
  }
}
