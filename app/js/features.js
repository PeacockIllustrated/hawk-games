export const FEATURES = (() => {
  const g = (typeof window !== "undefined" && window.__FEATURES__) || {};
  return {
    instantWins: true,  // <-- set false to disable access
    ...g,
  };
})();
