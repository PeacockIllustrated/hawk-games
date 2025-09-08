// app/js/competition.js
// Updated for Trust Payments integration with card (HPP) + site credit checkout.
// Full drop-in replacement, no brevity.

// --- Firebase Imports ---
import { getAuth } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/9.15.0/firebase-firestore.js";
import { app } from './auth.js';
import { payByCard, payByCredit } from './payments.js';

// --- Singletons ---
const db = getFirestore(app);
const auth = getAuth(app);

// --- Module State ---
let currentCompetitionData = null;
let competitionId = null;
let userMaxTickets = null;

// --- PRIZE ANGLE CONFIGURATION ---
const PRIZE_ANGLES = {
  'cash-1000': 150,
  'cash-500': 210,
  'cash-250': 300,
  'cash-100': 0,
  'cash-50': 60,
  'credit-20': 30,
  'credit-10': 270,
  'credit-5': 120,
  'no-win': [90, 180, 240, 330]
};

// --- SECURITY: Safe element creation helper ---
function createElement(tag, options = {}, children = []) {
  const el = document.createElement(tag);
  Object.entries(options).forEach(([key, value]) => {
    if (key === 'class') {
      const classes = Array.isArray(value) ? value : String(value).split(' ');
      classes.forEach(c => { if (c) el.classList.add(c); });
    } else if (key === 'textContent') {
      el.textContent = value;
    } else if (key === 'style') {
      Object.assign(el.style, value);
    } else {
      el.setAttribute(key, value);
    }
  });
  children.forEach(child => child && el.append(child));
  return el;
}

async function getUserMaxTickets(user, compId, defaultMax) {
    if (!user) {
        return defaultMax;
    }

    const userDocRef = doc(db, 'users', user.uid);
    try {
        const userDocSnap = await getDoc(userDocRef);
        if (userDocSnap.exists()) {
            const userData = userDocSnap.data();
            const entries = userData.entries || {};
            const userTicketsForComp = entries[compId] || 0;
            return Math.max(0, defaultMax - userTicketsForComp);
        } else {
            // User document doesn't exist, so they have 0 tickets for this comp
            return defaultMax;
        }
    } catch (error) {
        console.error("Error fetching user ticket data:", error);
        // On error, return the default max to not block the user
        return defaultMax;
    }
}

// --- DOMContentLoaded ---
document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  competitionId = params.get('id');
  const pageContent = document.getElementById('competition-page-content');

  if (competitionId) {
    loadCompetitionDetails(competitionId);
  } else {
    pageContent.innerHTML = '';
    pageContent.append(
      createElement('main', {}, [
        createElement('div', { class: 'container' }, [
          createElement('div', { class: 'hawk-card placeholder', textContent: 'Error: No competition specified.' })
        ])
      ])
    );
  }
});

async function loadCompetitionDetails(id) {
  const pageContent = document.getElementById('competition-page-content');
  const competitionRef = doc(db, 'competitions', id);

  try {
    const docSnap = await getDoc(competitionRef);
    if (docSnap.exists()) {
      currentCompetitionData = docSnap.data();
      document.title = `${currentCompetitionData.title} | The Hawk Games`;

      userMaxTickets = await getUserMaxTickets(auth.currentUser, id, currentCompetitionData.maxTicketsPerUser);

      pageContent.innerHTML = '';
      pageContent.append(...createHeroPageElements(currentCompetitionData, userMaxTickets));

      if (currentCompetitionData.hasParallax) {
        initializeParallax();
      }

      if (currentCompetitionData.endDate) {
        setupCountdown(currentCompetitionData.endDate.toDate());
      }

      setupEntryLogic(currentCompetitionData.skillQuestion.correctAnswer);
    } else {
      pageContent.innerHTML = '';
      pageContent.append(
        createElement('main', {}, [
          createElement('div', { class: 'container' }, [
            createElement('div', { class: 'hawk-card placeholder', textContent: 'Error: Competition not found.' })
          ])
        ])
      );
    }
  } catch (error) {
    console.error("Error fetching competition details:", error);
    pageContent.innerHTML = '';
    pageContent.append(
      createElement('main', {}, [
        createElement('div', { class: 'container' }, [
          createElement('div', { class: 'hawk-card placeholder', style: { color: 'red' }, textContent: 'Could not load competition details.' })
        ])
      ])
    );
  }
}

