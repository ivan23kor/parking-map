#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKEND_PORT="${BACKEND_PORT:-8000}"
WEB_PORT="${WEB_PORT:-8080}"
LOG_DIR="${ROOT_DIR}/logs"
mkdir -p "$LOG_DIR"

STREETS_DB="$ROOT_DIR/backend/data/streets.db"
if [ ! -f "$STREETS_DB" ]; then
  echo "WARNING: $STREETS_DB not found. Street queries will fail."
  echo "Run: python backend/ingest_osm.py <file.osm.pbf>"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required to start the stack."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to start the backend."
  exit 1
fi

if [ -z "${GOOGLE_MAPS_API_KEY:-}" ]; then
  echo "GOOGLE_MAPS_API_KEY is not set. The UI will load, but Google Street View requests will fail."
fi

ensure_backend_env() {
  if command -v uv >/dev/null 2>&1; then
    if [ ! -x "$ROOT_DIR/.venv/bin/python" ]; then
      uv venv "$ROOT_DIR/.venv"
    fi
    "$ROOT_DIR/.venv/bin/python" -m pip show fastapi >/dev/null 2>&1 || \
      uv pip install --python "$ROOT_DIR/.venv/bin/python" -r "$ROOT_DIR/backend/requirements.txt"
  else
    if [ ! -x "$ROOT_DIR/.venv/bin/python" ]; then
      python3 -m venv "$ROOT_DIR/.venv"
    fi
    "$ROOT_DIR/.venv/bin/python" -m pip show fastapi >/dev/null 2>&1 || \
      "$ROOT_DIR/.venv/bin/python" -m pip install -r "$ROOT_DIR/backend/requirements.txt"
  fi
}

wait_for_backend() {
  local health_url="http://127.0.0.1:${BACKEND_PORT}/health"
  local max_attempts=30
  local attempt=1

  while [ "$attempt" -le "$max_attempts" ]; do
    if python3 - <<PY >/dev/null 2>&1
import urllib.request
urllib.request.urlopen("${health_url}", timeout=2)
PY
    then
      return 0
    fi

    sleep 1
    attempt=$((attempt + 1))
  done

  echo "Backend did not become healthy within ${max_attempts}s. Check $LOG_DIR/backend.log"
  return 1
}

cleanup() {
  local exit_code=$?
  if [ -n "${BACKEND_PID:-}" ]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
  if [ -n "${WEB_PID:-}" ]; then
    kill "$WEB_PID" 2>/dev/null || true
  fi
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

ensure_backend_env

# Kill any existing processes on our ports
for pid in $(ss -tlnp 2>/dev/null | grep -E ":${BACKEND_PORT}|:${WEB_PORT}" | grep -oP 'pid=\K[0-9]+'); do
  echo "Killing existing process $pid"
  kill "$pid" 2>/dev/null || true
done

# Wait for ports to be freed, force-kill if stuck
for i in $(seq 1 10); do
  if ! ss -tlnp 2>/dev/null | grep -qE ":${BACKEND_PORT}|:${WEB_PORT}"; then
    break
  fi
  if [ "$i" -eq 5 ]; then
    echo "Ports still in use, force killing..."
    for pid in $(ss -tlnp 2>/dev/null | grep -E ":${BACKEND_PORT}|:${WEB_PORT}" | grep -oP 'pid=\K[0-9]+'); do
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
  sleep 1
done

echo "Starting backend on http://127.0.0.1:${BACKEND_PORT}"
"$ROOT_DIR/.venv/bin/python" -m uvicorn backend.main:app \
  --host 127.0.0.1 \
  --port "$BACKEND_PORT" \
  --reload-dir "$ROOT_DIR/backend" \
  --reload \
  >"$LOG_DIR/backend.log" 2>&1 &
BACKEND_PID=$!

echo "Waiting for backend health check..."
wait_for_backend

echo "Starting static app on http://127.0.0.1:${WEB_PORT}"
bun run serve >"$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!

echo "Stack is ready."
echo "UI: http://127.0.0.1:${WEB_PORT}/"
echo "API: http://127.0.0.1:${BACKEND_PORT}/docs"
echo "Logs: $LOG_DIR/backend.log and $LOG_DIR/web.log"

# Wait for both processes; trap will handle Ctrl+C
while kill -0 "$BACKEND_PID" "$WEB_PID" 2>/dev/null; do
  sleep 1
done
