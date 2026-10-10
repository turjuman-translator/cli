# Docker, Makefile and operations

How to run Turjuman in Docker with the `make` targets. The raw `docker compose` command behind
each target is in the appendix at the end. `make` (or `make help`) prints every target and
variable.

**What you need:** Docker with Compose 2.24 or newer (`docker compose version`), git and GNU make.
There is no published image: `make up` builds it on this computer (the first time takes a few
minutes and needs internet).

**Nothing to set up by hand.** `make up` is also the first run: it creates `config/`, `data/` and
`.env` when they are missing (it never overwrites). On its first start the server makes
`config/config.yaml`, generates the admin token when it needs one (`config/admin.token`, mode
600) and downloads the Quran data into `data/quran/` in the background (again later when the
internet is not reachable). `make setup` does the same as `make up`'s first step and says what it
made; it is not needed. The image builds for amd64 and arm64. The container restarts by
itself (`restart: unless-stopped`), but Docker Desktop on Windows and macOS runs only while a user
is logged in: let the computer log in by itself.

## Quick start

### Windows (the OBS PC)

1. Install the prerequisites:
   - **Docker Desktop** with the WSL2 backend, with "Start Docker Desktop when you sign in"
     enabled. Check Docker Desktop's license terms for the mosque's organisation; Rancher
     Desktop or Podman Desktop with compose are alternatives.
   - **Git for Windows**, which provides Git Bash: `winget install Git.Git`
   - **GNU make**: `winget install ezwinports.make`
   - **ffmpeg** (only for the audio bridge): `winget install Gyan.FFmpeg`
2. Open **Git Bash** in the repository folder. Run every `make` command from Git Bash, not
   from PowerShell or cmd.
3. `make up`: it returns once the container is healthy.
4. `make admin` opens the app: create your admin account and add your Soniox key under
   **Keys** (or run `make keys`, or set `SONIOX_API_KEY` in `.env` before `make up`).
5. Make a screen in the app (**New screen**), switch it on, and put its screen link in OBS:
   `make screens` prints the links. Create the OBS shortcut with microphone access once:
   `make obs-shortcut` (see "OBS" below).
6. Optional, server-side capture (an overlay with a control dock, instead of the page's
   microphone): set `audio.input.kind: network` in `config/config.yaml`, `make restart`, then
   `make bridge-list` and `make bridge-install DEVICE="<name>"` (see "Audio bridge").

### macOS

Same as Windows, with Docker Desktop (or OrbStack) and `brew install ffmpeg`. The bridge
runs in a terminal: `make bridge-list`, then `make bridge DEVICE=<index>` (avfoundation
index, or the exact name). macOS asks once for microphone access for the terminal app.
There is no autostart script on macOS; keep the terminal open, or wrap
`scripts/audio-bridge.sh --device <index>` in a LaunchAgent.

The AirPlay Receiver of macOS also listens on port 7000, the bridge port. Docker still
publishes `127.0.0.1:7000` for the bridge, but if the bridge cannot connect, turn AirPlay
Receiver off (System Settings → General → AirDrop & Handoff), or set another `BRIDGE_PORT` in
`.env` and run `make up`.

### Linux

1. `make up`, then `make admin`. On Linux `make up` also writes `UID`, `GID` and
   `PULSE_SOCKET` into `.env`, because compose cannot see bash's `UID`.
2. For server-side capture: `make devices`, then set `audio.input.kind: device` with that
   PulseAudio/PipeWire source name in `config/config.yaml`, and `make restart`.

On Linux the container talks to the host's PipeWire/PulseAudio socket directly
(`compose.linux-audio.yaml`, selected by `AUDIO=pulse`, the Linux default), so the bridge
is not needed and OBS can keep using the same interface. `make up AUDIO=bridge` uses the
bridge setup instead.

### Moving from `pnpm turjuman start` to Docker

Docker keeps its settings and state in `config/` and `data/` of the checkout. Without Docker,
`pnpm turjuman start` keeps them in the checkout itself. To take your accounts, screens and keys
along, stop `pnpm turjuman start` (both use port 8765) and move the files that exist, in the
checkout:

