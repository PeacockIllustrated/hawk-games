
/**
 * Landing presenter — pre-launch, no links.
 * Top-left: logo + tagline. Right: vertical "revolving" collection of comps.
 * Brand is inherited from app/css/hawk-games.css; assets live under app/assets/.
 */

const DATA = [
  { title: "Mercedes A‑Class AMG Line",  img: "app/assets/spin-wheel-bg-empty.png", tag: "Grand Prize" },
  { title: "PlayStation 5 Slim",        img: "app/assets/spin-wheel-bg.png",        tag: "Tech" },
  { title: "Apple Watch Ultra 2",       img: "app/assets/spin-wheel-bg-empty.png",  tag: "Wearables" },
  { title: "Nintendo Switch OLED",      img: "app/assets/spin-wheel-bg.png",        tag: "Gaming" },
  { title: "Callaway Golf Set",         img: "app/assets/spin-wheel-bg-empty.png",  tag: "Sports" },
  { title: "Ultimate Driving Experience",img:"app/assets/spin-wheel-bg.png",        tag: "Experience" },
];

/** Create a brand-consistent, non-interactive card */
function createCard({ title, img, tag }){
  const card = document.createElement('div');
  card.className = 'hawk-card reel-card';
  // Badge
  const badge = document.createElement('div');
  badge.className = 'hawk-card__instant-win-badge';
  badge.textContent = 'COMING SOON';

  const image = document.createElement('img');
  image.className = 'hawk-card__image';
  image.alt = title;
  image.src = img;

  const content = document.createElement('div');
  content.className = 'hawk-card__content';

  const h3 = document.createElement('h3');
  h3.className = 'hawk-card__title';
  h3.textContent = title;

  const footer = document.createElement('div');
  footer.className = 'hawk-card__footer';

  const price = document.createElement('div');
  price.className = 'hawk-card__price';
  price.textContent = tag;

  const note = document.createElement('div');
  note.className = 'note';
  note.textContent = 'Launch Day Reveal';

  footer.append(price, note);
  content.append(h3, footer);
  card.append(badge, image, content);

  // Ensure no pointer interactions (pre‑launch)
  card.style.pointerEvents = 'none';
  return card;
}

/** Build the reel: two identical lists for seamless looping */
function buildReel(){
  const track = document.getElementById('reelTrack');
  const listA = document.getElementById('reelListA');
  const listB = document.getElementById('reelListB');

  const cards = DATA.map(createCard);
  cards.forEach(c => listA.appendChild(c.cloneNode(true)));
  cards.forEach(c => listB.appendChild(c.cloneNode(true)));
}

/** Pause animation on hover and when tab is hidden; resume on focus/visible */
function wirePlayState(){
  const track = document.getElementById('reelTrack');
  const viewport = document.querySelector('.reel-viewport');

  // Hover pause (desktop)
  viewport.addEventListener('mouseenter', () => { track.style.animationPlayState = 'paused'; });
  viewport.addEventListener('mouseleave', () => { track.style.animationPlayState = 'running'; });

  // Visibility pause
  document.addEventListener('visibilitychange', () => {
    track.style.animationPlayState = document.hidden ? 'paused' : 'running';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  buildReel();
  wirePlayState();

  // Optional: Spline logo via data attribute, otherwise show static PNG
  const splineUrl = document.body.getAttribute('data-spline-url');
  if (splineUrl) {
    const el = document.querySelector('spline-viewer');
    if (el) el.setAttribute('url', splineUrl);
  } else {
    // Replace the viewer with the PNG logo for crispness if no URL
    const holder = document.querySelector('.brand-logo-visual');
    if (holder) {
      holder.innerHTML = '<img src="app/assets/logo.png" alt="The Hawk Games">';
    }
  }
});
