/* Agent Vouch frontend.
 *
 * Static page, no build step. Reads go through a public BSC RPC so the
 * leaderboard works without a wallet; writes go through the visitor's
 * injected wallet (window.ethereum).
 *
 * Deployment checklist (fill after deploy):
 *   1. CONTRACT_ADDRESS — the deployed AgentVouch address.
 *   2. DEPLOY_BLOCK — the block number the contract was deployed in.
 */

"use strict";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

// fill after deploy — the deployed AgentVouch contract on BSC mainnet.
const CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000000";

// fill after deploy — the block the contract was deployed in. Event scanning
// starts here; leave at 0 and the leaderboard stays in "not deployed" state.
const DEPLOY_BLOCK = 0;

// Agent ID registry (SPACE ID Agent ID, ERC-721) on BSC mainnet.
const REGISTRY_ADDRESS = "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F";

const BSC_CHAIN_ID = 56;
const BSC_CHAIN_ID_HEX = "0x38";
const PUBLIC_RPCS = [
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-dataseed1.defibit.io",
  "https://bsc-dataseed1.ninicoin.io",
];

// BSC eth_getLogs is rate-limited on public endpoints: small chunks, a pause
// between chunks, one retry per chunk, and failed chunks are skipped (and
// disclosed) rather than failing the whole scan.
const LOG_CHUNK_BLOCKS = 2000;
const CHUNK_DELAY_MS = 300;
const LEADERBOARD_SIZE = 25;
const CACHE_KEY = "agentvouch:cache:v1:" + CONTRACT_ADDRESS.toLowerCase();

const VOUCH_ABI = [
  "function vouch(address target)",
  "function unvouch(address target)",
  "function vouchCount(address target) view returns (uint256)",
  "function hasVouched(address voucher, address target) view returns (bool)",
  "function getVouchesGiven(address voucher) view returns (address[])",
  "function totalVouches() view returns (uint256)",
  "function agentIdRegistry() view returns (address)",
  "event Vouched(address indexed voucher, address indexed target)",
  "event Unvouched(address indexed voucher, address indexed target)",
  "error CallerHasNoAgentId()",
  "error TargetHasNoAgentId()",
  "error CannotVouchForSelf()",
  "error AlreadyVouched()",
  "error NoVouchExists()",
];

const REGISTRY_ABI = ["function balanceOf(address account) view returns (uint256)"];

const ERROR_MESSAGES = {
  CallerHasNoAgentId: "Your wallet does not hold an Agent ID, so it cannot vouch.",
  TargetHasNoAgentId: "That address does not hold an Agent ID, so it cannot be vouched for.",
  CannotVouchForSelf: "You cannot vouch for yourself.",
  AlreadyVouched: "You already vouch for this agent.",
  NoVouchExists: "You do not vouch for this agent.",
};

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  // "disconnected" | "connecting" | "connected" | "wrong-network" | "error"
  connection: "disconnected",
  account: null,
  isHolder: false,
  readContract: null, // public-RPC contract instance (reads only)
  registry: null, // public-RPC registry instance
  counts: new Map(), // target (lowercase) -> active vouch count
  lastScannedBlock: null,
  scanning: false,
};

const $ = (id) => document.getElementById(id);

const DEPLOYED =
  CONTRACT_ADDRESS !== "0x0000000000000000000000000000000000000000" && DEPLOY_BLOCK > 0;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shortAddress(addr) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function bscscanAddressUrl(addr) {
  return "https://bscscan.com/address/" + addr;
}

function bscscanTxUrl(hash) {
  return "https://bscscan.com/tx/" + hash;
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = "status" + (kind ? " " + kind : "");
}

function friendlyError(err) {
  if (!err) return "Unknown error.";
  if (err.code === "ACTION_REJECTED" || err.code === 4001) {
    return "Transaction rejected in your wallet. Nothing was sent.";
  }
  // ethers v6 decodes custom errors into err.errorName when in the ABI.
  const name = err.errorName || err.info?.error?.data?.errorName;
  if (name && ERROR_MESSAGES[name]) return ERROR_MESSAGES[name];
  if (err.shortMessage) return err.shortMessage;
  return err.message || String(err);
}

