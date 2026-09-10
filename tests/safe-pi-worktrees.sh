#!/usr/bin/env bash
set -euo pipefail

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/safe-pi-worktrees.XXXXXX")"
SANDBOX_FIXTURE_ROOT=""
cleanup() {
  rm -rf "$ROOT"
  [[ -z "$SANDBOX_FIXTURE_ROOT" ]] || rm -rf "$SANDBOX_FIXTURE_ROOT"
}
trap cleanup EXIT

SAFE_PI="$(cd "$(dirname "$0")/.." && pwd -P)/bin/safe-pi"
GIT_BIN="/usr/bin/git"
BASE_PROFILE="$ROOT/base.sb"
BROWSER_ADDON="$ROOT/browser-addon.sb"
FAKE_BIN="$ROOT/bin"
LAUNCH="$ROOT/launch"
CAPTURE_POLICY="$ROOT/captured-policy.sb"
CAPTURE_ARGS="$ROOT/captured-args"
CAPTURE_STDERR="$ROOT/captured-stderr"

REPO="$ROOT/repo with spaces"
MAIN="$REPO/main \"quote\\slash"
SIBLING="$ROOT/sibling worktree"
SPECIAL="$ROOT/linked \"quote\\slash"
SUBDIR="$SPECIAL/subdir"
STALE="$ROOT/stale worktree"
UNRELATED="$ROOT/unrelated repo"
mkdir -p "$FAKE_BIN" "$LAUNCH" "$MAIN"

printf '%s\n' '(define HOME_DIR "__SAFEHOUSE_HOME_DIR__")' > "$BASE_PROFILE"
: > "$BROWSER_ADDON"

cat > "$FAKE_BIN/sandbox-exec" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

[[ "${1:-}" == "-f" && "${3:-}" == "--" && "${4:-}" == "pi" ]] || {
  echo "unexpected sandbox-exec arguments" >&2
  exit 1
}
cp "$2" "$CAPTURE_POLICY"
: > "$CAPTURE_STDERR"
command="$4"
shift 4
"$command" "$@"
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

cat > "$FAKE_BIN/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${FAKE_GIT_MODE:-}" == "legacy" && "$*" == *--path-format=absolute* ]]; then
  echo "unknown option: --path-format=absolute" >&2
  exit 129
fi

if [[ "${FAKE_GIT_MODE:-}" == "fail-list" && "${1:-}" == "worktree" && "${2:-}" == "list" ]]; then
  echo "synthetic worktree list failure" >&2
  exit 1
fi

if [[ "${FAKE_GIT_MODE:-}" == "unsupported-z" && "${1:-}" == "worktree" && "${2:-}" == "list" ]]; then
  echo "unknown option: -z" >&2
  exit 129
fi

if [[ "${FAKE_GIT_MODE:-}" == "incomplete" && "${1:-}" == "worktree" && "${2:-}" == "list" ]]; then
  printf 'worktree %s\000HEAD deadbeef\000' "$FAKE_WORKTREE_PATH"
  exit 0
fi

if [[ "${FAKE_GIT_MODE:-}" == "trailing-partial" && "${1:-}" == "worktree" && "${2:-}" == "list" ]]; then
  /usr/bin/git "$@"
  printf 'worktree '
  exit 0
fi

if [[ "${FAKE_GIT_MODE:-}" == "control-char" && "${1:-}" == "worktree" && "${2:-}" == "list" ]]; then
  printf 'worktree %s\000HEAD deadbeef\000branch refs/heads/bad\000\000' "$FAKE_WORKTREE_PATH"
  exit 0
fi

if [[ "${FAKE_GIT_MODE:-}" == "cross-repo" && "${1:-}" == "worktree" && "${2:-}" == "list" ]]; then
  printf 'worktree %s\000HEAD deadbeef\000branch refs/heads/other\000\000' "$FAKE_WORKTREE_PATH"
  exit 0
fi

if [[ "${FAKE_GIT_MODE:-}" == "symlink" && "${1:-}" == "worktree" && "${2:-}" == "list" ]]; then
  printf 'worktree %s\000HEAD deadbeef\000branch refs/heads/link\000\000' "$FAKE_WORKTREE_PATH"
  exit 0
fi

if [[ "${FAKE_GIT_MODE:-}" == "bare" && "${1:-}" == "worktree" && "${2:-}" == "list" ]]; then
  printf 'worktree %s\000HEAD deadbeef\000bare\000\000' "$FAKE_WORKTREE_PATH"
  exit 0
