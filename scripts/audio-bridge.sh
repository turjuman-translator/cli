#!/usr/bin/env bash
# Host audio bridge for macOS and Linux. Windows: scripts/audio-bridge.ps1.
#
# Streams an audio input device, or a WAV file in real time, as raw s16le, 48 kHz, stereo
# to the captions container on tcp://127.0.0.1:<port> (config: audio.input.kind: network).
# The bridge is deliberately dumb: channel pick, gain and resampling happen in the container,
# so config/config.yaml stays the single source of truth.
#
# Device mode reconnects forever (container restarted, cable pulled): 1 s pause and one
# timestamped line per reconnect. File mode streams the file once, retrying until the
# container accepts the connection. Ctrl-C stops. bash 3.2 compatible (macOS /bin/bash).

set -u

port=7000
device=""
file=""
list=0

usage() {
  cat <<'EOF'
Usage:
  scripts/audio-bridge.sh --list                  list the audio input devices
  scripts/audio-bridge.sh --device <device>       stream a device to the container
  scripts/audio-bridge.sh --file <wav>            stream a WAV in real time (tests, rehearsals)
Options:
  --port <n>     container port on 127.0.0.1 (default 7000)
Devices:
  macOS  avfoundation index or exact name from --list, e.g. --device 2 or --device "MacBook Pro Microphone"
  Linux  PulseAudio/PipeWire source name from --list, or "default" (local Linux setups don't
         need the bridge: compose.linux-audio.yaml reads the host audio directly)
Via make:  make bridge-list | make bridge DEVICE="<device>" | make bridge-test FILE=<wav in data/recordings>
EOF
}

log() { printf '%s audio-bridge: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
die() { printf 'audio-bridge: %s\n' "$*" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    -l|--list) list=1; shift ;;
    -d|--device) [ $# -ge 2 ] || die "--device needs a value"; device="$2"; shift 2 ;;
    --device=*) device="${1#--device=}"; shift ;;
    -f|--file) [ $# -ge 2 ] || die "--file needs a value"; file="$2"; shift 2 ;;
    --file=*) file="${1#--file=}"; shift ;;
    -p|--port) [ $# -ge 2 ] || die "--port needs a value"; port="$2"; shift 2 ;;
    --port=*) port="${1#--port=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

case "$port" in
  ''|*[!0-9]*) die "--port must be a number, got '$port'" ;;
esac

os="$(uname -s 2>/dev/null || echo unknown)"
case "$os" in
  Darwin) kind=avfoundation; install_hint="brew install ffmpeg" ;;
  Linux) kind=pulse; install_hint="sudo apt install ffmpeg (or your distribution's ffmpeg package)" ;;
  *) die "unsupported system '$os' - on Windows use scripts/audio-bridge.ps1" ;;
esac

if ! command -v ffmpeg >/dev/null 2>&1; then
  printf 'audio-bridge: ffmpeg was not found on PATH. Install it with: %s\n' "$install_hint" >&2
  exit 127
fi

# ---- --list ------------------------------------------------------------------------------------
if [ "$list" = 1 ]; then
  if [ "$kind" = avfoundation ]; then
    echo "Audio input devices (use the index or the exact name: make bridge DEVICE=<index>):"
    # The listing goes to stderr and ffmpeg then exits non-zero ("Error opening input"): tolerate it.
    ffmpeg -hide_banner -nostdin -f avfoundation -list_devices true -i "" 2>&1 \
      | sed -n '/AVFoundation audio devices/,$p' \
      | sed -n 's/^\[AVFoundation[^]]*\] \(\[[0-9][0-9]*\] .*\)$/  \1/p' || true
    echo "macOS asks once for microphone access for your terminal app (System Settings > Privacy & Security > Microphone)."
  else
    echo "PulseAudio/PipeWire sources (use the name: make bridge DEVICE=<name>):"
    if command -v pactl >/dev/null 2>&1; then
      pactl list short sources 2>/dev/null | awk -F '\t' '{ printf "  %s\n", $2 }' || true
    else
      ffmpeg -hide_banner -nostdin -sources pulse 2>&1 || true
    fi
    echo "  default    (the default source)"
  fi
  exit 0
fi

# ---- input -------------------------------------------------------------------------------------
if [ -n "$file" ]; then
  [ -f "$file" ] || die "file not found: $file"
  input_desc="file $file"
  set -- -re -i "$file"
elif [ -n "$device" ]; then
  if [ "$kind" = avfoundation ]; then
    input_desc="avfoundation audio device '$device'"
    set -- -f avfoundation -i ":$device"
  else
    input_desc="pulse source '$device'"
    set -- -f pulse -i "$device"
  fi
else
  usage >&2
  echo >&2
  die "pass --device <device>, --file <wav> or --list"
fi

target="tcp://127.0.0.1:${port}?tcp_nodelay=1"
trap 'echo >&2; log "stopped"; exit 0' INT TERM

log "streaming $input_desc -> $target (s16le, 48 kHz, stereo). Ctrl-C stops."
reconnects=0
quick_fails=0
loglevel=warning
while :; do
  started=$SECONDS
  ffmpeg -hide_banner -loglevel "$loglevel" -nostdin "$@" \
    -ac 2 -ar 48000 -f s16le -flush_packets 1 "$target"
  rc=$?
  if [ -n "$file" ] && [ "$rc" -eq 0 ]; then
    log "finished streaming $file"
    exit 0
  fi
  # While the container is down every attempt fails at once; after 3 quick failures in a row,
  # silence ffmpeg's repeated "Connection refused" until a connection holds again.
  if [ $((SECONDS - started)) -lt 3 ]; then
    quick_fails=$((quick_fails + 1))
    if [ "$quick_fails" -eq 3 ]; then log "still failing - hiding ffmpeg's messages until a connection holds"; loglevel=quiet; fi
  else
    quick_fails=0
    loglevel=warning
  fi
  reconnects=$((reconnects + 1))
  log "ffmpeg exited (code $rc) - reconnecting in 1 s (reconnect #$reconnects; is the container up? make status)"
  sleep 1
done
