<p align="center">
  <img src="docs/assets/turjuman-banner.png" alt="Turjuman: live translation of the Friday khutbah, on every screen in your mosque" width="100%">
</p>

# Turjuman, self-hosted

Live translation of the khutbah on your mosque's screens, run on your own computer. The imam
speaks Arabic; the screens show the translation seconds after each sentence. It works the same
for lessons and talks, and you manage the screens from your phone.

Free and open source (MIT). Speech recognition and translation run on your own Soniox account:
you pay Soniox directly (about $0.18 per hour of speech), and your key and the audio go only to
Soniox. Rather not run it yourself? The same app is hosted at [turjuman.nl](https://turjuman.nl).

There are two ways to run it, with the same app:
- **natively** with Node.js (steps 3–5): Turjuman runs while its terminal is open;
- **with Docker** (step 9): it restarts by itself, also after a reboot.

Steps 6–8 are the same for both.

---

## Contents

1. [How it works](#1-how-it-works)
2. [What you need](#2-what-you-need)
3. [Install](#3-install)
4. [Add your Soniox key](#4-add-your-soniox-key)
5. [Start Turjuman](#5-start-turjuman)
6. [Make your first screen](#6-make-your-first-screen)
7. [Show it on a screen](#7-show-it-on-a-screen)
8. [Your phone and other devices](#8-your-phone-and-other-devices)
9. [Docker: keep it running](#9-docker-keep-it-running)
10. [Commands](#10-commands)
11. [Update](#11-update)
12. [Back up](#12-back-up)
13. [Costs, data and privacy](#13-costs-data-and-privacy)
14. [When something does not work](#14-when-something-does-not-work)
15. [Uninstall](#15-uninstall)

---

## 1. How it works

- Turjuman runs on one computer. OBS and browsers open its pages.
- A **screen** is the captions for one place, for example "Main hall". It has one link, its
  **screen link**: open it in OBS or in a browser on the computer connected to the TV.
- That page listens to the microphone input **of the computer it is open on**, and sends the
  audio to Turjuman; Turjuman sends it to Soniox and the captions back. So that computer needs
  the mosque's audio, for example from a USB audio interface on the mixer's aux output. A smart
  TV's own browser can't be used: it has no audio input.
- Simplest: Turjuman and OBS on one computer, with the audio. Nothing else is needed.
- A page on **another** computer needs HTTPS: browsers open the microphone only on `https://`
  pages or on the computer itself (step 8).
- Every open caption page is its own Soniox stream: two computers showing captions cost twice.

Turjuman can also read the audio itself, from an input of its own computer, for an OBS overlay
(server-side capture). Screens don't use it: see
[the guide](docs/guide.md#server-side-capture-overlay-and-control-dock).

## 2. What you need

| | |
|---|---|
| **A computer** | macOS, Linux or Windows, on during the khutbah. The computer that runs OBS works fine. |
| **Node.js 24 or newer, and git** | From [nodejs.org](https://nodejs.org). Run `corepack enable` once for `pnpm` (if `corepack` is not found: `npm install -g corepack`); the first `pnpm` command asks to download pnpm 12.6.0. About 250 MB on disk, most of it `node_modules`. With Docker instead: step 9. |
| **A Soniox account with credit** | [console.soniox.com](https://console.soniox.com) → API keys. |
| **Internet** | Outbound HTTPS to Soniox (`stt-rt.soniox.com`, `api.soniox.com`); no port needs opening. About 256 kbit/s upload per caption page while someone speaks. |
| **The mosque's audio** | On the computer that shows the captions (step 1). |

ffmpeg is only needed for server-side capture. **On Windows**, run the commands of this guide
in Git Bash (part of [Git for Windows](https://git-scm.com)): Windows PowerShell 5.1 doesn't
accept `&&`, and the HTTPS and backup steps are bash scripts.

## 3. Install

```bash
git clone https://github.com/turjuman-translator/cli.git turjuman
cd turjuman
pnpm install && pnpm build
```

Nothing else to install. The first start (step 5) makes `config.yaml` here and downloads, in the
background, the Quran text from Tanzil and the translations listed under `quran.translations`
(by default only the Dutch `nl.siregar`), for verified verse references. Without a network
connection Turjuman works, verses get no reference, and it tries again later. The translations
are for non-commercial use only ([NOTICE](NOTICE)).

**Settings.** Turjuman keeps everything in this folder (step 12). The `config.yaml` that the
first start makes holds only two settings: one mosque (`mode: local`) on this computer
(`server.exposure: local`). To change another setting, add it there (a full copy of the example
would keep today's defaults after an update), and restart Turjuman.
[`config.example.yaml`](config.example.yaml) explains every setting.

**Another language.** The defaults are Dutch: the Quran translation, the glossary
(`glossaries/ar-nl.yaml`) and the default caption language. A screen can use any of the 60
languages in `languages.yaml`. For verified Quran verses in another language, add its Tanzil
translation (the file name is its Tanzil id) and restart: Turjuman downloads it by itself.

```yaml
quran:
  translations:
    nl: quran/nl.siregar.txt
    en: quran/en.sahih.txt
```

Other language pairs run without a glossary (`doctor` says so). The Athan, Iqama and Salah cards
have Dutch and English labels; other languages show the English ones unless you add yours under
`events.labels`.

## 4. Add your Soniox key

You can add it in the app instead, after step 5: create your account there and add the key under
**Keys**, where it is stored encrypted. Or in the terminal:

```bash
pnpm turjuman setup
```

Setup asks for your Soniox key, checks it with Soniox (a free call) and saves it in `.env` in
this folder, readable only by you. Then it offers to create the first admin account: the
username and password you log in to the app with.

- To change the key, run `setup` again; Enter keeps the current key and checks it again.
- `pnpm turjuman setup --check` asks Soniox whether it accepts the saved key and changes
  nothing. It checks the key, not your credit.
- No key yet? Press Ctrl-C: nothing is saved.
- A key from an EU-region Soniox project (`stt.soniox.region: eu`): check it with
  `pnpm turjuman doctor --online`.

## 5. Start Turjuman

```bash
pnpm turjuman start
```

It prints where to open the app, then one log line for each request and event:

```
12:00:00 info  Server listening at http://127.0.0.1:8765
Turjuman server running (v0.1.0, exposure local)
  Caption link:     http://127.0.0.1:8765/
  Caption page:     http://127.0.0.1:8765/ar/nl
  Overlay / dock:   http://127.0.0.1:8765/overlay   http://127.0.0.1:8765/control
  Health:           http://127.0.0.1:8765/health

Open the app:
  Screens (dashboard):  http://127.0.0.1:8765/app
  New screen (builder): http://127.0.0.1:8765/app/new
  Caption look:         http://127.0.0.1:8765/app/look
12:00:06 info  GET /app 200 4 ms
```

The first start also says it made `config.yaml` and logs the Quran download, file by file.
Warnings (no Soniox key yet) don't stop the server.
The log goes to this terminal only; there is no log file. `Caption link`, `Caption page` and
`Overlay / dock` are pages without a screen
([the guide](docs/guide.md#the-caption-page-without-a-screen)); for screens, use the app.

Keep this terminal open: Ctrl-C stops Turjuman. If it restarts, open caption pages reconnect by
themselves. Run other commands in a second terminal in the same folder;
`pnpm turjuman open` opens the app in your browser.

**Check the setup** in the second terminal:

```bash
pnpm turjuman doctor
```

Each line says `[ok]`, `[warn]` or `[FAIL]`. Fix every `[FAIL]`; a `[warn]`, for example for
missing ffmpeg, or Quran data while the first download runs, can be fine. `doctor --online` also asks Soniox about the key.
Nothing is billed.

**Another port.** When 8765 is taken, `start` stops with
`Port 8765 is in use: is Turjuman running already?`. Set another in `config.yaml` and use it
wherever this guide says 8765:

```yaml
server:
  port: 8766
```

## 6. Make your first screen

In the app, open **New screen** (`/app/new`): choose the languages, the layout and the look,
pick the microphone and press **Test**, name the screen and press **Save as screen**. It appears
on your dashboard. A new screen starts **off**: switch it on there before the khutbah.

Or in the terminal:

```bash
pnpm turjuman screens add --name "Main hall" --from ar --to nl --enable
pnpm turjuman screens list        # every screen with its screen link
```

A screen made in the terminal uses the default microphone of the computer that shows it. A
microphone picked in the app is saved by its name: on another computer the page takes the first
input whose name contains it, else that computer's default input.

## 7. Show it on a screen

Every screen has a screen link, like `http://127.0.0.1:8765/feed/1f0c…`. Copy it in the app
(**Show on a screen**) or print it with `pnpm turjuman screens url "Main hall"`. Treat it like a
password: whoever has it, and can reach this server, can run captions on your Soniox credit.
**New link** in the app replaces it.

**OBS Studio:**
1. Start OBS with microphone access for web pages:
   - Windows: add `--enable-media-stream` to the OBS shortcut's *Target*, or make such a
     shortcut: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/obs-media-shortcut.ps1`.
   - macOS: `/Applications/OBS.app/Contents/MacOS/OBS --enable-media-stream`; allow OBS the
     microphone when macOS asks.
   - Linux: `obs --enable-media-stream`.
2. *Sources → + → Browser*. Paste the screen link. Width **1920**, height **1080**.
3. In the same window, turn **off** "Shutdown source when not visible" and "Refresh browser when
   scene becomes active".
4. To show it on the TV: right-click the scene → **Open Scene Projector** → the TV.

The same screen in another scene of the same OBS: *Sources → + → Browser → Add Existing*, so it
stays one Soniox stream.

**A browser:** open the screen link on the computer connected to the TV, allow the microphone,
and press F11 (macOS: Ctrl-Cmd-F) for full screen.

Switch off sleep on that computer and on the Turjuman computer. More display options:
[docs/guide.md](docs/guide.md#obs-setup-the-mosque-pc).

## 8. Your phone and other devices

### Your phone on the mosque's Wi-Fi

In the app you switch screens on and off, start the Athan, Iqama and Salah cards by hand
(Turjuman also recognises them itself), clear the captions and add accounts. To open it on a
phone:

1. In `config.yaml`:
   ```yaml
   server:
     host: 0.0.0.0
     exposure: lan
   ```
2. Restart Turjuman. It now also prints **On the network:** `http://192.168.x.x:8765/app`.
3. Open that address on your phone and log in. Add it to the home screen to open it like an app.

- Phone can't reach it? Allow incoming connections for Node.js in the computer's firewall.
- Give the computer a fixed address (a DHCP reservation in the router): screen links and the
  certificate below contain it.
- Over plain `http://` the password crosses the Wi-Fi unencrypted. Once HTTPS works, log in at
  the `https://` address.
- With `exposure: lan`, the first admin can only be created on the computer itself, and caption
  pages without a screen link need an access key ([docs/cli.md](docs/cli.md#other-commands)).
  Commands that call the running server (`ctl`; Docker: `make start`, `stop`, `clear`, `event`,
  `export`) use the admin token, which Turjuman generates itself in `admin.token` here (Docker:
  `config/admin.token`); you never type it. The screen and account commands don't need it.

### Captions on another computer: HTTPS

1. Make a certificate: `bash scripts/lan-cert.sh tls`. This makes a small certificate authority
   (CA) and a certificate for this computer's addresses in `tls/`, valid for 825 days. Run it
   again when the address changes; the CA stays the same. **On Windows** the script can't find
   the address: give it, `LAN_NAMES="192.168.1.20" bash scripts/lan-cert.sh tls`.
2. Add an HTTPS port in `config.yaml` and restart:
   ```yaml
   server:
     host: 0.0.0.0
     exposure: lan
     https:
       port: 8443
   ```
   Both `exposure: lan` and the port are needed: with `exposure: local`, HTTPS answers on this
   computer only. `start` now prints the HTTPS address and where devices get the CA.
3. On each device, install the CA once from `http://<this computer>:8765/ca.crt`. The steps per
   device: [HTTPS on the LAN](docs/guide.md#https-on-the-lan-microphones-on-phones-and-other-pcs).

Screen links now start with `https://<this computer>:8443/feed/…`. OBS on the Turjuman computer
can keep the `http://127.0.0.1:8765` link: `pnpm turjuman screens url "Main hall" --local`.
`doctor` checks the certificate, and warns 30 days before it expires.

`tls/ca.key` can sign certificates that every device with the CA trusts: keep it private, and
remove "Turjuman local CA" from devices that stop using Turjuman.

**From outside the mosque:** put Turjuman behind your own HTTPS reverse proxy, nginx for
example: set `server.exposure: public` and `server.trustProxy: true` in `config.yaml`, and use
the [nginx block](https://github.com/turjuman-translator/website/blob/main/docs/hosting.md#nginx). Turjuman needs no domain name: its links follow the
hostname of each request ([docs/docker.md](docs/docker.md#https-and-your-hostname)).

## 9. Docker: keep it running

You need Docker with Compose 2.24 or newer, git, and GNU make. On Windows: Docker Desktop and
Git Bash; the details per system are in [docs/docker.md](docs/docker.md).

```bash
git clone https://github.com/turjuman-translator/cli.git turjuman
cd turjuman
make up           # everything: config/, data/, .env, the image, the config and the Quran data
make admin        # open the app: create your admin account, then add your Soniox key under Keys
```

Then continue at step 6. `make keys` asks for the Soniox key in the terminal instead. `make help`
lists every helper; `make cli ARGS='…'` runs any `turjuman` command.

- Settings and state are in `config/` and `data/`: `config/config.yaml` takes the place of
  `config.yaml`, and `make lan-cert` of `bash scripts/lan-cert.sh tls` (on Windows:
  `make lan-cert LAN_NAMES="<this computer's IP>"`).
- For step 8, set `exposure: lan` (and the HTTPS `port: 8443`) in `config/config.yaml`; Docker
  sets `host` itself. Also add `CAPTIONS_BIND=0.0.0.0` to `.env`, then `make restart`.
- In Docker, `make screens` prints only the `http://127.0.0.1` links. For another device, copy
  the HTTPS link in the app opened at `http://<this computer>:8765/app` (**Show on a screen** →
  **On another computer or TV**).
- The container restarts by itself, but Docker Desktop (Windows, macOS) runs only while a user is
  logged in: let the computer log in by itself.
- Session folders and log times use `Europe/Amsterdam`; set `TZ` in `.env` for another time zone.
- Coming from `pnpm turjuman start`? Stop it (both use port 8765), and
  [move your files](docs/docker.md#moving-from-pnpm-turjuman-start-to-docker).

## 10. Commands

| Command | What it does |
|---|---|
| `pnpm turjuman setup [--check]` | Saves your Soniox key after checking it, and creates the first admin account; `--check` only checks the key |
| `pnpm turjuman start` | Starts Turjuman and prints where to open the app |
| `pnpm turjuman open [app\|builder\|look]` | Opens the dashboard, the screen builder or the look editor |
| `pnpm turjuman screens list\|add\|url\|enable\|disable\|rm` | Screens and their screen links |
| `pnpm turjuman users add\|list\|passwd\|remove` | Accounts for the app |
| `pnpm turjuman doctor [--online]` | Checks the setup; `--online` also checks the key with Soniox. Nothing is billed |
| `pnpm turjuman status` | Whether Turjuman runs, and its sessions |

`pnpm turjuman help <command>` shows a command's options; [docs/cli.md](docs/cli.md) has every
command. With Docker, use `make help`, or `make cli ARGS='…'`, for example
`make cli ARGS='screens enable "Main hall"'`.

## 11. Update

Outside a khutbah:

```bash
git pull
pnpm install && pnpm build
```

Then start Turjuman again. With Docker: `make backup`, then `make update` (it pulls, rebuilds,
restarts and waits until Turjuman is healthy).

Your settings, key, accounts, screens and transcripts stay: git ignores them. New settings appear
in `config.example.yaml`. Don't run `git clean -fdx` here: it deletes them. To change
`languages.yaml` or a glossary, edit a copy and point `languagesFile` or `glossariesDir` in
`config.yaml` to it; an edited tracked file makes `git pull` stop on a conflict.

`pnpm turjuman --version` (Docker: `make version`) shows the version. For an older
install, see [Upgrading an older install](docs/docker.md#upgrading-an-older-install).

## 12. Back up

Turjuman keeps its state in this folder (with Docker: in `config/` and `data/`):

| File | What |
|---|---|
| `config.yaml` | Your settings |
| `.env` | Your Soniox key, in plain text |
| `users.yaml`, `screens.yaml`, `presets.yaml` | Accounts, screens with their screen links, your own looks |
| `secret.key` | Signs logins (screen links keep working without it) |
| `orgs.yaml`, `master.key` | A key added in the app, encrypted; `master.key` unlocks it |
| `admin.token` | The admin token for the CLI and make (only with `exposure: lan` or `public`) |
| `keys.yaml` | Access keys for caption pages without a screen link (as hashes) |
| `tls/` | The HTTPS certificate and its CA (step 8) |
| `transcripts/` | One folder per session, kept until you delete it |
| `usage/`, `quran/` | Caption minutes per day; the Quran data |

**With Docker:** `make backup` writes `backups/<date>_<time>.tar.gz` with `config/` and
`data/transcripts/`, readable only by you.

**Natively** (bash; on Windows, Git Bash):

```bash
mkdir -p backups
(umask 077; tar -czf "backups/$(date +%Y-%m-%d_%H%M%S).tar.gz" $(ls -d config.yaml users.yaml screens.yaml presets.yaml orgs.yaml secret.key tls transcripts 2>/dev/null))
```

Both leave out `.env`, `keys.yaml`, `master.key`, `admin.token`, `usage/` and `quran/` (Turjuman
downloads the Quran data and makes a new token again). Keep copies of `.env` and `master.key` somewhere else, never in the same archive:
`master.key` with `orgs.yaml` unlocks the key stored in the app. The archive holds `tls/ca.key`:
keep it private.

To restore, unpack the archive in this folder (`tar -xzf backups/<file>.tar.gz`) and put `.env`
and `master.key` back.

## 13. Costs, data and privacy

- **Costs:** Soniox bills while its stream is open: while someone speaks, and up to 30 seconds
  after (`pages.closeAfterSilenceSec`). Longer pauses cost nothing, so a page can stay open in OBS
  for days. About $0.12 per hour for the speech and $0.06 for the translation, at Soniox's list
  prices. The app shows this month's cost under **Keys**.
- **When the key fails or the credit runs out,** Soniox ends the stream. Turjuman doesn't retry;
  the log says `Soniox fatal error; not retrying` with the reason. Top up at
  console.soniox.com, then switch the screen off and on in the app.
- **Your key** is removed from every log line and never sent to a browser.
- **Audio** goes from the caption page to this computer and on to Soniox, only while someone
  speaks. Turjuman stores no audio. Soniox also receives the language pair and the glossary.
- **Transcripts:** the text of each session is saved in `transcripts/` (Docker:
  `data/transcripts/`) until you delete it. Switch this off with `pages.savePageSessions: false`,
  or tell your community that the khutbah is transcribed.
- **Connections:** while it runs, Turjuman connects only to Soniox, and to tanzil.net while Quran
  data is missing; there are no analytics.

Details: [SECURITY.md](SECURITY.md).

## 14. When something does not work

| Problem | What to do |
|---|---|
| "Microphone needs HTTPS" | Open the page on the Turjuman computer (`127.0.0.1`), or set up HTTPS (step 8) |
| OBS shows the page but no captions | Start OBS with `--enable-media-stream`, and turn both Browser Source options off (step 7) |
| "Live translation is off" | Switch the screen on in the app |
| No captions, and no sound reaches the page | Check the mixer's output and the computer's input. Add `?debug=1` to the screen link to see the microphone and its level. A microphone on one channel: edit the screen in the app → **Microphone** → **Advanced** → Left or Right |
| "No microphone matches …; using the default" (with `?debug=1`) | The microphone picked in the app isn't on this computer: edit the screen and pick it, or make it this computer's default input |
| "Not accepted" for a key | Copy the key again from console.soniox.com and run `pnpm turjuman setup` |
| Captions stop; the log says `Soniox fatal error; not retrying` | The reason follows: 401 = the key is refused, 402 or `balance_exhausted` = no credit. Fix it at console.soniox.com, then switch the screen off and on |
| "Port 8765 is in use" | Turjuman runs already (`pnpm turjuman status`), or another program uses the port: set another (step 5) |
| `Invalid config …` | Each line names the setting. `server.host: "0.0.0.0" is not loopback`: also set `exposure: lan` |
| `Host not allowed` | With `exposure: local`, open Turjuman at `127.0.0.1` or `localhost`, or set `exposure: lan` (step 8) |
| The phone can't open `http://<ip>:8765` | Check `host: 0.0.0.0` and `exposure: lan` (Docker: `CAPTIONS_BIND=0.0.0.0` in `.env`), and the firewall |
| A certificate warning, or `[FAIL] HTTPS` in `doctor` | Install the CA on that device (step 8). If the computer's address changed, make the certificate again and restart |
| Anything else | `pnpm turjuman doctor`, the log in the terminal, and [the guide](docs/guide.md#troubleshooting) |

## 15. Uninstall

Back up what you want to keep (step 12), stop Turjuman and delete this folder: everything
Turjuman keeps is in it. With Docker, first:

```bash
make down
docker image rm turjuman:local turjuman:build
```

On Windows, also run `make bridge-uninstall` if you installed the audio bridge, and delete the
"OBS Studio (captions)" shortcut. On every device that installed the CA, remove
"Turjuman local CA".

---

MIT licence ([LICENSE](LICENSE)). The Quran text and translations have their own terms
([NOTICE](NOTICE)).

<sub>Generated from [turjuman-translator/website@4fbbbbc](https://github.com/turjuman-translator/website/tree/4fbbbbc).</sub>