fi

if [[ "${FAKE_GIT_MODE:-}" == "prunable" && "${1:-}" == "worktree" && "${2:-}" == "list" ]]; then
  printf 'worktree %s\000HEAD deadbeef\000prunable stale\000\000' "$FAKE_WORKTREE_PATH"
  exit 0
fi

exec /usr/bin/git "$@"
EOF
chmod +x "$FAKE_BIN/git"

"$GIT_BIN" init -q "$MAIN"
"$GIT_BIN" -C "$MAIN" config user.email safe-pi-test@example.invalid
"$GIT_BIN" -C "$MAIN" config user.name safe-pi-test
printf 'fixture\n' > "$MAIN/sentinel"
"$GIT_BIN" -C "$MAIN" add sentinel
"$GIT_BIN" -C "$MAIN" commit -qm initial
"$GIT_BIN" -C "$MAIN" worktree add -q -b sibling "$SIBLING"
SIBLING_LINK="$ROOT/sibling symlink"
ln -s "$SIBLING" "$SIBLING_LINK"
"$GIT_BIN" -C "$MAIN" worktree add -q -b special "$SPECIAL"
"$GIT_BIN" -C "$MAIN" worktree lock --reason fixture-locked "$SPECIAL"
"$GIT_BIN" -C "$SPECIAL" checkout -q --detach HEAD
mkdir -p "$SUBDIR"
"$GIT_BIN" -C "$MAIN" worktree add -q -b stale "$STALE"
STALE_REAL="$(cd "$STALE" && pwd -P)"
rm -rf "$STALE"
"$GIT_BIN" init -q "$UNRELATED"
"$GIT_BIN" -C "$UNRELATED" config user.email safe-pi-test@example.invalid
"$GIT_BIN" -C "$UNRELATED" config user.name safe-pi-test
printf 'unrelated\n' > "$UNRELATED/sentinel"
"$GIT_BIN" -C "$UNRELATED" add sentinel
"$GIT_BIN" -C "$UNRELATED" commit -qm unrelated

escape_sb() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

assert_contains() {
  local expected="$1"
  local file="$2"
  grep -F -- "$expected" "$file" >/dev/null || {
    echo "missing expected text in $file: $expected" >&2
    exit 1
  }
}

assert_not_contains() {
  local unexpected="$1"
  local file="$2"
  if grep -F -- "$unexpected" "$file" >/dev/null; then
    echo "unexpected text in $file: $unexpected" >&2
    exit 1
  fi
}

assert_ro_worktree() {
  local path="$1"
  local escaped
  escaped="$(escape_sb "$path")"
  assert_contains "(allow file-read* (subpath \"$escaped\"))" "$CAPTURE_POLICY"
  assert_not_contains "(allow file-read* file-write* (subpath \"$escaped\"))" "$CAPTURE_POLICY"
}

assert_no_worktree_snapshot() {
  local path="$1"
  local escaped
  escaped="$(escape_sb "$path")"
  assert_not_contains "(allow file-read* (subpath \"$escaped\"))" "$CAPTURE_POLICY"
}

run_safe_pi() {
  local workdir="$1"
  shift
  (
    cd "$workdir"
    env \
      BASE_PROFILE="$BASE_PROFILE" \
      BROWSER_ADDON="$BROWSER_ADDON" \
      KEYCHAIN_ADDON="$ROOT/missing-keychain.sb" \
      EMACS_ADDON="$ROOT/missing-emacs.sb" \
      CAPTURE_POLICY="$CAPTURE_POLICY" \
      CAPTURE_ARGS="$CAPTURE_ARGS" \
      CAPTURE_STDERR="$CAPTURE_STDERR" \
      FAKE_GIT_MODE="${FAKE_GIT_MODE:-}" \
      FAKE_WORKTREE_PATH="${FAKE_WORKTREE_PATH:-}" \
      PATH="$FAKE_BIN:/usr/bin:/bin" \
      "$SAFE_PI" "$@"
  )
}

MAIN_REAL="$(cd "$MAIN" && pwd -P)"
SIBLING_REAL="$(cd "$SIBLING" && pwd -P)"
SPECIAL_REAL="$(cd "$SPECIAL" && pwd -P)"
SUBDIR_REAL="$(cd "$SUBDIR" && pwd -P)"
UNRELATED_REAL="$(cd "$UNRELATED" && pwd -P)"

