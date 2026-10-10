# Contributing

This repository is generated from [turjuman-translator/website](https://github.com/turjuman-translator/website), where Turjuman is developed. Please open issues and pull requests there.

Turjuman is free for the ummah and open source (MIT). Fixes, translations of the interface and
new languages are all welcome.

## Getting started

You need Node.js 24 and pnpm 12. ffmpeg is only needed for server-side audio capture and file
replay.

```bash
pnpm install
pnpm build            # server and app
pnpm test             # unit tests (offline)
pnpm typecheck
pnpm lint             # Biome; `pnpm exec biome check --write .` fixes formatting
```

Run the server without spending money: `turjuman replay <provider.jsonl>` replays a recorded
session with no network calls.

## Docker: tests, development mode and the image

- `make test`: typecheck, lint and unit/integration tests in the `build` stage with
  `network_mode: none`, proving the non-live tests need no network. It always rebuilds the
  test image first.
- `make e2e`: starts a `replay` service from the app image (FakeProvider replaying
  `test/fixtures/${E2E_FIXTURE:-soniox-tts-1}.jsonl --speed 1 --loop`, throwaway tmpfs
  config/data; an optional `test/fixtures/e2e/config.yaml` becomes its config) and the pinned
  `mcr.microsoft.com/playwright:v1.63.0-noble` container, which installs
  `playwright-core@1.63.0` inside the container and runs
  `node --experimental-strip-types test/e2e/run.ts` with the repo mounted at `/work`. The
  Playwright container shares the replay container's network namespace, so:
  - `E2E_BASE_URL=http://127.0.0.1:8765`: a secure context, so `getUserMedia` (fake mic) works;
  - `E2E_INSECURE_URL=http://replay:8765`: the same server on a non-loopback origin, for the
    "HTTPS needed" banner test;
  - `PLAYWRIGHT_CHANNEL` is unset: the image's bundled Chromium is used.

  It does not touch the running service (no published ports, separate image tag).
- `make dev`: stops the service (same ports), then runs `pnpm dev` (tsx watch + web watch)
  with `src/`, `web/`, `scripts/`, `config/` and `data/` mounted, as the `node` user. When you
  leave it, start the service again with `make up`. On Windows, file watching across the Docker
  Desktop mount can be slow; dev mode is mainly for Linux and macOS.
- `make replay LOG=<path inside data/>`: stops the service, replays a provider log on the same
  ports for overlay work, and restarts the service afterwards (also on Ctrl-C).

**Bumping the Node base image.** The Dockerfile pins `node:24-slim` by its multi-arch **index**
digest, so the same pin works on amd64 and arm64:

```bash
docker buildx imagetools inspect node:24-slim     # copy the top-level "Digest:" (the index), not a per-platform one
# edit ARG NODE_IMAGE=node:24-slim@sha256:<digest> in Dockerfile
make build && make test && make restart
```

Pinned versions to bump the same way, deliberately: `pnpm` (`ARG PNPM_VERSION`, equal to
`packageManager` in package.json), and in `compose.yaml`
`mcr.microsoft.com/playwright:v1.63.0-noble` (equal to the `playwright-core` version in
compose.yaml and package.json). In the Dockerfile, tini is PID 1, so compose does not set
`init: true` for the service.

**Multi-arch build (linux/amd64 + linux/arm64).** The default `docker` builder cannot build
several platforms at once; use a `docker-container` builder:

```bash
docker buildx create --name turjuman-multi --driver docker-container --bootstrap   # once
docker buildx build --builder turjuman-multi --platform linux/amd64,linux/arm64 -t turjuman:multi .
# add --push -t <registry>/turjuman:<tag> to publish both architectures
```

Without `--push` the result stays in the build cache, which is enough to prove both
architectures build.

## Before you open a pull request

- `pnpm typecheck && pnpm lint && pnpm test` pass.
- The offline smoke tests still pass for the part you changed:
  - `scripts/smoke-screens.ts` (accounts, screens, screen links);
  - `scripts/smoke-hosted.ts` (organisations and their keys);
  - `scripts/smoke-session.ts` (sessions);
  - `scripts/smoke-fast-blocks.ts` (caption blocks);
  - `scripts/eval-honorifics.ts` (Islamic terms).

  Run each with `pnpm exec tsx <script>`.
- **Tests never call Soniox.** Use the fakes in the smoke scripts or a recorded
  `provider.jsonl`. Live runs cost money and belong in a manual check.
- **No secrets anywhere:** no API keys, tokens or passwords in code, tests, fixtures, logs or
  commit messages.

## How the code is written

- TypeScript strict mode, ESM, no `any`. Small modules with one clear job.
- A comment explains *why*, in plain words; the code says *what*.
- **Browser pages:**
  - no inline scripts or styles (the Content-Security-Policy forbids them);
  - no CDNs (the pages work offline);
  - the app has no dark mode.
- **Design:** colours, type and radii come from the tokens in `web/shared/brand.css`.
- **Interface text:** keep it short. Every string exists in English, Dutch and Arabic
  (`web/shared/app-i18n.ts`); Arabic layouts are right-to-left.

## Religious content

- **Quran text** is shown exactly as published by Tanzil: never edit, normalise or re-type it.
  Its licence and the translations' non-commercial terms are in `NOTICE`.
- **Translations of khutbahs:** changes that affect them (glossaries, honorifics) need
  a regression case in `scripts/eval-honorifics.ts`. Allah is never translated as "God".

## Reporting a security problem

See [SECURITY.md](SECURITY.md). Please do not open a public issue for it.