/* ------------------------------------------------------------------ */
/* Read provider (public RPC, no wallet needed)                        */
/* ------------------------------------------------------------------ */

function makeReadProvider() {
  // Try each public RPC until one answers; the first healthy one wins.
  return (async () => {
    for (const url of PUBLIC_RPCS) {
      try {
        const provider = new ethers.JsonRpcProvider(url, BSC_CHAIN_ID, {
          staticNetwork: true,
        });
        await provider.getBlockNumber();
        return provider;
      } catch {
        // try the next endpoint
      }
    }
    throw new Error("All public BSC endpoints are unreachable right now.");
  })();
}

/* ------------------------------------------------------------------ */
/* Leaderboard: event scan with localStorage cache                     */
/* ------------------------------------------------------------------ */

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data.lastBlock !== "number" || typeof data.counts !== "object") return null;
    return data;
  } catch {
    return null;
  }
}

function saveCache() {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        lastBlock: state.lastScannedBlock,
        counts: Object.fromEntries(state.counts),
        updatedAt: Date.now(),
      })
    );
  } catch {
    // Storage full or unavailable — the page still works, just rescans.
  }
}

function renderLeaderboard() {
  const list = $("leaderboard");
  list.innerHTML = "";

  const ranked = [...state.counts.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, LEADERBOARD_SIZE);

  $("stat-agents").textContent = String(
    [...state.counts.values()].filter((c) => c > 0).length
  );

  if (ranked.length === 0) {
    const li = document.createElement("li");
    li.className = "lb-empty";
    li.textContent = "No vouches yet — be the first to vouch for an agent you trust.";
    list.appendChild(li);
    return;
  }

  ranked.forEach(([target, count], i) => {
    const li = document.createElement("li");

    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = String(i + 1);

    const addr = document.createElement("span");
    addr.className = "lb-address";
    const link = document.createElement("a");
    link.href = bscscanAddressUrl(target);
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = target;
    addr.appendChild(link);

    const countEl = document.createElement("span");
    countEl.className = "lb-count";
    countEl.textContent = count + (count === 1 ? " vouch" : " vouches");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-small btn-outline";
    btn.textContent = "Vouch";
    btn.disabled = state.connection !== "connected" || !state.isHolder;
    btn.addEventListener("click", () => vouchFor(target));

    li.append(rank, addr, countEl, btn);
    list.appendChild(li);
  });
}

async function queryChunk(contract, filter, fromBlock, toBlock) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await contract.queryFilter(filter, fromBlock, toBlock);
    } catch (err) {
      if (attempt === 0) await sleep(1000);
      else throw err;
    }
  }
}