# RED: the existing wrapper only grants the main worktree, not every sibling.
run_safe_pi "$SPECIAL" --flag value
assert_ro_worktree "$MAIN_REAL"
assert_ro_worktree "$SIBLING_REAL"
assert_no_worktree_snapshot "$SPECIAL_REAL"
assert_no_worktree_snapshot "$STALE_REAL"
assert_no_worktree_snapshot "$UNRELATED_REAL"
assert_contains "--flag" "$CAPTURE_ARGS"

set +e
FAKE_GIT_MODE=symlink FAKE_WORKTREE_PATH="$SIBLING_LINK" run_safe_pi "$SPECIAL" > "$ROOT/symlink.stdout" 2> "$ROOT/symlink.stderr"
status=$?
set -e
(( status == 0 )) || {
  echo "symlink candidate should preserve launch success" >&2
  exit 1
}
assert_ro_worktree "$SIBLING_REAL"
SIBLING_LINK_ESCAPED="$(escape_sb "$SIBLING_LINK")"
assert_not_contains "(allow file-read* (subpath \"$SIBLING_LINK_ESCAPED\"))" "$CAPTURE_POLICY"

set +e
FAKE_GIT_MODE=legacy run_safe_pi "$SUBDIR" > "$ROOT/legacy.stdout" 2> "$ROOT/legacy.stderr"
status=$?
set -e
(( status == 0 )) || { echo "legacy Git path fallback should preserve launch success" >&2; exit 1; }
assert_ro_worktree "$SIBLING_REAL"
assert_no_worktree_snapshot "$SPECIAL_REAL"

set +e
FAKE_GIT_MODE=bare FAKE_WORKTREE_PATH="$SIBLING_REAL" run_safe_pi "$SPECIAL" > "$ROOT/bare.stdout" 2> "$ROOT/bare.stderr"
status=$?
set -e
(( status == 0 )) || { echo "bare candidate should preserve launch success" >&2; exit 1; }
assert_no_worktree_snapshot "$SIBLING_REAL"

set +e
FAKE_GIT_MODE=prunable FAKE_WORKTREE_PATH="$SIBLING_REAL" run_safe_pi "$SPECIAL" > "$ROOT/prunable.stdout" 2> "$ROOT/prunable.stderr"
status=$?
set -e
(( status == 0 )) || { echo "prunable candidate should preserve launch success" >&2; exit 1; }
assert_no_worktree_snapshot "$SIBLING_REAL"

# A main-worktree launch must see both linked worktrees, including locked/detached.
run_safe_pi "$MAIN"
assert_ro_worktree "$SIBLING_REAL"
assert_ro_worktree "$SPECIAL_REAL"
assert_no_worktree_snapshot "$STALE_REAL"
assert_no_worktree_snapshot "$MAIN_REAL"

# A subdirectory launch must not turn the current checkout root into an extra RO grant.
run_safe_pi "$SUBDIR"
assert_ro_worktree "$MAIN_REAL"
assert_ro_worktree "$SIBLING_REAL"
assert_no_worktree_snapshot "$SPECIAL_REAL"
SUBDIR_ESCAPED="$(escape_sb "$SUBDIR_REAL")"
assert_contains "(allow file-read* file-write* (subpath \"$SUBDIR_ESCAPED\"))" "$CAPTURE_POLICY"

# A failed or unsupported NUL listing must fail closed without a partial snapshot.
set +e
FAKE_GIT_MODE=fail-list FAKE_WORKTREE_PATH="$SIBLING_REAL" run_safe_pi "$SPECIAL" > "$ROOT/fail-list.stdout" 2> "$ROOT/fail-list.stderr"
status=$?
set -e
(( status == 0 )) || {
  echo "worktree-list failure should preserve launch success" >&2
  exit 1
}
assert_no_worktree_snapshot "$SIBLING_REAL"
assert_contains "Git worktree snapshot unavailable" "$ROOT/fail-list.stderr"

set +e
FAKE_GIT_MODE=unsupported-z FAKE_WORKTREE_PATH="$SIBLING_REAL" run_safe_pi "$SPECIAL" > "$ROOT/unsupported.stdout" 2> "$ROOT/unsupported.stderr"
status=$?
set -e
(( status == 0 )) || {
  echo "unsupported -z should preserve launch success" >&2
  exit 1
}
assert_no_worktree_snapshot "$SIBLING_REAL"
assert_contains "Git worktree snapshot unavailable" "$ROOT/unsupported.stderr"