```bash
mkdir -p config data
for f in config.yaml users.yaml screens.yaml presets.yaml keys.yaml orgs.yaml secret.key master.key admin.token tls; do
  if [ -e "$f" ]; then mv "$f" config/; fi
done
for d in transcripts quran usage recordings; do
  if [ -e "$d" ]; then mv "$d" data/; fi
done
make up
```

`make up` keeps the files that are there and adds what is missing. Moving, rather than
copying, keeps one copy of the accounts and keys, and keeps `tls/` (with its private keys) out
of the folder that Docker builds the image from. The `.env` with your API
keys stays where it is: compose passes it into the container. In `config/config.yaml`, keep
`server.port: 8765` and `server.https.port: 8443` (or `null`): the container listens on those,
and `HTTP_PORT` and `HTTPS_PORT` in `.env` choose the ports on this computer. With
`server.exposure: lan`, also set `CAPTIONS_BIND=0.0.0.0` in `.env` (see "Exposure" below).

### Updating

```bash
make backup
make update
```

`make update` runs `git pull --ff-only`, rebuilds the image, restarts the service and waits
until it is healthy. Update outside a khutbah. `config/`, `data/` and `.env` are not tracked
by git, so they stay as they are; new settings appear in `config.example.yaml`. For an older
install, see [the end of this page](#upgrading-an-older-install).

### Several instances on one computer

Each checkout is one instance with its own `config/` and `data/`. To run a second one next to
the first, for example a test copy, give it its own name, ports and image tags in its `.env`:

```bash
COMPOSE_PROJECT_NAME=turjuman-test
HTTP_PORT=8780
HTTPS_PORT=8781
BRIDGE_PORT=7080
CAPTIONS_IMAGE=turjuman-test:local
CAPTIONS_BUILD_IMAGE=turjuman-test:build
```

Every `make` target then works on that instance, e.g. `make up` prints `http://127.0.0.1:8780/app`.
Links for this computer (screen links, `turjuman screens url`) use these ports too.

Run `make` in the checkout of the instance you mean. In a checkout whose `.env` sets no
`COMPOSE_PROJECT_NAME`, every target, `make down` included, acts on the default project
`turjuman`.

## Server-side capture on Friday

Only with `audio.input.kind: device` or `network`. With screen links nothing needs starting or
stopping (the guide's "Friday checklist").

1. `make status` shows the container healthy, the bridge connected and an audio level.
2. Five minutes before the khutbah: `make start` (or Start in the OBS dock). It prints a
   one-line cost estimate first. The session stops by itself after 10 minutes of silence or
   90 minutes (`session.autoStopAfterSilenceMin`, `session.maxDurationMin`).
3. If the Athan or Iqama isn't picked up automatically: `make event EVENT=athan` (or
   `iqama`, `salah`, `none` to return to normal captions), or the buttons on the control page.
4. After the closing du'a: `make stop`. Transcripts and SRTs are in `data/transcripts/`;
   `make archive` opens the session's archive page and `make export SESSION=<id>` saves it.

## Quran data, events, archive and exports

- **The Quran data** (the Tanzil Quran text and the configured translations, with their
  license notices, in `data/quran/`): the server downloads what is missing by itself when it
  starts, in the background, and tries again later when the internet is not reachable
  (`make logs` shows its progress). Caption sessions that start after it arrived show verified
  verse references; no restart is needed. **`make quran-data`** downloads it again by hand: it
  runs `pnpm exec tsx scripts/quran-data.ts` in the compose `tools` service (the build-stage
  image, with the live `scripts/` and `src/` and the same `config/` and `data/` mounts, as your
  user on Linux), then restarts the service when it runs.
- **`make event EVENT=athan|iqama|salah|none [SESSION=<id>|all]`**: the manual override;
  it sends `POST /api/sessions/<id>/event` with `{"event": "..."}` to the running service.
  `SESSION` defaults to `all`; `none` returns to normal captions.
- **`make archive [SESSION=<id>]`**: opens the read-only archive page `/s/<id>`. Without
  `SESSION` it opens the latest session in `data/transcripts/`. `KEY=<access key>` adds
  `?key=` (remote use); `make sessions` lists the ids.
- **`make export SESSION=<id> [FORMAT=txt|md|srt]`**: downloads
  `/api/sessions/<id>/export.<fmt>` to `data/exports/<id>.<fmt>` (`FORMAT` defaults to
  `txt`; `EXPORT_DIR=` picks another folder).
- **`make customize`**: opens `/app/look`, the look editor with the built-in looks.

`event` and `export` call the API with `curl` on the host (included in macOS, Git for
Windows and most Linux distributions). They talk to `http://127.0.0.1:<HTTP_PORT>` (8765 by
default), or to the `CAPTIONS_BIND` address when that is a specific LAN IP.

**The admin token.** On a hosted server and with `server.exposure: lan` or `public`, the
targets that call the running server's API use the admin token: `start`, `stop`, `clear`,
`kill`, `sessions-live`, `event`, `export`, and `control`, `customize` and `archive` (they add
`?token=` to the page they open). You never set it: the server generates it on its first start
and keeps it in `config/admin.token` (mode 600), and the targets read it from there (or through
the container, when your user cannot read the file). `server.token` in `config/config.yaml`, or
`TOKEN=...` for one command, is used instead when set. The startup log says where the token is,
never the token. It is sent as a header via stdin, never on the command line. An admin login
works in the browser only.

## What runs where

| Piece | Where |
|---|---|
| Turjuman (the server), CLI (`doctor`, `devices`, `screens`, ...), tests | Docker |
| OBS, DistroAV/NDI, screens, the audio bridge (Windows/macOS) | Host |

- **Image** (`Dockerfile`): `build` stage (full install, `pnpm build`; also the `test`,
  `dev` and `tools` target), `prod-deps` stage, `runtime` stage with ffmpeg, pulseaudio-utils,
  alsa-utils and tini. It runs as the non-root `node` user (uid 1000), with
  `CONFIG_DIR=/app/config`, `DATA_DIR=/app/data`, `TZ=Europe/Amsterdam`,
  `SERVER_HOST=0.0.0.0` and `CAPTIONS_CONTAINER=1`.
- **Ports**: `8765` (pages, overlay, control, API) and `8443` (HTTPS, when
  `server.https.port: 8443` is set) are published on `${CAPTIONS_BIND}` (default
  `127.0.0.1`); the bridge port `7000` is always published on `127.0.0.1` only. On this
  computer they appear as `HTTP_PORT`, `HTTPS_PORT` and `BRIDGE_PORT` from `.env` (default
  8765, 8443 and 7000); inside the container they stay 8765, 8443 and 7000.
- **Files**: `./config` and `./data` are bind-mounted as directories (never single files, so
  atomic "save as default" works). The rest of the container is read-only (`read_only: true`,
  `/tmp` is a tmpfs).
- **Secrets** stay in `.env` and `config/` (never copied into the image; `.dockerignore`
  excludes `.env`, `config/`, `data/` and the account and key files).
- **Health**: the image's healthcheck calls `/health` every 15 s (every 1 s during the
  first 20 s); `make up` waits for it.
