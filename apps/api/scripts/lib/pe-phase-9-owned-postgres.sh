#!/usr/bin/env bash
# Dedicated-test capabilities only. Never provision production roles here.

start_owned_postgres() {
  CONTAINER_ID=""
  if docker container inspect "$NAME" >/dev/null 2>&1; then
    echo "FATAL: container name already exists; refusing replacement: $NAME" >&2
    return 1
  fi
  CONTAINER_ID="$(docker run -d --name "$NAME" \
    -e POSTGRES_USER="$USER_NAME" -e POSTGRES_PASSWORD="$PASS" \
    -e POSTGRES_DB=capiro -p "127.0.0.1:${PORT}:5432" "$IMAGE")"
  if [[ ! "$CONTAINER_ID" =~ ^[a-f0-9]{64}$ ]]; then
    echo "FATAL: docker did not return a created container ID" >&2
    CONTAINER_ID=""
    return 1
  fi
  echo "created_container_id=$CONTAINER_ID"
  echo "Waiting for postgres..."
  local i
  for i in $(seq 1 60); do
    if docker exec "$CONTAINER_ID" pg_isready -h 127.0.0.1 \
      -U "$USER_NAME" -d capiro >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "FATAL: postgres did not become ready" >&2
  return 1
}

cleanup() {
  [ -n "${CONTAINER_ID:-}" ] || return 0
  if [ "$KEEP" = "1" ]; then
    echo "KEEP=1 — leaving created container $CONTAINER_ID"
    return 0
  fi
  docker rm -f -v "$CONTAINER_ID" >/dev/null 2>&1 || true
}

bootstrap_owned_worker() {
  # The SQL rejects unsafe attributes and memberships. This role is cluster-scoped;
  # unchanged migrations create database-scoped functions and grant capabilities.
  docker exec -i -e PGPASSWORD="$PASS" "$CONTAINER_ID" \
    psql -h 127.0.0.1 -U "$USER_NAME" -d postgres -v ON_ERROR_STOP=1 \
    <"$ROOT/scripts/ci/disposable-capiro-worker-role.sql"
}