set +e
FAKE_GIT_MODE=cross-repo FAKE_WORKTREE_PATH="$UNRELATED_REAL" run_safe_pi "$SPECIAL" > "$ROOT/cross-repo.stdout" 2> "$ROOT/cross-repo.stderr"
status=$?
set -e
(( status == 0 )) || {
  echo "cross-repository candidate should preserve launch success" >&2
  exit 1
}
assert_no_worktree_snapshot "$UNRELATED_REAL"

set +e
FAKE_GIT_MODE=incomplete FAKE_WORKTREE_PATH="$SIBLING_REAL" run_safe_pi "$SPECIAL" > "$ROOT/incomplete.stdout" 2> "$ROOT/incomplete.stderr"
status=$?
set -e
(( status == 0 )) || {
  echo "incomplete listing should preserve launch success" >&2
  exit 1
}
assert_no_worktree_snapshot "$SIBLING_REAL"
assert_contains "incomplete Git worktree snapshot" "$ROOT/incomplete.stderr"

FAKE_GIT_MODE=trailing-partial run_safe_pi "$SPECIAL" > "$ROOT/trailing.stdout" 2> "$ROOT/trailing.stderr"
assert_no_worktree_snapshot "$SIBLING_REAL"
assert_contains "incomplete Git worktree snapshot" "$ROOT/trailing.stderr"

# A control-character path is skipped rather than inserted into SBPL.
BAD_PATH="$ROOT/bad
path"
set +e
FAKE_GIT_MODE=control-char FAKE_WORKTREE_PATH="$BAD_PATH" run_safe_pi "$SPECIAL" > "$ROOT/control.stdout" 2> "$ROOT/control.stderr"
status=$?
set -e
(( status == 0 )) || {
  echo "control-character candidate should preserve launch success" >&2
  exit 1
}
assert_not_contains 'bad' "$CAPTURE_POLICY"
assert_contains "unsafe path" "$ROOT/control.stderr"

