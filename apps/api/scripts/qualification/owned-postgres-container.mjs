import assert from 'node:assert/strict';

export const OWNER_LABEL = 'capiro.qualification-owner';

// The adapter is the harness's pinned-local-daemon process wrapper. Unit tests
// supply a process-result double; importing this module never launches Docker.
export function ownedPostgresContainer({ docker, imageId, name, ownershipToken }) {
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  assert.match(name, /^core108-fixtures-[a-f0-9-]+$/);
  assert.match(ownershipToken, /^[a-f0-9-]{36}$/);
  let creationAttempted = false;
  let containerId;

  function inspect(reference) {
    const result = docker(['container', 'inspect', reference], undefined, false);
    if (result.status !== 0) {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /No such (?:object|container)/i);
      return null;
    }
    const entries = JSON.parse(result.stdout);
    assert.equal(entries.length, 1, 'Expected one inspected container');
    return entries[0];
  }

  function requireOwned(container) {
    assert.ok(container, 'Created container is absent');
    assert.match(container.Id, /^[a-f0-9]{64}$/);
    assert.equal(container.Name, `/${name}`, 'Refusing foreign container name');
    assert.equal(container.Config?.Labels?.[OWNER_LABEL], ownershipToken,
      'Refusing foreign container ownership');
    assert.equal(container.Image, imageId, 'Refusing foreign container image');
    assert.equal(container.HostConfig.NetworkMode, 'none');
    assert.ok(!container.HostConfig.Binds?.length);
    assert.ok(!container.HostConfig.Mounts?.length);
    assert.ok(!Object.keys(container.HostConfig.PortBindings ?? {}).length);
    return container.Id;
  }

  return {
    get id() { return containerId; },
    start() {
      assert.equal(creationAttempted, false, 'Container creation already attempted');
      assert.equal(inspect(name), null, 'Refusing an existing container');
      // Record the attempt before invoking the process: Docker may create the
      // container even when its reply is lost or the client times out.
      creationAttempted = true;
      const result = docker(['create', '--pull=never', '--name', name, '--network', 'none',
        '--label', 'capiro.qualification=core108-disposable',
        '--label', `${OWNER_LABEL}=${ownershipToken}`,
        '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', imageId]);
      const createdId = result.stdout.trim();
      assert.match(createdId, /^[a-f0-9]{64}$/);
      containerId = createdId;
      assert.equal(requireOwned(inspect(containerId)), containerId);
      // ID and ownership are retained before startup, including startup errors.
      docker(['start', containerId]);
      return containerId;
    },
    cleanup() {
      if (!creationAttempted) return { attempted: false, removed: false };
      // Ambiguous create replies are resolved by unique name AND token, never
      // by name alone. Removal always targets the verified immutable ID.
      const container = inspect(containerId ?? name);
      if (!container) return { attempted: true, removed: false, alreadyAbsent: true };
      const ownedId = requireOwned(container);
      if (containerId) assert.equal(ownedId, containerId);
      containerId = ownedId;
      docker(['rm', '-f', '-v', containerId]);
      return { attempted: true, removed: true };
    },
  };
}
