#!/usr/bin/env bash
# StableNaira live-meeting deployment ceremony.
#
# Usage:
#   bash scripts/ceremony.sh testnet              # full testnet ceremony
#   GROUP=mainnet bash scripts/ceremony.sh        # mainnet ceremony (requires explicit confirm)
#   PHASES="deploy oracle verify queue commit summary" bash scripts/ceremony.sh testnet
#   START_AT=queue bash scripts/ceremony.sh testnet     # resume from a specific phase
#
# Phases (executed in order):
#   1. deploy   – per-chain stack deploy + queue BRIDGE_ROLE / mintCap (timelocked)
#   2. oracle   – BSC-only StableNairaPriceOracle deploy
#   3. verify   – per-chain Etherscan verify
#   4. queue    – per-chain queueSetRemoteRouter for each peer
#   5. commit   – per-chain wait-and-commit (blocks ~1h for the timelock to elapse)
#   6. summary  – pretty-print every deployed address
#
# Set SKIP_WAIT=1 to skip the 1-hour wait (only useful on a forked/local network
# where you can mine through the timelock).

set -euo pipefail

GROUP="${1:-${GROUP:-testnet}}"

CYAN=$'\033[96m'
MAGENTA=$'\033[95m'
GREEN=$'\033[92m'
YELLOW=$'\033[93m'
RED=$'\033[91m'
GRAY=$'\033[90m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

# The chain list comes from the template's deploymentGroups rather than being
# hardcoded here. The queue/commit phases below already resolve the group that
# way (PHASE=queue-all / commit-all read GROUP), so a hardcoded list here would
# deploy a subset and then try to wire chains that were never deployed.
TEMPLATE="ignition/parameters/deploy-stable-naira-stack.template.json"
read -r -a NETWORKS <<< "$(
  node -e '
    const g = process.argv[1];
    const t = require("./" + process.argv[2]);
    const n = t.deploymentGroups[g];
    if (!n) { console.error("unknown group " + g); process.exit(1); }
    process.stdout.write(n.join(" "));
  ' "$GROUP" "$TEMPLATE"
)" || { echo "${RED}Could not resolve deployment group '${GROUP}' from ${TEMPLATE}${RESET}"; exit 1; }

case "$GROUP" in
  testnet)
    BSC_NETWORK="testnet"
    ;;
  mainnet)
    BSC_NETWORK="mainnet"
    if [[ "${I_REALLY_MEAN_MAINNET:-}" != "yes" ]]; then
      echo "${RED}${BOLD}Refusing to run mainnet ceremony without I_REALLY_MEAN_MAINNET=yes${RESET}"
      echo "${YELLOW}Set I_REALLY_MEAN_MAINNET=yes and re-run, but only after testnet validation.${RESET}"
      exit 1
    fi
    ;;
  *)
    echo "${RED}Unknown deployment group '${GROUP}'. Expected: testnet | mainnet${RESET}"
    exit 1
    ;;
esac

ALL_PHASES=(deploy oracle verify queue commit summary)
PHASES=(${PHASES:-${ALL_PHASES[@]}})

# START_AT lets us resume the ceremony at a given phase.
if [[ -n "${START_AT:-}" ]]; then
  filtered=()
  found=0
  for p in "${PHASES[@]}"; do
    if [[ "$found" == "0" && "$p" != "$START_AT" ]]; then continue; fi
    found=1
    filtered+=("$p")
  done
  PHASES=("${filtered[@]}")
fi

banner() {
  echo ""
  echo "${MAGENTA}╔══════════════════════════════════════════════════════════════════════════════╗${RESET}"
  echo "${MAGENTA}║${RESET}  ${BOLD}${CYAN}$1${RESET}"
  if [[ -n "${2:-}" ]]; then
    echo "${MAGENTA}║${RESET}  ${GRAY}$2${RESET}"
  fi
  echo "${MAGENTA}╚══════════════════════════════════════════════════════════════════════════════╝${RESET}"
}

run_phase() {
  local phase="$1" net="$2"
  echo ""
  echo "${MAGENTA}── phase=${BOLD}${phase}${RESET}${MAGENTA} net=${BOLD}${net}${RESET} ${MAGENTA}──${RESET}"
  PHASE="$phase" SKIP_WAIT="${SKIP_WAIT:-}" \
    npx hardhat run scripts/deploy.ts --network "$net"
}

teleprint() {
  local msg="$1"
  for ((i=0; i<${#msg}; i++)); do
    printf "%s" "${msg:$i:1}"
    sleep 0.005
  done
  echo ""
}

teleprint "${GREEN}> Booting StableNaira deployment uplink…${RESET}"
teleprint "${GREEN}> Group:   ${BOLD}${GROUP}${RESET}"
teleprint "${GREEN}> Targets: ${BOLD}${NETWORKS[*]}${RESET}"
teleprint "${GREEN}> Phases:  ${BOLD}${PHASES[*]}${RESET}"
sleep 0.4

# Pre-flight balance check (skip with SKIP_PRECHECK=1).
if [[ "${SKIP_PRECHECK:-}" != "1" ]]; then
  banner "PHASE 0 / PRE-FLIGHT" "Confirming deployer wallet is funded on every target chain"
  if ! GROUP="$GROUP" npx hardhat run scripts/precheck.ts --network hardhat; then
    echo ""
    echo "${RED}${BOLD}Aborting: pre-flight balance check failed.${RESET}"
    echo "${YELLOW}Fund the deployer wallet via the faucets above, then re-run.${RESET}"
    echo "${GRAY}(Set SKIP_PRECHECK=1 to bypass this check.)${RESET}"
    exit 1
  fi
fi

for phase in "${PHASES[@]}"; do
  case "$phase" in
    deploy)
      banner "PHASE 1 / DEPLOY STACK" "Deploying StableNaira + ValidatorRegistry + MultisigVerifier + MessageTransmitter + TokenMessenger"
      for net in "${NETWORKS[@]}"; do
        run_phase deploy "$net"
      done
      ;;
    oracle)
      banner "PHASE 2 / ORACLE" "Deploying StableNairaPriceOracle on BSC only"
      run_phase oracle "$BSC_NETWORK"
      ;;
    verify)
      banner "PHASE 3 / VERIFY" "Submitting source code to block explorers"
      for net in "${NETWORKS[@]}"; do
        run_phase verify "$net" || true   # don't abort the ceremony if a single verify fails
      done
      ;;
    queue)
      banner "PHASE 4 / QUEUE WIRES" "Queueing cross-chain remote routers across all ${#NETWORKS[@]} chains (1-hour timelock starts now)"
      # New: single invocation queues every chain via JsonRpcProvider per chain.
      GROUP="$GROUP" PHASE=queue-all npx hardhat run scripts/deploy.ts --network "${NETWORKS[0]}"
      ;;
    commit)
      banner "PHASE 5 / COMMIT WIRES" "Single global countdown for the latest eta across all chains, then commits everywhere"
      # New: single invocation waits for global-latest eta then commits every chain.
      GROUP="$GROUP" PHASE=commit-all SKIP_WAIT="${SKIP_WAIT:-}" \
        npx hardhat run scripts/deploy.ts --network "${NETWORKS[0]}"
      ;;
    summary)
      banner "PHASE 6 / SUMMARY" "Pretty-print address book"
      run_phase summary "${NETWORKS[0]}"
      ;;
    *)
      echo "${RED}Unknown phase: $phase${RESET}"
      exit 1
      ;;
  esac
done

echo ""
echo "${GREEN}${BOLD}🚀  Ceremony complete.${RESET}"
