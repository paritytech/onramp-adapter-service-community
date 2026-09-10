# syntax=docker/dockerfile:1-labs
#
# Build and run onramp-adapter-service. Two stages: a build image that compiles
# TypeScript to dist/, and a slim runtime that holds NO secret and NO baked-in
# config. Three separate things are mounted at runtime: the Meld API key, the
# JWT signing key, and config.json. The two keys are distinct secrets, each its
# own file from its own Kubernetes Secret, so a compromise of one does not
# expose the other. For config.json see docs/configuration.md
# section.
# A missing mount stops the process; it never resolves to a placeholder we
# shipped.
#
# The image deliberately contains no key. The runtime `node` user runs the
# service and reads the secrets from where the orchestrator mounts them.

# ---- build -------------------------------------------------------------------
FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS build

# System CA bundle for TLS to Meld and the People-chain WebSocket transport.
# node:22-slim omits ca-certificates.crt; the release notes where that bites are
# that HTTPS calls and the WSS transport handshake both rely on the system CAs.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY package.json package-lock.json ./
# `npm ci` already refuses to run against a lockfile that disagrees with package.json and never
# writes one; that is the guarantee pnpm and yarn spell `--frozen-lockfile`. npm has no such flag: it
# printed `Unknown cli config` and ignored it, so the enforcement everyone read here came from
# `ci` itself and the flag was noise in the build log.
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

# ---- runtime stage -----------------------------------------------------------
FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS runtime

# Same CA rationale as the build stage; also curl for the healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ARG VCS_REF=main
ARG BUILD_DATE=""
ARG REGISTRY_PATH=ghcr.io/paritytech
ARG PROJECT_NAME=onramp-adapter-service

LABEL io.parity.image.authors="cicd-team@parity.io" \
      io.parity.image.vendor="Parity Technologies" \
      io.parity.image.title="${REGISTRY_PATH}/${PROJECT_NAME}" \
      io.parity.image.description="${PROJECT_NAME}" \
      io.parity.image.source="https://github.com/paritytech/onramp-adapter-service-community/blob/${VCS_REF}/Dockerfile" \
      io.parity.image.documentation="https://github.com/paritytech/onramp-adapter-service-community/blob/${VCS_REF}/README.md" \
      io.parity.image.revision="${VCS_REF}" \
      io.parity.image.created="${BUILD_DATE}"

WORKDIR /app
COPY --from=build /src/dist ./dist
COPY package.json package-lock.json ./
# Production deps only: no test/build/dev toolchain in the runtime image.
RUN npm ci --omit=dev

ENV NODE_ENV=production
ENV CONFIG_PATH=/run/config/config.json

# Non-root. The secrets are mounted as files owned by this user (or root, with
# the container dropping privileges).
USER node

EXPOSE 8080/tcp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8080/health >/dev/null || exit 1

ENTRYPOINT ["node"]
CMD ["dist/main.js"]