async function scanLeaderboard() {
  if (state.scanning || !state.readContract) return;
  state.scanning = true;
  const statusEl = $("board-status");
  const footnoteEl = $("board-footnote");

  try {
    const latest = await state.readContract.runner.getBlockNumber();

    // Start from the cache if present, else from the deploy block.
    let from = DEPLOY_BLOCK;
    const cached = loadCache();
    if (cached && cached.lastBlock >= DEPLOY_BLOCK && cached.lastBlock < latest) {
      state.counts = new Map(
        Object.entries(cached.counts).map(([k, v]) => [k.toLowerCase(), v])
      );
      state.lastScannedBlock = cached.lastBlock;
      from = cached.lastBlock + 1;
      renderLeaderboard();
    } else if (cached && cached.lastBlock >= latest) {
      state.counts = new Map(
        Object.entries(cached.counts).map(([k, v]) => [k.toLowerCase(), v])
      );
      state.lastScannedBlock = cached.lastBlock;
      renderLeaderboard();
      statusEl.textContent = "Up to date as of block " + latest.toLocaleString() + ".";
      return;
    }

    let failedChunks = 0;
    // Highest block such that every block from `from` to it was scanned
    // without a gap. The cache watermark only ever advances this far, so a
    // failed range is retried on the next load instead of silently skipped.
    let contiguousEnd = from - 1;

    for (let start = from; start <= latest; start += LOG_CHUNK_BLOCKS) {
      const end = Math.min(start + LOG_CHUNK_BLOCKS - 1, latest);
      statusEl.textContent =
        "Scanning blocks " + start.toLocaleString() + "–" + end.toLocaleString() + "…";
      try {
        const [vouched, unvouched] = await Promise.all([
          queryChunk(state.readContract, state.readContract.filters.Vouched(), start, end),
          queryChunk(state.readContract, state.readContract.filters.Unvouched(), start, end),
        ]);
        for (const ev of vouched) {
          const t = ev.args.target.toLowerCase();
          state.counts.set(t, (state.counts.get(t) || 0) + 1);
        }
        for (const ev of unvouched) {
          const t = ev.args.target.toLowerCase();
          state.counts.set(t, Math.max(0, (state.counts.get(t) || 0) - 1));
        }
        if (start === contiguousEnd + 1) contiguousEnd = end;
      } catch {
        failedChunks++;
        // Skip the failed range and keep going; disclosed below.
      }
      renderLeaderboard();
      await sleep(CHUNK_DELAY_MS);
    }

    state.lastScannedBlock = contiguousEnd;
    saveCache();

    $("stat-scanned").textContent = Math.max(0, contiguousEnd - DEPLOY_BLOCK + 1).toLocaleString();
    statusEl.textContent = "Up to date as of block " + contiguousEnd.toLocaleString() + ".";
    if (failedChunks > 0) {
      footnoteEl.hidden = false;
      footnoteEl.textContent =
        failedChunks +
        " block range(s) could not be read from the public RPC and were skipped — " +
        "counts may be slightly low. Press Refresh to retry.";
    } else {
      footnoteEl.hidden = true;
    }
  } catch (err) {
    statusEl.textContent = "Could not load the leaderboard: " + friendlyError(err);
  } finally {
    state.scanning = false;
  }
}

async function refreshTotal() {
  if (!state.readContract) return;
  try {
    const total = await state.readContract.totalVouches();
    $("stat-total").textContent = total.toString();
  } catch {
    $("stat-total").textContent = "–";
  }
}

/* ------------------------------------------------------------------ */
/* Wallet connection                                                   */
/* ------------------------------------------------------------------ */

function updateWalletUI() {
  const btn = $("connect-btn");
  const label = $("account-label");
  const badge = $("id-badge");

  if (state.connection === "connected" && state.account) {
    btn.textContent = "Connected";
    btn.disabled = true;
    label.hidden = false;
    label.textContent = shortAddress(state.account);
    badge.hidden = false;
    if (state.isHolder) {
      badge.textContent = "Agent ID holder ✓";
      badge.className = "badge holder";
    } else {
      badge.textContent = "No Agent ID";
      badge.className = "badge no-id";
    }
  } else if (state.connection === "wrong-network") {
    btn.textContent = "Switch to BSC";
    btn.disabled = false;
    label.hidden = false;
    label.textContent = shortAddress(state.account);
    badge.hidden = true;
  } else if (state.connection === "connecting") {
    btn.textContent = "Connecting…";
    btn.disabled = true;
  } else {
    btn.textContent = "Connect wallet";
    btn.disabled = false;
    label.hidden = true;
    badge.hidden = true;
  }

  renderLeaderboard();
  refreshMyVouches();
}

async function checkHolderStatus(provider, account) {
  if (!state.registry) return false;
  try {
    const balance = await state.registry.balanceOf(account);
    return balance > 0n;
  } catch {
    return false;
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    setStatus($("vouch-status"), "No wallet detected. Install a wallet with an injected provider (e.g. MetaMask or Binance Wallet) and try again.", "error");
    return;
  }

  if (state.connection === "wrong-network") {
    await switchToBsc();
    return;
  }

  state.connection = "connecting";
  updateWalletUI();

  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    const accounts = await provider.send("eth_requestAccounts", []);
    const network = await provider.getNetwork();

    state.account = ethers.getAddress(accounts[0]);
    if (Number(network.chainId) !== BSC_CHAIN_ID) {
      state.connection = "wrong-network";
      setStatus($("vouch-status"), "Your wallet is on the wrong network. Switch to BSC mainnet (chain 56) to vouch.", "error");
    } else {
      state.isHolder = await checkHolderStatus(provider, state.account);
      state.connection = "connected";
      setStatus($("vouch-status"), "", "");
      if (!state.isHolder) {
        setStatus($("vouch-status"), "This wallet does not hold an Agent ID, so it cannot vouch. Only Agent ID holders can vouch.", "error");
      }
    }
  } catch (err) {
    state.connection = "disconnected";
    state.account = null;
    setStatus($("vouch-status"), friendlyError(err), "error");
  }
  updateWalletUI();
}