function setupEntryLogic(correctAnswer) {
  const entryButton = document.getElementById('entry-button');
  let isAnswerCorrect = false;

  const answersWrap = document.querySelector('.answer-options');
  if (answersWrap) {
    answersWrap.addEventListener('click', (e) => {
      const button = e.target.closest('.answer-btn');
      if (!button) return;
      document.querySelectorAll('.answer-options .answer-btn').forEach(btn => btn.classList.remove('selected'));
      button.classList.add('selected');
      isAnswerCorrect = button.dataset.answer === correctAnswer;
    });
  }


  if (entryButton) {
    entryButton.addEventListener('click', () => {
      if (!auth.currentUser) {
        openModal(createElement('div', {}, [
          createElement('h2', { textContent: 'Login Required' }),
          createElement('p', { textContent: 'Please log in or register to enter.' }),
          createElement('a', { href: 'login.html', class: 'btn' }, ['Login'])
        ]));
        return;
      }
      if (!isAnswerCorrect) {
        openModal(createElement('div', {}, [
          createElement('h2', { textContent: 'Incorrect Answer' }),
          createElement('p', { textContent: 'You must select the correct answer to enter.' }),
          createElement('button', { 'data-close-modal': true, class: 'btn' }, ['Try Again'])
        ]));
        return;
      }
      showConfirmationModal();
    });
  }
}

function showConfirmationModal() {
  const slider = document.getElementById('ticket-slider');
  if (!slider) {
    openModal(createElement('div', {}, [
      createElement('h2', { textContent: 'Error' }),
      createElement('p', { textContent: 'Could not find ticket selector.' }),
      createElement('button', { 'data-close-modal': true, class: 'btn' }, ['OK'])
    ]));
    return;
  }

  const tickets = parseInt(slider.value, 10);
  const price = getTieredPrice(currentCompetitionData.ticketTiers, tickets);

  const payByCardBtn = createElement('button', { id: 'pay-card-btn', class: 'btn', disabled: true }, ['Pay by Card']);
  const payByCreditBtn = createElement('button', { id: 'pay-credit-btn', class: ['btn', 'btn-secondary'], disabled: true }, ['Pay with Credit']);

  const termsCheckbox = createElement('input', {
    type: 'checkbox',
    id: 'modal-terms-checkbox',
    style: {
      marginRight: '0.75rem',
      accentColor: 'var(--primary-gold)',
      width: '18px',
      height: '18px',
      marginTop: '2px',
      flexShrink: '0'
    }
  });

  const termsLabel = createElement('label', {
    for: 'modal-terms-checkbox',
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
      marginBottom: '1.5rem',
      fontSize: '0.9rem',
      color: '#ccc',
      maxWidth: '380px',
      margin: '1rem auto 0 auto',
      textAlign: 'left',
      lineHeight: '1.5',
      cursor: 'pointer'
    }
  }, [
    termsCheckbox,
    createElement('span', {}, [
      'I confirm I am 18+ and have read the ',
      createElement('a', { href: 'terms-and-conditions.html', target: 'blank', style: { color: 'var(--primary-gold)' } }, ['Terms & Conditions.'])
    ])
  ]);

  const content = createElement('div', {}, [
    createElement('h2', { textContent: 'Confirm Your Entry' }),
    createElement('p', {}, [
      `You are about to purchase `,
      createElement('strong', { textContent: `${tickets}` }),
      ` entries for `,
      createElement('strong', { textContent: `£${price.toFixed(2)}` }),
      `.`
    ]),
    termsLabel,
    createElement('div', { class: 'modal-actions', style: { marginTop: '1.5rem', display: 'flex', gap: '1rem', justifyContent: 'center' } }, [
      createElement('button', { 'data-close-modal': true, class: ['btn', 'btn-secondary'] }, ['Cancel']),
      payByCardBtn,
      payByCreditBtn
    ])
  ]);

  openModal(content);

  const modalCheckbox = document.getElementById('modal-terms-checkbox');
  modalCheckbox.addEventListener('change', () => {
    payByCardBtn.disabled = !modalCheckbox.checked;
    payByCreditBtn.disabled = !modalCheckbox.checked;
  });

  payByCardBtn.addEventListener('click', async () => {
    await handleEntryCard(tickets);
  });

  payByCreditBtn.addEventListener('click', async () => {
    await handleEntryCredit(tickets);
  });
}

