# Turjuman guide

The reference for running Turjuman: screens and accounts, OBS, HTTPS on the LAN, the caption
blocks, caption pages and their options, server-side capture, transcripts and troubleshooting.
Start with the [README](../README.md). Docker is in [docker.md](docker.md), every command in
[cli.md](cli.md), every setting in `config.example.yaml`, and hosting for many mosques in
[hosting.md](https://github.com/turjuman-translator/website/blob/main/docs/hosting.md).

## Screens, accounts and the app

A **screen** is the captions for one place (for example "Main hall TV"); its page can stay open
24/7 in an OBS Browser Source. You switch it on and off, start or stop the Athan, Iqama and Salah
cards, and clear its captions, from your phone in the app at **`/app`**.

- **First admin:** open `http://127.0.0.1:8765/app` on the server itself and create the account,
  or run `pnpm turjuman users add <name> --admin` (Docker: `make user-add USERNAME=<name> ADMIN=1`).
  With `exposure: lan` or `public`, the app creates the first admin only for requests from the
  server itself (in Docker those arrive through Docker's network, so use the command), or with
  the admin token. After that, log in at `/app` with the username and password.
- **Accounts:** admins add accounts in the app (or with `pnpm turjuman users add|list|passwd|remove`).
  Admins manage everything; users manage their own screens. Passwords are scrypt hashes in
  `CONFIG_DIR/users.yaml`; a login lasts `accounts.sessionDays` (30 days). A new password or a
  disabled account logs out every device.
- **Screens:** **New screen** opens the builder; its last step saves the screen. Every screen has a
  unique GUID, and its **screen link** is `<server>/feed/<guid>`: put that one link into OBS. A new
  screen starts **off**: switch it on before the khutbah. A screen link works without an access
  key, in every exposure mode.
  - **The GUID is the key:** only the app hands it out, so treat the link like a password. The
    server never logs it.
  - **The microphone:** the page listens to the input picked in the builder's **Microphone** step,
    saved by its name. On another computer the page takes the first input whose name contains
    it, else that computer's default input. A screen made with `screens add` uses the default
    input. A microphone on one channel of the interface: **Microphone → Advanced → Left/Right**.
  - **Changing the look** in the app reaches OBS by itself: the connected pages reload their screen
    link, so the link in OBS never changes.
  - **On / off:** while off, the page shows a calm "Live translation is off" card, uses no
    microphone and costs nothing. Switching on starts captions at the next speech; switching off
    ends the running session (transcripts are written).
  - **Athan · Iqama · Salah · Stop:** show a prayer card by hand on every page of the screen (the
    detector does the same automatically). A Salah keeps the captions silent until Stop. The
    buttons work while the screen is on and shown somewhere.
  - **Clear** clears all captions on the screen (the transcripts keep everything).
  - **New link** gives the screen a new GUID: the old link stops at once (paste the new one into
    OBS). **Delete screen** removes the screen.
  - Owners can rename, re-style, regenerate and delete their screens. Switching, the prayer cards
    and Clear need an admin, unless the admin allows the owner ("The owner may switch this
    screen").
- **Several displays:** every open page is its own session and its own Soniox stream. The same
  screen in several scenes of one OBS stays one session with *Add Existing*.
- **Only screen links:** the setting "Only screen links start captions" (**Settings** in the app;
  `pages.requireScreen: true`) refuses every other caption page.
- **Admin access:** a logged-in admin may also open `/control`, `/app/look` and the API in the
  browser. With exposure lan or public, the CLI and make commands that call the running server's
  API use the admin token, which the server generates in `CONFIG_DIR/admin.token`
  ([docker.md](docker.md#quran-data-events-archive-and-exports), "The admin token"); commands that
  manage accounts and screens edit the files and need none.
- **The secret:** logins are signed with `CAPTIONS_SECRET` (env) or `CONFIG_DIR/secret.key`
  (created automatically, mode 0600). Changing or deleting it logs everybody out (screen links
  keep working: they are GUIDs in `screens.yaml`). Back it up with the config; never share it.

## OBS setup (the mosque PC)

**1. Start OBS with microphone access for browser sources**
- **Windows:** add `--enable-media-stream` to the OBS shortcut's *Target*, after the closing quote,
  or run `powershell -ExecutionPolicy Bypass -File scripts\obs-media-shortcut.ps1`.
- **macOS:** `/Applications/OBS.app/Contents/MacOS/OBS --enable-media-stream`
- **Linux:** `obs --enable-media-stream`
- If OBS still doesn't get the microphone, also add `--use-fake-ui-for-media-stream` (the shortcut
  script's `-AutoAccept` adds it).

**2. Add the Browser Source**
- *Sources → + → Browser*. The URL is the screen's **screen link**: copy it in the app (the screen's
  *Show on a screen* panel), or print it with `pnpm turjuman screens url "<name>"`.
  - In OBS on the computer that runs Turjuman, use the link that starts with
    `http://127.0.0.1:8765/feed/`. When the screen links use HTTPS,
    `pnpm turjuman screens url "<name>" --local` prints it.
  - On another computer, use the HTTPS link (see
    [HTTPS on the LAN](#https-on-the-lan-microphones-on-phones-and-other-pcs)). A plain
    `http://<network address>` page cannot open the microphone.
- Width **1920**, height **1080**. The page scales with the source; looks with a transparent
  background, such as *lower-third*, can sit over the camera.
- Turn **off** "Shutdown source when not visible".
- Turn **off** "Refresh browser when scene becomes active".

**3. The microphone:** make the USB interface the computer's default input, or pick it in the
builder (see "The microphone" above).

**4. Several screens**
- **The same screen on several displays:** add the source once, then add it to the other scenes
  with *Add Existing*, so it stays one session.
- **Different languages:** make one screen per language, each with its own screen link.
- Show a scene on a TV with right-click on the scene → **Open Scene Projector** → the TV's display.

**5. Debugging:** add `?debug=1` to the screen link (`…/feed/<guid>?debug=1`) for the level meter
and the microphone in use, and use the Browser Source's **Interact** window.

**If the microphone doesn't work in your OBS version:** open the page in Chrome and use a
*Window Capture*, or use [server-side capture](#server-side-capture-overlay-and-control-dock).

### Friday checklist

1. Turjuman runs (`pnpm turjuman status`; Docker: `make status`), and `pnpm turjuman doctor`
   (Docker: `make doctor`) shows no `[FAIL]`; `[warn]` lines can be fine.
2. OBS is open (started with `--enable-media-stream`). The screen is on: the dashboard shows it as
   "Connected · listening"; in OBS the screen stays empty until someone speaks.
3. Speak a test sentence: the translation appears.
4. After the khutbah nothing needs stopping: Turjuman closes the Soniox stream after 30 s of
   silence.

## HTTPS on the LAN (microphones on phones and other PCs)

Browsers only allow the microphone on `https://` pages, or on the server itself
(`http://127.0.0.1:8765`). A caption page on another device over plain
`http://<server-ip>:8765` therefore shows "Microphone needs HTTPS". The fix is HTTPS:

1. **Certificate:** run `bash scripts/lan-cert.sh tls` in the checkout (Docker: `make lan-cert`).
   It needs bash and openssl, and creates a small certificate authority (CA) for this
   installation and a certificate for this machine's addresses, in `tls/` (Docker:
   `config/tls/`). The CA lasts 10 years and is made once; the certificate lasts 825 days. Run the
   command again when the server's IP changes, or when `doctor` says it expires within 30 days.
   - **Windows:** the script can't find the address in Git Bash. Give it:
     `LAN_NAMES="192.168.1.20" bash scripts/lan-cert.sh tls` (Docker:
     `make lan-cert LAN_NAMES="192.168.1.20"`). `LAN_NAMES` also takes extra host names.
2. **Settings:** set both `server.exposure: lan` and `server.https.port: 8443` in `config.yaml`
   (natively also `server.host: 0.0.0.0`; Docker: `config/config.yaml`), and restart (Docker:
   `make restart`). Both are needed: with `exposure: local` the HTTPS port answers on this
   computer only, and Turjuman offers no HTTPS link for other devices. The server keeps plain HTTP
   on 8765 and adds HTTPS on 8443.
   - **Docker:** also set `CAPTIONS_BIND=0.0.0.0` in `.env` (otherwise compose publishes the ports
     on `127.0.0.1` only), then `make restart`. To use other ports on the host, set `HTTP_PORT`
     and `HTTPS_PORT` in `.env` and keep 8765 and 8443 in `config/config.yaml`.
3. **On each device, once:** download the CA from `http://<server-ip>:8765/ca.crt` and install it
   as trusted.
   - **iPhone/iPad:** Settings → *Profile Downloaded* → Install, then Settings → General → About →
     Certificate Trust Settings → turn on *Turjuman local CA*.
   - **Android:** Settings → Security → Encryption & credentials → Install a certificate → CA
     certificate.
   - **Windows (OBS PC):** open the file → Install Certificate → Local Machine → *Trusted Root
     Certification Authorities*; restart OBS.
   - **Mac:** open it in Keychain Access (System), and set *Always Trust*.
4. **Use the HTTPS address:** open `https://<server-ip>:8443/…`. The screen links now start with
   `https://…/feed/<guid>`. Log in again on that address: logins are per address. In Docker,
   `make screens` keeps printing the `http://127.0.0.1` links: copy the HTTPS link in the app,
   opened at `http://<server-ip>:8765/app`.

`pnpm turjuman doctor` (Docker: `make doctor`) checks the certificate: present, matching its key,
not expired, and (natively) naming this computer's address. OBS on the server itself can keep the
`http://127.0.0.1:8765/feed/…` link: `pnpm turjuman screens url <id> --local` prints it.

Without installing the CA, a browser can usually still be used after accepting the certificate
warning. OBS cannot click through a warning, so install the CA on the OBS PC. `tls/ca.key` can
sign certificates that every device with the CA trusts: keep it private, and remove the CA from
devices that stop using Turjuman.

For access from outside the mosque, put Turjuman behind your own HTTPS reverse proxy:
[docker.md](docker.md#https-and-your-hostname) (with the nginx block).

## Caption blocks: the default layout

**What the congregation sees:**
- **Complete, readable blocks:** one Dutch block for each Arabic sentence.
  - The translation is faithful, never a summary.
  - The newest block sits at the bottom, highlighted; older blocks fade upward.
- **Quran verses** appear in quotes with a **verified** reference such as `(2:286)` and a gold
  accent bar.
  - A full verse uses the approved Dutch translation (Siregar, see below).
  - The Arabic verse is shown above it; `quranArabic=0` hides it.
  - A verse gets a reference only when the Arabic matches the Quran text exactly. A wrong
    reference is worse than none.
- **Duas** (a sentence that starts with اللهم or ربنا) have a green accent bar.
- **Athan, Iqama and the prayer:** a calm card replaces the translated call phrases. During the
  prayer, the recitation is shown as Quran blocks and the prayer formulas are hidden.
  - Detection is rule-based on the Arabic transcript; the khutbah's own takbir and shahada never
    trigger it.
  - Manual override: the screen's **Athan**, **Iqama**, **Salah** and **Stop** buttons in the app;
    for server-side capture, the buttons on `/control` or `make event EVENT=athan|iqama|salah|none`.
  - The cards have Dutch and English labels (`events.labels`); other languages show the English
    ones unless you add yours.
- **Respectful terminology:**
  - In Dutch and English, Allah is always "Allah", never "God". اللهم is "O Allah".
  - Spoken honorifics appear as one calligraphic glyph after the name: Mohammed ﷺ, Allah ﷾ / ﷿,
    Musa ﵇, Abu Bakr ﵁, 'Aisha ﵂, rahimahullah ﵀.

**Speed:** the blocks are built from Soniox's own streaming translation. Text appears about
**0.6 s** after the imam pauses, and one sentence grows as one block, with no flicker and no bursts
of blocks.
- Words that may be a Quran quote or a prayer call are held for a moment, until they are
  recognised.
- During the prayer nothing is shown at all.

**How it works:**
1. Soniox transcribes the Arabic and translates it, in one stream.
2. The translation becomes the caption blocks, one per sentence.
3. A local **Quran matcher** checks every quotation against the Tanzil text.
4. A rule-based detector recognises Athan, Iqama and Salah.

The terms come from the glossary (`glossaries/ar-nl.yaml`, plain text you can review; other
language pairs have none yet). The fixed rules for Allah and the honorifics are in
`src/text/honorifics.ts`.

**Quran data:** the server downloads the Tanzil Quran text and the translations listed under
`quran.translations` (by default only the Dutch one) into `DATA_DIR/quran/` by itself, in the
background, when they are missing; sessions that start after they arrived show the references.
Without a network connection it tries again later. By hand: `pnpm exec tsx scripts/quran-data.ts`
(Docker: `make quran-data`).
- **Quran text:** © Tanzil (tanzil.net), CC BY 3.0, used unmodified.
- **Translations:** Tanzil allows non-commercial use only (see `NOTICE`).
- **Other languages:** add the Tanzil translation for the screen's language under
  `quran.translations`, for example `en: quran/en.sahih.txt` (the file name is the Tanzil
  translation id), and run the step again.
- **Dutch translation:** Siregar (`quran.translations.nl`) is the only one of the three Tanzil
  Dutch translations that writes "Allah". Leemhuis and Keyzer write "God". Tanzil's Siregar text
  has OCR errors: 92 damaged verses show Soniox's translation, with their reference.

**History and archive:**
- In a normal browser you can scroll back on the live page. A "↓ Live" pill returns to the newest
  block.
- After the khutbah, `/s/<sessionId>` shows the whole session read-only, with exports as `.txt`,
  `.md` and `.srt`. The session ids: `pnpm turjuman sessions` (Docker: `make sessions`, and
  `make archive`, `make export SESSION=<id>`).

**Customize the look:**
- The **look editor** at **`/app/look`** (**Look** in the app): pick one of the 10 built-in looks,
  then adjust any detail: colours, fonts, sizes, block shapes, Quran and dua accents, honorific
  glyphs, event cards, motion, and placement (top / middle / bottom × left / center / right).
- The live preview shows the result. Copy the caption or overlay link, or save it as your own look
  with **Save as a look…** (stored in `CONFIG_DIR/presets.yaml`).
- `docs/presets.md` lists every look (a *preset* in links: `preset=<id>`) and URL parameter.
- The built-in looks:
  - **Blocks:** mosque-dark (default), mosque-light, midnight-gold, high-contrast,
    minimal-transparent, glass, sidebar-pip (room for a camera on the right), large-print.
  - **Rolling captions:** lower-third, cinema.

**Classic rolling captions:** add `?layout=rollup`. These show Soniox's live translation (≈ 1 s),
appended word by word, and the terminology rules above are only hints there.

## The caption page without a screen

A caption page needs no screen: `/` builds a caption link, and `/<from>/<to>` shows captions. It
can't be switched on or off in the app. With exposure lan or public it needs an access key
(`turjuman keys add`). Screen links pass only `?debug=` and `?ui=`; the other parameters below are
for these pages (a screen keeps its own in the app).

| URL | Meaning |
|---|---|
| `http://127.0.0.1:8765/` | Caption link: from (or *Auto-detect*), to, microphone, display options |
| `/ar/nl` | Arabic → Dutch |
| `/auto/nl` | Detect the spoken language automatically |

Optional parameters (combine with `&`):

| Param | Default | Meaning |
|---|---|---|
| `layout` | `blocks` | `blocks` (caption blocks, see above) or `rollup` (classic rolling captions) |
| `preset` | `mosque-dark` | A look from the gallery (`/app/look`, `docs/presets.md`); every colour, font and size can also be overridden per URL |
| `show` | `target` (blocks) / `both` (rollup) | `target`, `both` (Arabic with the translation) or `source` |
| `size` | preset | Font size in px |
| `pos` | `bottom` | Vertical placement: `top`, `middle` or `bottom` |
| `justify` | `center` | Horizontal placement: `left`, `center` or `right` (with a narrower `width`, e.g. for a camera picture-in-picture) |
| `width` | preset | Panel width in % of the screen |
| `bg` | preset | `panel` or `none` (transparent, text with shadow) |
| `quranArabic` | `1` | The Arabic verse above a Quran block; `0` hides it |
| `partial` | `0` (blocks) / `1` (rollup) | Faint live text while a sentence is still being spoken |
| `history` | `1` in browsers | Scroll back on the live page (always off inside OBS) |
| `lines` | `2` | Rollup only: lines per language |
| `idle` | `10` | Rollup only: seconds of silence before the captions fade out |
| `mic` | none | Use the first microphone whose name contains this text, e.g. `?mic=USB` |
| `ch` | `mix` | `left` / `right` for stereo interfaces with the mic on one channel |
| `dsp` | `off` | Browser echo cancellation, noise suppression and auto-gain. Keep `off` for a mixer feed |
| `key` | none | Access key: required with exposure lan or public |
| `ui` | `auto` | Toolbar: hidden inside OBS, shown in normal browsers; `1` / `0` force it. Also works on a screen link |
| `debug` | `0` | Show the level meter, the microphone, session id, engine state and live latency. Also works on a screen link: `/feed/<guid>?debug=1` |

**Pauses:** the page sends audio only while someone speaks, plus 0.5 s before and about 1.5 s
after. Turjuman keeps the Soniox stream open through pauses up to 30 s
(`pages.closeAfterSilenceSec`), then closes it and opens a new one at the next word, without
clipping it. Soniox bills while the stream is open, so long pauses cost nothing and a page can stay
open in OBS for days.

## Server-side capture: overlay and control dock

Instead of the page's microphone, Turjuman can read the audio itself, with ffmpeg, from an input
of its own computer: for example the mixer's aux feed through a USB interface, when OBS's browser
microphone isn't an option. Its captions show on `/overlay`; screens and the app's switches don't
use this audio.

1. Set `audio.input.kind: device` in `config.yaml`, with the exact name from
   `pnpm turjuman devices`. Use `kind: network` with Docker on Windows/macOS (the host's audio
   bridge, see [docker.md](docker.md#audio-bridge)).
2. **Control dock:** OBS *Docks → Custom Browser Docks → `http://127.0.0.1:8765/control`*. It has:
   - Start/Stop and a source selector;
   - a level meter, the list of sessions, and Clear.
3. **Overlay:** a Browser Source at `http://127.0.0.1:8765/overlay?lang=ar,nl` (1920×400), with
   the same OBS settings as above.
4. **Start** the session before the khutbah: Start in the dock, `pnpm turjuman ctl start`
   (Docker: `make start`), or start Turjuman with `pnpm turjuman start --start`. It stops by
   itself after 10 minutes of silence or 90 minutes (`session.autoStopAfterSilenceMin`,
   `session.maxDurationMin`), and resumes after a restart within 10 minutes.

## Cost and privacy

Soniox (`stt-rt-v5`) does the speech recognition and the translation, in one stream: about $0.12
per hour of speech plus $0.06 for the translation, at Soniox's list prices, billed while the stream
is open (see "Pauses" above). `pnpm turjuman estimate start` prints the cost per minute for your
configuration. What is stored and what Soniox receives: "Costs, data and privacy" in the
[README](../README.md), and [SECURITY.md](../SECURITY.md).

- **EU data residency:** use a key from an EU-region Soniox project (request access at
  support@soniox.com) and set `stt.soniox.region: eu`. Check the key with
  `pnpm turjuman doctor --online`.
- Transcripts of caption pages are saved by default (`pages.savePageSessions: true`). Tell your
  community, or turn it off.

**Glossary**
- The glossary lives in `glossaries/ar-nl.yaml` and is a **DRAFT** to review.
- Its fields are `context` (what the khutbah is about), `terms` (recognition hints) and
  `translation_terms` (fixed renderings).
- Soniox treats `translation_terms` as hints. For example, it may write "vrede en zegeningen zij
  met hem" instead of "ﷺ"; the caption blocks turn such phrases into ﷺ in Dutch and English.

## Transcripts

Every session writes to `transcripts/<YYYY-MM-DD_HHmm>_<id>/`, under `DATA_DIR` (Docker:
`data/transcripts/`). Folders are kept until you delete them.

| File | Contents |
|---|---|
| `session.log`, `session.jsonl` | Start/stop, reconnects, cost guards |
| `blocks.jsonl` | The caption blocks |
| `soniox/segments.jsonl` | Every finished segment |
| `soniox/ar.srt`, `soniox/nl.srt` | Subtitles, rewritten while the session runs and on stop |
| `soniox/provider.jsonl` | Raw Soniox messages, only with `transcripts.recordProviderMessages: true` |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Page says the microphone needs HTTPS | Open it on the same machine at `http://127.0.0.1:8765/…`, or use HTTPS (see [HTTPS on the LAN](#https-on-the-lan-microphones-on-phones-and-other-pcs)) |
| "Microphone not found" / wrong mic | Check the OS default input, or pick the microphone in the builder ([The microphone](#screens-accounts-and-the-app)). The page retries every 5 s |
| OBS source stays black / no mic | Start OBS with `--enable-media-stream`; Browser Source toggles **off**; test the same URL in Chrome |
| No captions, level meter flat (`?debug=1`) | The mic is muted or on the other channel: **Microphone → Advanced → Left/Right** in the builder |
| Captions stop; the log says `Soniox fatal error; not retrying` | 401 = the key is refused; 402 or `balance_exhausted` = no credit. Fix it at console.soniox.com, then switch the screen off and on. `pnpm turjuman setup --check` (or `doctor --online`; Docker: `make doctor ONLINE=1`) asks Soniox whether it accepts the key; `doctor` alone only checks that a key is set |
| "invalid key" / "daily limit reached" (a page without a screen link) | `pnpm turjuman keys list`, `pnpm turjuman usage`; create a new access key or raise `--daily-minutes` |
| `Port 8765 is in use` at start | Turjuman runs already (`pnpm turjuman status`), or set another `server.port` in `config.yaml` |
| `Host not allowed` | With `exposure: local`, open Turjuman at `127.0.0.1` or `localhost`, or set `exposure: lan` |
| Missing ﷺ or Arabic glyphs | The fonts are bundled (Noto Naskh Arabic, Noto Sans). Other scripts fall back to system fonts |
| Blank overlay | Is Turjuman running (`pnpm turjuman status`, Docker: `make status`)? Was the session started (server-side capture)? Browser Source URL correct? |

## Development

Turjuman is developed at https://github.com/turjuman-translator/website: the source of this edition, the specs and the tests that need the website. See its CONTRIBUTING.md.
