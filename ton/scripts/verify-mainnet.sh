#!/usr/bin/env bash
# Read-only on-chain verification of the TON mainnet StableNaira deploy.
# Uses toncenter v3 runGetMethod directly (no @ton/ton client, avoids the
# Orbs ton-access exit_code -13 quirk seen on Tact-generated getters).
set -euo pipefail

ART="$(cd "$(dirname "$0")"/.. && pwd)/../ignition/deployments/tonMainnet/addresses.json"
[ -f "$ART" ] || { echo "missing artifact: $ART"; exit 1; }

JETTON=$(jq -r '.contracts.stableNairaJettonMaster' "$ART")
MT=$(jq    -r '.contracts.messageTransmitter'       "$ART")
TM=$(jq    -r '.contracts.tokenMessenger'           "$ART")
REG=$(jq   -r '.contracts.validatorRegistry'        "$ART")
DEPLOYER=$(jq -r '.deployer'                        "$ART")

V_HEX="0x2503Cba0edfEe3F790D14bA141b92B11816EC987"

api() {
  local addr=$1 method=$2 stack=${3:-"[]"}
  curl -sS https://toncenter.com/api/v3/runGetMethod \
    -H "content-type: application/json" \
    -d "{\"address\":\"$addr\",\"method\":\"$method\",\"stack\":$stack}"
}

# Returns ".stack[0].value" hex/int (as a string), retrying transient `null`s.
get_num() {
  local v
  for attempt in 1 2 3 4 5; do
    v=$(api "$1" "$2" "${3:-"[]"}" | jq -r '.stack[0].value')
    if [ "$v" != "null" ] && [ -n "$v" ]; then echo "$v"; return; fi
    sleep 2
  done
  echo "$v"
}
get_bool() {
  # Tact returns 0 / -1 for false / true on the stack
  local v; v=$(get_num "$1" "$2" "${3:-"[]"}")
  case "$v" in 0|0x0) echo false ;; -1|0x-1|-0x1|0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff) echo true ;; *) echo "unknown=$v" ;; esac
}

PASS=0
FAIL=0
check() {
  local label=$1 actual=$2 expected=$3
  if [ "$actual" = "$expected" ]; then
    echo "  [PASS] $label = $actual"
    PASS=$((PASS+1))
  else
    echo "  [FAIL] $label: expected $expected, got $actual"
    FAIL=$((FAIL+1))
  fi
}

echo "ValidatorRegistry  ($REG):"
check "finalized"        "$(get_bool $REG isFinalized)"          true
check "validatorCount"   "$(get_num  $REG validatorCountValue)"  0x1
check "threshold"        "$(get_num  $REG thresholdValue)"       0x1
V_DEC=$(python3 -c "print(int('$V_HEX', 16))")
V_STACK="[{\"type\":\"num\",\"value\":\"$V_DEC\"}]"
check "isValidator(0x2503...)" "$(get_bool $REG isValidator "$V_STACK")" true

echo
echo "MessageTransmitter ($MT):"
check "localDomain"      "$(get_num  $MT localDomainValue)"   0xf4241  # 1_000_001
check "threshold mirror" "$(get_num  $MT thresholdValue)"     0x1
check "paused"           "$(get_bool $MT isPausedValue)"      false
check "isValidator(0x2503...)" "$(get_bool $MT isValidator "$V_STACK")" true

echo
echo "StableNairaJettonMaster ($JETTON):"
check "paused"           "$(get_bool $JETTON isPaused)"  false
check "mintCap"          "$(get_num  $JETTON mintCapValue)"   0x0

# isMinter takes an Address - need to push as tuple slice. Skip for now; we'll
# verify TokenMessenger->jetton minter wire via the on-chain side: jetton must
# accept a Mint message only from the TM in production.

echo
echo "TokenMessenger    ($TM):"
check "paused"           "$(get_bool $TM isPausedValue)"  false
check "feeBps"           "$(get_num  $TM feeBpsValue)"    0x0

router_check() {
  local label=$1 domain=$2 expected=$3
  local STACK="[{\"type\":\"num\",\"value\":\"$domain\"}]"
  local actual
  actual=$(get_num $TM remoteRouter "$STACK")
  # normalize: actual is 0x-prefixed; expected may be too
  local a_lower e_lower
  a_lower=$(echo "$actual" | tr 'A-F' 'a-f')
  e_lower=$(echo "$expected" | tr 'A-F' 'a-f')
  if [ "$a_lower" = "$e_lower" ]; then
    echo "  [PASS] remoteRouter[$label, $domain] = $actual"
    PASS=$((PASS+1))
  else
    echo "  [FAIL] remoteRouter[$label, $domain]: expected $expected, got $actual"
    FAIL=$((FAIL+1))
  fi
}

router_check BSC        56    0xbe1ed9d08141d4c8331ba30ecb64ff42f1512f31
router_check Ethereum   1     0xafe9bbce49428ec10f833190cfdc19eb72a1b59f
router_check Base       8453  0xafe9bbce49428ec10f833190cfdc19eb72a1b59f
router_check AssetChain 42420 0x534ffe8ac515bc5ab681d86973748d85041bfe8d

echo
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" = 0 ]
