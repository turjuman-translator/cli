# Turjuman: the operator's command surface.
#
#   make                          list every target and variable (same as `make help`)
#   make up                       the first run too: it creates config/, data/ and .env, and the
#                                 server makes config/config.yaml, the admin token and downloads
#                                 the Quran data by itself
#   make screens                  the screens and their screen links
#
# Works with GNU make 3.81+ (macOS ships 3.81) and bash 3.2+ on Linux, macOS and Windows
# (Git Bash + GNU make: `winget install Git.Git` and `winget install ezwinports.make`).
# Recipes avoid bash-4-only features (macOS runs them in bash 3.2). No target deletes
# config/ or data/. The raw docker compose commands are in docs/docker.md.

SHELL := bash
.DEFAULT_GOAL := help
.SUFFIXES:

# Git Bash (MSYS) would rewrite container paths like /app/data into Windows paths.
export MSYS_NO_PATHCONV := 1
export MSYS2_ARG_CONV_EXCL := *

# ---- platform --------------------------------------------------------------------------------
UNAME_S := $(shell uname -s 2>/dev/null)
ifneq ($(filter MINGW% MSYS% CYGWIN%,$(UNAME_S)),)
  PLATFORM := windows
else
  ifeq ($(UNAME_S),Darwin)
    PLATFORM := macos
  else
    PLATFORM := linux
  endif
endif

# ---- variables: `VAR ?= default ## description` lines feed `make help` ----------------------
AUDIO ?= $(if $(filter linux,$(PLATFORM)),pulse,bridge) ## pulse = container uses the host PulseAudio/PipeWire (Linux default); bridge = host audio bridge (Windows/macOS default)
TOKEN ?= ## admin token for the API (default: server.token, else the generated config/admin.token); never echoed
FILE ?= ## WAV name in data/recordings (start, bridge-test)
DEVICE ?= ## bridge: device name or alternative name (Windows), index or name (macOS), Pulse source (Linux)
SESSION ?= ## kill, event, archive, export: session id (see make sessions-live / make sessions)
EVENT ?= ## event: athan | iqama | salah | none
FORMAT ?= txt ## export: txt | md | srt (default txt)
EXPORT_DIR ?= data/exports ## export: output folder (default data/exports)
FROM ?= ## page, page-url: source language code, or auto
TO ?= ## page, page-url: target language code
SHOW ?= ## page, page-url: both | target | source
KEY ?= ## page, page-url, archive, export: access key for remote use (adds ?key=)
LANG ?= ## overlay: blocks to show, e.g. LANG=ar,nl (command line only)
OUT ?= ## record: output name, written to data/recordings/<OUT>.wav
SECONDS ?= ## record: stop after n seconds (default: until Ctrl-C)
LOG ?= ## replay: provider log, path inside data/
SPEED ?= 1 ## replay: playback speed (default 1)
LOOP ?= ## replay: 1 = loop forever
SINCE ?= ## logs: e.g. 10m
LABEL ?= ## key-add: who the key is for
DAILY_MINUTES ?= ## key-add: daily streamed-minutes limit
ID ?= ## key-revoke: key id (see make key-list)
USERNAME ?= ## user-add, user-passwd: account name (command line only)
NAME ?= ## user-add: display name shown in the app
ADMIN ?= ## user-add: 1 = an admin account
BASE_URL ?= ## browser targets: base URL (default http://127.0.0.1:HTTP_PORT)
HTTP_PORT ?= ## this instance's app port on this computer (default 8765; usually set in .env)
HTTPS_PORT ?= ## this instance's HTTPS port (default 8443; usually set in .env)
BRIDGE_PORT ?= ## this instance's audio-bridge port (default 7000; usually set in .env)
CAPTIONS_IMAGE ?= ## the image tag (default turjuman:local; set it per instance in .env)
CAPTIONS_BUILD_IMAGE ?= ## the build/tools image tag (default turjuman:build; set it per instance in .env)
COMPOSE_PROJECT_NAME ?= ## the compose project of this instance (default turjuman; usually set in .env)
AUTO_ACCEPT ?= ## obs-shortcut: 1 = also auto-accept media permission prompts
ONLINE ?= ## doctor: 1 = also ask Soniox whether it accepts the key (a free model list)
ARGS ?= ## cli: a turjuman command with its options, e.g. ARGS="screens enable <id>"
LAN_NAMES ?= ## lan-cert: extra names or IP addresses for the certificate, e.g. LAN_NAMES="192.168.1.20" (on Windows give the LAN IP: the script cannot find it there)
E2E_FIXTURE ?= ## e2e: provider log in test/fixtures, without .jsonl (default soniox-tts-1)

# Defaults written as `VAR ?= value ## ...` keep the space before `##`; strip it.
AUDIO := $(strip $(AUDIO))
SPEED := $(strip $(SPEED))
FORMAT := $(strip $(FORMAT))
EXPORT_DIR := $(strip $(EXPORT_DIR))
ifeq ($(filter pulse bridge,$(AUDIO)),)
  $(error AUDIO must be pulse or bridge (got "$(AUDIO)"))
