# syntax=docker/dockerfile:1
# Turjuman container image.
#
# Stages:
#   pnpm       pnpm on the pinned Node base (shared by the next two)
#   build      full install + `pnpm build`; keeps devDependencies and ffmpeg, so it is also
#              the compose `test` and `dev` target
#   prod-deps  a fresh production-only install
#   runtime    the image that runs: dist/, public/, prod node_modules, templates, ffmpeg, tini
#
# Multi-arch (linux/amd64 + linux/arm64) and the base-image bump procedure: docs/docker.md.
#
# NODE_IMAGE is pinned by the multi-arch INDEX digest (`docker buildx imagetools inspect
# node:24-slim`, top-level "Digest:"), never a per-platform manifest digest, so the same pin
# resolves on amd64 and arm64. This digest is node 24.21.0 on Debian 12 (bookworm-slim).
ARG NODE_IMAGE=node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG PNPM_VERSION=12.6.0

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS pnpm
ARG PNPM_VERSION
# Same pnpm as package.json "packageManager", so pnpm never tries to fetch another version
# (the test container runs with network_mode: none).
RUN npm install --global --no-fund --no-audit "pnpm@${PNPM_VERSION}" \
 && npm cache clean --force \
 && pnpm --version
WORKDIR /app

# ---------------------------------------------------------------------------------------------
FROM pnpm AS build
# ffmpeg: the integration tests spawn it (`make test` runs in this stage).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# pnpm-workspace.yaml holds allowBuilds (pnpm 12 strictDepBuilds), so it must be present
# before the install, together with the lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=turjuman-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
# Dependencies are fixed at build time. Don't let `pnpm test:ci` / `pnpm dev` re-verify them at
# run time: as the non-root dev user that check tries to reinstall node_modules and fails, and
# the test container has no network.
ENV pnpm_config_verify_deps_before_run=false \
    pnpm_config_update_notifier=false
COPY . .
# dist/ and public/ belong to `node` so the dev profile (which runs as node) can rebuild them.
# COPY keeps host modes, and pnpm-lock.yaml / pnpm-workspace.yaml are 0600 on some hosts:
# make every source file world-readable (node_modules untouched) so pnpm works as `node`.
RUN pnpm build \
 && chown -R node:node /app/dist /app/public \
 && find /app -path /app/node_modules -prune -o -type f ! -perm -o=r -exec chmod a+r {} +

# ---------------------------------------------------------------------------------------------
FROM pnpm AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm's isolated node_modules uses relative symlinks into node_modules/.pnpm, so copying
# /app/node_modules into another stage with the same WORKDIR keeps it intact.
RUN --mount=type=cache,id=turjuman-pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --store-dir /pnpm/store

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# ffmpeg: capture/decoding; pulseaudio-utils + alsa-utils: Linux audio (pactl, arecord);
# tini: PID 1 (signal forwarding, zombie reaping), so compose must NOT set `init: true`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg pulseaudio-utils alsa-utils tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# TZ: session folders use local time. Verified: node:24-slim (bookworm) ships tzdata, and
# `new Date().toString()` prints CEST/CET with TZ=Europe/Amsterdam, so no extra package.
ENV NODE_ENV=production \
    CONFIG_DIR=/app/config \
    DATA_DIR=/app/data \
    TZ=Europe/Amsterdam \
    SERVER_HOST=0.0.0.0 \
    CAPTIONS_CONTAINER=1
COPY --from=prod-deps /app/node_modules ./node_modules
# The defaults: config.example.yaml (documentation), languages.yaml and glossaries/ (used when
# config/ has no copy). The server makes config/config.yaml itself on its first start.
COPY package.json config.example.yaml languages.yaml ./
COPY glossaries ./glossaries
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
# Mount points; compose bind-mounts ./config and ./data over them (always directories, so
# atomic renames work). Everything else is read-only at runtime (compose read_only: true).
RUN mkdir -p /app/config /app/data \
 && chown node:node /app/config /app/data \
 && chmod -R a+rX /app/package.json /app/config.example.yaml /app/languages.yaml /app/glossaries
USER node
# 8765: caption pages, overlay, control page, API, /health.  7000: audio bridge (TCP, raw PCM).
EXPOSE 8765 7000
# /health answers 200 whenever the server is up, regardless of session state.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --start-interval=1s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8765/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# `docker compose run --rm captions doctor` (or devices, bench ...) replaces CMD.
ENTRYPOINT ["tini", "--", "node", "dist/main.js"]
CMD ["run"]