// --- Entry Handlers ---
async function handleEntryCard(ticketsBought) {
  openModal(createElement('div', {}, [
    createElement('h2', { textContent: 'Redirecting to Secure Payment…' }),
    createElement('div', { class: 'loader' }),
    createElement('p', { textContent: 'Please wait, do not close this window.' })
  ]));

  try {
    const intent = {
      type: 'tickets',
      compId: competitionId,
      ticketsBought
    };
    await payByCard(intent); // navigates to Trust HPP
  } catch (error) {
    console.error("Card checkout failed:", error);
    openModal(createElement('div', {}, [
      createElement('h2', { textContent: 'Error' }),
      createElement('p', { textContent: error.message || 'Could not start card payment.' }),
      createElement('button', { 'data-close-modal': true, class: 'btn' }, ['Close'])
    ]));
  }
}

async function handleEntryCredit(ticketsBought) {
  openModal(createElement('div', {}, [
    createElement('h2', { textContent: 'Processing Credit Payment…' }),
    createElement('div', { class: 'loader' }),
    createElement('p', { textContent: 'Please wait, do not close this window.' })
  ]));

  try {
    const data = await payByCredit({ compId: competitionId, ticketsBought });
    if (data.awardedTokens && data.awardedTokens.length > 0) {
      showInstantWinModal(data.awardedTokens.length);
    } else {
      const successMessage = `Your tickets #${data.ticketStart} to #${data.ticketStart + data.ticketsBought - 1} have been successfully registered. Good luck!`;
      const doneBtn = createElement('button', { 'data-close-modal': true, class: 'btn', style: { marginTop: '1rem' } }, ['Done']);
      doneBtn.onclick = () => window.location.reload();
      openModal(createElement('div', { class: 'celebration-modal' }, [
        createElement('div', { class: 'modal-icon-success', textContent: '✓' }),
        createElement('h2', { textContent: 'Entry Successful!' }),
        createElement('p', { textContent: successMessage }),
        doneBtn
      ]));
    }
  } catch (error) {
    console.error("Credit checkout failed:", error);
    openModal(createElement('div', {}, [
      createElement('h2', { textContent: 'Error' }),
      createElement('p', { textContent: error.message || 'Could not complete credit payment.' }),
      createElement('button', { 'data-close-modal': true, class: 'btn' }, ['Close'])
    ]));
  }
}

// --- Modal helpers ---
function openModal(contentElement) {
  const modal = document.getElementById('modal-container');
  const modalContent = document.getElementById('modal-content');
  if (!modal || !modalContent) return;
  modalContent.innerHTML = '';
  modalContent.append(contentElement);
  modal.classList.add('show');
}

function closeModal() {
  const modal = document.querySelector('.modal-container.show');
  if (modal) modal.classList.remove('show');
}

document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close-modal]')) {
    closeModal();
  }
});