endif

# ---- internals -------------------------------------------------------------------------------
COMPOSE_BASE := docker compose -f compose.yaml
COMPOSE := $(COMPOSE_BASE)$(if $(filter pulse,$(AUDIO)), -f compose.linux-audio.yaml)
# Instance settings given on the command line go to compose; empty ones are not exported, so the
# values in .env stay in force (compose reads .env itself).
$(foreach v,HTTP_PORT HTTPS_PORT BRIDGE_PORT CAPTIONS_IMAGE CAPTIONS_BUILD_IMAGE COMPOSE_PROJECT_NAME,$(if $(strip $($(v))),$(eval export $(v))))
IMAGE := $(or $(strip $(CAPTIONS_IMAGE)),$(shell sed -n 's/^CAPTIONS_IMAGE=//p' .env 2>/dev/null | tail -n 1 | tr -d '\r"'"'"),turjuman:local)

# $(call q,value): single-quote for bash, so names with spaces/parentheses/quotes survive.
q = '$(subst ','"'"',$(1))'

# Older installs used the compose project name khutbah-captions. With the default name, refuse
# to start next to a leftover container of it (both want the same ports) and say how to stop it.
LEGACY_CHECK = if [ -z "$$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' .env 2>/dev/null | tail -n 1)$(strip $(COMPOSE_PROJECT_NAME))" ] && [ -n "$$(docker ps -aq --filter label=com.docker.compose.project=khutbah-captions 2>/dev/null)" ]; then echo "An older instance of this checkout still exists (compose project khutbah-captions)." >&2; echo "Stop it once with: docker compose -p khutbah-captions down   then run make up again." >&2; exit 1; fi