- **Logs**: pino JSON on stdout; Docker keeps 3 x 10 MB (`make logs`, `make logs SINCE=10m`).
- **Restarts**: `restart: unless-stopped` brings the service back after crashes and reboots;
  on Windows, the bridge's Task Scheduler entry starts the bridge at logon.
- **Shutdown**: `make down` stops the session through the API first; Docker then sends
  SIGTERM and waits up to 20 s (`stop_grace_period`) for transcripts and SRTs.
- **Time zone**: session folders and log times use local time, `TZ=Europe/Amsterdam` by
  default. Set `TZ` in `.env` (for example `TZ=Europe/London`) and run `make up` for another
  time zone. The `node:24-slim` image includes tzdata.

### The two `.env` files

- **`.env`** in the checkout: `make up` creates it from `.env.example`. Compose reads it for
  the settings below and passes its variables into the container.
- **`config/.env`**: where `make keys` saves the Soniox key. The app reads it when it starts.

A key that is not empty in `.env` wins over the same key in `config/.env`. An empty one
(`SONIOX_API_KEY=`) counts as not set.

| Key in `.env` | Used for |
|---|---|
| `SONIOX_API_KEY` | your Soniox key; commented out by default, because `make keys` saves it in `config/.env` |
| `TURJUMAN_MASTER_KEY` | optional: encrypts the keys added in the app (`orgs.yaml`); unset, `config/master.key` is created on first use |
| `COMPOSE_PROJECT_NAME` | the compose project of this instance (default `turjuman`) |
| `HTTP_PORT`, `HTTPS_PORT`, `BRIDGE_PORT` | the ports on this computer (default 8765, 8443, 7000) |
| `CAPTIONS_IMAGE`, `CAPTIONS_BUILD_IMAGE` | the image tags (default `turjuman:local` and `turjuman:build`) |
| `TZ` | the time zone of session folders and log times (default `Europe/Amsterdam`) |
| `CAPTIONS_BIND` | where the app's ports are published (default `127.0.0.1`; `0.0.0.0` publishes them on the LAN) |
| `UID`, `GID`, `PULSE_SOCKET` | Linux audio override (`make up` writes them) |
| `CAPTIONS_SECRET` | optional: the secret that signs logins, instead of `config/secret.key` |

