ARG UBI_IMAGE=registry.access.redhat.com/ubi9/ubi-minimal:latest

# ---------------------------------------------------------------------------
# Build stage: download/verify Node.js and install production dependencies.
# Nothing from this stage except the node binary and node_modules is shipped.
# ---------------------------------------------------------------------------
FROM ${UBI_IMAGE} AS build

ARG NODE_VERSION=26.13.1
# SHA-256 of the official node-v${NODE_VERSION}-linux-<arch>.tar.xz archives
# (source: https://nodejs.org/dist/v26.13.1/SHASUMS256.txt)
ARG NODE_SHA256_X64=5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864
ARG NODE_SHA256_ARM64=89e1853138db51e8b82d3e98ba9c0d3f2956a28e5e55ea1b7e12d25aae92d5dd

# (libatomic is needed to run the node/npm binaries during the build)
RUN microdnf install -y --setopt=install_weak_deps=0 --nodocs tar gzip xz libatomic \
    && microdnf clean all

# Install Node.js from the official binary distribution over HTTPS,
# verifying the archive against a pinned SHA-256 checksum.
RUN set -eux; \
    case "$(uname -m)" in \
        x86_64)  NODE_ARCH=x64;   NODE_SHA256="${NODE_SHA256_X64}" ;; \
        aarch64) NODE_ARCH=arm64; NODE_SHA256="${NODE_SHA256_ARM64}" ;; \
        *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    ARCHIVE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"; \
    curl --proto '=https' --tlsv1.2 -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${ARCHIVE}"; \
    echo "${NODE_SHA256}  ${ARCHIVE}" | sha256sum -c -; \
    tar -xJf "${ARCHIVE}" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f "${ARCHIVE}"; \
    node --version; \
    npm --version

WORKDIR /app

# Install production dependencies only (lockfile-exact)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---------------------------------------------------------------------------
# Runtime stage: minimal UBI + node binary + app. No package managers, no
# compilers, no archive tools.
# ---------------------------------------------------------------------------
FROM ${UBI_IMAGE}

# libatomic is a runtime dependency of the official Node.js binaries
RUN microdnf install -y --setopt=install_weak_deps=0 --nodocs libatomic \
    && microdnf clean all

COPY --from=build /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/

# Writable location for the SQLite database (mount a volume here). The
# container runs as numeric UID 1001, which needs no /etc/passwd entry.
RUN mkdir -p /data && chown -R 1001:1001 /data

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/bookstore.db

USER 1001

EXPOSE 3000

# Probe /health on the address the server actually binds to.
# (Podman only honours HEALTHCHECK with `--format docker`; compose.yaml also defines one.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch(`http://${process.env.BIND_ADDRESS||'127.0.0.1'}:${process.env.PORT||3000}/health`,{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "src/server.js"]
