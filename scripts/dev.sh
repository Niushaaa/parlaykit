#!/usr/bin/env bash
# One-command local stack: anvil chain + contracts + quoter (DEMO venue) + demo page.
# Uses anvil's PUBLIC well-known dev keys — never use these anywhere real.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOYER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil #0
QUOTER_PK=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6     # anvil #9
QUOTER_ADDR=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720

command -v anvil >/dev/null || { echo "Install Foundry first: https://book.getfoundry.sh/getting-started/installation"; exit 1; }
cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT

echo "▶ anvil on :8545"
anvil --chain-id 31337 --silent &
sleep 2

echo "▶ deploying contracts"
cd "$ROOT/contracts"
[ -d lib/openzeppelin-contracts ] || forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 foundry-rs/forge-std --no-git
PRIVATE_KEY=$DEPLOYER_PK QUOTE_SIGNER=$QUOTER_ADDR forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast >/dev/null
cat deployments/31337.json

echo "▶ quoter on :8787 (DEMO venue on)"
cd "$ROOT/quoter"
[ -d node_modules ] || npm install --silent
CHAIN_ID=31337 DEMO=1 QUOTER_PRIVATE_KEY=$QUOTER_PK ADMIN_PRIVATE_KEY=$DEPLOYER_PK node src/server.js &
sleep 2

echo "▶ demo venue on http://127.0.0.1:5173  (add ?devwallet=1 to skip MetaMask)"
cd "$ROOT/demo" && python3 -m http.server 5173 --bind 127.0.0.1 >/dev/null 2>&1 &

echo
echo "Ready. Load /extension as an unpacked extension, open http://127.0.0.1:5173/?devwallet=1"
echo "Resolve a demo market:  cd quoter && CHAIN_ID=31337 QUOTER_PRIVATE_KEY=$QUOTER_PK ADMIN_PRIVATE_KEY=$DEPLOYER_PK node scripts/resolve.js btc-150k yes"
wait