# Bash, with a `say` function defined: create what a first run needs and is missing, never
# overwriting anything. config/ and data/ with their folders (made here, so Docker does not make
# them owned by root), editable copies of languages.yaml and glossaries/, .env (mode 600) and on
# Linux UID, GID and PULSE_SOCKET in .env. The server itself makes config/config.yaml and the
# admin token, and downloads the Quran data.
PREPARE = keep_or_copy() { if [ -e "$$2" ]; then say "  kept     $$2"; else cp "$$1" "$$2"; say "  created  $$2"; fi; }; \
	ensure_nl() { if [ -s .env ] && [ -n "$$(tail -c 1 .env)" ]; then echo >> .env; fi; }; \
	add_env() { if grep -q "^$$1=" .env; then say "  kept     $$1 in .env"; else ensure_nl; echo "$$1=$$2" >> .env; say "  added    $$1=$$2 to .env"; fi; }; \
	mkdir -p config/glossaries data/recordings data/transcripts; \
	keep_or_copy languages.yaml config/languages.yaml; \
	for g in glossaries/*.yaml; do [ -e "$$g" ] || continue; keep_or_copy "$$g" "config/$$g"; done; \
	if [ -e .env ]; then say "  kept     .env"; else cp .env.example .env; chmod 600 .env; say "  created  .env"; fi; \
	if [ "$(PLATFORM)" = linux ]; then \
	  add_env UID "$$(id -u)"; \
	  add_env GID "$$(id -g)"; \
	  add_env PULSE_SOCKET "$${XDG_RUNTIME_DIR:-/run/user/$$(id -u)}/pulse/native"; \
	  sock="$$(sed -n 's/^PULSE_SOCKET=//p' .env | tail -n 1)"; \
	  [ -S "$$sock" ] || say "  note:    $$sock is not a socket (yet) - is PipeWire/PulseAudio running for this user?"; \
	fi

# Is the captions container running?  (bash condition)
RUNNING = [ -n "$$($(COMPOSE) ps -q --status running captions 2>/dev/null)" ]
NEED_RUNNING = $(RUNNING) || { echo "The captions service is not running - start it with: make up" >&2; exit 1; }
# CLI inside the running service. TOKEN travels by name (-e TOKEN), so it is never echoed.
EXEC = $(COMPOSE) exec -T$(if $(TOKEN), -e TOKEN) captions node dist/main.js
# CLI in the running service, or in a one-off container when the service is down.
CLI = if $(RUNNING); then $(EXEC) $(1); else $(COMPOSE) run --rm --no-deps$(if $(TOKEN), -e TOKEN) captions $(1); fi
# The same, passing piped stdin through (echo '...' | make user-add ...); a terminal's stdin is
# closed instead, so the CLI generates a password rather than waiting for input.
CLI_STDIN = if [ -t 0 ]; then { $(call CLI,$(1)); } < /dev/null; else $(call CLI,$(1)); fi
# USERNAME is also a Windows environment variable: only a command-line USERNAME= counts.
ACCOUNT := $(if $(filter command line,$(origin USERNAME)),$(strip $(USERNAME)))
ACCOUNT_CHECK = $(if $(ACCOUNT),true,{ echo 'Usage: $(USAGE_$@)'; echo '       (USERNAME is required)'; } >&2; exit 1)
# Interactive docker commands need a TTY (Ctrl-C, shells). Git Bash's mintty window has none
# for Windows programs: use winpty when present, else fall back to -T.
TTY_SH = tty=-T; pre=; if [ -t 0 ] && [ -t 1 ]; then tty=; if [ "$(PLATFORM)" = windows ] && [ "$${TERM_PROGRAM:-}" = mintty ]; then if command -v winpty >/dev/null 2>&1; then pre=winpty; else tty=-T; fi; fi; fi

START_ARGS = $(if $(FILE), --file $(call q,/app/data/recordings/$(FILE)))
RECORD_ARGS = --out $(call q,/app/data/recordings/$(patsubst %.wav,%,$(OUT)).wav)$(if $(SECONDS), --seconds $(call q,$(SECONDS)))

# ---- URLs ------------------------------------------------------------------------------------
# KEY=value from .env (last wins; quotes and CR stripped). Recursive, so only run when used.
env_get = $(shell sed -n 's/^$(1)=//p' .env 2>/dev/null | tail -n 1 | tr -d '\r"'"'")
# The service as this host reaches it: 127.0.0.1, unless CAPTIONS_BIND publishes it on one LAN IP.
BIND_EFF = $(or $(CAPTIONS_BIND),$(call env_get,CAPTIONS_BIND))
API_HOST = $(if $(filter-out 0.0.0.0 127.0.0.1 :: localhost,$(BIND_EFF)),$(if $(findstring :,$(BIND_EFF)),[$(BIND_EFF)],$(BIND_EFF)),127.0.0.1)
HTTP_PORT_EFF = $(or $(strip $(HTTP_PORT)),$(call env_get,HTTP_PORT),8765)
# The bridge streams to this instance's published bridge port (BRIDGE_PORT in .env); a second
# instance's Windows autostart task carries its project name, so it never replaces the first's.
BRIDGE_PORT_EFF = $(or $(strip $(BRIDGE_PORT)),$(call env_get,BRIDGE_PORT),7000)
PROJECT_EFF = $(or $(strip $(COMPOSE_PROJECT_NAME)),$(call env_get,COMPOSE_PROJECT_NAME),turjuman)
BRIDGE_TASK = Turjuman audio bridge$(if $(filter-out turjuman,$(PROJECT_EFF)), ($(PROJECT_EFF)))
API_URL = http://$(API_HOST):$(HTTP_PORT_EFF)
BASE = $(or $(BASE_URL),$(API_URL))
# LANG is also the locale variable: only a command-line LANG= selects overlay blocks.
OVERLAY_LANG := $(if $(filter command line,$(origin LANG)),$(LANG))
empty :=
space := $(empty) $(empty)
# $(call qs,k=v k=v ...) -> ?k=v&k=v (pairs with empty values are dropped by the callers)
qs = $(if $(strip $(1)),?$(subst $(space),&,$(strip $(1))))
PAGE_URL = $(BASE)/$(FROM)/$(TO)$(call qs,$(if $(SHOW),show=$(SHOW)) $(if $(KEY),key=$(KEY)))
OVERLAY_URL = $(BASE)/overlay?debug=1$(if $(OVERLAY_LANG),&lang=$(OVERLAY_LANG))

# ---- admin token and direct API calls (host side) ---------------------------------------------
# Bash: `cfg <key>` prints server.<key> from config/config.yaml (quotes, comments and CR stripped).
CFG_FN = cfg() { [ -f config/config.yaml ] || return 0; awk -v k="$$1" -v sq="'" '/^[^ \t\#]/ { s = ($$0 ~ /^server:/) } s && $$1 == k ":" { v = $$0; sub(/\r$$/, "", v); sub(/^[ \t]*[^ \t:]*:[ \t]*/, "", v); if (substr(v, 1, 1) == "\"") { v = substr(v, 2); sub(/".*/, "", v) } else if (substr(v, 1, 1) == sq) { v = substr(v, 2); sub(sq ".*", "", v) } else { sub(/[ \t]+\#.*/, "", v); sub(/[ \t]+$$/, "", v) } print v; exit }' config/config.yaml; }
# Bash: tok = TOKEN, else CAPTIONS_TOKEN, else server.token, else the token the server generated
# (config/admin.token; read in the container when this user cannot read it). secured=1 on a
# hosted server and with exposure lan or public (HTTP CLI calls need the token there).
AUTH_SH = $(CFG_FN); $(URLENC_FN); tok="$${TOKEN:-$${CAPTIONS_TOKEN:-}}"; [ -n "$$tok" ] || tok="$$(cfg token)"; \
	if [ -z "$$tok" ] && [ -r config/admin.token ]; then tok="$$(tr -d '\r\n' < config/admin.token)"; fi; \
	if [ -z "$$tok" ] && [ -e config/admin.token ] && $(RUNNING); then tok="$$($(COMPOSE) exec -T captions cat /app/config/admin.token 2>/dev/null | tr -d '\r\n')"; fi; \
	secured=0; case "$$(cfg exposure)" in lan|public) secured=1;; esac; \
	if grep -Eq '^mode:[[:space:]]*hosted' config/config.yaml 2>/dev/null; then secured=1; fi
# Bash: `urlenc <s>` percent-encodes s for a URL query (bytewise, bash 3.2 safe).
URLENC_FN = urlenc() { local LC_ALL=C s="$$1" o="" c n i=0; while [ "$$i" -lt "$${\#s}" ]; do c="$${s:$$i:1}"; case "$$c" in [A-Za-z0-9._~-]) o="$$o$$c";; *) n=$$(printf '%d' "'$$c"); o="$$o$$(printf '%%%02X' $$(( (n + 256) % 256 )))";; esac; i=$$((i + 1)); done; printf '%s' "$$o"; }
# Bash: append ?token= to $$url when the exposure needs it (or TOKEN was given).
URL_TOKEN = if [ -n "$$tok" ] && { [ "$$secured" = 1 ] || [ -n "$${TOKEN:-}" ]; }; then url="$$url?token=$$(urlenc "$$tok")"; fi
# curl that sends $$tok as a Bearer header through stdin, so it never shows up in argv or echo.
CURL_AUTH = { if [ -n "$$tok" ]; then printf 'header = "Authorization: Bearer %s"\n' "$$(printf '%s' "$$tok" | sed 's/[\\"]/\\&/g')"; fi; } | curl -fsS --max-time 60 -K -
SID_CHECK = case "$$sid" in ""|*[!A-Za-z0-9._-]*) echo "SESSION must be a session id (see make sessions-live or make sessions)" >&2; exit 1;; esac
API_HINT = The request failed: is the service running (make status) and the session id right? With exposure lan/public and on a hosted server the admin token is used (TOKEN=..., server.token, or config/admin.token).