// --- Countdown ---
function setupCountdown(endDate) {
  const timerElement = document.getElementById('timer');
  if (!timerElement) return;

  const interval = setInterval(() => {
    const distance = endDate.getTime() - new Date().getTime();
    timerElement.innerHTML = '';

    if (distance < 0) {
      clearInterval(interval);
      timerElement.textContent = "COMPETITION CLOSED";
      document.querySelectorAll('#entry-button, .answer-btn, .ticket-option').forEach(el => el.disabled = true);
      return;
    }

    const d = String(Math.floor(distance / (1000 * 60 * 60 * 24)));
    const h = String(Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))).padStart(2, '0');
    const m = String(Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60))).padStart(2, '0');
    const s = String(Math.floor((distance % (1000 * 60)) / 1000)).padStart(2, '0');

    if (timerElement.classList.contains('hero-digital-timer')) {
      timerElement.textContent = `${d}:${h}:${m}:${s}`;
    } else {
      timerElement.append(
        d, createElement('small', { textContent: 'd' }), ` : ${h}`,
        createElement('small', { textContent: 'h' }), ` : ${m}`,
        createElement('small', { textContent: 'm' }), ` : ${s}`,
        createElement('small', { textContent: 's' })
      );
    }
  }, 1000);
}

// --- Parallax ---
function initializeParallax() {
  const bg = document.querySelector('.hero-comp-header-bg');
  const fg = document.querySelector('.hero-comp-header-fg');
  if (!bg || !fg) return;
  window.addEventListener('scroll', () => {
    const scrollValue = window.scrollY;
    bg.style.transform = `translateY(${scrollValue * 0.1}px)`;
    fg.style.transform = `translateY(-${scrollValue * 0.15}px)`;
  });
}

function getTieredPrice(tiers, quantity) {
    // Ensure tiers are sorted by amount, ascending
    const sortedTiers = [...tiers].sort((a, b) => a.amount - b.amount);

    let bestTier = sortedTiers[0]; // Default to the smallest tier

    // Find the best applicable tier for the quantity
    for (const tier of sortedTiers) {
        if (quantity >= tier.amount) {
            bestTier = tier;
        } else {
            // Since tiers are sorted, we can break early
            break;
        }
    }

    // The price of a single ticket is found in the first tier
    const singleTicketPrice = sortedTiers[0].price / sortedTiers[0].amount;

    // Calculate the price
    if (bestTier) {
        const numBundles = Math.floor(quantity / bestTier.amount);
        const remainder = quantity % bestTier.amount;
        return (numBundles * bestTier.price) + (remainder * singleTicketPrice);
    }

    // Fallback for safety, though the logic above should always find a tier
    return quantity * singleTicketPrice;
}

// --- Page builder ---
function createTicketSlider(tiers, maxTickets) {
    const container = createElement('div', { class: 'ticket-slider-container' });

    if (maxTickets === 0) {
        container.append(createElement('p', { class: 'tickets-sold-out-text', textContent: 'You have reached the maximum number of entries for this competition.' }));
        return container;
    }

    const slider = createElement('input', { type: 'range', id: 'ticket-slider', min: 1, max: maxTickets, value: 1 });
    const display = createElement('div', { class: 'ticket-slider-display' });

    const updateDisplay = () => {
        const quantity = slider.value;
        const price = getTieredPrice(tiers, quantity);
        display.innerHTML = `
            <span class="ticket-amount">${quantity}</span>
            <span class="ticket-label">Entr${quantity > 1 ? 'ies' : 'y'}</span>
            <span class="ticket-price">£${price.toFixed(2)}</span>
        `;
        // Enable entry button once slider is moved
        const entryButton = document.getElementById('entry-button');
        if(entryButton) entryButton.disabled = false;
    };

    slider.addEventListener('input', updateDisplay);

    container.append(slider, display);

    // Initial display update
    setTimeout(updateDisplay, 0);

    return container;
}

