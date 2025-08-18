
// Keep it tiny and on-brand. We rely on app/js/auth.js to render header/footer,
// then we patch relative links to point into /app/ when we're on the root landing.

const SPLINE_URL = "https://prod.spline.design/PLACEHOLDER/scene.splinecode"; // Replace with your Spline scene

function patchHeaderFooterLinks() {
  const scope = document;
  const anchors = scope.querySelectorAll('.main-header a, .main-footer a');
  anchors.forEach(a => {
    const href = a.getAttribute('href') || '';
    if (!href) return;
    // External or already absolute
    if (/^https?:\/\//i.test(href) || href.startsWith('/app/')) return;

    // Map common pages to /app/
    const map = {
      'index.html': '/app/index.html',
      'terms-and-conditions.html': '/app/terms-and-conditions.html',
      'privacy-policy.html': '/app/privacy-policy.html',
      'free-entry-route.html': '/app/free-entry-route.html',
      'account.html': '/app/account.html',
      'login.html': '/app/login.html',
      'admin.html': '/app/admin.html',
      'instant-games.html': '/app/instant-games.html',
    };

    if (href in map) a.setAttribute('href', map[href]);
    else if (href.startsWith('index.html#')) {
      a.setAttribute('href', href.replace('index.html#', '/app/index.html#'));
    } else if (href.startsWith('#')) {
      // in case header links use a hash to sections on index
      a.setAttribute('href', '/app/index.html' + href);
    }
  });

  // Fix header/footer logos that use 'assets/*'
  const imgs = scope.querySelectorAll('.main-header img, .main-footer img');
  imgs.forEach(img => {
    const src = img.getAttribute('src') || '';
    if (src.startsWith('assets/')) {
      img.setAttribute('src', 'app/' + src);
    }
  });
}

function initSpline() {
  const el = document.querySelector('.hero-logo spline-viewer');
  if (el) el.setAttribute('url', SPLINE_URL);
}

document.addEventListener('DOMContentLoaded', () => {
  // Run once after auth.js renders header/footer (auth.js calls renderHeader on auth state)
  const obs = new MutationObserver((mut) => {
    if (document.querySelector('.main-header a')) {
      patchHeaderFooterLinks();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  initSpline();
});