# Open a URL or folder with the desktop's default handler; print it when that fails (SSH).
# OPEN_URL opens the URL held in the bash variable $$url.
ifeq ($(PLATFORM),windows)
  open_cmd = powershell.exe -NoProfile -Command "Start-Process '$(subst ','',$(1))'"
  OPEN_URL = powershell.exe -NoProfile -Command "Start-Process '$$url'"
else
  ifeq ($(PLATFORM),macos)
    open_cmd = open $(call q,$(1))
    OPEN_URL = open "$$url"
  else
    open_cmd = xdg-open $(call q,$(1)) >/dev/null 2>&1
    OPEN_URL = xdg-open "$$url" >/dev/null 2>&1
  endif
endif
open_or_print = $(call open_cmd,$(1)) || echo "Could not open it here - open manually: $(1)"
OPEN_URL_OR_PRINT = $(OPEN_URL) || echo "Could not open it here - open manually: $$url"

# ---- audio bridge (host side) ----------------------------------------------------------------
ifeq ($(PLATFORM),windows)
  BRIDGE := powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/audio-bridge.ps1
  BRIDGE_LIST = $(BRIDGE) -List
  BRIDGE_RUN = $(BRIDGE) -Device $(call q,$(DEVICE)) -Port $(BRIDGE_PORT_EFF)
  BRIDGE_TEST = $(BRIDGE) -File $(call q,data/recordings/$(FILE)) -Port $(BRIDGE_PORT_EFF)
  BRIDGE_INSTALL = $(BRIDGE) -InstallAutostart -Device $(call q,$(DEVICE)) -Port $(BRIDGE_PORT_EFF) -TaskName $(call q,$(BRIDGE_TASK))
  BRIDGE_UNINSTALL = $(BRIDGE) -UninstallAutostart -Port $(BRIDGE_PORT_EFF) -TaskName $(call q,$(BRIDGE_TASK))
else
  BRIDGE := bash scripts/audio-bridge.sh
  BRIDGE_LIST = $(BRIDGE) --list
  BRIDGE_RUN = $(BRIDGE) --device $(call q,$(DEVICE)) --port $(BRIDGE_PORT_EFF)
  BRIDGE_TEST = $(BRIDGE) --file $(call q,data/recordings/$(FILE)) --port $(BRIDGE_PORT_EFF)
  BRIDGE_INSTALL = echo 'Autostart is Windows-only (Task Scheduler). On $(PLATFORM), keep make bridge DEVICE=... running in a terminal (see docs/docker.md).' >&2; exit 1
  BRIDGE_UNINSTALL = $(BRIDGE_INSTALL)
endif
BRIDGE_SKIP := $(and $(filter linux,$(PLATFORM)),$(filter pulse,$(AUDIO)))
BRIDGE_NOT_NEEDED = echo 'AUDIO=pulse: on Linux the container reads the host PulseAudio/PipeWire directly, so the bridge is not needed (AUDIO=bridge streams from this host anyway).'
OBS_HINT = echo 'obs-shortcut is Windows-only. macOS: /Applications/OBS.app/Contents/MacOS/OBS --enable-media-stream   Linux: obs --enable-media-stream'

