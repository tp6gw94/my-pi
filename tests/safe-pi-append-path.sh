#!/usr/bin/env bash
set -euo pipefail

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/safe-pi-append-path.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

SAFE_PI="$(cd "$(dirname "$0")/.." && pwd -P)/bin/safe-pi"
BASE_PROFILE="$ROOT/base.sb"
BROWSER_ADDON="$ROOT/browser-addon.sb"
FAKE_BIN="$ROOT/bin"
LAUNCH="$ROOT/launch"
SPECIAL_PARENT="$ROOT/nested path"
SPECIAL_DIR="$SPECIAL_PARENT/dir with \"quote\\slash"
SPECIAL_SYMLINK="$LAUNCH/special link"
SECOND_DIR="$ROOT/second path"
REGULAR_FILE="$ROOT/not-a-directory"
MISSING_DIR="$ROOT/missing-directory"
CAPTURE_POLICY="$ROOT/captured-policy.sb"
CAPTURE_ARGS="$ROOT/captured-args"
SANDBOX_MARKER="$ROOT/sandbox-started"

mkdir -p "$FAKE_BIN" "$LAUNCH" "$SPECIAL_DIR" "$SECOND_DIR"
ln -s "$SPECIAL_DIR" "$SPECIAL_SYMLINK"
printf '%s\n' '(define HOME_DIR "__SAFEHOUSE_HOME_DIR__")' > "$BASE_PROFILE"
: > "$BROWSER_ADDON"
printf '%s\n' 'not a directory' > "$REGULAR_FILE"

cat > "$FAKE_BIN/sandbox-exec" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

[[ "${1:-}" == "-f" && "${3:-}" == "--" && "${4:-}" == "pi" ]] || {
  echo "unexpected sandbox-exec arguments" >&2
  exit 1
}

policy="$2"
cp "$policy" "$CAPTURE_POLICY"
touch "$SANDBOX_MARKER"
command="$4"
shift 4
set +e
"$command" "$@"
status=$?
set -e
rm -f "$policy"
exit "$status"
EOF
chmod +x "$FAKE_BIN/sandbox-exec"

cat > "$FAKE_BIN/pi" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
: > "$CAPTURE_ARGS"
for arg in "$@"; do
  printf '%s\n' "$arg" >> "$CAPTURE_ARGS"
done
EOF
chmod +x "$FAKE_BIN/pi"

run_safe_pi() {
  (
    cd "$LAUNCH"
    env \
      BASE_PROFILE="$BASE_PROFILE" \
      BROWSER_ADDON="$BROWSER_ADDON" \
      KEYCHAIN_ADDON="$ROOT/missing-keychain.sb" \
      EMACS_ADDON="$ROOT/missing-emacs.sb" \
      CAPTURE_POLICY="$CAPTURE_POLICY" \
      CAPTURE_ARGS="$CAPTURE_ARGS" \
      SANDBOX_MARKER="$SANDBOX_MARKER" \
      PATH="$FAKE_BIN:$PATH" \
      "$SAFE_PI" "$@"
  )
}

SPECIAL_REAL="$(cd "$SPECIAL_DIR" && pwd -P)"
SPECIAL_PARENT_REAL="$(cd "$SPECIAL_PARENT" && pwd -P)"
LAUNCH_REAL="$(cd "$LAUNCH" && pwd -P)"
SECOND_REAL="$(cd "$SECOND_DIR" && pwd -P)"
escaped_special="${SPECIAL_REAL//\\/\\\\}"
escaped_special="${escaped_special//\"/\\\"}"
escaped_special_parent="${SPECIAL_PARENT_REAL//\\/\\\\}"
escaped_special_parent="${escaped_special_parent//\"/\\\"}"
SPECIAL_SYMLINK_REAL="$LAUNCH_REAL/special link"
escaped_special_symlink="${SPECIAL_SYMLINK_REAL//\\/\\\\}"
escaped_special_symlink="${escaped_special_symlink//\"/\\\"}"
escaped_second="${SECOND_REAL//\\/\\\\}"
escaped_second="${escaped_second//\"/\\\"}"

run_safe_pi
[[ ! -s "$CAPTURE_ARGS" ]] || {
  echo "no-argument launch forwarded an argument" >&2
  exit 1
}
if grep -F -- 'Launch-time appended path access' "$CAPTURE_POLICY" >/dev/null; then
  echo "no-argument launch generated append-path access" >&2
  exit 1
fi

SPECIAL_RELATIVE="special link"
run_safe_pi \
  --append-path "$SPECIAL_RELATIVE" \
  --append-path="$SECOND_DIR" \
  --flag value \
  --repeat same \
  --spaced "value with spaces" \
  --empty "" \
  -- \
  --append-path literal \
  --literal-value

assert_contains() {
  local expected="$1"
  local file="$2"
  grep -F -- "$expected" "$file" >/dev/null || {
    echo "missing expected text in $file: $expected" >&2
    exit 1
  }
}

assert_contains "(allow file-read* file-write* (subpath \"$escaped_special\"))" "$CAPTURE_POLICY"
assert_contains "(allow file-read* file-write* (subpath \"$escaped_second\"))" "$CAPTURE_POLICY"
assert_contains "    (literal \"$escaped_special_parent\")" "$CAPTURE_POLICY"
assert_contains "    (literal \"$escaped_special\")" "$CAPTURE_POLICY"
assert_contains "    (literal \"$escaped_second\")" "$CAPTURE_POLICY"
if grep -F -- "$escaped_special_symlink" "$CAPTURE_POLICY" >/dev/null; then
  echo "symlink path leaked into generated policy" >&2
  exit 1
fi
if grep -F -- '..' "$CAPTURE_POLICY" >/dev/null; then
  echo "relative path segment leaked into generated policy" >&2
  exit 1
fi

cat > "$ROOT/expected-args" <<'EOF'
--flag
value
--repeat
same
--spaced
value with spaces
--empty

--
--append-path
literal
--literal-value
EOF
cmp -s "$ROOT/expected-args" "$CAPTURE_ARGS" || {
  echo "Pi arguments were not forwarded exactly" >&2
  diff -u "$ROOT/expected-args" "$CAPTURE_ARGS" >&2 || true
  exit 1
}

expect_rejected() {
  local label="$1"
  local expected="$2"
  shift 2
  local stderr="$ROOT/$label.stderr"

  rm -f "$SANDBOX_MARKER"
  set +e
  run_safe_pi "$@" > "$ROOT/$label.stdout" 2> "$stderr"
  local status=$?
  set -e

  (( status != 0 )) || {
    echo "$label unexpectedly succeeded" >&2
    exit 1
  }
  assert_contains "$expected" "$stderr"
  [[ ! -e "$SANDBOX_MARKER" ]] || {
    echo "$label started the sandbox before rejecting input" >&2
    exit 1
  }
}

expect_rejected missing-value '--append-path requires a path' --append-path
expect_rejected empty-value '--append-path cannot be empty' --append-path ''
expect_rejected empty-attached '--append-path cannot be empty' --append-path=
expect_rejected regular-file '--append-path must name an existing directory' --append-path "$REGULAR_FILE"
expect_rejected missing-directory '--append-path must name an existing directory' --append-path "$MISSING_DIR"

echo "safe-pi append-path behavior: PASS"
