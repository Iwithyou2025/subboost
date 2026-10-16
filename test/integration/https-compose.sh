#!/usr/bin/env bash
# Real Docker/Caddy smoke test; no public DNS, ACME or secrets are required.
set -Eeuo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
export SUBBOOST_HOME="$work/subboost-https-smoke" SUBBOOST_SCRIPT_SOURCE_ONLY=1 SUBBOOST_ASSUME_YES=1
source "$repo/local/scripts/install.sh"
TMP_DIR="$work/tmp"
DOCKER_RUNNER=docker
mkdir -p "$SUBBOOST_HOME" "$TMP_DIR"
cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
INSTALL_MODE=server
TLS_MODE=import
HTTPS_DOMAIN=smoke.example.com
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/key" -out "$work/cert" \
  -days 3 -subj /CN=smoke.example.com -addext subjectAltName=DNS:smoke.example.com 2>/dev/null
export SUBBOOST_TLS_CERT_FILE="$work/cert" SUBBOOST_TLS_KEY_FILE="$work/key"
printf 'ENCRYPTION_KEY=smoke-only\n' > "$ENV_FILE"
cat > "$COMPOSE_FILE" <<'YAML'
services:
  app:
    image: python:3.12-alpine
    command: ["python", "-m", "http.server", "3000"]
    ports:
      - "${SUBBOOST_PORT}:3000"
YAML
collect_https_certificate
prepare_https_config
compose config --format json > "$work/effective.json"
python3 - "$work/effective.json" <<'PY'
import json, sys
c=json.load(open(sys.argv[1]))
p=c['services']['app']['ports']
assert len(p)==1 and p[0]['host_ip']=='127.0.0.1', p
assert len(c['services']['caddy']['ports'])==1
assert str(c['services']['caddy']['ports'][0]['published'])=='443'
PY
retry_network compose pull
compose run --rm --no-deps caddy caddy validate --config /etc/subboost-tls/Caddyfile --adapter caddyfile
compose up -d
for attempt in $(seq 1 30); do
  if curl --noproxy '*' --cacert "$work/cert" --resolve smoke.example.com:443:127.0.0.1 \
    -fsS --connect-timeout 2 --max-time 4 https://smoke.example.com/ >/dev/null; then break; fi
  [ "$attempt" != 30 ] || exit 1
  sleep 1
done
# Replacing/recreating the upstream must not strand the reverse proxy on its old IP.
compose up -d --no-deps --force-recreate app
for attempt in $(seq 1 15); do
  if curl --noproxy '*' --cacert "$work/cert" --resolve smoke.example.com:443:127.0.0.1 \
    -fsS --connect-timeout 2 --max-time 4 https://smoke.example.com/ >/dev/null; then break; fi
  [ "$attempt" != 15 ] || exit 1
  sleep 1
done
compose down --volumes --remove-orphans
# Validate the automatic TLS-ALPN configuration without requesting a real cert.
TLS_MODE=auto
prepare_https_config
compose run --rm --no-deps caddy caddy validate --config /etc/subboost-tls/Caddyfile --adapter caddyfile
printf 'HTTPS Docker smoke test passed.\n'