function createHeroPageElements(data, userMaxTickets) {
  const answers = Object.entries(data.skillQuestion.answers).map(([key, value]) =>
    createElement('div', { class: 'answer-btn', 'data-answer': key, textContent: value })
  );

  const progressPercent = (data.ticketsSold / data.totalTickets) * 100;

  let bestValueAmount = -1;
  if (data.ticketTiers && data.ticketTiers.length > 1) {
    const bestTier = data.ticketTiers.reduce((best, current) =>
      (current.price / current.amount < best.price / best.amount) ? current : best
    );
    bestValueAmount = bestTier.amount;
  }

  const ticketSlider = createTicketSlider(data.ticketTiers, userMaxTickets);

  const isTrueHero = data.isHeroComp && data.hasParallax;
  let header;
  const mainContentSections = [];

  if (isTrueHero) {
    header = createElement('header', { class: 'hero-comp-header' }, [
      createElement('div', { class: 'hero-comp-header-bg', style: { backgroundImage: `url('${data.imageSet.background}')` } }),
      createElement('img', { class: 'hero-comp-header-fg', src: data.imageSet.foreground, alt: data.title })
    ]);

    mainContentSections.push(
      createElement('section', { class: 'hero-comp-title-section' }, [
        createElement('h1', { textContent: `Win a ${data.title}` }),
        createElement('p', { class: 'cash-alternative-hero' }, [
          'Or take ', createElement('span', { textContent: `£${(data.cashAlternative || 0).toLocaleString()}` }), ' Cash Alternative'
        ]),
        createElement('div', { class: 'time-remaining', textContent: 'TIME REMAINING' }),
        createElement('div', { id: 'timer', class: 'hero-digital-timer' })
      ]),
      createElement('section', { class: 'hero-comp-progress-section' }, [
        createElement('label', { textContent: `Tickets Sold: ${data.ticketsSold || 0} / ${data.totalTickets}` }),
        createElement('div', { class: 'progress-bar' }, [createElement('div', { class: 'progress-bar-fill', style: { width: `${progressPercent}%` } })])
      ])
    );
  } else {
    header = createElement('header'); // Empty header, does not take up space

    const introDetails = createElement('div', { style: { flex: '1 1 50%', display: 'flex', flexDirection: 'column' } }, [
      createElement('h1', { textContent: `Win a ${data.title}` }),
      createElement('p', { class: 'cash-alternative-hero' }, [
        'Or take ', createElement('span', { textContent: `£${(data.cashAlternative || 0).toLocaleString()}` }), ' Cash Alternative'
      ]),
      createElement('div', { class: 'time-remaining', textContent: 'TIME REMAINING', style: { marginTop: 'auto' } }),
      createElement('div', { id: 'timer', class: 'hero-digital-timer' }),
      createElement('div', { class: 'hero-comp-progress-section', style: { marginTop: '1rem' } }, [
        createElement('label', { textContent: `Tickets Sold: ${data.ticketsSold || 0} / ${data.totalTickets}` }),
        createElement('div', { class: 'progress-bar' }, [createElement('div', { class: 'progress-bar-fill', style: { width: `${progressPercent}%` } })])
      ])
    ]);

    // Prize visuals
    const photoView = createElement('div', { class: 'view-panel photo-view active' }, [
      createElement('img', { src: data.prizeImage, alt: data.title, style: { width: '100%', borderRadius: '5px' } })
    ]);
    const threeDView = createElement('div', { class: 'view-panel spline-view' });

    const viewsContainer = createElement('div', { class: 'views-container' }, [photoView, threeDView]);

    const photosButton = createElement('button', { class: ['btn', 'btn-small', 'active'], textContent: 'Photos' });
    const threeDButton = createElement('button', { class: ['btn', 'btn-small'], textContent: '3D View', style: { display: 'none' } });

    const viewToggle = createElement('div', { class: 'view-toggle-buttons' }, [photosButton, threeDButton]);

    const prizeVisualsPanel = createElement('div', { style: { flex: '1 1 50%' } }, [
      viewToggle,
      viewsContainer
    ]);

    // 3D toggle logic
    if (data.splineUrl) {
      threeDButton.style.display = 'inline-block';

      const splineViewer = createElement('spline-viewer', {
        url: data.splineUrl,
        'loading-anim': 'true'
      });
      threeDView.append(splineViewer);

      photosButton.addEventListener('click', () => {
        photosButton.classList.add('active');
        threeDButton.classList.remove('active');
        photoView.classList.add('active');
        threeDView.classList.remove('active');
      });

      threeDButton.addEventListener('click', () => {
        threeDButton.classList.add('active');
        photosButton.classList.remove('active');
        threeDView.classList.add('active');
        photoView.classList.remove('active');
      });
    }

    const introSection = createElement('section', {
      class: 'main-comp-layout', // Class added for mobile stacking
      style: { display: 'flex', gap: '2rem', paddingTop: '120px' }
    }, [
      prizeVisualsPanel,
      introDetails
    ]);

    mainContentSections.push(introSection);
  }

  // Common entry sections
  mainContentSections.push(
    createElement('section', { class: 'hero-comp-entry-flow' }, [
      createElement('div', { class: 'entry-step question-step' }, [
        createElement('h2', { textContent: '1. Answer The Question' }),
        createElement('p', { class: 'question-text', textContent: data.skillQuestion.text }),
        createElement('div', { class: 'answer-options' }, answers)
      ]),
      createElement('div', { class: 'entry-step tickets-step' }, [
        createElement('h2', { textContent: '2. Choose Your Tickets' }),
        createElement('div', { class: 'ticket-options' }, [ticketSlider])
      ])
    ]),
    createElement('section', { class: 'hero-comp-confirm-section' }, [
      createElement('button', { id: 'entry-button', class: ['btn', 'hero-cta-btn'], disabled: true }, [
        'Enter Now',
        createElement('span', { textContent: 'Secure Your Chance' })
      ])
    ])
  );

  // Hero-only glance section
  if (isTrueHero) {
    const prizeSpecs = [
      'AMG Spec',
      'Diesel Coupe',
      'Premium Black Finish',
      `Cash Alternative: £${(data.cashAlternative || 0).toLocaleString()}`
    ].map(spec => createElement('li', { textContent: spec }));

    const glanceImage = data.imageSet.foreground;

    mainContentSections.push(
      createElement('section', { class: 'hero-comp-glance-section' }, [
        createElement('h2', { textContent: '3. Prize At a Glance' }),
        createElement('div', { class: 'glance-content' }, [
          createElement('img', { src: glanceImage, alt: 'Prize image' }),
          createElement('ul', {}, prizeSpecs)
        ])
      ])
    );
  }

  // Trust badges
  mainContentSections.push(
    createElement('section', { class: 'hero-comp-trust-section' }, [
      createElement('div', { class: 'trust-badge' }, [
        createElement('span', { class: 'trust-icon', textContent: '🛡️' }),
        createElement('h3', { textContent: '100% Secure Payments' })
      ]),
      createElement('div', { class: 'trust-badge' }, [
        createElement('span', { class: 'trust-icon', textContent: '⚖️' }),
        createElement('h3', { textContent: 'Licensed & Fully Compliant' })
      ]),
      createElement('div', { class: 'trust-badge' }, [
        createElement('span', { class: 'trust-icon', textContent: '🏆' }),
        createElement('h3', { textContent: 'Real Winners Every Week' })
      ])
    ])
  );

  const main = createElement('main', { class: 'hero-comp-main' }, [
    createElement('div', { class: 'container' }, mainContentSections)
  ]);

  return [header, main];
}

