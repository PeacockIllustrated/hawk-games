
// Minimal, isolated landing logic (no changes to existing app code).
// Uses Firebase Auth to personalise CTA if available.

const SPLINE_URL_PLACEHOLDER = "https://prod.spline.design/PLACEHOLDER/scene.splinecode"; // TODO: replace with your Spline logo URL

// --- Firebase init (safe, standalone) ---
const firebaseConfig = {
  apiKey: "AIzaSyCHnYCOB-Y4tA1_ikShsBZJVD0KJfJJMdU",
  authDomain: "the-hawk-games-64239.firebaseapp.com",
  projectId: "the-hawk-games-64239",
  storageBucket: "the-hawk-games-64239.firebasestorage.app",
  messagingSenderId: "391161456812",
  appId: "1:391161456812:web:48f7264720dff9a70dd709",
  measurementId: "G-DGLYCBJLWF"
};

(async function init(){
  try {
    const [{ initializeApp }, { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup }] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/9.15.0/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/9.15.0/firebase-auth.js"),
    ]);
    // Avoid duplicate apps
    let app;
    try {
      app = initializeApp(firebaseConfig);
    } catch (e) {
      // no-op: app may already be initialised elsewhere
    }
    const auth = getAuth();

    const ctaPrimary = document.querySelector('[data-cta="primary"]');
    const ctaSecondary = document.querySelector('[data-cta="secondary"]');
    const greet = document.querySelector('[data-greet]');
    const signInBtn = document.querySelector('[data-signin]');

    function openApp(){
      window.location.href = "/app/";
    }

    onAuthStateChanged(auth, (user) => {
      if (user) {
        greet.textContent = `Welcome back, ${user.displayName?.split(' ')[0] || 'Player'}!`;
        ctaPrimary.textContent = "Open the app";
        ctaPrimary.addEventListener('click', openApp, { once: true });
        ctaSecondary.classList.add('hidden');
        signInBtn.classList.add('hidden');
      } else {
        greet.textContent = "A new era of fair, fast, fun prize comps.";
        ctaPrimary.textContent = "Enter now";
        ctaPrimary.addEventListener('click', openApp, { once: true });
        ctaSecondary.classList.remove('hidden');
        signInBtn.classList.remove('hidden');
      }
    });

    signInBtn?.addEventListener('click', async () => {
      try {
        const provider = new GoogleAuthProvider();
        await signInWithPopup(auth, provider);
      } catch (err) {
        console.warn("Sign-in cancelled or failed.", err);
      }
    });

    // Spline viewer hookup (defer if component not ready yet)
    const setSpline = () => {
      const el = document.querySelector('spline-viewer');
      if (el && !el.getAttribute('url')) {
        el.setAttribute('url', SPLINE_URL_PLACEHOLDER);
      }
    };
    setSpline();
    setTimeout(setSpline, 1200);

  } catch (err) {
    console.warn("Landing Firebase init skipped", err);
  }
})();
