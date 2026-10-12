#!/usr/bin/env bash
# Container lifecycle classification + cleanup — SOURCED by run-linux-capture.sh
# and exercised (with a fake `docker`) by tests/lifecycle-controls.sh.
#
# Contract with the caller (must exist before sourcing):
#   RUN_ID, INSPECT_TIMEOUT, STOP_TIMEOUT, RM_TIMEOUT, log()
# Provides: created_ids, DOCKER_STATE, CREATED_CID, docker_inspect_id,
#           register_created, cleanup_containers
# Never calls exit()/die() and installs no trap.
#
# 'absent' requires a definite no-such-object diagnostic bound to the EXACT id;
# every other failure (daemon down, timeout, unexpected error) is UNKNOWN — never
# treated as removed. Removal is only "confirmed" on successful exact rm AND a
# re-inspect that is definitely absent; id/label mismatches are retained.

created_ids=()
DOCKER_STATE=""
CREATED_CID=""
CLEANUP_UNCERTAIN=0

docker_inspect_id() { # <cid>; prints the id when present
  local cid="$1" out rc=0
  out="$(timeout "$INSPECT_TIMEOUT" docker inspect -f '{{.Id}}' "$cid" 2>&1)" || rc=$?
  if [[ $rc -eq 0 ]]; then
    if [[ -n "$out" ]]; then DOCKER_STATE=present; printf '%s' "$out"; return 0; fi
    DOCKER_STATE=unknown; return 0
  fi
  if [[ $rc -eq 124 ]]; then DOCKER_STATE=unknown; return 0; fi
  if grep -Eqi "no such (object|container):?[[:space:]]*${cid}" <<<"$out"; then DOCKER_STATE=absent; return 0; fi
  DOCKER_STATE=unknown; return 0
}

register_created() { # <cidfile> <phase>; returns 1 when there is no valid receipt
  local cidfile="$1" phase="$2" cid
  cid="$(cat "$cidfile" 2>/dev/null || true)"
  if [[ ! "$cid" =~ ^[0-9a-f]{64}$ ]]; then
    log "no container-id receipt for phase '$phase' — creation state UNKNOWN"
    CREATED_CID=""; return 1
  fi
  CREATED_CID="$cid"; created_ids+=("$cid"); return 0
}

cleanup_containers() { # sets CLEANUP_UNCERTAIN; always returns 0
  CLEANUP_UNCERTAIN=0
  local cid
  for cid in "${created_ids[@]:-}"; do
    [[ -n "$cid" ]] || continue
    docker_inspect_id "$cid" >/dev/null
    case "$DOCKER_STATE" in
      absent)
        log "container $cid already absent" ;;
      unknown)
        CLEANUP_UNCERTAIN=1
        log "UNCERTAIN: state of $cid unknown (daemon unavailable/timeout) — NOT treated as removed" ;;
      present)
        local gotid; gotid="$(timeout "$INSPECT_TIMEOUT" docker inspect -f '{{.Id}}' "$cid" 2>&1 || true)"
        local lab; lab="$(timeout "$INSPECT_TIMEOUT" docker inspect -f '{{ index .Config.Labels "cleanup1.visual.run" }}' "$cid" 2>&1 || true)"
        if [[ "$gotid" != "$cid" || "$lab" != "$RUN_ID" ]]; then
          CLEANUP_UNCERTAIN=1
          log "UNCERTAIN: id/label mismatch for $cid (id='$gotid' label='$lab') — retained"
          continue
        fi
        local src=0; timeout "$STOP_TIMEOUT" docker stop "$cid" >/dev/null 2>&1 || src=$?
        local rrc=0; timeout "$RM_TIMEOUT" docker rm -f "$cid" >/dev/null 2>&1 || rrc=$?
        docker_inspect_id "$cid" >/dev/null
        if [[ "$rrc" -eq 0 && "$DOCKER_STATE" == "absent" ]]; then
          log "confirmed removal of owned container $cid (stop rc=$src)"
        else
          CLEANUP_UNCERTAIN=1
          log "UNCERTAIN: $cid not proven removed (stop rc=$src rm rc=$rrc state=$DOCKER_STATE) — retained"
        fi
        ;;
    esac
  done
  return 0
}