// --- INSTANT WIN MODAL LOGIC ---
function showInstantWinModal(tokenCount) {
  const modal = document.getElementById('instant-win-modal');
  if (!modal) return;

  const titleEl = document.getElementById('spin-modal-title');
  if (titleEl) titleEl.textContent = `You've Unlocked ${tokenCount} Instant Win Spin${tokenCount > 1 ? 's' : ''}!`;

  const spinButton = document.getElementById('spin-button');
  const spinResultContainer = document.getElementById('spin-result');
  const wheel = document.getElementById('wheel');

  spinButton.disabled = false;
  spinButton.textContent = "SPIN THE WHEEL";
  spinButton.onclick = handleSpinButtonClick;
  spinResultContainer.innerHTML = '';
  wheel.style.transition = 'none';
  wheel.style.transform = 'rotate(0deg)';

  modal.classList.add('show');

  if (!modal.dataset.initialized) {
    setupSpinWheel();
    modal.dataset.initialized = 'true';
  }
}

function setupSpinWheel() {
  const wheel = document.getElementById('wheel');
  const segmentCount = 12;
  wheel.innerHTML = '';
  for (let i = 0; i < segmentCount; i++) {
    const segment = document.createElement('div');
    segment.className = 'wheel-segment';
    wheel.appendChild(segment);
  }
}

