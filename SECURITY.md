# Security

Turjuman handles API keys that cost money, the accounts of the people who run a mosque's screens,
and what is said in the mosque. This page explains how each is protected and how to report a
problem.

## Reporting a problem

Please report security problems privately via **Report a vulnerability** on the **Security** tab
of [github.com/turjuman-translator/website](https://github.com/turjuman-translator/website/security).
Do not open a public issue. Include what you found, how to reproduce it, and what it lets an
attacker do.

## API keys (Soniox)

**Local mode** (one mosque per install):
- The Soniox key lives in `.env`, next to the server, readable only by its owner (mode 0600).
  `turjuman setup` writes that file for you. A key added in the app is encrypted in `orgs.yaml`,
  as in hosted mode.
- `.env` is never committed (`.gitignore`) and never copied into the Docker image (`.dockerignore`).

**Hosted mode** (many mosques on one server):
- Each mosque's Soniox key is encrypted at rest in `orgs.yaml` with AES-256-GCM.
- Each value is bound to its organisation (additional authenticated data). A value copied to
  another mosque does not decrypt.
- The 32-byte master key comes from `TURJUMAN_MASTER_KEY`, or from `master.key` in the config
  folder (created with mode 0600 the first time a key is stored).
- Keys are checked with Soniox before they are stored. A rejected key is not stored and counts
  as a failed attempt for the address.
- A key never leaves the server: the app only ever shows whether it is set, its last four
  characters, and when it was last checked.
- `master.key` is never recreated while encrypted keys exist without it, and `make backup` leaves
  it out of the archive.
- One mosque's sessions never use another mosque's keys, or the server's own `.env` keys.

**In both modes:**
- Keys (and decrypted keys) are removed from every log line, error message and status text.
- Provider recordings (`provider.jsonl`) have the key redacted.

## Accounts

- **Passwords:** stored as scrypt hashes (N=16384, r=8, p=1, 16-byte salt), never logged. Hosted
  accounts need at least 10 characters. Checking an unknown account costs as much time as a
  wrong password.
- **Login cookies:**
  - signed with HMAC-SHA256 using `secret.key` (or `CAPTIONS_SECRET`);
  - `HttpOnly`, `SameSite=Lax`, and `Secure` on HTTPS.
  - A new password, or disabling the account, logs it out on every device.
- **Rate limits:**
  - logins and password changes: 10 failures in 10 minutes block the address for 10 minutes, and
    10 failures on one account block that account for 15 minutes. Attempts count while they are
    running, so parallel guesses gain nothing. IPv6 addresses count per /64.
  - sign-ups: at most 5 per address per hour, plus a honeypot field;
  - API key checks: 20 per hour per address and per mosque;
  - new accounts and screens: 60 per address per hour. On a hosted server a mosque has at most
    100 accounts and 50 screens.
- **Your own password** changes only with the current one, from the account menu.
- **E-mail addresses are not verified** in this version. A hosted server's operator can remove an
  account that should not exist with `turjuman users remove <e-mail>`.
- **Roles:**
  - the owner and admins manage their own organisation;
  - users manage only their own screens;
  - nobody sees another organisation's accounts, screens, looks, keys or caption history;
  - the server operator works with the admin token or the CLI (`turjuman orgs`), never through
    a mosque's login.

## Screens and caption pages

- **Screen links:** a screen link (`/feed/<guid>`) uses a random UUID, which is its only secret.
  Treat it like a password. **New link** gives a new one; the old link stops working at once.
- **Remote caption pages:** without a screen link they need a login, or (local mode) an access
  key. Access keys are stored as SHA-256 hashes.
- **Response headers:** every page is served with a strict Content-Security-Policy (no inline
  code, no third-party origins), `Referrer-Policy: no-referrer`, `nosniff`, and
  `X-Frame-Options: DENY` for the app.
- **Cross-site requests:** requests that change something must come from the same origin and
  carry a JSON body.

## Audio and transcripts

- The caption page sends audio to the server only while someone speaks, and the server passes it
  on to Soniox, with the language pair and the glossary. Turjuman stores no audio (only
  `turjuman record`, run by hand, writes a recording).
- The text of each session is kept in `transcripts/` (`pages.savePageSessions`, default on) until
  someone deletes it.
- While it runs, the server connects only to Soniox, and to tanzil.net while the Quran data is
  missing. There are no analytics.

## HTTPS on the LAN

`scripts/lan-cert.sh` (`make lan-cert`) makes a small certificate authority in `tls/`, and devices
install its `ca.crt` as trusted. Its private key, `tls/ca.key` (mode 0600), can sign certificates
that every such device trusts, for any site: keep it, and backups that contain it, private. Remove
"Turjuman local CA" from devices that stop using Turjuman.

## Running a server safely

- Serve it over **HTTPS** behind your own reverse proxy with `trustProxy: true` (the nginx block
  in docs/hosting.md). Login cookies and microphones need it. Your proxy must set
  `X-Forwarded-For` itself, not pass on what the client sent (that block does); otherwise the
  rate limits see the wrong address.
- The admin token opens every mosque's sessions on a hosted server. The server generates one
  (43 random characters, `config/admin.token`, mode 0600); a token you set in `config.yaml`
  instead needs at least 24 random characters (`openssl rand -hex 24`).
- Keep the config folder readable only by the server's user. It holds `.env`, `secret.key`,
  `master.key`, `admin.token`, `users.yaml`, `screens.yaml` and `orgs.yaml`.
- **Back up `master.key` (or `TURJUMAN_MASTER_KEY`) separately from `orgs.yaml`:**
  - one without the other is harmless;
  - together they reveal every stored key;
  - without the master key, mosques must paste their keys again.
- Caption history: transcripts are kept on the server (`pages.savePageSessions`, default on).
  Tell the mosques you host, or switch it off.