# ---- usage lines for missing required variables (see require-%) ------------------------------
USAGE_kill = make kill SESSION=<id>   (ids: make sessions-live)
USAGE_page = make page FROM=ar TO=nl [SHOW=both|target|source] [KEY=<access key>]
USAGE_page-url = make page-url FROM=ar TO=nl [KEY=<access key>] [SHOW=both|target|source]
USAGE_bridge = make bridge DEVICE="<name from make bridge-list>"
USAGE_bridge-install = make bridge-install DEVICE="<name from make bridge-list>"
USAGE_bridge-test = make bridge-test FILE=<wav in data/recordings>
USAGE_record = make record OUT=<name> [SECONDS=n]
USAGE_replay = make replay LOG=<provider.jsonl path inside data/> [SPEED=1] [LOOP=1]
USAGE_key-add = make key-add LABEL="<who it is for>" [DAILY_MINUTES=n]
USAGE_key-revoke = make key-revoke ID=<id>   (ids: make key-list)
USAGE_user-add = make user-add USERNAME=<name> [ADMIN=1] [NAME="Display name"]   (the password is printed once; or pipe one in: echo "<password>" | make user-add ...)
USAGE_user-passwd = make user-passwd USERNAME=<name>   (names: make users)
USAGE_event = make event EVENT=athan|iqama|salah|none [SESSION=<id>|all]   (default: all live sessions)
USAGE_export = make export SESSION=<id> [FORMAT=txt|md|srt]   (ids: make sessions)

.PHONY: help setup quran-data build up down restart update status logs shell \
        start stop clear sessions-live kill event \
        control overlay customize page page-url obs-shortcut \
        bridge-list bridge bridge-install bridge-uninstall bridge-test \
        doctor devices record replay sessions open-data open-config \
        archive export \
        key-add key-list key-revoke usage \
        admin app keys user-add user-passwd users orgs screens cli lan-cert \
        test e2e dev backup prune version need-setup

##@ Setup & lifecycle

help: ## List all targets and variables (default target)
	@awk -v platform='$(PLATFORM)' -v audio='$(AUDIO)' ' \
	BEGIN { printf "Turjuman - make <target> [VAR=value]   (platform: %s, AUDIO=%s)\n", platform, audio } \
	/^##@ / { printf "\n%s\n", substr($$0, 5); next } \
	/^[a-zA-Z0-9_-]+:/ && index($$0, "## ") > 0 { n = $$0; sub(/:.*/, "", n); printf "  %-17s %s\n", n, substr($$0, index($$0, "## ") + 3); next } \
	/^[A-Z][A-Z0-9_]* *[?]=/ && index($$0, "## ") > 0 { n = $$0; sub(/ *[?]=.*/, "", n); vars = vars sprintf("  %-14s %s\n", n, substr($$0, index($$0, "## ") + 3)) } \
	END { printf "\nVariables (pass on the command line, e.g. make bridge DEVICE=\"Line (USB Audio CODEC)\")\n%s", vars } \
	' $(firstword $(MAKEFILE_LIST))

setup: ## Create config/, data/ and .env when missing, saying what it did (make up does the same, silently)
	@set -euo pipefail; say() { echo "$$1"; }; $(PREPARE); \
	echo; \
	echo "Next: make up   (returns once the service is healthy). The server makes config/config.yaml"; \
	echo "and the admin token (config/admin.token) itself, and downloads the Quran data in the background."; \
	echo "Optional: config/config.yaml. audio.input.kind: none (the default) serves browser caption pages only;"; \
	if [ "$(PLATFORM)" = linux ]; then \
	  echo "for server-side capture set kind: device with a source name from: make devices"; \
	else \
	  echo "for server-side capture set kind: network, then: make bridge-list and make bridge$(if $(filter windows,$(PLATFORM)),-install) DEVICE=\"<name>\""; \
	fi

quran-data: need-setup ## Download the Quran data again (the server downloads what is missing by itself)
	@$(COMPOSE_BASE) --profile tools run --build --rm tools pnpm exec tsx scripts/quran-data.ts
	@if $(RUNNING); then echo "Restarting so the server loads the Quran data..."; $(COMPOSE) restart captions && $(COMPOSE) up -d --wait --wait-timeout 120; fi

build: ## Build the image
	@$(COMPOSE) build

up: need-setup ## Start in the background, the first time too; returns once healthy (docker compose up -d --wait)
	@$(LEGACY_CHECK)
	@$(COMPOSE) up -d --wait --wait-timeout 120
	@echo "Turjuman is up: $(BASE)/   (make admin opens the app; make status, make logs)"

down: ## Stop gracefully; a running session is finalized first
	@if $(RUNNING); then $(EXEC) ctl stop || echo "(ctl stop failed - stopping the container still finalizes the session)" >&2; fi
	@$(COMPOSE) down --remove-orphans

restart: need-setup ## Restart the service and wait until healthy
	@$(COMPOSE) restart captions
	@$(COMPOSE) up -d --wait --wait-timeout 120

update: need-setup ## git pull, rebuild, restart and wait until healthy
	@git pull --ff-only
	@$(LEGACY_CHECK)
	@$(COMPOSE) build
	@$(COMPOSE) up -d --wait --wait-timeout 120

