# The `turjuman` command

Everything you need to run Turjuman on your own computer works from one command: set the Soniox key, start the server, open the builder, and make and list screens.

After `pnpm install && pnpm build`, run it from the repository folder as `pnpm turjuman <command>`; `node dist/main.js <command>` works too. In Docker, `make` runs the common commands (`make help` lists them), and `make cli ARGS='<command>'` runs any other, for example `make cli ARGS='screens enable <id>'`.

Every command takes `--help`, and `turjuman help <command>` does the same. `turjuman --version` prints the version. A wrong option prints the command's usage and exits with code 2, for example `turjuman doctor: Unknown option '--onlin'.`

Two folders matter:
- **`CONFIG_DIR`** holds `config.yaml` (`start` and `run` make it on the first start), `.env`, and the files Turjuman writes itself: `users.yaml`, `screens.yaml`, `presets.yaml`, `keys.yaml`, `orgs.yaml`, `secret.key`, `master.key`, `admin.token` and `tls/`. `languages.yaml` and `glossaries/` are read from here when they exist, else from the app's own copies.
- **`DATA_DIR`** holds `transcripts/`, `quran/`, `usage/`, `state/` and `recordings/`.

Both default to the current folder. `pnpm turjuman` always runs in the checkout, so natively that is the checkout; `node dist/main.js` uses the folder you run it in. In Docker they are `config/` and `data/` in the checkout. `SERVER_HOST` and `SERVER_PORT` in the environment override `server.host` and `server.port` (the image sets `SERVER_HOST=0.0.0.0`).

Where the Soniox key comes from, the first one found wins:
1. A variable set in the environment (`SONIOX_API_KEY`). An empty one counts as not set.
2. The `.env` files: `CONFIG_DIR/.env`, where `setup` saves the key, and `./.env`. Without `CONFIG_DIR` in the environment they are the same file. When `CONFIG_DIR` is set, its `.env` wins over `./.env`.
3. The key added in the app under **Keys**, stored encrypted in `orgs.yaml`.

In Docker, compose passes the checkout's `.env` into the container. A key that is not empty there wins over `config/.env`, where `make keys` saves.

## Quick start

```bash
pnpm install && pnpm build
pnpm turjuman start            # the server; leave it running
pnpm turjuman open builder     # in a second terminal: make your first screen
```

The first start needs nothing else: it makes `config.yaml` and downloads the Quran data in the background. The app asks for the first admin account, and takes your Soniox key under **Keys**; `pnpm turjuman setup` does both from the terminal instead.

Or make a screen without the browser:

```bash
pnpm turjuman screens add --name "Main hall" --from ar --to nl --enable
pnpm turjuman screens list
```

## `setup`

Asks for your Soniox key, checks it with Soniox and saves it in `.env` in the config folder. It then offers to create the first admin account, when there is none, and prints the next steps. The check is a free call to Soniox's model list; nothing is billed.

Get the key at https://console.soniox.com → API keys.

What happens to the key:
- **Not accepted:** Soniox refused it, and setup asks again.
- **Unchecked:** Soniox couldn't be reached. Setup saves the key anyway and says so; check it later with `setup --check`.

Run `setup` again to change the key. Pressing Enter keeps the current one; setup shows its last four characters and checks it again. When Soniox refuses it, setup asks for a new one.

Ctrl-C while setup asks for the key stops it, and nothing is saved. Ctrl-C at the admin account keeps the key that was saved and makes no account. Both exit with code 130.

How `.env` is written:
- only `SONIOX_API_KEY` changes; every other line and comment stays;
- the file is replaced atomically and always ends up with mode 0600.

```bash
pnpm turjuman setup                                   # interactive; the key is not shown while you type
pnpm turjuman setup --check                           # check the key that is set; changes nothing
pnpm turjuman setup --yes --soniox-key-file ~/keys/soniox.txt
pass show soniox | pnpm turjuman setup --yes --soniox-key-file -    # "-" reads standard input
```

**The key never goes on the command line**, because other users of the computer can read command lines. With `--yes`, setup asks nothing:
- a key from a file is checked first; when Soniox refuses it, setup stops (exit code 1) and saves nothing;
- without a file, a saved key is kept as it is, without a new check; without a saved key, setup stops (exit code 2);
- no admin account is made. Create one with `pnpm turjuman users add <name> --admin`, or at `/login` on the server itself.