async function switchToBsc() {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BSC_CHAIN_ID_HEX }],
    });
  } catch (err) {
    if (err.code === 4902) {
      try {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: BSC_CHAIN_ID_HEX,
              chainName: "BNB Smart Chain",
              nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
              rpcUrls: ["https://bsc-dataseed.bnbchain.org"],
              blockExplorerUrls: ["https://bscscan.com"],
            },
          ],
        });
      } catch (addErr) {
        setStatus($("vouch-status"), friendlyError(addErr), "error");
      }
    } else {
      setStatus($("vouch-status"), friendlyError(err), "error");
    }
  }
}

function watchWalletEvents() {
  if (!window.ethereum || !window.ethereum.on) return;
  window.ethereum.on("accountsChanged", (accounts) => {
    if (!accounts || accounts.length === 0) {
      state.connection = "disconnected";
      state.account = null;
      state.isHolder = false;
      updateWalletUI();
    } else {
      connectWallet();
    }
  });
  window.ethereum.on("chainChanged", () => connectWallet());
}

/* ------------------------------------------------------------------ */
/* Vouch / unvouch                                                     */
/* ------------------------------------------------------------------ */

function getWriteContract() {
  const provider = new ethers.BrowserProvider(window.ethereum);
  return provider.getSigner().then((signer) => new ethers.Contract(CONTRACT_ADDRESS, VOUCH_ABI, signer));
}

function parseTarget(input) {
  const value = (input || "").trim();
  if (!value) return { error: "Enter an agent wallet address." };
  if (!ethers.isAddress(value)) return { error: "That is not a valid address." };
  const target = ethers.getAddress(value);
  if (state.account && target.toLowerCase() === state.account.toLowerCase()) {
    return { error: "You cannot vouch for yourself." };
  }
  return { target };
}

async function vouchFor(targetInput) {
  const statusEl = $("vouch-status");
  if (state.connection !== "connected") {
    setStatus(statusEl, "Connect your wallet first.", "error");
    return;
  }
  if (!state.isHolder) {
    setStatus(statusEl, "Only Agent ID holders can vouch.", "error");
    return;
  }

  const parsed = parseTarget(targetInput);
  if (parsed.error) {
    setStatus(statusEl, parsed.error, "error");
    return;
  }
  const target = parsed.target;

  setStatus(statusEl, "Checking the vouch on-chain before signing…", "");
  try {
    const contract = await getWriteContract();
    // Simulate first: catches every revert (no ID, duplicate, self) before
    // the wallet ever asks the user to sign.
    await contract.vouch.staticCall(target);

    setStatus(statusEl, "Confirm the transaction in your wallet…", "");
    const tx = await contract.vouch(target);
    setStatus(statusEl, "Transaction submitted. Waiting for confirmation…", "");

    const receipt = await tx.wait();
    if (receipt.status === 1n || receipt.status === 1) {
      setStatus(statusEl, "Vouched for " + shortAddress(target) + ".", "ok");
    } else {
      setStatus(statusEl, "The transaction was submitted but reverted on-chain.", "error");
    }
  } catch (err) {
    setStatus(statusEl, friendlyError(err), "error");
    return;
  }
  await afterWrite();
}