status: ## Container state plus a /health summary: sessions, audio, bridge, latency p50/p95
	@$(COMPOSE) ps
	@if $(RUNNING); then $(EXEC) status; else echo "The captions service is not running - start it with: make up" >&2; exit 1; fi

logs: ## Follow the logs (SINCE=10m optional)
	@$(COMPOSE) logs -f $(if $(SINCE),--since $(call q,$(SINCE)),--tail 200) captions

shell: ## Open a shell inside the running container
	@$(NEED_RUNNING); $(TTY_SH); $$pre $(COMPOSE) exec $$tty captions bash

##@ Session (Friday operations)

start: ## Start a session (paid: prints a cost estimate first); FILE=<name in data/recordings> replays a recording (rehearsal)
	@$(NEED_RUNNING); \
	$(EXEC) estimate start$(START_ARGS) || true; \
	$(EXEC) ctl start$(START_ARGS)

stop: ## Stop the session and write transcripts and SRTs
	@$(NEED_RUNNING); $(EXEC) ctl stop

clear: ## Clear the captions on all screens
	@$(NEED_RUNNING); $(EXEC) ctl clear

sessions-live: ## List the active sessions (all kinds)
	@$(NEED_RUNNING); $(EXEC) ctl sessions

kill: require-SESSION ## Stop one session: SESSION=<id>
	@$(NEED_RUNNING); $(EXEC) ctl kill $(call q,$(SESSION))

event: require-EVENT ## Force an event (manual override): EVENT=athan|iqama|salah|none [SESSION=<id>|all] (default all)
	@$(AUTH_SH); ev=$(call q,$(EVENT)); sid=$(call q,$(or $(SESSION),all)); \
	case "$$ev" in athan|iqama|salah|none) ;; *) echo 'Usage: $(USAGE_event)' >&2; exit 1;; esac; \
	$(SID_CHECK); \
	if $(CURL_AUTH) -X POST -H 'Content-Type: application/json' --data "{\"event\":\"$$ev\"}" "$(API_URL)/api/sessions/$$sid/event"; then echo; else echo '$(API_HINT)' >&2; exit 1; fi

##@ Browser shortcuts & OBS

control: ## Open the control page (adds ?token= on a hosted server and with exposure lan/public)
	@$(AUTH_SH); url="$(BASE)/control"; $(URL_TOKEN); echo "Opening $(BASE)/control"; $(OPEN_URL_OR_PRINT)

overlay: ## Open an overlay preview with debug on (LANG=ar,nl optional)
	@echo "Opening $(OVERLAY_URL)"; $(call open_or_print,$(OVERLAY_URL))

customize: ## Open the caption-look editor /app/look (adds ?token= on a hosted server and with exposure lan/public)
	@$(AUTH_SH); url="$(BASE)/app/look"; $(URL_TOKEN); echo "Opening $(BASE)/app/look"; $(OPEN_URL_OR_PRINT)

page: require-FROM require-TO ## Open a caption page without a screen: FROM=ar TO=nl [SHOW=] [KEY=]
	@echo "Opening $(PAGE_URL)"; $(call open_or_print,$(PAGE_URL))

page-url: require-FROM require-TO ## Print the caption-page URL to paste into OBS: FROM=ar TO=nl [KEY=] (adds ?key=)
	@echo '$(PAGE_URL)'

obs-shortcut: ## Windows: desktop shortcut "OBS Studio (captions)" with --enable-media-stream (AUTO_ACCEPT=1)
	@$(if $(filter windows,$(PLATFORM)),powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/obs-media-shortcut.ps1$(if $(AUTO_ACCEPT), -AutoAccept),$(OBS_HINT))

##@ Audio bridge (Windows/macOS; on Linux only with AUDIO=bridge)

bridge-list: ## List the host's audio input devices
	@$(if $(BRIDGE_SKIP),$(BRIDGE_NOT_NEEDED),$(BRIDGE_LIST))

bridge: require-DEVICE ## Run the bridge in the foreground: DEVICE="<name>" (Ctrl-C stops)
	@$(if $(BRIDGE_SKIP),$(BRIDGE_NOT_NEEDED),$(BRIDGE_RUN))

bridge-install: require-DEVICE ## Install bridge autostart at logon (Windows): DEVICE="<name>"
	@$(if $(BRIDGE_SKIP),$(BRIDGE_NOT_NEEDED),$(BRIDGE_INSTALL))

bridge-uninstall: ## Remove the bridge autostart (Windows)
	@$(if $(BRIDGE_SKIP),$(BRIDGE_NOT_NEEDED),$(BRIDGE_UNINSTALL))

bridge-test: require-FILE ## Stream a WAV through the bridge instead of the mic: FILE=<name in data/recordings>
	@$(if $(BRIDGE_SKIP),$(BRIDGE_NOT_NEEDED),$(BRIDGE_TEST))

##@ Diagnostics & tools

doctor: need-setup ## Check the setup: config, the Soniox key, HTTPS certificate, Quran data, the connection to Soniox [ONLINE=1]
	@$(COMPOSE) run --rm captions doctor$(if $(ONLINE), --online)