## Exposure: local, LAN, public

- **local** (default): nothing to do; only this machine reaches `127.0.0.1:8765`.
- **lan**: set `server.exposure: lan` in `config/config.yaml` and `CAPTIONS_BIND=0.0.0.0` (or
  the LAN IP) in `.env`, then `make up`. The app refuses a LAN bind while `exposure: local`. No
  admin account yet? Create it with `make user-add USERNAME=<name> ADMIN=1`: with exposure lan
  the app creates the first admin only for requests from this computer, and requests through
  Docker don't count. The make targets that call the API now use the admin token (above).
  Browsers only allow the microphone on HTTPS or localhost, so caption pages on other
  machines need HTTPS: run `make lan-cert` (on Windows `make lan-cert LAN_NAMES="<this
  computer's IP>"`: the script can't find the address there), set `server.https.port: 8443` next
  to `server.exposure: lan`, and run `make restart`. Steps per device: "HTTPS on the LAN" in
  [guide.md](guide.md#https-on-the-lan-microphones-on-phones-and-other-pcs).
  In the container the CLI doesn't know this computer's LAN address, so `make screens` prints
  only the `http://127.0.0.1` links. For another device, copy the HTTPS link in the app opened
  at `http://<this computer>:8765/app` (**Show on a screen** → **On another computer or TV**).
- **public** (behind your HTTPS reverse proxy): see the next section.

## HTTPS and your hostname

HTTPS and the hostname belong to your own reverse proxy, nginx for example; Turjuman needs
neither a domain nor a certificate. The container publishes the app on `127.0.0.1:8765`
(`HTTP_PORT`), and the proxy forwards to it. The complete nginx server block, with the WebSocket
headers, is in [hosting.md](https://github.com/turjuman-translator/website/blob/main/docs/hosting.md#nginx).

1. In `config/config.yaml`: `server.exposure: public` and `server.trustProxy: true`, then
   `make restart` (a hosted server's first start writes both already).
2. Point your proxy at `http://127.0.0.1:8765` with the block from [hosting.md](https://github.com/turjuman-translator/website/blob/main/docs/hosting.md#nginx).
3. Create the first admin with `make user-add USERNAME=<name> ADMIN=1`, and log in at `/app`
   on your domain.

Every link the server makes follows the hostname of the request: the proxy forwards it as
`X-Forwarded-Host` and `X-Forwarded-Proto`, which the app trusts from the proxy only
(`trustProxy`). Change the domain in nginx at any time; Turjuman needs no change.
`hosted.publicUrl` is an optional fixed address: with it, `make screens` prints public screen
links instead of the `http://127.0.0.1` ones.

Screen links need nothing more. Only a caption page without a screen link (`/ar/nl`) needs an
access key:

- `make key-add LABEL="Mosque OBS" DAILY_MINUTES=120` creates one (printed once; only its hash
  is stored);
- `make page-url FROM=ar TO=nl KEY=<key>` prints the address to paste into OBS or a browser;
- `make usage` shows the streamed minutes per key; `make key-revoke ID=<id>` revokes one.

### Screens and the app

Screens, each with its own screen link, are switched on and off in the app at `/app` (on your
domain behind the proxy). A new screen starts off. The app only creates the first admin for
requests from the server itself, and in Docker with `exposure: lan/public` requests arrive
from the Docker network, so create it with the CLI:

```bash
make user-add USERNAME=abdullah ADMIN=1 NAME="Abdullah"   # the password is printed once
echo 'a long password' | make user-add USERNAME=imam    # or pipe one in
make user-passwd USERNAME=imam                           # new password; logs it out everywhere
make users                                               # accounts
make screens                                             # screens and their screen links (/feed/<guid>)
make admin                                               # open the app (/app)
```

Accounts, screens and the signing secret live in `config/users.yaml`, `config/screens.yaml`
and `config/secret.key` (mode 0600). Deleting `secret.key` (or changing `CAPTIONS_SECRET` in
`.env`) logs everybody out; screen links keep working, because they are the GUIDs in
`screens.yaml`.

## Audio bridge

The bridge streams the interface's raw audio (s16le, 48 kHz, stereo) to the container on
`tcp://127.0.0.1:<BRIDGE_PORT>` (7000 unless `.env` sets another; the `make` targets use this
instance's port). Channel pick, gain and resampling stay in the container
(`config/config.yaml`). It reconnects forever with a 1 s pause and one timestamped line per
reconnect; until bytes arrive, the status shows `waiting-for-bridge`, which is normal.

| | Windows | macOS | Linux (`AUDIO=bridge` only) |
|---|---|---|---|
| Script | `scripts/audio-bridge.ps1` | `scripts/audio-bridge.sh` | `scripts/audio-bridge.sh` |
| List | `make bridge-list` | `make bridge-list` | `make bridge-list AUDIO=bridge` |
| Device | exact name or "alternative name" | avfoundation index or name | Pulse source name |
| Autostart | `make bridge-install DEVICE="..."` | - (terminal or LaunchAgent) | - |

- **Windows, by hand** (execution policy): always run the script as
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audio-bridge.ps1 -List`
  (or `-Device "Line (USB Audio CODEC)"`, `-File <wav>`, `-Port 7000`). `-List` prints each
  device's friendly name and its DirectShow alternative name; both work with `-Device`.
- **Autostart (Windows)**: `make bridge-install DEVICE="..."` registers the Task Scheduler
  task "Turjuman audio bridge": at logon, hidden window, no time limit, log in
  `%LOCALAPPDATA%\Turjuman\audio-bridge.log`. It also starts it right away. Another instance (its own
  `COMPOSE_PROJECT_NAME` and `BRIDGE_PORT`) gets its own task, "Turjuman audio bridge
  (<project>)", and log, `audio-bridge-<port>.log`.
  **Uninstall** with `make bridge-uninstall` (or `-UninstallAutostart`), which removes this
  instance's task (the default one also the old-named task) and stops its running bridge; or
  delete the task in Task Scheduler (`taskschd.msc`).
- **Without hardware**: `make bridge-test FILE=test.wav` streams `data/recordings/test.wav`
  in real time (`-re`) instead of the microphone, once.
- **ffmpeg missing**: the scripts print `winget install Gyan.FFmpeg` / `brew install ffmpeg`.
- **macOS, port 7000**: the AirPlay Receiver listens on it too; see [macOS](#macos).

## OBS

- `make obs-shortcut` (Windows) creates the desktop shortcut "OBS Studio (captions)" that
  starts `obs64.exe` with `--enable-media-stream` (working directory = OBS's own folder).
  `make obs-shortcut AUTO_ACCEPT=1` also adds `--use-fake-ui-for-media-stream`, which grants
  the microphone to every page in OBS without asking; use it only if the microphone is still
  not granted. For OBS in another folder:
  `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\obs-media-shortcut.ps1 -ObsPath "D:\...\obs64.exe"`.
- macOS: `/Applications/OBS.app/Contents/MacOS/OBS --enable-media-stream`; Linux:
  `obs --enable-media-stream`.

## Backups and cleanup

- `make backup` writes `backups/<date>_<time>.tar.gz` with `config/` and `data/transcripts/`,
  readable only by you, without `.env`, `config/.env`, `config/keys.yaml`, `config/master.key`
  and `config/admin.token` (a new one is made on the next start).
  What to keep apart, and how to restore: "Back up" in the README.
- `make prune` removes dangling images and build cache; it never removes volumes, `config/`
  or `data/`. No make target deletes `config/` or `data/`.
- Tests, development mode and image maintenance: [CONTRIBUTING.md](../CONTRIBUTING.md).

## Troubleshooting

- **Status stuck on "waiting for bridge"**: the bridge isn't running or can't reach the
  container. Run `make bridge DEVICE="..."` in the foreground and read its messages; on
  Windows check `%LOCALAPPDATA%\Turjuman\audio-bridge.log`. Check that
  `audio.input.kind: network` and that `make status` shows the container healthy. On macOS,
  the AirPlay Receiver may hold port 7000 (see [macOS](#macos)).
- **Port 7000, 8443 or 8765 already in use**: another program (or `pnpm turjuman start`, or
  `make dev`/`make replay` from another terminal, or another instance) holds the port. Stop
  it, or set other ports in `.env` (`HTTP_PORT`, `HTTPS_PORT`, `BRIDGE_PORT`), then `make up`.
- **`make up` says an older instance still exists** (compose project `khutbah-captions`): see
  [Upgrading an older install](#upgrading-an-older-install).
- **A certificate warning on other devices, on Windows**: the certificate script can't find the
  LAN address in Git Bash. Run `make lan-cert LAN_NAMES="<this computer's IP>"`, then
  `make restart`.
- **Permission errors on `data/` or `config/` (Linux)**: the container runs as uid 1000
  (bridge setup) or as `UID`/`GID` from `.env` (Pulse setup). Run `make up` as your normal
  user (not with sudo), check `UID`/`GID` in `.env`, or `sudo chown -R "$(id -u):$(id -g)"
  config data`. If Docker created `config/`/`data/` itself (owned by root), the service was
  started with `docker compose` before `make up` ever ran.
- **Session folders in the wrong time zone**: set `TZ` in `.env` (default
  `Europe/Amsterdam`) and run `make up`; `docker compose exec captions date` shows the
  container's time.
- **PulseAudio connection refused**: wrong `PULSE_SOCKET` in `.env`
  (`ls -l /run/user/$(id -u)/pulse/native`), wrong `UID`, or real PulseAudio (not PipeWire)
  needs the cookie mount (commented in `compose.linux-audio.yaml`).
- **`make: command not found`**: install GNU make (`winget install ezwinports.make`) and
  run it from Git Bash, not from PowerShell or cmd.
- **Container paths turned into Windows paths** (`C:/Program Files/Git/app/data/...`): Git
  Bash rewrote them. The Makefile exports `MSYS_NO_PATHCONV=1`; when you type `docker`
  commands by hand in Git Bash, prefix them with `MSYS_NO_PATHCONV=1`.
- **"the input device is not a TTY" in Git Bash**: the mintty window has no Windows console;
  the Makefile uses `winpty` when available. Running Git Bash inside Windows Terminal avoids it.
- **Compose errors about `env_file`/`--wait-timeout`**: Docker Compose v2.24 or newer is
  needed (`docker compose version`).

## Appendix: raw docker compose commands

On Linux with host audio, add `-f compose.linux-audio.yaml` after `-f compose.yaml`.

| make | docker compose |
|---|---|
| `make build` | `docker compose build` |
| `make up` | creates `config/`, `data/` and `.env` when missing, then `docker compose up -d --wait --wait-timeout 120` |
| `make down` | `docker compose exec -T captions node dist/main.js ctl stop; docker compose down --remove-orphans` |
| `make restart` | `docker compose restart captions && docker compose up -d --wait` |
| `make status` | `docker compose ps; docker compose exec -T captions node dist/main.js status` |
| `make logs` | `docker compose logs -f --tail 200 captions` |
| `make shell` | `docker compose exec captions bash` |
| `make start` / `stop` / ... | `docker compose exec -T captions node dist/main.js ctl start` / `ctl stop` / ... |
| `make doctor [ONLINE=1]` | `docker compose run --rm captions doctor [--online]` |
| `make cli ARGS="screens enable x"` | `docker compose exec -T captions node dist/main.js screens enable x` (`docker compose run --rm --no-deps captions screens enable x` when the service is down) |
| `make keys` | `docker compose run --rm --no-deps captions setup`, then a restart when the service runs |
| `make devices` | `docker compose run --rm captions devices` |
| `make replay LOG=...` | `docker compose stop captions; docker compose run --rm --service-ports captions replay /app/data/...; docker compose up -d --wait captions` |
| `make record OUT=x` | `docker compose exec captions node dist/main.js record --out /app/data/recordings/x.wav` |
| `make key-add LABEL=x` | `docker compose exec -T captions node dist/main.js keys add --label x` |
| `make user-add USERNAME=x ADMIN=1` | `docker compose exec -T captions node dist/main.js users add x --admin < /dev/null` (pipe a password in instead of `/dev/null` to set one) |
| `make user-passwd USERNAME=x` | `docker compose exec -T captions node dist/main.js users passwd x < /dev/null` |
| `make users` | `docker compose exec -T captions node dist/main.js users list` |
| `make screens` | `docker compose exec -T captions node dist/main.js screens list` |
| `make orgs` | `docker compose exec -T captions node dist/main.js orgs list` |
| `make admin` | open `http://127.0.0.1:8765/app` |
| `make lan-cert` | `bash scripts/lan-cert.sh config/tls` (on the host) |
| `make test` | `docker compose --profile test run --rm --build test` |
| `make e2e` | `docker compose --profile e2e up --build --attach playwright --exit-code-from playwright replay playwright` |
| `make dev` | `docker compose stop captions; docker compose --profile dev run --rm --build --service-ports dev` |
| `make quran-data` | `docker compose --profile tools run --build --rm tools pnpm exec tsx scripts/quran-data.ts`, then a restart when the service runs |
| `make event EVENT=athan` | `curl -fsS -X POST -H 'Content-Type: application/json' -H 'Authorization: Bearer <token>' --data '{"event":"athan"}' http://127.0.0.1:8765/api/sessions/all/event` |
| `make export SESSION=x FORMAT=md` | `curl -fsS -H 'Authorization: Bearer <token>' -o data/exports/x.md http://127.0.0.1:8765/api/sessions/x/export.md` |
| `make archive SESSION=x` | open `http://127.0.0.1:8765/s/x` (`?key=<key>` remotely) |
| `make customize` | open `http://127.0.0.1:8765/app/look` (`?token=<token>` on a hosted server and for lan/public) |

## Upgrading an older install

- **Removed settings.** Turjuman uses only Soniox. A `config.yaml` that still has settings of the
  Gemini engine, LLM translation (`translation.engine: llm`), compare mode or the caption
  composer, `transcripts.recordAudio` or `debug.faultInjection` (which had no effect), or
  `pages.maxSessions` (caption pages have no server-wide limit any more), still starts: each is
  ignored, with a warning at the start and in `doctor`. Delete them.
- **The Caddy proxy is gone** (`make proxy-up`, `make proxy-down`, `DOMAIN`): HTTPS is your
  own reverse proxy's job ([HTTPS and your hostname](#https-and-your-hostname)). `make down`
  removes the old Caddy container; delete `DOMAIN` and `COMPOSE_PROFILES=proxy` from `.env`,
  and `docker volume rm turjuman_caddy_data turjuman_caddy_config` when you no longer need its
  certificates.
- **The compose project `khutbah-captions`.** While a container of that project exists and
  `.env` sets no `COMPOSE_PROJECT_NAME`, `make up` and `make update` stop and print the command
  to remove it. Run it once, then `make up` again:

  ```bash
  docker compose -p khutbah-captions down
  make up
  ```

  `config/` and `data/` are folders in the checkout, so nothing is lost. On Windows, run
  `make bridge-install DEVICE="..."` once more: it replaces the old "Khutbah captions audio
  bridge" task with "Turjuman audio bridge".