async function unvouchFor(targetInput) {
  const statusEl = $("vouch-status");
  if (state.connection !== "connected") {
    setStatus(statusEl, "Connect your wallet first.", "error");
    return;
  }

  const parsed = parseTarget(targetInput);
  if (parsed.error) {
    setStatus(statusEl, parsed.error, "error");
    return;
  }
  const target = parsed.target;

  setStatus(statusEl, "Checking the unvouch on-chain before signing…", "");
  try {
    const contract = await getWriteContract();
    await contract.unvouch.staticCall(target);

    setStatus(statusEl, "Confirm the transaction in your wallet…", "");
    const tx = await contract.unvouch(target);
    setStatus(statusEl, "Transaction submitted. Waiting for confirmation…", "");

    const receipt = await tx.wait();
    if (receipt.status === 1n || receipt.status === 1) {
      setStatus(statusEl, "Vouch removed for " + shortAddress(target) + ".", "ok");
    } else {
      setStatus(statusEl, "The transaction was submitted but reverted on-chain.", "error");
    }
  } catch (err) {
    setStatus(statusEl, friendlyError(err), "error");
    return;
  }
  await afterWrite();
}

async function afterWrite() {
  // Re-scan from the last watermark so the new event is picked up.
  await refreshTotal();
  await scanLeaderboard();
  await refreshMyVouches();
}

/* ------------------------------------------------------------------ */
/* My vouches                                                          */
/* ------------------------------------------------------------------ */

async function refreshMyVouches() {
  const section = $("my-vouches-section");
  const list = $("my-vouches");
  const statusEl = $("my-vouches-status");

  if (state.connection !== "connected" || !state.readContract) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  list.innerHTML = "";
  statusEl.textContent = "Loading…";

  try {
    const given = await state.readContract.getVouchesGiven(state.account);
    if (given.length === 0) {
      statusEl.textContent = "You have not vouched for anyone yet.";
      return;
    }
    statusEl.textContent = "";
    for (const target of given) {
      const count = await state.readContract.vouchCount(target);
      const li = document.createElement("li");

      const addr = document.createElement("span");
      addr.className = "lb-address";
      const link = document.createElement("a");
      link.href = bscscanAddressUrl(target);
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = target;
      addr.appendChild(link);

      const countEl = document.createElement("span");
      countEl.className = "lb-count";
      countEl.textContent = count.toString() + (count === 1n ? " vouch" : " vouches");

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-small btn-danger-outline";
      btn.textContent = "Unvouch";
      btn.addEventListener("click", () => unvouchFor(target));

      li.append(addr, countEl, btn);
      list.appendChild(li);
    }
  } catch (err) {
    statusEl.textContent = "Could not load your vouches: " + friendlyError(err);
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  if (typeof ethers === "undefined") {
    $("board-status").textContent =
      "The ethers library failed to load from the CDN. Check your connection and reload the page.";
    return;
  }

  $("contract-address").textContent = DEPLOYED
    ? CONTRACT_ADDRESS
    : "not deployed yet";

  $("connect-btn").addEventListener("click", connectWallet);
  $("refresh-btn").addEventListener("click", () => {
    scanLeaderboard();
    refreshTotal();
  });
  $("vouch-form").addEventListener("submit", (e) => {
    e.preventDefault();
    vouchFor($("vouch-address").value);
  });
  watchWalletEvents();

  if (!DEPLOYED) {
    $("board-status").textContent =
      "The AgentVouch contract has not been deployed yet. The leaderboard will appear here once it is live.";
    $("stat-total").textContent = "–";
    $("stat-agents").textContent = "–";
    $("stat-scanned").textContent = "–";
    return;
  }

  try {
    const provider = await makeReadProvider();
    state.readContract = new ethers.Contract(CONTRACT_ADDRESS, VOUCH_ABI, provider);
    state.registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, provider);
  } catch (err) {
    $("board-status").textContent = friendlyError(err);
    return;
  }

  await refreshTotal();
  await scanLeaderboard();

  // If the wallet is already connected (e.g. page reload), restore the
  // session silently without prompting.
  if (window.ethereum) {
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send("eth_accounts", []);
      if (accounts.length > 0) await connectWallet();
    } catch {
      // Stay disconnected; the user can connect manually.
    }
  }
}

document.addEventListener("DOMContentLoaded", init);