`setup --check` asks Soniox about the key the server uses: the environment or `CONFIG_DIR/.env`, else the key added in the app. It exits with code 1 when the key is missing or not accepted. `doctor --online` asks too (see [Other commands](#other-commands)).

In hosted mode (`mode: hosted`), `setup` asks nothing: every mosque adds its own Soniox key in the app. See [hosting.md](https://github.com/turjuman-translator/website/blob/main/docs/hosting.md).

## `start`

Starts the server, the same as `run` and with the same options (`--config`, `--start`, `--file <wav> [--loop]`). It reads the same `.env` files as the server. Once the server listens, it prints its banner (local mode: the caption link `/`, a caption page, the overlay and the dock; hosted mode: the website `/` and the app `/app`) and, under it, where to open the app:
- **Screens (dashboard):** `/app`
- **New screen (builder):** `/app/new`
- **Caption look:** `/app/look`

When they're configured, it also prints:
- the network address (`server.exposure: lan`);
- the HTTPS address (`server.https.port`). With `exposure: lan` it is the address for other devices, and it adds where each device gets the certificate (`http://<lan-ip>:<port>/ca.crt`); with `exposure: local` HTTPS answers on this computer only (`https://127.0.0.1:<port>`). Without a certificate it says `not started` and names the command that makes one (`bash scripts/lan-cert.sh tls`; in Docker `make lan-cert`);
- the public address (`hosted.publicUrl`).

At a terminal, log lines follow, one per entry, for example `12:00:06 info  GET /app 200 4 ms`; a request is one line when it completes. Piped output, and Docker, get JSON lines.

On the first start, when `CONFIG_DIR` has no `config.yaml` (and no `--config` is given), `start` and `run` make one with this edition's settings and say so (`Created …/config.yaml (mode local, exposure local).`). In the self-hosted edition that is one mosque on this computer; in the main repository, a hosted server behind a reverse proxy (`mode: hosted`, `server.exposure: public`, `server.trustProxy: true`). An existing `config.yaml` is never changed, and `--dry-run` makes nothing.

A server that needs an admin token (`mode: hosted`, or `server.exposure: lan` or `public`) and has none in `config.yaml` generates one on its first start, keeps it in `CONFIG_DIR/admin.token` (mode 0600) and uses the same one after every restart and update. The log says where it is, never the token. Delete the file to make a new one.

When the Quran data is missing, the server downloads it in the background from Tanzil (tanzil.net) into `DATA_DIR/quran/` and logs each file; it serves at once, and the caption sessions that start after the data arrived show verified verse references. Without internet it tries again after 1 minute, 5 minutes, then every 30 minutes. `pnpm exec tsx scripts/quran-data.ts` downloads it by hand (`--force` again, `--trans <id>` extra translations).

When the port is taken, `start` stops with exit code 1:

```
Port 8765 is in use: is Turjuman running already? (pnpm turjuman status)
To use another port, set server.port in config.yaml (start from config.example.yaml).
```

Stop it with Ctrl-C.

## `open [app|builder|look]`

Opens that page in the browser on this computer and prints its address. The page is `app` unless you give another. It uses `hosted.publicUrl` when that is set, and the local address otherwise.

```bash
pnpm turjuman open            # the dashboard
pnpm turjuman open builder    # make a new screen
pnpm turjuman open look       # fine-tune the caption look
```

## `screens`

A screen is the captions for one place, for example "Main hall". OBS needs only its screen link, `<origin>/feed/<guid>`. Anyone who has the link can show that screen, so share it like a key.

| Command | What it does |
|---|---|
| `screens list [--json]` | One line per screen: id, name, languages, on/off and screen link (the `SCREEN LINK` column). `--json` gives machine output, with `localUrl` next to `url`. |
| `screens add --name <name> --from <code> --to <code> [--preset <id>] [--layout blocks\|rollup] [--size <px>] [--enable] [--json]` | Makes a screen and prints its screen link (`Screen link for OBS: …`). |
| `screens url <id> [--local]` | Prints only the screen link. `--local` prints the `http://127.0.0.1:<port>/feed/…` link instead, for OBS on the computer that runs Turjuman, when the screen links use HTTPS. |
| `screens enable <id>` / `screens disable <id>` | Switches a screen on or off. |
| `screens rm <id> [--yes]` | Deletes a screen; its link stops working. It asks first unless you give `--yes`. |

More on `screens add`:
- The language pair is checked against `languages.yaml`, exactly as the app checks it.
- `--preset` takes a built-in look (`mosque-dark`, `mosque-light`, `midnight-gold`, …) or one you saved at `/app/look`.
- The look is saved in the same short form the builder uses.
- A new screen starts **off** unless you give `--enable`.
- `screens add` is for local mode. On a hosted server, every mosque makes its screens in the app.

`<id>` can also be the screen's exact name.

```bash
pnpm turjuman screens add --name "Sisters" --from ar --to en --preset mosque-light --layout rollup
pnpm turjuman screens url "Sisters"
pnpm turjuman screens enable Sisters
pnpm turjuman screens rm Sisters --yes
```

Screen links use these addresses, in this order:
1. `hosted.publicUrl`, when it is set.
2. The HTTPS address on the LAN, when `server.exposure: lan` and `server.https.port` are set and the certificate is in place. Other computers and TVs need HTTPS for the microphone.
3. Otherwise this computer's own address, `http://127.0.0.1:<server.port>`, which works for OBS or a browser on the computer that runs Turjuman.

A plain `http://<network address>` link is never printed, because a caption page there cannot open the microphone, not even on this computer. In Docker the CLI doesn't know this computer's LAN address, so step 2 never applies: `make screens` prints the `http://127.0.0.1:<HTTP_PORT>` links (or the `hosted.publicUrl` ones). The app shows the HTTPS link when you open it at the LAN address.

When the links use HTTPS, `screens add` also prints the link for this computer (`On this computer:  http://127.0.0.1:…/feed/…`), and `screens list` ends with a note that names `screens url <id> --local`.

A screen link keeps `?debug=1` (the level meter and engine state) and `?ui=…` (the toolbar) when you add them, for example `/feed/<guid>?debug=1`. Nothing else passes through.

The commands edit `screens.yaml` directly. A running server applies the change to the pages that are open within a few seconds:
- a screen switched on starts showing captions;
- a screen switched off stops;
- a deleted screen's link stops working.

## Other commands

| Command | What it does |
|---|---|
| `doctor [--online]` | Checks the setup: Node.js, the config, whether the Soniox key is set, the HTTPS certificate, Quran data, glossaries, ffmpeg, the port and a TLS handshake with Soniox. It exits with code 1 when a line says `[FAIL]`; `[warn]` lines can be fine. `--online` also asks Soniox whether it accepts the key the server uses (a free model list; Docker: `make doctor ONLINE=1`). Nothing is billed. |
| `status` | Whether the server runs: its sessions, audio and latency. Exit code 1 when no server answers. |
| `sessions [--limit n]` | Recent sessions with their duration and segments (default: the last 20). |
| `users add <name> [--admin] [--name "…"]`, `users list\|passwd\|remove <name>` | Accounts for the app. A password is read from piped standard input, else generated and printed once. `users add` prints where to log in. |
| `keys add --label <name> [--daily-minutes <n>] [--expires <date>]`, `keys list\|revoke <id>`, `usage [--month YYYY-MM]` | Access keys for caption pages without a screen link (needed with exposure lan or public), and the minutes each one used. Not the Soniox key. |
| `estimate start` | The cost per minute and per hour, from `pricing` in the config. |
| `run [--config <file>] [--start] [--file <wav> [--loop]] [--dry-run] [--print]` | Starts the server without printing the app addresses. `--dry-run` only reads the audio input and prints its levels. |
| `orgs list\|disable\|enable <id>` | The operator's commands for the organisations on a hosted server. |

For server-side capture (`audio.input.kind: device` or `network`) and testing:

| Command | What it does |
|---|---|
| `devices [--monitors]` | Lists the audio inputs as `audio.input.device` must name them (`--monitors`: also PulseAudio monitor sources). |
| `ctl start [--file <wav>]\|stop\|clear\|kill <id>\|sessions` | Controls the local session of a running server. `clear` clears the captions on every screen. |
| `record --out <file.wav> [--seconds n]` | Records the audio input to a 48 kHz stereo WAV file. |
| `replay <provider.jsonl> [--speed 1] [--loop]` | The server with a recorded Soniox session instead of Soniox: no network, no cost. |

`status` and `ctl` talk to `http://127.0.0.1:<server.port>` (`CAPTIONS_URL` overrides it). On a hosted server and with `server.exposure: lan` or `public`, they send the admin token: `TOKEN=…` in the environment when set, else `server.token` from the config, else the generated `CONFIG_DIR/admin.token`. An admin login works in the browser only.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Done. |
| `1` | It failed: for example a key was not accepted, or there is no such screen. |
| `2` | The command was wrong: an unknown option or a missing value. |
| `130` | Cancelled with Ctrl-C. |
