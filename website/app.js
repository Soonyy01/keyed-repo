/* Keyed web app. Plain JavaScript, no build step. */
(() => {
  "use strict";

  // ------------------------------------------------------------------ config
  const CFG = window.KEYED_CONFIG || {};
  const NETS = {
    mainnet: { chainId: 4663, name: "Robinhood Chain", rpc: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com", symbol: "ETH" },
    testnet: { chainId: 46630, name: "Robinhood Chain Testnet", rpc: "https://rpc.testnet.chain.robinhood.com", explorer: "https://explorer.testnet.chain.robinhood.com", symbol: "ETH" },
    local: { chainId: 31337, name: "Local test chain", rpc: "http://127.0.0.1:8545", explorer: "", symbol: "ETH" },
  };
  const NET = NETS[CFG.NETWORK] || NETS.mainnet;
  const RPC = (CFG.RPC_URL || "").trim() || NET.rpc;
  const ADDRESS = (CFG.CONTRACT_ADDRESS || "").trim();
  const E = window.ethers;
  const DEMO = !ADDRESS || !E;
  const SYM = NET.symbol;

  // ------------------------------------------------------------------ helpers
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
  const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  const ZERO = "0x0000000000000000000000000000000000000000";
  const WEI = 10n ** 18n;

  function fmt(wei) {
    const v = BigInt(wei || 0);
    if (v === 0n) return "0";
    const n = Number(v) / 1e18;
    if (n < 1e-8) return "<0.00000001";
    if (n < 1) return Number(n.toPrecision(4)).toFixed(10).replace(/0+$/, "").replace(/\.$/, "");
    if (n < 1000) return n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
    return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  const eth = (wei) => `${fmt(wei)} ${SYM}`;
  const pct = (bps) => `${(Number(bps) / 100).toFixed(Number(bps) % 100 ? 1 : 0)}%`;

  function ago(sec) {
    const d = Math.max(0, Math.floor(Date.now() / 1000) - Number(sec));
    if (d < 60) return "just now";
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  }

  const COLORS = ["var(--pink)", "var(--cyan)", "var(--violet)", "var(--orange)"];
  function colorFor(addr) {
    let h = 0;
    for (const ch of String(addr || "").toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }
  function avatar(club, size = "") {
    const letter = esc((club?.name || "?").trim().charAt(0).toUpperCase() || "?");
    const url = club?.avatar && /^https:\/\//i.test(club.avatar) ? club.avatar : "";
    const img = url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
    return `<span class="av ${size}" style="background:${colorFor(club?.creator)}">${letter}${img}</span>`;
  }
  const cleanHandle = (h) => String(h || "").trim().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").replace(/^@/, "").replace(/[/?#].*$/, "");
  const handleLink = (h) => {
    const c = cleanHandle(h);
    return c ? `<a class="chip" href="https://x.com/${encodeURIComponent(c)}" target="_blank" rel="noopener">@${esc(c)}</a>` : "";
  };

  // bonding curve, same math as the contract
  function curvePrice(supply, amount) {
    supply = BigInt(supply); amount = BigInt(amount);
    const sum1 = supply === 0n ? 0n : ((supply - 1n) * supply * (2n * (supply - 1n) + 1n)) / 6n;
    const last = supply + amount - 1n;
    const sum2 = supply === 0n && amount === 1n ? 0n : (last * (last + 1n) * (2n * last + 1n)) / 6n;
    return ((sum2 - sum1) * WEI) / 16000n;
  }
  function fees(value, shareBps) {
    const p = (value * 100n) / 10000n;
    const ct = (value * 300n) / 10000n;
    const h = (ct * BigInt(shareBps)) / 10000n;
    return { p, c: ct - h, h, total: p + ct };
  }

  // ------------------------------------------------------------------ toast
  let toastTimer;
  function toast(html, isErr = false) {
    const t = $("#toast");
    t.innerHTML = html;
    t.classList.toggle("err", isErr);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), isErr ? 6000 : 5000);
  }
  function errMsg(e) {
    const code = e?.code ?? e?.info?.error?.code ?? e?.error?.code;
    if (code === "ACTION_REJECTED" || code === 4001) return "Transaction cancelled in your wallet.";
    const raw = e?.reason || e?.revert?.args?.[0] || e?.info?.error?.message || e?.shortMessage || e?.message || "Something went wrong.";
    if (/insufficient funds/i.test(raw)) return `Not enough ${SYM} to cover this plus the network fee.`;
    return String(raw).replace(/^execution reverted:?\s*/i, "").replace(/^Error:\s*/, "").slice(0, 160);
  }

  // ================================================================== DATA: chain
  const ABI = [
    "function getClubs(uint256 offset,uint256 limit) view returns (tuple(address creator,string name,string handle,string avatar,string bio,uint256 maxSupply,uint256 supply,uint256 holderShareBps,uint256 holderCount,uint256 createdAt,uint256 buyPrice,uint256 sellPrice)[])",
    "function getClub(address creator) view returns (tuple(address creator,string name,string handle,string avatar,string bio,uint256 maxSupply,uint256 supply,uint256 holderShareBps,uint256 holderCount,uint256 createdAt,uint256 buyPrice,uint256 sellPrice))",
    "function getClubTrades(address creator,uint256 limit) view returns (tuple(address trader,address creator,uint128 value,uint32 amount,uint32 supplyAfter,bool isBuy,uint40 time)[])",
    "function getRecentTrades(uint256 limit) view returns (tuple(address trader,address creator,uint128 value,uint32 amount,uint32 supplyAfter,bool isBuy,uint40 time)[])",
    "function getHolders(address creator,uint256 offset,uint256 limit) view returns (address[] addrs,uint256[] balances)",
    "function getHoldings(address user) view returns (address[] clubList,uint256[] balances,uint256[] rewards)",
    "function balanceOf(address creator,address holder) view returns (uint256)",
    "function pendingRewards(address creator,address holder) view returns (uint256)",
    "function credits(address) view returns (uint256)",
    "function getBuyPriceAfterFee(address creator,uint256 amount) view returns (uint256)",
    "function getSellPriceAfterFee(address creator,uint256 amount) view returns (uint256)",
    "function buyKeys(address creator,uint256 amount) payable",
    "function sellKeys(address creator,uint256 amount,uint256 minReceive)",
    "function launchClub(string name,string handle,string avatar,string bio,uint256 maxSupply,uint256 holderShareBps)",
    "function updateProfile(string name,string handle,string avatar,string bio)",
    "function raiseHolderShare(uint256 newShareBps)",
    "function claimRewards(address[] clubList)",
    "function withdraw()",
  ];

  const normClub = (r) => ({
    creator: r.creator, name: r.name, handle: r.handle, avatar: r.avatar, bio: r.bio,
    maxSupply: Number(r.maxSupply), supply: Number(r.supply), share: Number(r.holderShareBps),
    holders: Number(r.holderCount), createdAt: Number(r.createdAt),
    buyPrice: BigInt(r.buyPrice), sellPrice: BigInt(r.sellPrice),
  });
  const normTrade = (t) => ({
    trader: t.trader, creator: t.creator, value: BigInt(t.value), amount: Number(t.amount),
    supplyAfter: Number(t.supplyAfter), isBuy: t.isBuy, time: Number(t.time),
  });

  function chainApi() {
    const rp = new E.JsonRpcProvider(RPC, NET.chainId, { staticNetwork: true });
    const rc = new E.Contract(ADDRESS, ABI, rp);
    const wc = () => new E.Contract(ADDRESS, ABI, wallet.signer);
    return {
      clubs: async () => (await rc.getClubs(0, 500)).map(normClub),
      club: async (a) => { const c = normClub(await rc.getClub(a)); return c.creator === ZERO ? null : c; },
      trades: async (a, n) => (await rc.getClubTrades(a, n)).map(normTrade),
      recent: async (n) => (await rc.getRecentTrades(n)).map(normTrade),
      holders: async (a) => { const r = await rc.getHolders(a, 0, 100); return r[0].map((x, i) => ({ addr: x, bal: Number(r[1][i]) })); },
      holdings: async (u) => { const r = await rc.getHoldings(u); return r[0].map((x, i) => ({ club: x, bal: Number(r[1][i]), reward: BigInt(r[2][i]) })); },
      balance: async (a, u) => Number(await rc.balanceOf(a, u)),
      pending: async (a, u) => BigInt(await rc.pendingRewards(a, u)),
      credits: async (u) => BigInt(await rc.credits(u)),
      quoteBuy: async (a, n) => BigInt(await rc.getBuyPriceAfterFee(a, n)),
      quoteSell: async (a, n) => BigInt(await rc.getSellPriceAfterFee(a, n)),
      walletBalance: async (u) => BigInt(await rp.getBalance(u)),
      buy: (a, n, value) => wc().buyKeys(a, n, { value }),
      sell: (a, n, min) => wc().sellKeys(a, n, min),
      launch: (f) => wc().launchClub(f.name, f.handle, f.avatar, f.bio, f.maxSupply, f.share),
      updateProfile: (f) => wc().updateProfile(f.name, f.handle, f.avatar, f.bio),
      raiseShare: (bps) => wc().raiseHolderShare(bps),
      claim: (list) => wc().claimRewards(list),
      withdraw: () => wc().withdraw(),
    };
  }

  // ================================================================== DATA: demo
  function demoApi() {
    const PREC = WEI;
    const now = () => Math.floor(Date.now() / 1000);
    const S = { clubs: new Map(), order: [], bal: new Map(), debt: new Map(), stored: new Map(), credits: new Map(), trades: [], wallet: 5n * WEI };
    const k2 = (a, b) => a.toLowerCase() + ":" + b.toLowerCase();
    const get = (m, k) => m.get(k) ?? 0n;
    const holdersOf = (c) => [...S.bal.entries()].filter(([k, v]) => k.startsWith(c.toLowerCase() + ":") && v > 0n);

    function settle(c, u) {
      const club = S.clubs.get(c.toLowerCase());
      const acc = (get(S.bal, k2(c, u)) * club.acc) / PREC;
      const d = get(S.debt, k2(c, u));
      if (acc > d) S.stored.set(k2(c, u), get(S.stored, k2(c, u)) + acc - d);
      S.debt.set(k2(c, u), acc);
    }
    function pending(c, u) {
      const club = S.clubs.get(c.toLowerCase());
      if (!club) return 0n;
      return get(S.stored, k2(c, u)) + (get(S.bal, k2(c, u)) * club.acc) / PREC - get(S.debt, k2(c, u));
    }
    function record(trader, creator, isBuy, amount, value, supplyAfter, t) {
      S.trades.push({ trader, creator, isBuy, amount, value, supplyAfter, time: t ?? now() });
    }
    function launch(creator, f, t) {
      const key = creator.toLowerCase();
      if (S.clubs.has(key)) throw new Error("Club already exists");
      S.clubs.set(key, { creator, ...f, supply: 1, acc: 0n, createdAt: t ?? now() });
      S.order.push(key);
      S.bal.set(k2(creator, creator), 1n);
      record(creator, creator, true, 1, 0n, 1, t);
    }
    function buy(user, c, n, t) {
      const club = S.clubs.get(c.toLowerCase());
      if (club.supply + n > club.maxSupply) throw new Error("Sold out");
      const value = curvePrice(club.supply, n);
      const f = fees(value, club.share);
      if (f.h > 0n) club.acc += (f.h * PREC) / BigInt(club.supply);
      settle(c, user);
      const b = get(S.bal, k2(c, user)) + BigInt(n);
      S.bal.set(k2(c, user), b);
      S.debt.set(k2(c, user), (b * club.acc) / PREC);
      club.supply += n;
      S.credits.set(c.toLowerCase(), get(S.credits, c.toLowerCase()) + f.c);
      record(user, club.creator, true, n, value, club.supply, t);
      return value + f.total;
    }
    function sell(user, c, n) {
      const club = S.clubs.get(c.toLowerCase());
      if (club.supply <= n) throw new Error("Cannot sell the last key");
      const b0 = get(S.bal, k2(c, user));
      if (b0 < BigInt(n)) throw new Error("Not enough keys");
      const value = curvePrice(club.supply - n, n);
      const f = fees(value, club.share);
      settle(c, user);
      const b = b0 - BigInt(n);
      S.bal.set(k2(c, user), b);
      S.debt.set(k2(c, user), (b * club.acc) / PREC);
      club.supply -= n;
      if (f.h > 0n) club.acc += (f.h * PREC) / BigInt(club.supply);
      S.credits.set(c.toLowerCase(), get(S.credits, c.toLowerCase()) + f.c);
      record(user, club.creator, false, n, value, club.supply);
      return value - f.total;
    }
    const view = (key) => {
      const c = S.clubs.get(key);
      const bp = c.supply + 1 <= c.maxSupply ? curvePrice(c.supply, 1) : 0n;
      const sp = c.supply > 1 ? curvePrice(c.supply - 1, 1) : 0n;
      return {
        creator: c.creator, name: c.name, handle: c.handle, avatar: c.avatar, bio: c.bio,
        maxSupply: c.maxSupply, supply: c.supply, share: c.share, holders: holdersOf(c.creator).length,
        createdAt: c.createdAt, buyPrice: bp ? bp + fees(bp, c.share).total : 0n, sellPrice: sp ? sp - fees(sp, c.share).total : 0n,
      };
    };

    const wait = (ms = 700) => new Promise((r) => setTimeout(r, ms));
    const tx = async (fn) => {
      await wait(500);
      const out = fn();
      const hash = "0x" + Math.random().toString(16).slice(2).padEnd(64, "0");
      return { hash, wait: async () => { await wait(600); return { hash, out }; } };
    };
    const me = () => wallet.addr;

    return {
      clubs: async () => S.order.slice().reverse().map(view),
      club: async (a) => (S.clubs.has(a.toLowerCase()) ? view(a.toLowerCase()) : null),
      trades: async (a, n) => S.trades.filter((t) => same(t.creator, a)).slice(-n).reverse(),
      recent: async (n) => S.trades.slice(-n).reverse(),
      holders: async (a) => holdersOf(a).map(([k, v]) => ({ addr: S.clubs.get(a.toLowerCase()) && k.split(":")[1], bal: Number(v) })).sort((x, y) => y.bal - x.bal),
      holdings: async (u) => S.order.map((key) => ({ club: S.clubs.get(key).creator, bal: Number(get(S.bal, k2(key, u))), reward: pending(key, u) })).filter((h) => h.bal > 0 || h.reward > 0n),
      balance: async (a, u) => Number(get(S.bal, k2(a, u))),
      pending: async (a, u) => pending(a, u),
      credits: async (u) => get(S.credits, u.toLowerCase()),
      quoteBuy: async (a, n) => {
        const c = S.clubs.get(a.toLowerCase());
        if (!c || n < 1 || c.supply + n > c.maxSupply) return 0n;
        const v = curvePrice(c.supply, n); return v + fees(v, c.share).total;
      },
      quoteSell: async (a, n) => {
        const c = S.clubs.get(a.toLowerCase());
        if (!c || n < 1 || c.supply <= n) return 0n;
        const v = curvePrice(c.supply - n, n); return v - fees(v, c.share).total;
      },
      walletBalance: async () => S.wallet,
      buy: (a, n, value) => tx(() => {
        if (S.wallet < value) throw new Error("insufficient funds");
        const cost = buy(me(), a, n); S.wallet -= cost;
      }),
      sell: (a, n) => tx(() => { S.wallet += sell(me(), a, n); }),
      launch: (f) => tx(() => launch(me(), f)),
      updateProfile: (f) => tx(() => Object.assign(S.clubs.get(me().toLowerCase()), f)),
      raiseShare: (bps) => tx(() => {
        const c = S.clubs.get(me().toLowerCase());
        if (bps <= c.share || bps > 10000) throw new Error("Share can only go up");
        c.share = bps;
      }),
      claim: (list) => tx(() => {
        let tot = 0n;
        for (const a of list) { settle(a, me()); tot += get(S.stored, k2(a, me())); S.stored.set(k2(a, me()), 0n); }
        if (tot === 0n) throw new Error("Nothing to claim");
        S.wallet += tot;
      }),
      withdraw: () => tx(() => {
        const v = get(S.credits, me().toLowerCase());
        if (v === 0n) throw new Error("Nothing to withdraw");
        S.credits.set(me().toLowerCase(), 0n); S.wallet += v;
      }),
    };
  }

  const api = DEMO ? demoApi() : chainApi();

  // ================================================================== wallet
  const wallet = { addr: null, signer: null, eip: null, chainOk: true };
  const discovered = [];
  window.addEventListener("eip6963:announceProvider", (ev) => {
    const d = ev.detail;
    if (d?.info && d?.provider && !discovered.some((x) => x.info.uuid === d.info.uuid)) discovered.push(d);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  // Privy login (email, X or wallet). privy.js publishes window.KeyedPrivy.
  const privyOn = () => !DEMO && !!(CFG.PRIVY_APP_ID || "").trim() && !window.KeyedPrivyFailed;
  const xUser = () => window.KeyedPrivy?.user?.twitter?.username || "";
  let privySyncing = false;
  let pendingLogin = false;
  async function syncPrivy() {
    const kp = window.KeyedPrivy;
    if (window.KeyedPrivyFailed) { paintWallet(); return; }
    if (!kp?.ready || privySyncing) return;
    paintWallet();
    if (pendingLogin && !kp.authenticated) { pendingLogin = false; try { kp.login(); } catch (e) { toast(esc(errMsg(e)), true); } return; }
    pendingLogin = false;
    if (!kp.authenticated) {
      if (wallet.viaPrivy) { Object.assign(wallet, { addr: null, signer: null, eip: null, chainOk: true, viaPrivy: false }); paintWallet(); route(); }
      return;
    }
    const w = kp.wallets?.[0];
    if (!w) return;
    if (wallet.viaPrivy && same(wallet.addr, w.address)) { if (location.hash.startsWith("#/launch")) route(); return; }
    privySyncing = true;
    try {
      const prov = await w.getEthereumProvider();
      wallet.viaPrivy = true;
      await setEip(prov, w.address);
      if (!wallet.chainOk) await ensureChain().catch(() => {});
      route();
    } catch (e) { toast(esc(errMsg(e)), true); }
    finally { privySyncing = false; }
  }
  window.addEventListener("keyed:privy", syncPrivy);

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  function paintWallet() {
    const b = $("#wallet");
    if (wallet.addr) {
      b.textContent = wallet.chainOk ? short(wallet.addr) : "Wrong network";
      b.className = wallet.chainOk ? "btn btn-ghost" : "btn btn-sell";
    } else {
      b.textContent = privyOn() ? "Log in" : "Connect wallet";
      b.className = "btn btn-dark";
    }
  }

  async function setEip(eip, addr) {
    wallet.eip = eip;
    wallet.addr = E ? E.getAddress(addr) : addr;
    const bp = new E.BrowserProvider(eip, "any");
    wallet.signer = await bp.getSigner(wallet.addr);
    const cid = Number(await eip.request({ method: "eth_chainId" }));
    wallet.chainOk = cid === NET.chainId;
    if (!eip.__keyed) {
      eip.__keyed = true;
      eip.on?.("accountsChanged", (accs) => {
        if (!accs?.length) { disconnect(); return; }
        setEip(eip, accs[0]).then(() => { paintWallet(); route(); });
      });
      eip.on?.("chainChanged", (c) => {
        wallet.chainOk = Number(c) === NET.chainId;
        if (wallet.addr) setEip(eip, wallet.addr).then(() => { paintWallet(); route(); });
      });
    }
    paintWallet();
  }

  function disconnect() {
    if (wallet.viaPrivy) { try { window.KeyedPrivy?.logout(); } catch { /* ignore */ } }
    Object.assign(wallet, { addr: null, signer: null, eip: null, chainOk: true, viaPrivy: false });
    store.set("keyed.wallet", null);
    paintWallet();
    route();
  }

  async function connectWith(entry) {
    closeModal();
    try {
      const accs = await entry.provider.request({ method: "eth_requestAccounts" });
      if (!accs?.length) return;
      await setEip(entry.provider, accs[0]);
      store.set("keyed.wallet", entry.info.rdns || "injected");
      if (!wallet.chainOk) await ensureChain().catch(() => {});
      toast(`Connected ${short(wallet.addr)}`);
      route();
    } catch (e) { toast(errMsg(e), true); }
  }

  function walletEntries() {
    const list = discovered.slice();
    if (!list.length && window.ethereum) list.push({ info: { name: "Browser wallet", rdns: "injected", icon: "" }, provider: window.ethereum });
    return list;
  }

  function openModal() {
    if (privyOn()) {
      const kp = window.KeyedPrivy;
      if (kp?.ready) { try { kp.login(); } catch (e) { toast(esc(errMsg(e)), true); } }
      else { pendingLogin = true; toast("Opening login…"); }
      return;
    }
    if (DEMO) {
      wallet.addr = "0xDe110000000000000000000000000000000000Fe";
      wallet.chainOk = true;
      paintWallet();
      toast(`Demo wallet connected with 5 ${SYM} of play money.`);
      route();
      return;
    }
    const list = walletEntries();
    $("#walletList").innerHTML = list.length
      ? list.map((w, i) => `<button type="button" data-i="${i}">${w.info.icon ? `<img src="${esc(w.info.icon)}" alt="">` : ""}${esc(w.info.name)}</button>`).join("")
      : `<p class="muted">No wallet found in this browser. Install <a href="https://metamask.io/download/" target="_blank" rel="noopener">MetaMask</a> or <a href="https://rabby.io/" target="_blank" rel="noopener">Rabby</a>, or open this site in the browser inside MetaMask, Rabby or Trust Wallet on your phone.</p>`;
    $$("#walletList button").forEach((b) => b.addEventListener("click", () => connectWith(list[+b.dataset.i])));
    $("#walletModal").hidden = false;
  }
  function closeModal() { $("#walletModal").hidden = true; }

  async function ensureChain() {
    if (DEMO || !wallet.eip) return;
    const hex = "0x" + NET.chainId.toString(16);
    try {
      await wallet.eip.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      const code = e?.code ?? e?.data?.originalError?.code;
      if (code !== 4902) throw e;
      await wallet.eip.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hex, chainName: NET.name, nativeCurrency: { name: "Ether", symbol: NET.symbol, decimals: 18 }, rpcUrls: [RPC], blockExplorerUrls: NET.explorer ? [NET.explorer] : [] }],
      });
    }
    await setEip(wallet.eip, wallet.addr);
  }

  async function autoConnect() {
    if (DEMO || privyOn()) return;
    const last = store.get("keyed.wallet");
    if (!last) return;
    await new Promise((r) => setTimeout(r, 250));
    const entry = walletEntries().find((w) => (w.info.rdns || "injected") === last) || walletEntries()[0];
    if (!entry) return;
    try {
      const accs = await entry.provider.request({ method: "eth_accounts" });
      if (accs?.length) { await setEip(entry.provider, accs[0]); route(); }
    } catch { /* wallet locked */ }
  }

  $("#wallet").addEventListener("click", () => {
    if (!wallet.addr) return openModal();
    if (!wallet.chainOk) return ensureChain().then(route).catch((e) => toast(errMsg(e), true));
    location.hash = "#/me";
  });
  $("#dockWallet").addEventListener("click", () => { if (wallet.addr) location.hash = "#/me"; else openModal(); });
  $("#wmClose").addEventListener("click", closeModal);
  $("#walletModal").addEventListener("click", (e) => { if (e.target.id === "walletModal") closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  // ------------------------------------------------------------------ transactions
  async function runTx(btn, fn, doneText) {
    if (!wallet.addr) { openModal(); return false; }
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = "Confirm in wallet…";
    try {
      await ensureChain();
      const tx = await fn();
      btn.textContent = "Confirming…";
      await tx.wait();
      const link = NET.explorer && !DEMO ? ` · <a href="${NET.explorer}/tx/${tx.hash}" target="_blank" rel="noopener">View</a>` : "";
      toast(esc(doneText) + link);
      return true;
    } catch (e) {
      toast(esc(errMsg(e)), true);
      return false;
    } finally {
      btn.disabled = false;
      btn.innerHTML = old;
    }
  }

  // ================================================================== views
  const view = $("#view");
  let renderId = 0;

  function clubCard(c) {
    const fill = Math.max(1, Math.round((c.supply / c.maxSupply) * 100));
    return `<a class="key" href="#/club/${c.creator}">
      <div class="who">${avatar(c)}<div><b>${esc(c.name)}</b><span>${c.handle ? "@" + esc(cleanHandle(c.handle)) : short(c.creator)}</span></div></div>
      <div class="stats">
        <div><small>Key price</small><strong>${c.buyPrice ? eth(c.buyPrice) : "Sold out"}</strong></div>
        <div><small>Holders</small><strong>${c.holders}</strong></div>
      </div>
      <div><div class="supply"><i style="width:${fill}%"></i></div>
      <div class="meta" style="margin-top:6px"><span>${c.supply}/${c.maxSupply} keys</span><span>${pct(c.share)} to holders</span></div></div>
    </a>`;
  }

  function tradeRow(t, clubsByAddr) {
    const c = clubsByAddr?.get(t.creator.toLowerCase());
    const launch = t.isBuy && t.value === 0n && same(t.trader, t.creator) && t.supplyAfter === 1;
    return `<a class="li" href="#/club/${t.creator}">
      ${c ? avatar(c, "sm") : ""}
      <div class="grow"><b>${launch ? "Club launched" : `${short(t.trader)} ${t.isBuy ? "bought" : "sold"} ${t.amount} key${t.amount > 1 ? "s" : ""}`}</b>
      <span>${c ? esc(c.name) + " · " : ""}${ago(t.time)}</span></div>
      <div class="right">${launch ? `<span class="tag buy">New</span>` : `<span class="tag ${t.isBuy ? "buy" : "sell"}">${t.isBuy ? "Buy" : "Sell"}</span>${eth(t.value)}`}</div>
    </a>`;
  }

  // ------------------------------------------------------------------ landing
  async function landing(id) {
    view.innerHTML = `
    <header class="hero">
      <div>
        <p class="eyebrow">Creator keys on Robinhood Chain</p>
        <h1>Your key to the <span class="grad">inner circle.</span></h1>
        <p class="lede">Find the creators you believe in, hold their keys, and share in the club they build.</p>
        <div class="cta">
          <a class="btn btn-jelly" href="#/explore">Explore clubs →</a>
          <a class="btn btn-ghost" href="#/launch">Launch your club</a>
        </div>
        <div class="chain"><span class="chip"><i></i>Robinhood Chain</span><span class="chip">Keys priced in ${SYM}</span><span class="chip">Fixed supply</span></div>
      </div>
      <div class="stage" aria-hidden="true">
        <span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span><span class="blob b4"></span>
        <img class="logo" src="logo.webp" alt="">
      </div>
    </header>

    <section class="sec">
      <div class="head"><h2>Clubs worth holding.</h2><a class="btn btn-ghost" href="#/explore">See all clubs</a></div>
      <div class="keys" id="topClubs">${'<div class="skeleton"></div>'.repeat(4)}</div>
    </section>

    ${infoSections()}

    <div class="closer">
      <img src="logo.webp" alt="">
      <h2>Pick a door. <span class="grad">Get keyed.</span></h2>
      <a class="btn btn-jelly" href="#/explore">Enter the app →</a>
    </div>`;

    try {
      const clubs = await api.clubs();
      if (id !== renderId) return;
      const top = clubs.slice().sort((a, b) => (b.buyPrice > a.buyPrice ? 1 : -1)).slice(0, 4);
      $("#topClubs").innerHTML = top.length ? top.map(clubCard).join("")
        : `<div class="panel empty" style="grid-column:1/-1"><b>No clubs yet</b>Be the first creator on Keyed. <a href="#/launch">Launch your club</a></div>`;
    } catch (e) {
      if (id === renderId) $("#topClubs").innerHTML = loadError(e);
    }
  }

  const loadError = (e) => `<div class="panel empty" style="grid-column:1/-1"><b>Could not load clubs</b>${esc(errMsg(e))}. Check your connection and refresh the page.</div>`;

  // ------------------------------------------------------------------ explore
  let exploreState = { q: "", sort: "top" };
  async function explore(id) {
    view.innerHTML = `
      <div class="page-title"><div><p class="eyebrow">Discover</p><h1>Find your people.</h1></div>
      <a class="btn btn-jelly" href="#/launch">Launch your club</a></div>
      <div class="split2">
        <div style="min-width:0">
          <div class="tools">
            <input class="input" id="q" type="search" placeholder="Search by name or @handle" value="${esc(exploreState.q)}" aria-label="Search clubs">
            <div class="seg" role="tablist" aria-label="Sort">
              ${[["top", "Top"], ["new", "New"], ["holders", "Most holders"]].map(([k, l]) => `<button type="button" data-sort="${k}" class="${exploreState.sort === k ? "on" : ""}">${l}</button>`).join("")}
            </div>
          </div>
          <div class="keys" id="grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">${'<div class="skeleton"></div>'.repeat(4)}</div>
        </div>
        <aside class="panel"><h3>Live trades</h3><div class="list" id="feed"><div class="empty">Loading…</div></div></aside>
      </div>`;
    let clubs = [];
    const paint = () => {
      const q = exploreState.q.toLowerCase().replace(/^@/, "");
      let list = clubs.filter((c) => !q || c.name.toLowerCase().includes(q) || cleanHandle(c.handle).toLowerCase().includes(q) || c.creator.toLowerCase().includes(q));
      if (exploreState.sort === "top") list.sort((a, b) => (b.buyPrice > a.buyPrice ? 1 : b.buyPrice < a.buyPrice ? -1 : 0));
      if (exploreState.sort === "new") list.sort((a, b) => b.createdAt - a.createdAt);
      if (exploreState.sort === "holders") list.sort((a, b) => b.holders - a.holders);
      $("#grid").innerHTML = list.length ? list.map(clubCard).join("")
        : `<div class="panel empty" style="grid-column:1/-1">${clubs.length ? `<b>No clubs match "${esc(exploreState.q)}"</b>Try another name.` : `<b>No clubs yet</b><a href="#/launch">Launch the first one</a>`}</div>`;
    };
    $("#q").addEventListener("input", (e) => { exploreState.q = e.target.value; paint(); });
    $$("[data-sort]").forEach((b) => b.addEventListener("click", () => {
      exploreState.sort = b.dataset.sort;
      $$("[data-sort]").forEach((x) => x.classList.toggle("on", x === b));
      paint();
    }));
    try {
      const [cl, feed] = await Promise.all([api.clubs(), api.recent(15)]);
      if (id !== renderId) return;
      clubs = cl;
      paint();
      const map = new Map(clubs.map((c) => [c.creator.toLowerCase(), c]));
      $("#feed").innerHTML = feed.length ? feed.map((t) => tradeRow(t, map)).join("") : `<div class="empty">No trades yet.</div>`;
    } catch (e) {
      if (id !== renderId) return;
      $("#grid").innerHTML = loadError(e);
      $("#feed").innerHTML = "";
    }
  }

  // ------------------------------------------------------------------ club page
  function curveSvg(c) {
    const W = 520, H = 170, pl = 8, pr = 8, pt = 14, pb = 22;
    const max = c.maxSupply;
    const yMax = (max * max) / 16000;
    const X = (n) => pl + (n / max) * (W - pl - pr);
    const Y = (n) => pt + (1 - (n * n) / 16000 / yMax) * (H - pt - pb);
    const pts = [];
    for (let i = 0; i <= 60; i++) { const n = (i / 60) * max; pts.push(`${X(n).toFixed(1)},${Y(n).toFixed(1)}`); }
    const cur = Math.min(c.supply, max);
    const nowPts = [];
    for (let i = 0; i <= 40; i++) { const n = (i / 40) * cur; nowPts.push(`${X(n).toFixed(1)},${Y(n).toFixed(1)}`); }
    const lastPrice = BigInt(Math.max(0, max - 1)) ** 2n * WEI / 16000n;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Price curve: key ${cur} of ${max}">
      <defs><linearGradient id="cg" x1="0" x2="1"><stop offset="0" stop-color="var(--cyan)"/><stop offset=".5" stop-color="var(--violet)"/><stop offset="1" stop-color="var(--pink)"/></linearGradient></defs>
      <line x1="${pl}" x2="${W - pr}" y1="${H - pb}" y2="${H - pb}" stroke="var(--line)" stroke-width="1"/>
      <polyline points="${pts.join(" ")}" fill="none" stroke="var(--line)" stroke-width="3" stroke-dasharray="4 5"/>
      <polygon points="${X(0)},${H - pb} ${nowPts.join(" ")} ${X(cur)},${H - pb}" fill="url(#cg)" opacity=".18"/>
      <polyline points="${nowPts.join(" ")}" fill="none" stroke="url(#cg)" stroke-width="4" stroke-linecap="round"/>
      <circle cx="${X(cur)}" cy="${Y(cur)}" r="7" fill="var(--pink)" stroke="var(--surface)" stroke-width="3"/>
      <text x="${pl}" y="${H - 6}">key 0</text>
      <text x="${W - pr}" y="${H - 6}" text-anchor="end">key ${max}</text>
      <text x="${W - pr}" y="${pt - 2}" text-anchor="end">last key ≈ ${fmt(lastPrice)} ${SYM}</text>
    </svg>`;
  }

  let tradeMode = "buy";
  async function clubPage(id, addr) {
    view.innerHTML = `<div class="page-title"><div class="skeleton" style="min-height:120px;width:100%"></div></div>`;
    let c;
    try { c = await api.club(addr); } catch (e) { if (id === renderId) view.innerHTML = `<div class="panel empty" style="margin-top:24px">${loadError(e)}</div>`; return; }
    if (id !== renderId) return;
    if (!c) {
      view.innerHTML = `<div class="panel empty" style="margin-top:24px"><b>Club not found</b>No club exists at ${esc(short(addr))}. <a href="#/explore">Back to explore</a></div>`;
      return;
    }
    const isOwner = same(wallet.addr, c.creator);
    view.innerHTML = `
      <div class="split2" style="padding-top:20px">
        <div class="stack">
          <div class="panel">
            <div class="profile">${avatar(c, "lg")}
              <div style="min-width:0"><h1>${esc(c.name)}</h1>
                <div class="sub">${handleLink(c.handle)}<button class="chip" type="button" id="copyAddr" title="Copy address">${short(c.creator)} ⧉</button>${isOwner ? `<span class="chip">Your club</span>` : ""}</div>
              </div>
            </div>
            ${c.bio ? `<p class="bio">${esc(c.bio)}</p>` : ""}
            <div class="kpis">
              <div class="kpi"><small>Key price</small><strong>${c.buyPrice ? eth(c.buyPrice) : "Sold out"}</strong></div>
              <div class="kpi"><small>Holders</small><strong>${c.holders}</strong></div>
              <div class="kpi"><small>Keys held</small><strong>${c.supply} / ${c.maxSupply}</strong></div>
              <div class="kpi"><small>Holder share</small><strong>${pct(c.share)}</strong></div>
            </div>
          </div>
          <div class="panel curve"><h3>Price curve</h3>${curveSvg(c)}</div>
          <div class="panel"><h3>Trades</h3><div class="list" id="ctrades"><div class="empty">Loading…</div></div></div>
          <div class="panel"><h3>Holders</h3><div class="list" id="cholders"><div class="empty">Loading…</div></div></div>
        </div>
        <div class="stack">
          <div class="panel trade">
            <div class="tabs" role="tablist">
              <button type="button" data-mode="buy" class="${tradeMode === "buy" ? "on" : ""}">Buy</button>
              <button type="button" data-mode="sell" class="${tradeMode === "sell" ? "on" : ""}">Sell</button>
            </div>
            <div class="stepper">
              <button type="button" id="minus" aria-label="One less key">−</button>
              <input class="input" id="amt" type="number" min="1" max="100" value="1" inputmode="numeric" aria-label="Number of keys">
              <button type="button" id="plus" aria-label="One more key">+</button>
            </div>
            <dl class="rows" id="quote"></dl>
            <button class="btn btn-block" id="go" type="button"></button>
            <p class="note" id="tnote"></p>
          </div>
          <div class="panel" id="pos"><h3>Your position</h3><div class="empty">Connect your wallet to see your keys and rewards.</div></div>
          ${isOwner ? `<div class="panel" id="owner"></div>` : ""}
        </div>
      </div>`;

    $("#copyAddr").addEventListener("click", () => copy(c.creator));
    const amtEl = $("#amt");
    let myBal = 0, quoteSeq = 0;

    async function paintQuote() {
      const n = Math.max(1, Math.min(100, parseInt(amtEl.value, 10) || 1));
      const seq = ++quoteSeq;
      const buying = tradeMode === "buy";
      const total = buying ? await api.quoteBuy(c.creator, n) : await api.quoteSell(c.creator, n);
      if (seq !== quoteSeq || id !== renderId) return;
      const go = $("#go");
      const value = buying ? curvePrice(c.supply, n) : c.supply > n ? curvePrice(c.supply - n, n) : 0n;
      const f = fees(value, c.share);
      let note = "";
      let ok = total > 0n;
      if (buying && !total) note = c.supply >= c.maxSupply ? "All keys are held. Wait for someone to sell." : `Only ${c.maxSupply - c.supply} keys left.`;
      if (!buying) {
        if (c.supply <= n) { ok = false; note = "The last key in a club can't be sold."; }
        else if (wallet.addr && myBal < n) { ok = false; note = myBal ? `You hold ${myBal} key${myBal > 1 ? "s" : ""}.` : "You don't hold any keys in this club."; }
      }
      $("#quote").innerHTML = `
        <div><dt>Key price</dt><dd>${eth(value)}</dd></div>
        <div><dt>Fee (4%)</dt><dd>${buying ? "+" : "−"} ${eth(f.total)}</dd></div>
        <div class="total"><dt>${buying ? "You pay" : "You receive"}</dt><dd>${ok ? eth(total) : "–"}</dd></div>`;
      go.className = "btn btn-block " + (buying ? "btn-jelly" : "btn-sell");
      go.textContent = !wallet.addr ? "Connect wallet" : `${buying ? "Buy" : "Sell"} ${n} key${n > 1 ? "s" : ""}`;
      go.disabled = !!wallet.addr && !ok;
      $("#tnote").textContent = note || (buying ? "Network fee is paid separately. Any extra you send is refunded." : "If the price drops more than 2% before your sale confirms, it is cancelled.");
      go.dataset.n = n;
      go.dataset.total = total.toString();
    }

    $$("[data-mode]").forEach((b) => b.addEventListener("click", () => {
      tradeMode = b.dataset.mode;
      $$("[data-mode]").forEach((x) => x.classList.toggle("on", x === b));
      paintQuote();
    }));
    $("#minus").addEventListener("click", () => { amtEl.value = Math.max(1, (parseInt(amtEl.value, 10) || 1) - 1); paintQuote(); });
    $("#plus").addEventListener("click", () => { amtEl.value = Math.min(100, (parseInt(amtEl.value, 10) || 1) + 1); paintQuote(); });
    amtEl.addEventListener("input", paintQuote);

    $("#go").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (!wallet.addr) return openModal();
      const n = +btn.dataset.n;
      const total = BigInt(btn.dataset.total || "0");
      const ok = tradeMode === "buy"
        ? await runTx(btn, () => api.buy(c.creator, n, (total * 102n) / 100n), `Bought ${n} ${c.name} key${n > 1 ? "s" : ""}`)
        : await runTx(btn, () => api.sell(c.creator, n, (total * 98n) / 100n), `Sold ${n} ${c.name} key${n > 1 ? "s" : ""}`);
      if (ok) route();
    });

    // side data
    const clubsMap = new Map([[c.creator.toLowerCase(), c]]);
    api.trades(c.creator, 10).then((list) => {
      if (id !== renderId) return;
      $("#ctrades").innerHTML = list.length ? list.map((t) => tradeRow(t, clubsMap)).join("") : `<div class="empty">No trades yet.</div>`;
    }).catch(() => { if (id === renderId) $("#ctrades").innerHTML = `<div class="empty">Could not load trades.</div>`; });
    api.holders(c.creator).then((list) => {
      if (id !== renderId) return;
      list.sort((a, b) => b.bal - a.bal);
      const more = list.length - 10;
      $("#cholders").innerHTML = list.length ? list.slice(0, 10).map((h, i) => `
        <div class="li"><span class="mono muted" style="width:22px">${i + 1}</span>
        <div class="grow"><b>${same(h.addr, wallet.addr) ? "You" : same(h.addr, c.creator) ? esc(c.name) + " (creator)" : short(h.addr)}</b></div>
        <div class="right">${h.bal} key${h.bal > 1 ? "s" : ""}<span>${((h.bal / c.supply) * 100).toFixed(1)}%</span></div></div>`).join("") + (more > 0 ? `<div class="li muted" style="font-size:14px">and ${more} more holder${more > 1 ? "s" : ""}</div>` : "")
        : `<div class="empty">No holders yet.</div>`;
    }).catch(() => { if (id === renderId) $("#cholders").innerHTML = `<div class="empty">Could not load holders.</div>`; });

    if (wallet.addr) {
      const [bal, rew] = await Promise.all([api.balance(c.creator, wallet.addr), api.pending(c.creator, wallet.addr)]);
      if (id !== renderId) return;
      myBal = bal;
      const sellable = Math.min(bal, c.supply - 1);
      const worth = sellable > 0 ? await api.quoteSell(c.creator, sellable) : 0n;
      if (id !== renderId) return;
      $("#pos").innerHTML = `<h3>Your position</h3>
        <dl class="rows">
          <div><dt>Keys you hold</dt><dd>${bal}</dd></div>
          <div><dt>Sell value now</dt><dd>${eth(worth)}</dd></div>
          <div><dt>Unclaimed rewards</dt><dd>${eth(rew)}</dd></div>
        </dl>
        <button class="btn btn-ghost btn-block" id="claimOne" type="button" ${rew > 0n ? "" : "disabled"}>Claim rewards</button>`;
      $("#claimOne").addEventListener("click", async (e) => {
        if (await runTx(e.currentTarget, () => api.claim([c.creator]), `Claimed ${eth(rew)}`)) route();
      });
    }
    await paintQuote();

    if (isOwner) await creatorTools($("#owner"), c, id);
  }

  async function creatorTools(el, c, id) {
    const cred = await api.credits(wallet.addr);
    if (id !== renderId || !el) return;
    el.innerHTML = `<h3>Creator tools</h3>
      <dl class="rows"><div><dt>Your fee earnings</dt><dd>${eth(cred)}</dd></div></dl>
      <button class="btn btn-jelly btn-block" id="wd" type="button" ${cred > 0n ? "" : "disabled"}>Withdraw earnings</button>
      <div class="form" style="margin-top:20px">
        <div class="field"><label for="shareUp">Holder share: <span id="shareOut">${pct(c.share)}</span></label>
          <input id="shareUp" type="range" min="${c.share}" max="10000" step="500" value="${c.share}" style="accent-color:var(--violet)">
          <span class="hint">You can raise this any time. It can never go back down.</span></div>
        <button class="btn btn-ghost" id="shareBtn" type="button" disabled>Raise holder share</button>
      </div>`;
    $("#wd", el).addEventListener("click", async (e) => { if (await runTx(e.currentTarget, () => api.withdraw(), `Withdrew ${eth(cred)}`)) route(); });
    const s = $("#shareUp", el);
    s.addEventListener("input", () => { $("#shareOut", el).textContent = pct(s.value); $("#shareBtn", el).disabled = +s.value <= c.share; });
    $("#shareBtn", el).addEventListener("click", async (e) => { if (await runTx(e.currentTarget, () => api.raiseShare(+s.value), `Holder share raised to ${pct(s.value)}`)) route(); });
  }

  function copy(text) {
    const done = () => toast("Contract address copied");
    try {
      navigator.clipboard.writeText(text).then(done, () => toast(esc(text)));
    } catch { toast(esc(text)); }
  }

  // ------------------------------------------------------------------ launch / edit
  async function launchPage(id) {
    let existing = null;
    if (wallet.addr) {
      try { existing = await api.club(wallet.addr); } catch { /* treat as new */ }
      if (id !== renderId) return;
    }
    const editing = !!existing;
    const v = existing || { name: "", handle: "", avatar: "", bio: "", maxSupply: 100, share: 2000, creator: wallet.addr || ZERO, supply: 1, holders: 1 };
    view.innerHTML = `
      <div class="page-title"><div><p class="eyebrow">Creator studio</p><h1>${editing ? "Your club." : "Open your club."}</h1></div>
      ${editing ? `<a class="btn btn-ghost" href="#/club/${existing.creator}">View your club</a>` : ""}</div>
      <div class="split2">
        <form class="panel form" id="lf" novalidate>
          <div class="two">
            <div class="field"><label for="f-name">Club name</label><input class="input" id="f-name" maxlength="40" required value="${esc(v.name)}" placeholder="Mira Sol"></div>
            <div class="field"><label for="f-handle">X handle</label>${privyOn()
              ? `<input class="input" id="f-handle" readonly value="${esc(xUser() || (editing ? cleanHandle(v.handle) : ""))}" placeholder="Link your X account">
                 ${xUser() ? `<span class="hint">Verified with X ✓</span>` : `<button class="btn btn-ghost btn-sm" id="linkX" type="button" style="justify-self:start">Link X account</button>`}`
              : `<input class="input" id="f-handle" maxlength="32" value="${esc(cleanHandle(v.handle))}" placeholder="@yourname">`}</div>
          </div>
          <div class="field"><label for="f-avatar">Profile picture URL</label><input class="input" id="f-avatar" maxlength="300" value="${esc(v.avatar)}" placeholder="https://…/me.jpg">
            <span class="hint">Optional. Paste a link to an image that starts with https://.</span></div>
          <div class="field"><label for="f-bio">Bio</label><textarea class="input" id="f-bio" maxlength="280" placeholder="What do holders get?">${esc(v.bio)}</textarea>
            <span class="hint" id="bioCount">${v.bio.length}/280</span></div>
          ${editing ? "" : `
          <div class="field"><label for="f-max">Total keys</label><input class="input" id="f-max" type="number" min="2" max="5000" value="${v.maxSupply}" inputmode="numeric">
            <span class="hint" id="maxHint"></span></div>
          <div class="field"><label for="f-share">Share of your 3% fee with holders</label>
            <div class="range"><input id="f-share" type="range" min="0" max="10000" step="500" value="${v.share}"><output id="shareVal">${pct(v.share)}</output></div>
            <span class="hint">You can raise this later, never lower it.</span></div>`}
          <p class="note" id="ferr" style="color:var(--bad)" hidden></p>
          <button class="btn btn-jelly" id="fsubmit" type="submit">${!wallet.addr ? "Connect wallet to launch" : editing ? "Save profile" : "Launch club"}</button>
          ${editing ? "" : `<p class="note">Launching costs only the network fee. You get key #1 for free. Total keys can't be changed later.</p>`}
        </form>
        <div class="stack">
          <p class="eyebrow">Preview</p>
          <div id="preview"></div>
          ${editing ? `<div class="panel" id="owner"></div>` : ""}
        </div>
      </div>`;

    const val = (s) => $(s)?.value ?? "";
    const paint = () => {
      const max = Math.max(2, Math.min(5000, parseInt(val("#f-max"), 10) || v.maxSupply));
      const share = editing ? v.share : +val("#f-share");
      const p = { ...v, name: val("#f-name") || "Your club", handle: val("#f-handle"), avatar: val("#f-avatar"), maxSupply: max, share, buyPrice: editing ? v.buyPrice : curvePrice(1, 1) + fees(curvePrice(1, 1), share).total };
      $("#preview").innerHTML = clubCard(p).replace('class="key"', 'class="key" style="pointer-events:none"');
      if (!editing) {
        $("#shareVal").textContent = pct(share);
        $("#maxHint").textContent = `Key #2 costs ${fmt(curvePrice(1, 1))} ${SYM}. Key #${max} costs ${fmt(curvePrice(max - 1, 1))} ${SYM}.`;
      }
      $("#bioCount").textContent = `${val("#f-bio").length}/280`;
    };
    $$("#lf input, #lf textarea").forEach((el) => el.addEventListener("input", paint));
    paint();
    $("#linkX")?.addEventListener("click", () => { try { window.KeyedPrivy.linkTwitter(); } catch (e) { toast(esc(errMsg(e)), true); } });
    if (editing) creatorTools($("#owner"), existing, id);

    $("#lf").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!wallet.addr) return openModal();
      const err = $("#ferr");
      const f = { name: val("#f-name").trim(), handle: privyOn() ? (xUser() || (editing ? cleanHandle(v.handle) : "")) : cleanHandle(val("#f-handle")), avatar: val("#f-avatar").trim(), bio: val("#f-bio").trim() };
      const problems = [];
      if (!f.name) problems.push("Add a club name.");
      if (new TextEncoder().encode(f.name).length > 40) problems.push("Club name is too long.");
      if (f.avatar && !/^https:\/\//i.test(f.avatar)) problems.push("Profile picture link must start with https://.");
      if (new TextEncoder().encode(f.bio).length > 280) problems.push("Bio is too long.");
      if (!editing) {
        f.maxSupply = parseInt(val("#f-max"), 10);
        f.share = +val("#f-share");
        if (!(f.maxSupply >= 2 && f.maxSupply <= 5000)) problems.push("Total keys must be between 2 and 5,000.");
      }
      err.hidden = !problems.length;
      err.textContent = problems.join(" ");
      if (problems.length) return;
      const btn = $("#fsubmit");
      const ok = editing
        ? await runTx(btn, () => api.updateProfile(f), "Profile saved")
        : await runTx(btn, () => api.launch(f), `${f.name} is live`);
      if (ok) location.hash = `#/club/${wallet.addr}`;
    });
  }

  // ------------------------------------------------------------------ portfolio
  async function mePage(id) {
    if (!wallet.addr) {
      view.innerHTML = `<div class="page-title"><div><p class="eyebrow">My keys</p><h1>Your keys.</h1></div></div>
        <div class="panel empty"><b>Connect your wallet</b>Your keys, rewards and creator earnings show up here.<div style="margin-top:16px"><button class="btn btn-jelly" id="pc" type="button">Connect wallet</button></div></div>`;
      $("#pc").addEventListener("click", openModal);
      return;
    }
    view.innerHTML = `<div class="page-title"><div><p class="eyebrow">My keys · ${short(wallet.addr)}</p><h1>Your keys.</h1></div>
      <button class="btn btn-ghost" id="disc" type="button">Disconnect</button></div>
      <div class="skeleton"></div>`;
    $("#disc").addEventListener("click", disconnect);
    try {
      const [holdings, clubs, cred, wbal] = await Promise.all([api.holdings(wallet.addr), api.clubs(), api.credits(wallet.addr), api.walletBalance(wallet.addr)]);
      if (id !== renderId) return;
      const map = new Map(clubs.map((c) => [c.creator.toLowerCase(), c]));
      const rows = await Promise.all(holdings.map(async (h) => {
        const c = map.get(h.club.toLowerCase());
        const sellable = Math.min(h.bal, (c?.supply || 1) - 1);
        const worth = sellable > 0 ? await api.quoteSell(h.club, sellable) : 0n;
        return { ...h, c, worth };
      }));
      if (id !== renderId) return;
      const totalWorth = rows.reduce((s, r) => s + r.worth, 0n);
      const totalRew = rows.reduce((s, r) => s + r.reward, 0n);
      const mine = map.get(wallet.addr.toLowerCase());
      view.innerHTML = `<div class="page-title"><div><p class="eyebrow">My keys · ${short(wallet.addr)}</p><h1>Your keys.</h1></div>
        <div class="cta"><span class="chip">Wallet: ${eth(wbal)}</span><button class="btn btn-ghost btn-sm" id="disc" type="button">Disconnect</button></div></div>
        ${!DEMO && wbal === 0n ? `<div class="panel" style="margin-bottom:20px">You need some ${SYM} on ${esc(NET.name)} to trade. Send or bridge ${SYM} to <span class="mono">${short(wallet.addr)}</span>.</div>` : ""}
        <div class="sum">
          <div class="panel"><span class="eyebrow">Keys worth</span><strong>${eth(totalWorth)}</strong><span class="muted">If you sold everything now</span></div>
          <div class="panel"><span class="eyebrow">Unclaimed rewards</span><strong>${eth(totalRew)}</strong>
            <button class="btn btn-jelly btn-sm" id="claimAll" type="button" ${totalRew > 0n ? "" : "disabled"}>Claim all</button></div>
          <div class="panel"><span class="eyebrow">Creator earnings</span><strong>${eth(cred)}</strong>
            ${mine || cred > 0n ? `<button class="btn btn-ghost btn-sm" id="wdAll" type="button" ${cred > 0n ? "" : "disabled"}>Withdraw</button>` : `<a class="btn btn-ghost btn-sm" href="#/launch">Launch your club</a>`}</div>
        </div>
        <div class="panel"><h3>Holdings</h3><div class="list">
          ${rows.length ? rows.map((r) => `<a class="li" href="#/club/${r.club}">${r.c ? avatar(r.c, "sm") : ""}
            <div class="grow"><b>${esc(r.c?.name || short(r.club))}</b><span>${r.bal} key${r.bal === 1 ? "" : "s"}${r.reward > 0n ? ` · ${eth(r.reward)} to claim` : ""}</span></div>
            <div class="right">${eth(r.worth)}<span>sell value</span></div></a>`).join("")
            : `<div class="empty"><b>No keys yet</b><a href="#/explore">Find a club to join</a></div>`}
        </div></div>`;
      $("#disc").addEventListener("click", disconnect);
      $("#claimAll").addEventListener("click", async (e) => {
        const list = rows.filter((r) => r.reward > 0n).map((r) => r.club);
        if (await runTx(e.currentTarget, () => api.claim(list), `Claimed ${eth(totalRew)}`)) route();
      });
      $("#wdAll")?.addEventListener("click", async (e) => { if (await runTx(e.currentTarget, () => api.withdraw(), `Withdrew ${eth(cred)}`)) route(); });
    } catch (e) {
      if (id === renderId) view.innerHTML = `<div class="panel empty" style="margin-top:24px">${loadError(e)}</div>`;
    }
  }

  function infoSections() {
    return `
    <section class="sec">
      <div class="head"><h2>Three steps in.</h2><p>Connect a wallet, pick a creator, hold their key. Creators can launch their own club in a minute.</p></div>
      <div class="steps">
        <article class="step"><span class="n">1</span><h3>Connect</h3><p>Log in with email or X, or use MetaMask, Rabby or any Robinhood Chain wallet.</p></article>
        <article class="step"><span class="n">2</span><h3>Collect</h3><p>Buy a creator's key in ${SYM}. The price rises with every key sold, and you can sell back any time.</p></article>
        <article class="step"><span class="n">3</span><h3>Launch your club</h3><p>Pick how many keys exist and how much of your fee goes to holders. Your first key is free.</p></article>
      </div>
    </section>

    <section class="sec">
      <div class="fees">
        <div>
          <p class="eyebrow">Fee per trade</p>
          <div class="big grad">4%</div>
          <p class="muted" style="max-width:38ch">Every buy and sell pays one flat fee, split automatically by the contract.</p>
        </div>
        <div>
          <div class="splitbar" role="img" aria-label="1% to Keyed, 3% to the creator and holders">
            <div style="flex:1;background:var(--cyan)">1%</div>
            <div style="flex:3;background:linear-gradient(90deg,var(--violet),var(--pink) 60%,var(--orange))">3%</div>
          </div>
          <ul class="legend">
            <li><i style="background:var(--cyan)"></i><div><b>Keyed · 1%</b> <span>keeps the platform running.</span></div></li>
            <li><i style="background:var(--violet)"></i><div><b>Creator · 3%</b> <span>goes to the club owner.</span></div></li>
            <li><i style="background:var(--orange)"></i><div><b>Holders</b> <span>get the part of the 3% the creator chooses to share. It can only go up.</span></div></li>
          </ul>
        </div>
      </div>
    </section>

    <section class="sec">
      <div class="head"><h2>Good to know.</h2></div>
      <div class="faq">
        <details open><summary>What is a key?</summary><p>A key is a tradable spot in a creator's club. Each club has a fixed number of keys, and holders earn whatever fee share the creator has set.</p></details>
        <details><summary>How is the price set?</summary><p>By a curve in the contract: key number n costs (n − 1)² ÷ 16,000 ${SYM}. Early keys are cheap and the price climbs as more are held. Selling moves the price back down.</p></details>
        <details><summary>Can a creator add more keys later?</summary><p>No. The maximum is fixed at launch, so there is no surprise dilution.</p></details>
        <details><summary>Where do my rewards go?</summary><p>They build up in the contract. Claim them any time from your portfolio, even after you sell your keys.</p></details>
        <details><summary>Is this safe?</summary><p>Keyed is an experiment and the contract has not been audited. Only use money you are comfortable losing.</p></details>
      </div>
    </section>

`;
  }

  function infoPage() {
    const scan = !DEMO && NET.explorer ? `${NET.explorer}/address/${ADDRESS}` : "";
    view.innerHTML = `<div class="page-title"><div><p class="eyebrow">How it works</p><h1>A closer look.</h1></div>
      ${scan ? `<a class="btn btn-ghost" href="${scan}" target="_blank" rel="noopener">Contract on Blockscout</a>` : ""}</div>
      ${infoSections()}`;
  }

  // ------------------------------------------------------------------ messages
  function messagesPage() {
    view.innerHTML = `<div class="page-title"><div><p class="eyebrow">Messages</p><h1>Talk to your club.</h1></div></div>
      <div class="panel empty"><b>Coming soon</b>Holder chats and creator posts are on the way. For now, collect and trade keys in Discover.
      <div style="margin-top:16px"><a class="btn btn-jelly" href="#/explore">Go to Discover</a></div></div>`;
  }

  // ================================================================== router
  function route() {
    const id = ++renderId;
    const parts = (location.hash.replace(/^#\/?/, "") || "").split("/");
    const page = parts[0] || "";
    $$("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === page || (page === "club" && a.dataset.nav === "explore")));
    $("#tabbar").hidden = page === "" || page === "info";
    $(".dock").hidden = page === "";
    document.body.classList.toggle("has-dock", page !== "");
    const dock = page === "" ? "home" : page === "info" ? "info" : page === "me" ? "wallet" : "app";
    $$("[data-dock]").forEach((t) => t.classList.toggle("on", t.dataset.dock === dock));
    if (page === "info") return infoPage();
    if (page === "explore") return explore(id);
    if (page === "club" && /^0x[0-9a-fA-F]{40}$/.test(parts[1] || "")) return clubPage(id, parts[1]);
    if (page === "launch") return launchPage(id);
    if (page === "me") return mePage(id);
    if (page === "messages") return messagesPage();
    return landing(id);
  }
  let lastPage = null;
  window.addEventListener("hashchange", () => {
    const p = location.hash.split("/")[1] || "";
    if (p !== lastPage) window.scrollTo(0, 0);
    lastPage = p;
    route();
  });

  // banner
  const banner = $("#banner");
  if (DEMO) {
    banner.innerHTML = "<b>Demo mode.</b> Play money only. Nothing here is onchain yet.";
    banner.hidden = false;
  } else if (NET.chainId === NETS.testnet.chainId) {
    banner.innerHTML = `<b>${esc(NET.name)}.</b> Test ${SYM} only.`;
    banner.hidden = false;
  }
  if (CFG.X_URL) $("#xlink").href = CFG.X_URL;
  const TOKEN_CA = (CFG.TOKEN_CA || "").trim();
  if (TOKEN_CA) {
    $("#tokenCaShort").textContent = short(TOKEN_CA);
    $("#tokenCa").addEventListener("click", () => copy(TOKEN_CA));
    $("#tokenCa").hidden = false;
  }
  if (!DEMO) {
    if (NET.explorer) { $("#caLink").href = `${NET.explorer}/address/${ADDRESS}`; $("#caLink").hidden = false; }
    $("#footNote").hidden = false;
  }

  paintWallet();
  route();
  autoConnect();
})();