cli: need-setup ## Run any turjuman command in the service: ARGS="screens enable <id>" (ARGS=--help lists them)
	@$(call CLI,$(ARGS))

devices: need-setup ## List input devices as the container sees them
	@$(COMPOSE) run --rm captions devices

record: require-OUT need-setup ## Record the input to data/recordings/<OUT>.wav: OUT=<name> [SECONDS=n]
	@$(TTY_SH); \
	if $(RUNNING); then $$pre $(COMPOSE) exec $$tty$(if $(TOKEN), -e TOKEN) captions node dist/main.js record $(RECORD_ARGS); \
	else $$pre $(COMPOSE) run --rm --service-ports $$tty captions record $(RECORD_ARGS); fi


replay: require-LOG need-setup ## Replay a provider log for overlay work: LOG=<path in data/> [SPEED=] [LOOP=1]; pauses the service
	@set -uo pipefail; \
	was_running=0; if $(RUNNING); then was_running=1; fi; \
	restore() { trap - EXIT INT TERM; if [ "$$was_running" = 1 ]; then echo "Restarting the captions service..."; $(COMPOSE) up -d --wait --wait-timeout 120 captions; fi; }; \
	trap restore EXIT; trap 'exit 130' INT TERM; \
	if [ "$$was_running" = 1 ]; then echo "Stopping the captions service (replay uses the same ports)..."; $(COMPOSE) stop captions; fi; \
	$(COMPOSE) run --rm --service-ports captions replay $(call q,/app/data/$(LOG)) --speed $(call q,$(SPEED))$(if $(LOOP), --loop)

sessions: need-setup ## List recent sessions with duration and latency summary
	@$(call CLI,sessions)

open-data: ## Open the data/ folder in the file manager
	@[ -d data ] || { echo "data/ does not exist yet - run: make up" >&2; exit 1; }; $(call open_or_print,data)

open-config: ## Open the config/ folder in the file manager
	@[ -d config ] || { echo "config/ does not exist yet - run: make up" >&2; exit 1; }; $(call open_or_print,config)

##@ Archive & exports

archive: ## Open a session's read-only archive page /s/<id> (SESSION=<id>, default: the latest; KEY= for remote)
	@$(AUTH_SH); sid=$(call q,$(SESSION)); \
	if [ -z "$$sid" ]; then sid="$$(ls -1 data/transcripts 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}_' | sort | tail -n 1 | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}_//')"; fi; \
	[ -n "$$sid" ] || { echo "No sessions in data/transcripts yet - pass SESSION=<id> (see make sessions)" >&2; exit 1; }; \
	$(SID_CHECK); \
	url="$(BASE)/s/$$sid"; echo "Opening $$url"; \
	if [ -n "$${KEY:-}" ]; then url="$$url?key=$$(urlenc "$$KEY")"; else $(URL_TOKEN); fi; \
	$(OPEN_URL_OR_PRINT)

export: require-SESSION need-setup ## Save a session export to data/exports/<id>.<fmt>: SESSION=<id> [FORMAT=txt|md|srt]
	@$(AUTH_SH); sid=$(call q,$(SESSION)); fmt=$(call q,$(FORMAT)); \
	case "$$fmt" in txt|md|srt) ;; *) echo 'Usage: $(USAGE_export)' >&2; exit 1;; esac; \
	$(SID_CHECK); \
	if [ -z "$$tok" ] && [ -n "$${KEY:-}" ]; then tok="$$KEY"; fi; \
	dir=$(call q,$(EXPORT_DIR)); mkdir -p "$$dir"; out="$$dir/$$sid.$$fmt"; \
	if $(CURL_AUTH) -o "$$out" "$(API_URL)/api/sessions/$$sid/export.$$fmt"; then echo "Saved $$out"; else rm -f "$$out"; echo '$(API_HINT)' >&2; exit 1; fi

##@ Remote caption pages: access keys

key-add: require-LABEL need-setup ## Create an access key (printed once): LABEL="<name>" [DAILY_MINUTES=n]
	@$(call CLI,keys add --label $(call q,$(LABEL))$(if $(DAILY_MINUTES), --daily-minutes $(call q,$(DAILY_MINUTES))))

key-list: need-setup ## List keys: labels, limits, last used (never the key itself)
	@$(call CLI,keys list)

key-revoke: require-ID need-setup ## Revoke a key: ID=<id>
	@$(call CLI,keys revoke $(call q,$(ID)))

usage: need-setup ## Streamed minutes per key and engine, today and this month
	@$(call CLI,usage)

lan-cert: ## HTTPS on the LAN (microphones on phones/other PCs): a local CA + certificate in config/tls; then set server.https.port: 8443 [LAN_NAMES=]
	@LAN_NAMES=$(call q,$(LAN_NAMES)) bash scripts/lan-cert.sh config/tls

##@ The app: accounts & screens

admin: ## Open the app /app (exposure local: the first visit creates the admin account)
	@url="$(BASE)/app"; echo "Opening $$url"; $(OPEN_URL_OR_PRINT)

app: admin ## The same as make admin: open the app /app

