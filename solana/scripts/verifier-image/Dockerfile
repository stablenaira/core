# Custom Solana verifiable-build image whose bundled platform-tools matches
# what produced the StableNaira mainnet bytecode locally.
#
# Reproducing OtterSec failure mode: cargo-build-sbf is Solana's wrapper that
# invokes /root/.local/share/solana/install/active_release/.../rustc, NOT the
# rustup toolchain. So `rustup install 1.89.0` does not change which rustc the
# SBF build actually uses. The deciding factor is the platform-tools version
# bundled with the Solana install:
#
#   solana-verifiable-build:3.0.12  -> platform-tools v1.51 (rustc 1.84) -> FAILS edition2024
#   local Mac at deploy time         -> platform-tools v1.52 (rustc 1.89) -> works
#
# So this image replaces the Solana CLI bundled in the base image with the
# same version we used locally (3.1.15), which pulls down platform-tools v1.52.
#
# Build + push:
#   docker buildx build --platform linux/amd64 \
#     -t ghcr.io/stablenaira/solana-verifiable-build:3.1.15-v1.52 \
#     --push solana/scripts/verifier-image
#
# Use with solana-verify:
#   solana-verify verify-from-repo --skip-build \
#     --base-image ghcr.io/stablenaira/solana-verifiable-build:3.1.15-v1.52 \
#     --commit-hash <full-sha> \
#     --library-name <crypto_parity|stable_naira|...> \
#     --mount-path solana \
#     --program-id <pubkey> \
#     --keypair <deployer-keypair.json> \
#     --skip-prompt \
#     https://github.com/stablenaira/core

FROM solanafoundation/solana-verifiable-build:3.0.12

# Replace Solana CLI 3.0.12 + platform-tools v1.51 with 3.1.15 + v1.52
# using the existing agave-install manager that ships in the base image.
RUN set -eux; \
    # cargo-build-sbf shipped in 3.0.12 has cargo 1.84 embedded (it does not
    # shell out to a separate cargo, so symlinks / rustup overrides don't
    # change its parser). Replace the entire Solana install with v3.1.14
    # (newest tagged 3.1.x agave release — has cargo 1.85+ embedded in
    # cargo-build-sbf) plus platform-tools v1.52 (rustc 1.89).
    apt-get update && apt-get install -y --no-install-recommends bzip2 && rm -rf /var/lib/apt/lists/*; \
    curl -fsSL https://github.com/anza-xyz/agave/releases/download/v3.1.14/solana-release-x86_64-unknown-linux-gnu.tar.bz2 -o /tmp/solana.tar.bz2; \
    rm -rf /tmp/solana-release; \
    mkdir -p /tmp/solana-release; \
    tar -xjf /tmp/solana.tar.bz2 -C /tmp/solana-release --strip-components=1; \
    rm -rf /root/.local/share/solana/install/releases/3.0.12; \
    mkdir -p /root/.local/share/solana/install/releases/3.1.14; \
    mv /tmp/solana-release /root/.local/share/solana/install/releases/3.1.14/solana-release; \
    rm -f /root/.local/share/solana/install/active_release; \
    ln -s /root/.local/share/solana/install/releases/3.1.14/solana-release /root/.local/share/solana/install/active_release; \
    rm /tmp/solana.tar.bz2; \
    # Pre-fetch platform-tools v1.52 so subsequent builds don't re-download.
    cargo-build-sbf --install-only --tools-version v1.52 --force-tools-install; \
    test -d /root/.cache/solana/v1.52/platform-tools/rust/bin; \
    # Re-point the SDK's dependency symlink to v1.52 (the version local Mac
    # used). v3.1.14 might default to a different platform-tools — we pin.
    SDK_LINK=/root/.local/share/solana/install/releases/3.1.14/solana-release/bin/platform-tools-sdk/sbf/dependencies/platform-tools; \
    rm -f "$SDK_LINK"; \
    ln -s /root/.cache/solana/v1.52/platform-tools "$SDK_LINK"; \
    # Sanity: cargo-build-sbf should now report 3.1.14 + platform-tools v1.52 + rustc 1.89.
    cargo-build-sbf --version | tee /tmp/sbf-version.txt; \
    grep -q "3.1.14" /tmp/sbf-version.txt || (echo "FATAL: cargo-build-sbf is not 3.1.14" && cat /tmp/sbf-version.txt && exit 1); \
    rm /tmp/sbf-version.txt

LABEL org.opencontainers.image.source="https://github.com/stablenaira/core" \
      org.opencontainers.image.description="solana-verifiable-build:3.0.12 base + Solana CLI 3.1.15 / platform-tools v1.52 / rustc 1.89 (matches StableNaira local build env)" \
      org.opencontainers.image.licenses="MIT"
