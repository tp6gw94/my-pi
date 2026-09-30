#!/usr/bin/env bash
set -euo pipefail

SAFE_PI="$(cd "$(dirname "$0")/.." && pwd -P)/bin/safe-pi"
PROFILE_DIR="$(dirname "$SAFE_PI")/../safehouse"
if [[ "$(uname -s)" != Darwin || ! -x /usr/bin/sandbox-exec ]]; then
  echo "safe-pi Docker behavior: SKIP (macOS sandbox-exec unavailable)"
  exit 0
fi
if ! command -v docker >/dev/null || ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  echo "safe-pi Docker behavior: SKIP (running Docker daemon unavailable)"
  exit 0
fi

endpoint="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}"
if [[ "$endpoint" != unix://* || ! -S "${endpoint#unix://}" ]]; then
  echo "safe-pi Docker behavior: SKIP (local Unix Docker socket unavailable)"
  exit 0
fi

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/safe-pi-docker.XXXXXX")"
# Outside the launch workdir and all normal home grants.
PRIVATE_ROOT="$(mktemp -d "$HOME/safe-pi-docker-private.XXXXXX")"
trap 'rm -rf "$ROOT" "$PRIVATE_ROOT"' EXIT
mkdir -p "$ROOT/bin" "$ROOT/workdir" "$ROOT/clean-config"
printf 'private sentinel\n' > "$PRIVATE_ROOT/sentinel"

# No LLM call: only the Docker CLI or a sandbox restriction probe.
cat > "$ROOT/bin/pi" <<'EOF'
#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == restriction-probe ]]; then
  if /bin/cat "$PRIVATE_ROOT/sentinel" >/dev/null 2>&1; then
    echo "unrelated home file unexpectedly readable" >&2
    exit 1
  fi
  if (printf 'changed\n' > "$PRIVATE_ROOT/sentinel") 2>/dev/null; then
    echo "unrelated home file unexpectedly writable" >&2
    exit 1
  fi
  echo "unrelated home read/write: denied"
  exit 0
fi
exec docker "$@"
EOF
chmod +x "$ROOT/bin/pi"

run_safe_pi() {
  (
    cd "$ROOT/workdir"
    env BASE_PROFILE="$PROFILE_DIR/custom-pi.sb" \
      BROWSER_ADDON="$PROFILE_DIR/browser-addon.sb" \
      KEYCHAIN_ADDON="$PROFILE_DIR/keychain-addon.sb" \
      EMACS_ADDON="$PROFILE_DIR/emacs-addon.sb" \
      PI_XDG_ADDON="$PROFILE_DIR/pi-xdg-addon.sb" \
      PRIVATE_ROOT="$PRIVATE_ROOT" PATH="$ROOT/bin:$PATH" \
      "$SAFE_PI" "$@"
  )
}

# Removing only the addon must reproduce the original socket denial.
# A readable empty config isolates the socket denial from config-file denials.
if DOCKER_ADDON="$ROOT/missing-docker.sb" DOCKER_CONFIG="$ROOT/clean-config" run_safe_pi \
    --host "$endpoint" version > "$ROOT/denied.out" 2>&1; then
  echo "Docker socket unexpectedly accessible without addon" >&2
  exit 1
fi
grep -E 'operation not permitted|permission denied.*docker API' "$ROOT/denied.out" >/dev/null || {
  /bin/cat "$ROOT/denied.out" >&2
  echo "expected a sandbox socket denial" >&2
  exit 1
}
echo "without Docker addon: local socket permission denied"

# The default addon must preserve Docker's configured context and reach its daemon.
expected_context="$(docker context show)"
[[ "$(run_safe_pi context show)" == "$expected_context" ]]
expected_server="$(docker version --format '{{.Server.Version}}')"
[[ "$(run_safe_pi version --format '{{.Server.Version}}')" == "$expected_server" ]]
[[ "$(run_safe_pi --host "$endpoint" version --format '{{.Server.Version}}')" == "$expected_server" ]]
run_safe_pi ps --format '{{.ID}}' > "$ROOT/ps.out"
if [[ -S /var/run/docker.sock ]]; then
  [[ "$(run_safe_pi --host unix:///var/run/docker.sock version --format '{{.Server.Version}}')" == \
    "$(docker --host unix:///var/run/docker.sock version --format '{{.Server.Version}}')" ]]
fi
for plugin in compose buildx; do
  if expected="$(docker "$plugin" version 2>/dev/null)"; then
    [[ "$(run_safe_pi "$plugin" version)" == "$expected" ]]
    echo "Docker $plugin plugin: PASS"
  else
    echo "Docker $plugin plugin: SKIP (not installed)"
  fi
done
run_safe_pi restriction-probe
[[ "$(/bin/cat "$PRIVATE_ROOT/sentinel")" == 'private sentinel' ]]
echo "safe-pi Docker context=$expected_context, server=$expected_server, version/ps/local socket: PASS"
