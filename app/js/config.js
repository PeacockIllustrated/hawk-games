// app/js/config.js
export const DEMO_WALLETS = (window?.__DEMO_WALLETS__ === true)
  || (localStorage.getItem("wallet_demo") === "1");
