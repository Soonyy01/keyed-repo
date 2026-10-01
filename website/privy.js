// Privy login for Keyed (email, X or any wallet).
// Loads Privy's React SDK from esm.sh and publishes the session on window.KeyedPrivy.
// app.js listens for the "keyed:privy" event. If Privy can't load, the site falls
// back to plain browser wallets (MetaMask, Rabby, Trust...).
const CFG = window.KEYED_CONFIG || {};
const APP_ID = (CFG.PRIVY_APP_ID || "").trim();
const HAS_CONTRACT = !!(CFG.CONTRACT_ADDRESS || "").trim();

const fail = (e) => {
  console.error("Privy failed to load", e);
  window.KeyedPrivyFailed = true;
  window.dispatchEvent(new Event("keyed:privy"));
};

if (APP_ID && HAS_CONTRACT) {
  const timer = setTimeout(() => { if (!window.KeyedPrivy) fail(new Error("timeout")); }, 15000);
  boot().then(() => clearTimeout(timer), (e) => { clearTimeout(timer); fail(e); });
}

async function boot() {
  const [React, ReactDOM, Privy, chains] = await Promise.all([
    import("https://esm.sh/react@18.3.1"),
    import("https://esm.sh/react-dom@18.3.1/client"),
    import("https://esm.sh/@privy-io/react-auth@2?deps=react@18.3.1,react-dom@18.3.1"),
    import("https://esm.sh/viem@2/chains"),
  ]);
  const h = React.createElement;
  const chain = CFG.NETWORK === "testnet" ? chains.bscTestnet : chains.bsc;
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;

  function Bridge() {
    const p = Privy.usePrivy();
    const { wallets } = Privy.useWallets();
    React.useEffect(() => {
      window.KeyedPrivy = {
        ready: p.ready,
        authenticated: p.authenticated,
        user: p.user,
        wallets,
        login: p.login,
        logout: p.logout,
        linkTwitter: p.linkTwitter,
      };
      window.dispatchEvent(new Event("keyed:privy"));
    }, [p.ready, p.authenticated, p.user, wallets]);
    return null;
  }

  const config = {
    loginMethods: ["email", "twitter", "wallet"],
    appearance: {
      theme: dark ? "dark" : "light",
      accentColor: "#8b3dff",
      logo: new URL("logo-privy.png", location.href).href,
      landingHeader: "Log in to Keyed",
      loginMessage: "Your key to the inner circle.",
      walletChainType: "ethereum-only",
      showWalletLoginFirst: false,
    },
    embeddedWallets: {
      createOnLogin: "users-without-wallets",
      ethereum: { createOnLogin: "users-without-wallets" },
    },
    defaultChain: chain,
    supportedChains: [chain],
  };

  const mount = document.createElement("div");
  mount.id = "privy-root";
  document.body.appendChild(mount);
  ReactDOM.createRoot(mount).render(h(Privy.PrivyProvider, { appId: APP_ID, config }, h(Bridge)));
}
