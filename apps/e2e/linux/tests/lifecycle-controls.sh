#!/usr/bin/env bash
# Fake-native lifecycle controls for the SOURCED lifecycle module
# (apps/e2e/linux/lifecycle.sh). Exercises classification + cleanup WITHOUT real
# containers (no docker daemon, no images) — a decision-table proof root can run.
#
#   bash apps/e2e/linux/tests/lifecycle-controls.sh
#
# Each scenario stubs `docker` + `timeout`; asserts DOCKER_STATE,
# CLEANUP_UNCERTAIN and the recorded docker calls; exits non-zero on any failure.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIFECYCLE="$HERE/../lifecycle.sh"

RUN_ID="cleanup1-visual-testcase"
INSPECT_TIMEOUT=5
STOP_TIMEOUT=5
RM_TIMEOUT=5

CALLS=""
log() { printf '  [lifecycle] %s\n' "$*"; }
timeout() { shift; "$@"; } # drop the duration; run the command directly

FAKE_SCENARIO=""
CID1="$(printf 'a%.0s' {1..64})"
WRONG_ID="$(printf 'b%.0s' {1..64})"
FAKE_DIR=""

docker() {
  local last="${*: -1}"
  case "$1" in
    inspect)
      local fmt="$3"
      case "$FAKE_SCENARIO" in
        daemon) echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; return 1 ;;
        absent) echo "Error response from daemon: No such object: $last" >&2; return 1 ;;
      esac
      if [[ -f "$FAKE_DIR/$last.present" ]]; then
        if [[ "$fmt" == *Labels* ]]; then
          if [[ "$FAKE_SCENARIO" == labelmismatch ]]; then echo "some-other-run"; else echo "$RUN_ID"; fi
        else
          if [[ "$FAKE_SCENARIO" == idmismatch ]]; then echo "$WRONG_ID"; else echo "$last"; fi
        fi
        return 0
      fi
      echo "Error response from daemon: No such object: $last" >&2; return 1 ;;
    stop) CALLS="$CALLS stop:$last"; return 0 ;;
    rm)
      CALLS="$CALLS rm:$last"
      if [[ "$FAKE_SCENARIO" == rmfails ]]; then return 1; fi
      rm -f "$FAKE_DIR/$last.present"; return 0 ;;
  esac
  return 0
}

# shellcheck source=../lifecycle.sh
source "$LIFECYCLE"

FAIL=0
check() { # <description> <actual> <expected>
  if [[ "$2" == "$3" ]]; then printf 'PASS %s (%s)\n' "$1" "$2"; else printf 'FAIL %s: got %s want %s\n' "$1" "$2" "$3"; FAIL=1; fi
}

reset_state() { created_ids=("$CID1"); DOCKER_STATE=""; CLEANUP_UNCERTAIN=0; CALLS=""; }

FAKE_DIR="$(mktemp -d)"
trap 'printf "Retaining owned test fixture: %s\n" "$FAKE_DIR"' EXIT

# 1. present + owned → stop+rm succeed, re-inspect absent → confirmed removal.
FAKE_SCENARIO=present; touch "$FAKE_DIR/$CID1.present"; reset_state
cleanup_containers
check "present-owned removal uncertain" "$CLEANUP_UNCERTAIN" "0"
check "present-owned stop+rm called" "$CALLS" " stop:$CID1 rm:$CID1"

# 2. definitely absent (no-such-object bound to the exact id).
FAKE_SCENARIO=absent; reset_state
cleanup_containers
check "absent uncertain" "$CLEANUP_UNCERTAIN" "0"

# 3. daemon error → UNKNOWN, never removed.
FAKE_SCENARIO=daemon; reset_state
cleanup_containers
check "daemon-error uncertain" "$CLEANUP_UNCERTAIN" "1"

# 4. label mismatch → retained + uncertain, no stop/rm.
FAKE_SCENARIO=labelmismatch; touch "$FAKE_DIR/$CID1.present"; reset_state
cleanup_containers
check "label-mismatch uncertain" "$CLEANUP_UNCERTAIN" "1"
check "label-mismatch no stop/rm" "$CALLS" ""

# 5. id mismatch (returned Id != requested cid) → retained + uncertain.
FAKE_SCENARIO=idmismatch; touch "$FAKE_DIR/$CID1.present"; reset_state
cleanup_containers
check "id-mismatch uncertain" "$CLEANUP_UNCERTAIN" "1"
check "id-mismatch no stop/rm" "$CALLS" ""

# 6. rm fails (container remains) → uncertain.
FAKE_SCENARIO=rmfails; touch "$FAKE_DIR/$CID1.present"; reset_state
cleanup_containers
check "rm-fails uncertain" "$CLEANUP_UNCERTAIN" "1"
check "rm-fails attempted rm" "$CALLS" " stop:$CID1 rm:$CID1"

# 7. create receipt with a valid id → registered.
CIDFILE="$FAKE_DIR/ok.cid"; printf '%s' "$CID1" > "$CIDFILE"
created_ids=()
if register_created "$CIDFILE" create; then rc=0; else rc=$?; fi
check "create-with-CID returns ok" "$rc" "0"
check "create-with-CID registered" "${created_ids[0]:-}" "$CID1"

# 8. create receipt missing → UNKNOWN creation, not registered.
created_ids=(); : > "$FAKE_DIR/empty.cid"
if register_created "$FAKE_DIR/empty.cid" create; then rc=0; else rc=$?; fi
check "create-without-CID returns fail" "$rc" "1"
check "create-without-CID not registered" "${#created_ids[@]}" "0"
check "create-without-CID created_cid empty" "$CREATED_CID" ""

echo
if [[ "$FAIL" -eq 0 ]]; then echo "lifecycle controls: ALL PASS"; else echo "lifecycle controls: FAILURES"; fi
exit "$FAIL"