run_sandbox_probe() {
  [[ "$(uname -s)" == Darwin && -x /usr/bin/sandbox-exec ]] || {
    echo "safe-pi sandbox probe: SKIP (macOS sandbox-exec unavailable)"
    return 0
  }

  local sandbox_root sandbox_repo sandbox_main sandbox_linked sandbox_sibling sandbox_other
  local sandbox_bin probe_results common_dir common_marker
  local ro_file ro_append ro_create ro_delete current_file
  local real_base real_browser real_keychain real_emacs status mode launch_dir expected_read
  local append_before delete_before

  sandbox_root="$HOME/safe-pi-worktrees-fixture.$$.$RANDOM"
  SANDBOX_FIXTURE_ROOT="$sandbox_root"
  sandbox_repo="$sandbox_root/repo"
  sandbox_main="$sandbox_repo/main"
  sandbox_linked="$sandbox_root/linked"
  sandbox_sibling="$sandbox_root/sibling \"quote\\slash"
  sandbox_other="$sandbox_root/unrelated"
  sandbox_bin="$ROOT/sandbox-bin"
  probe_results="$ROOT/sandbox-results"
  mkdir -p "$sandbox_main" "$sandbox_bin" "$probe_results"
  cp "$FAKE_BIN/git" "$sandbox_bin/git"
  "$GIT_BIN" init -q "$sandbox_main"
  "$GIT_BIN" -C "$sandbox_main" config user.email safe-pi-test@example.invalid
  "$GIT_BIN" -C "$sandbox_main" config user.name safe-pi-test
  printf 'sandbox sentinel\n' > "$sandbox_main/sentinel"
  "$GIT_BIN" -C "$sandbox_main" add sentinel
  "$GIT_BIN" -C "$sandbox_main" commit -qm initial
  "$GIT_BIN" -C "$sandbox_main" worktree add -q -b linked "$sandbox_linked"
  "$GIT_BIN" -C "$sandbox_main" worktree add -q -b sibling "$sandbox_sibling"
  mkdir -p "$sandbox_linked/subdir"
  "$GIT_BIN" init -q "$sandbox_other"
  "$GIT_BIN" -C "$sandbox_other" config user.email safe-pi-test@example.invalid
  "$GIT_BIN" -C "$sandbox_other" config user.name safe-pi-test
  printf 'unrelated sentinel\n' > "$sandbox_other/sentinel"
  "$GIT_BIN" -C "$sandbox_other" add sentinel
  "$GIT_BIN" -C "$sandbox_other" commit -qm unrelated

  ro_file="$sandbox_sibling/sentinel"
  ro_append="$sandbox_sibling/should-not-append"
  ro_create="$sandbox_sibling/should-not-create"
  ro_delete="$sandbox_sibling/should-delete"
  current_file="$sandbox_linked/current-write"
  printf 'append baseline\n' > "$ro_append"
  printf 'delete baseline\n' > "$ro_delete"
  chmod 600 "$ro_file" "$ro_append" "$ro_delete"
  chmod 700 "$sandbox_main" "$sandbox_linked" "$sandbox_sibling" "$sandbox_other"
  common_dir="$($GIT_BIN -C "$sandbox_linked" rev-parse --path-format=absolute --git-common-dir)"
  common_marker="$common_dir/safe-pi-sandbox-marker"
  ro_create="$sandbox_sibling/should-not-create"

  # Confirm expected writes work before entering the sandbox; this avoids
  # mistaking Unix mode/TCC failures for sandbox denials.
  printf 'outside\n' >> "$ro_append"
  printf 'outside\n' >> "$ro_file"
  printf 'outside\n' > "$ro_create"
  rm -f "$ro_create"
  printf 'delete baseline\n' > "$ro_delete"
  rm -f "$common_marker"
  printf 'outside\n' > "$common_marker"
  rm -f "$common_marker"
  append_before="$(cat "$ro_append")"
  delete_before="$(cat "$ro_delete")"
  [[ "$(cat "$ro_file")" == *"sandbox sentinel"* ]]
  [[ "$(cat "$sandbox_linked/sentinel")" == "sandbox sentinel" ]]

  cat > "$sandbox_bin/pi" <<'EOF'
#!/usr/bin/env bash
set -u
record() {
  printf '%s\n' "$2" > "$PROBE_RESULTS/$1"
}
if content="$(cat "$PROBE_RO_FILE" 2>/dev/null)"; then
  [[ "$content" == *"sandbox sentinel"* ]] && record ro-read pass || record ro-read fail
else
  record ro-read denied
fi
if cat "$PROBE_CURRENT_ROOT" >/dev/null 2>&1; then
  record current-root-read readable
else
  record current-root-read denied
fi
if printf 'sandbox append\n' >> "$PROBE_RO_APPEND" 2>/dev/null; then
  record ro-append appended
else
  record ro-append denied
fi
if printf 'sandbox create\n' > "$PROBE_RO_CREATE" 2>/dev/null; then
  record ro-create created
else
  record ro-create denied
fi
if rm "$PROBE_RO_DELETE" 2>/dev/null; then
  record ro-delete deleted
else
  record ro-delete denied
fi
if printf 'sandbox current\n' > "$PROBE_CURRENT" 2>/dev/null; then
  record current-write pass
else
  record current-write fail
fi
if cat "$PROBE_UNRELATED" >/dev/null 2>&1; then
  record unrelated-read readable
else
  record unrelated-read denied
fi
if printf 'sandbox common\n' > "$PROBE_COMMON" 2>/dev/null; then
  record common-write pass
else
  record common-write denied
fi
if [[ "${EXPECT_APPEND:-0}" == 1 ]]; then
  if [[ -e "$PROBE_RO_CREATE" ]]; then
    record append-create created
    rm -f "$PROBE_RO_CREATE"
  else
    record append-create denied
  fi
  [[ -e "$PROBE_RO_DELETE" ]] && record append-delete present || record append-delete deleted
else
  record append-create not-run
  record append-delete not-run
fi
exit 0
EOF
  chmod +x "$sandbox_bin/pi"

  real_base="$HOME/.pi/safehouse/custom-pi.sb"
  real_browser="$HOME/.pi/safehouse/browser-addon.sb"
  real_keychain="$HOME/.pi/safehouse/keychain-addon.sb"
  real_emacs="$HOME/.pi/safehouse/emacs-addon.sb"
  [[ -f "$real_base" && -f "$real_browser" ]] || {
    echo "safe-pi sandbox probe: SKIP (real Safehouse profiles unavailable)"
    return 0
  }

  for mode in baseline readonly subdir; do
  launch_dir="$sandbox_linked"
  [[ "$mode" != subdir ]] || launch_dir="$sandbox_linked/subdir"
  current_file="$launch_dir/current-write"
  expected_read=pass
  [[ "$mode" != baseline ]] || expected_read=denied
  rm -f "$probe_results"/* "$ro_create" "$common_marker" "$current_file"
  set +e
  (
    cd "$launch_dir"
    env \
      BASE_PROFILE="$real_base" \
      BROWSER_ADDON="$real_browser" \
      KEYCHAIN_ADDON="$real_keychain" \
      EMACS_ADDON="$real_emacs" \
      PATH="$sandbox_bin:/usr/bin:/bin" \
      FAKE_GIT_MODE="$(if [[ "$mode" == baseline ]]; then printf fail-list; fi)" \
      PROBE_RESULTS="$probe_results" \
      PROBE_RO_FILE="$ro_file" \
      PROBE_RO_APPEND="$ro_append" \
      PROBE_RO_CREATE="$ro_create" \
      PROBE_RO_DELETE="$ro_delete" \
      PROBE_CURRENT="$current_file" \
      PROBE_CURRENT_ROOT="$sandbox_linked/sentinel" \
      PROBE_UNRELATED="$sandbox_other/sentinel" \
      PROBE_COMMON="$common_marker" \
      EXPECT_APPEND=0 \
      "$SAFE_PI"
  )
  status=$?
  set -e
  (( status == 0 )) || {
    echo "safe-pi sandbox probe failed to launch fake pi (status $status)" >&2
    return 1
  }

  assert_contains "$expected_read" "$probe_results/ro-read"
  if [[ "$mode" == subdir ]]; then
    assert_contains "denied" "$probe_results/current-root-read"
  else
    assert_contains "readable" "$probe_results/current-root-read"
  fi
  assert_contains "denied" "$probe_results/ro-append"
  assert_contains "denied" "$probe_results/ro-create"
  assert_contains "denied" "$probe_results/ro-delete"
  assert_contains "pass" "$probe_results/current-write"
  assert_contains "denied" "$probe_results/unrelated-read"
  assert_contains "pass" "$probe_results/common-write"
  [[ ! -e "$ro_create" ]] || { echo "RO sandbox unexpectedly created a file" >&2; return 1; }
  [[ -e "$ro_delete" ]] || { echo "RO sandbox unexpectedly deleted a file" >&2; return 1; }
  [[ "$(cat "$ro_append")" == "$append_before" && "$(cat "$ro_delete")" == "$delete_before" ]] || {
    echo "RO sandbox unexpectedly changed fixture content" >&2
    return 1
  }
  [[ "$(cat "$current_file")" == "sandbox current" ]] || { echo "current worktree write did not occur" >&2; return 1; }
  [[ "$(cat "$common_marker")" == "sandbox common" ]] || {
    echo "common-dir marker was not written" >&2
    return 1
  }
  printf 'sandbox %s: PASS\n' "$mode"
  done

  rm -f "$probe_results"/* "$ro_create" "$common_marker"
  set +e
  (
    cd "$sandbox_linked"
    env \
      BASE_PROFILE="$real_base" \
      BROWSER_ADDON="$real_browser" \
      KEYCHAIN_ADDON="$real_keychain" \
      EMACS_ADDON="$real_emacs" \
      PATH="$sandbox_bin:/usr/bin:/bin" \
      PROBE_RESULTS="$probe_results" \
      PROBE_RO_FILE="$ro_file" \
      PROBE_RO_APPEND="$ro_append" \
      PROBE_RO_CREATE="$ro_create" \
      PROBE_RO_DELETE="$ro_delete" \
      PROBE_CURRENT="$current_file" \
      PROBE_UNRELATED="$sandbox_other/sentinel" \
      PROBE_COMMON="$common_marker" \
      PROBE_CURRENT_ROOT="$sandbox_linked/sentinel" \
      FAKE_GIT_MODE= \
      EXPECT_APPEND=1 \
      "$SAFE_PI" --append-path "$sandbox_sibling"
  )
  status=$?
  set -e
  (( status == 0 )) || {
    echo "safe-pi append sandbox probe failed to launch fake pi (status $status)" >&2
    return 1
  }
  assert_contains "appended" "$probe_results/ro-append"
  assert_contains "created" "$probe_results/ro-create"
  assert_contains "deleted" "$probe_results/ro-delete"
  [[ ! -e "$ro_create" && ! -e "$ro_delete" ]] || {
    echo "append-path sandbox cleanup did not occur" >&2
    return 1
  }
  echo "safe-pi sandbox read/write behavior: PASS"
}

if [[ "${1:-}" == "--sandbox" ]]; then
  run_sandbox_probe
else
  printf '%s\n' 'safe-pi worktree policy behavior: PASS'
fi
