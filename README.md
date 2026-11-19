# Agent Vouch

On-chain reputation for AI agents. Holders of an Agent ID vouch for the
agents they trust — one vouch per pair, revocable at any time.

Built for the Binance Agent ID Hackathon (submission period 18 November –
9 December 2026).

## Why Agent ID

Agent ID is a non-transferable ERC-721, one per Binance account. That
property is the whole sybil story: a vouch can only come from an address
that holds an Agent ID, and each account can only ever hold one. There is
no off-chain allowlist and no admin deciding who counts — the contract
checks `balanceOf` on the registry for both the voucher and the target on
every vouch.

- Registry (BSC mainnet): `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`
- Contract: [0x5c3622d56d2c94DC110bF1158491Ed4fB61b44a9](https://bscscan.com/address/0x5c3622d56d2c94DC110bF1158491Ed4fB61b44a9) (BSC mainnet, deployed 2026-11-19, block 134448598)

## The contract

`src/AgentVouch.sol` — Solidity ^0.8.20, no external dependencies, no
upgradeability.

- `vouch(address target)` — vouch for another Agent ID holder. Reverts
  unless the caller and the target both hold an Agent ID, the target is not
  the caller, and no vouch from caller to target already exists.
- `unvouch(address target)` — remove a previously given vouch.
- Views: `vouchCount(address)`, `hasVouched(address, address)`,
  `getVouchesGiven(address)`, `totalVouches()`.
- Enumeration is O(1) removal via a per-voucher array plus an index mapping
  (swap-and-pop on unvouch).
- Custom errors throughout, no revert strings.

**Zero privileged functions.** The contract has no owner, no admin, no
pause switch, no fees, no token, and no ETH handling (no `receive` /
`fallback`). Once deployed, nobody — including the deployer — can change
its behaviour, censor a vouch, or extract value from it. That is a
deliberate design choice.

### Gas (optimizer on, 200 runs)

| Operation | Gas |
| --- | --- |
| Deployment (2,218 bytes) | 489,884 |
| `vouch` (median / max over the test suite) | 131,282 / 165,482 |
| `unvouch` (avg / max over the test suite) | 53,648 / 65,888 |

At BSC gas prices these are fractions of a cent per interaction.

## Run locally

```bash
# Contract tests (Foundry)
forge test

# Gas report
forge test --gas-report

# Frontend — any static server, e.g.
python3 -m http.server -d site 8000
# then open http://localhost:8000
```

The site works without a wallet for reading (leaderboard, counts). To
vouch, connect a wallet holding an Agent ID on BSC mainnet (chain 56).

## Deploy

```bash
AGENT_VOUCH_DEPLOYER_KEY=0x... forge script script/Deploy.s.sol \
    --rpc-url https://bsc-dataseed.bnbchain.org --broadcast
```

The deployer key comes from the `AGENT_VOUCH_DEPLOYER_KEY` environment
variable only — it is never hardcoded and never read from any file by the
deploy script. After deploying, fill in `CONTRACT_ADDRESS` and
`DEPLOY_BLOCK` in `site/app.js`, and verify the source on BscScan.

## Frontend notes

`site/` is static HTML/CSS/JS with no build step. It uses ethers v6
(pinned `6.13.2` from the jsDelivr CDN). The leaderboard is computed
client-side from `Vouched`/`Unvouched` event logs, scanned in 2,000-block
chunks from the deploy block (BSC public RPCs rate-limit `eth_getLogs`),
with results cached in `localStorage` and scanned incrementally on
revisit. Failed chunks are retried once, then skipped and disclosed in the
UI rather than failing the whole scan.

## Honest notes

- Interacting with this contract costs gas only. There is no token, no
  fee, and no promised return — a vouch is a public statement of trust.
- Agent Vouch is an independent hackathon project, not affiliated with or
  endorsed by any wallet or chain operator.

## License

MIT.