keys: need-setup ## Enter your Soniox key (checked with Soniox, saved in config/.env), then restart
	@$(TTY_SH); $$pre $(COMPOSE) run --rm --no-deps $$tty captions setup
	@if $(RUNNING); then $(COMPOSE) restart captions && $(COMPOSE) up -d --wait --wait-timeout 120; fi

user-add: need-setup ## Create an account for the app (password printed once, or piped): USERNAME=<name> [ADMIN=1] [NAME="Display name"]
	@$(ACCOUNT_CHECK); $(call CLI_STDIN,users add $(call q,$(ACCOUNT))$(if $(ADMIN), --admin)$(if $(NAME), --name $(call q,$(NAME))))

user-passwd: need-setup ## New password for an account (printed once, or piped); logs it out everywhere: USERNAME=<name>
	@$(ACCOUNT_CHECK); $(call CLI_STDIN,users passwd $(call q,$(ACCOUNT)))

users: need-setup ## List the accounts of the app: role, status, last login, screens
	@$(call CLI,users list)

orgs: need-setup ## Hosted servers: the organisations (owner, accounts, screens, keys set, minutes this month)
	@$(call CLI,orgs list)

screens: need-setup ## List the screens with their screen links (in Docker: the http://127.0.0.1 links)
	@$(call CLI,screens list)

##@ Development & maintenance

test: ## Typecheck, lint and unit/integration tests in Docker, offline (test profile)
	@$(COMPOSE_BASE) --profile test run --rm --build test

e2e: ## Playwright overlay and caption-page checks against a replay server (e2e profile)
	@[ -f test/e2e/run.ts ] || { echo "test/e2e/run.ts not found - the e2e suites are not in this checkout yet" >&2; exit 1; }
	@$(COMPOSE_BASE) --profile e2e up --build --attach playwright --exit-code-from playwright replay playwright; rc=$$?; \
	$(COMPOSE_BASE) --profile e2e rm -fsv replay playwright >/dev/null 2>&1 || true; \
	exit $$rc

dev: need-setup ## Dev mode: source mounted, auto-reload (dev profile); stops the service first (same ports)
	@if $(RUNNING); then echo "Stopping the captions service (dev mode uses the same ports)..."; $(COMPOSE) stop captions; fi
	@$(COMPOSE_BASE) --profile dev run --rm --build --service-ports dev; echo "Dev mode ended. Bring the service back with: make up"

backup: ## Archive config/ and data/transcripts/ to backups/<date>_<time>.tar.gz (without .env, keys.yaml, master.key and admin.token)
	@set -euo pipefail; umask 077; \
	paths=""; for p in config data/transcripts; do if [ -e "$$p" ]; then paths="$$paths $$p"; fi; done; \
	if [ -z "$$paths" ]; then echo "Nothing to back up yet (no config/ or data/transcripts/)." >&2; exit 1; fi; \
	mkdir -p backups; out="backups/$$(date +%Y-%m-%d_%H%M%S).tar.gz"; \
	tar -czf "$$out" --exclude='.env' --exclude='.env.*' --exclude='keys.yaml' --exclude='master.key' --exclude='admin.token' --exclude='*.tmp' $$paths; \
	echo "Backup written: $$out (readable only by you)"; \
	echo "Not included: .env (API keys), config/keys.yaml (access keys), config/master.key and config/admin.token (made again on the next start)."; \
	if [ -f config/master.key ]; then echo "Keep a copy of config/master.key somewhere else: with orgs.yaml it unlocks the stored API keys."; fi

prune: ## Remove dangling images and build cache (never volumes, config/ or data/)
	@docker image prune -f
	@docker builder prune -f

version: ## Print the git commit, image id and app version
	@echo "git commit : $$(git rev-parse --short HEAD 2>/dev/null || echo unknown)$$(if [ -n "$$(git status --porcelain 2>/dev/null)" ]; then echo ' (local changes)'; fi)"
	@id="$$(docker image inspect --format '{{.Id}}' $(IMAGE) 2>/dev/null)" || id="not built (make build)"; echo "image      : $(IMAGE) $$id"
	@echo "app version: $$(docker run --rm --network none $(IMAGE) --version 2>/dev/null || echo 'unknown (image not built?)')"
	@echo "package    : $$(sed -n 's/^  "version": "\(.*\)",$$/\1/p' package.json)"
	@echo "platform   : $(PLATFORM), AUDIO=$(AUDIO), compose $$(docker compose version --short 2>/dev/null || echo '?')"

# ---- guards (no `##`, so not listed by help) -------------------------------------------------
# What a first run needs: made silently when it is missing (make setup says what it made).
need-setup:
	@set -euo pipefail; say() { :; }; $(PREPARE)

# `bridge-test: require-FILE`: print the goal's usage line and fail when FILE is empty.
require-%:
	@$(if $(strip $($*)),true,{ echo 'Usage: $(or $(strip $(foreach g,$(MAKECMDGOALS),$(USAGE_$(g)))),make <target> $*=...)'; echo '       ($* is required)'; } >&2; exit 1)
