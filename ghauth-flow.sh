#!/bin/bash
set -uo pipefail
export GIT_TERMINAL_PROMPT=0

CLIENT_ID="Iv1.b231c327f1eaa229"
LOGFILE="ghauth.log"
STATUSFILE="ghauth.status"
CODEFILE="ghcode.txt"
LOCKFILE=".gh-device-lock"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >> "$LOGFILE"; }
acquire_lock() { mkdir "$LOCKFILE" 2>/dev/null; return $?; }
release_lock() { rmdir "$LOCKFILE" 2>/dev/null || true; }
write_status() { printf '%s\n' "$1" > "$STATUSFILE"; }
write_code()  { printf '%s\n' "$1" > "$CODEFILE"; }

log "=== restarting direct-POST device-code flow ==="
log "started at $(date -u +%H:%M:%S) pid $$"

DEVICE_CODE=$(cat "$CODEFILE" 2>/dev/null || true)

if [ -z "$DEVICE_CODE" ]; then
  log "no stored device_code; requesting a fresh one"
  CODE_RESP=$(curl -sS -X POST "https://github.com/login/device/code" \
    -H "Accept: application/json" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "client_id=$CLIENT_ID" 2>&1 || true)

  RC=$?
  log "device code request rc=$RC"
  log "device code response:\n%s" "$CODE_RESP"

  if [ $RC -ne 0 ]; then
    log "ERROR: curl failed rc=$RC"
    printf 'ERROR:curl_failed\n' > "$STATUSFILE"
    exit 2
  fi

  DEVICE_CODE=$(printf '%s' "$CODE_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("device_code",""))' 2>/dev/null || true)
  VERIFICATION_URL=$(printf '%s' "$CODE_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("verification_uri",""))' 2>/dev/null || true)
  EXPIRATION=$(printf '%s' "$CODE_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("expires_in","899"))' 2>/dev/null || true)
  INTERVAL=$(printf '%s' "$CODE_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("interval","5"))' 2>/dev/null || true)

  if [ -z "$DEVICE_CODE" ] || [ -z "$VERIFICATION_URL" ]; then
    log "ERROR: did not obtain device_code / verification_uri"
    printf 'ERROR:no_device_code\n' > "$STATUSFILE"
    exit 2
  fi

  write_code "$DEVICE_CODE"
  log "new device_code=$DEVICE_CODE verification_url=$VERIFICATION_URL expires=$EXPIRATION interval=$INTERVAL"
else
  log "reusing stored device_code=$DEVICE_CODE"
  VERIFICATION_URL="https://github.com/login/device"
  EXPIRATION=899
  INTERVAL=5
fi

log "user: open $VERIFICATION_URL and authorize device code $DEVICE_CODE"
write_status "PENDING"

POLL=${INTERVAL}
[ "$POLL" -lt 3 ] 2>/dev/null && POLL=3

deadline=$(date -d "+${EXPIRATION} seconds" +%s 2>/dev/null || date -v+"${EXPIRATION}M" +%s 2>/dev/null || echo 0)

until [ -f "$LOCKFILE" ] && ! acquire_lock; do sleep "$POLL"; done

while true; do
  now=$(date +%s)
  if [ "$deadline" != "0" ] && [ "$now" -ge "$deadline" ]; then
    log "flow ended: expired after ${EXPIRATION}s"
    write_status "FAILED:expired_token"
    break
  fi

  sleep "$POLL"
  log "polling /login/oauth/access_token for device_code=$DEVICE_CODE"

  TOKEN_RESP=$(curl -sS -X POST "https://github.com/login/oauth/access_token" \
    -H "Accept: application/json" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "client_id=$CLIENT_ID" \
    --data-urlencode "device_code=$DEVICE_CODE" \
    --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:device_code" 2>&1 || true)

  RC=$?
  log "access_token request rc=$RC"
  log "access_token response:\n%s" "$TOKEN_RESP"

  if [ $RC -ne 0 ]; then
    log "curl failed rc=$RC, retrying"
    continue
  fi

  ERROR=$(printf '%s' "$TOKEN_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("error",""))' 2>/dev/null || true)
  ACCESS_TOKEN=$(printf '%s' "$TOKEN_RESP" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null || true)

  if [ -n "$ACCESS_TOKEN" ]; then
    log "access_token obtained"
    write_status "AUTHENTICATED"
    break
  elif [ "$ERROR" = "authorization_pending" ] || [ "$ERROR" = "slow_down" ]; then
    log "poll status: $ERROR"
    continue
  else
    log "unexpected token error: $ERROR"
    continue
  fi
done

release_lock

if [ -f "$STATUSFILE" ] && [ "$(cat "$STATUSFILE")" = "AUTHENTICATED" ]; then
  log "configuring gh credentials from token..."
  printf '%s' "$ACCESS_TOKEN" | gh auth login --hostname github.com --with-token 2>&1 | tr -s ' \n' ' ' >> "$LOGFILE" || true
  log "gh auth login rc=$?"

  log "running gh auth setup-git..."
  gh auth setup-git 2>&1 | tr -s ' \n' ' ' >> "$LOGFILE" || true
  log "gh auth setup-git rc=$?"

  log "gh auth status:"
  gh auth status 2>&1 | tr -s ' \n' ' ' >> "$LOGFILE" || true
  log "flow complete"
fi

log "flow ended"