async function handleSpinButtonClick() {
  const spinButton = document.getElementById('spin-button');
  const spinResultContainer = document.getElementById('spin-result');
  const wheel = document.getElementById('wheel');

  const user = auth.currentUser;
  if (!user) {
    spinResultContainer.innerHTML = `<p class="spin-error">Please log in to play.</p>`;
    return;
  }

  const userDocRef = doc(db, 'users', user.uid);
  const userDocSnap = await getDoc(userDocRef);
  const userTokens = (userDocSnap.exists() ? (userDocSnap.data().spinTokens || []) : []) || [];

  if (userTokens.length === 0 || spinButton.disabled) return;

  spinButton.disabled = true;
  spinButton.textContent = 'SPINNING...';
  spinResultContainer.innerHTML = '';

  wheel.style.transition = 'none';
  wheel.style.transform = 'rotate(0deg)';
  void wheel.offsetWidth;

  // Oldest token first
  const tokenToSpend = userTokens.sort((a, b) =>
    new Date(a.earnedAt.seconds * 1000) - new Date(b.earnedAt.seconds * 1000)
  )[0];

  try {
    // Spend token via CF
    const spendToken = (await import("https://www.gstatic.com/firebasejs/9.15.0/firebase-functions.js"));
    const functions = spendToken.getFunctions(app);
    const spendTokenFunc = spendToken.httpsCallable(functions, 'spendSpinToken');

    const result = await spendTokenFunc({ tokenId: tokenToSpend.tokenId });
    const { won, prizeType, value } = result.data;

    let targetAngle;
    if (won) {
      const prizeKey = `${prizeType}-${value}`;
      targetAngle = PRIZE_ANGLES[prizeKey];
    }

    if (targetAngle === undefined) {
      const noWinAngles = PRIZE_ANGLES['no-win'];
      targetAngle = noWinAngles[Math.floor(Math.random() * noWinAngles.length)];
    }

    const baseSpins = 360 * 8;
    const randomOffsetInSegment = (Math.random() - 0.5) * 20;
    const finalAngle = baseSpins + (360 - targetAngle) + randomOffsetInSegment;

    wheel.style.transition = 'transform 8s cubic-bezier(0.25, 0.1, 0.25, 1)';
    wheel.style.transform = `rotate(${finalAngle}deg)`;

    setTimeout(() => {
      if (won) {
        const prizeValue = (typeof value === 'number') ? value.toFixed(2) : '0.00';
        const prizeText = prizeType === 'credit' ? `£${prizeValue} SITE CREDIT` : `£${prizeValue} CASH`;
        spinResultContainer.innerHTML = `<p class="spin-win">🎉 YOU WON ${prizeText}! 🎉</p>`;
      } else {
        spinResultContainer.innerHTML = `<p>Better luck next time!</p>`;
      }

      spinButton.textContent = 'GO TO INSTANT GAMES';
      spinButton.onclick = () => window.location.href = 'instant-games.html';
      spinButton.disabled = false;

      const closeBtn = document.createElement('button');
      closeBtn.className = 'btn btn-secondary';
      closeBtn.textContent = 'Close';
      closeBtn.style.marginTop = '1rem';
      closeBtn.onclick = () => {
        document.getElementById('instant-win-modal').classList.remove('show');
        window.location.reload();
      };
      spinResultContainer.appendChild(closeBtn);

    }, 8500);

  } catch (error) {
    console.error("Error spending token:", error);
    spinResultContainer.innerHTML = `<p class="spin-error">Error: ${error.message}</p>`;
    spinButton.disabled = false;
    spinButton.textContent = "SPIN THE WHEEL";
  }
}
