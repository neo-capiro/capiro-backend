import canonical from '../../../apps/web/vitest.config.ts';
export default { ...canonical, server: { ...(canonical.server ?? {}), host: '127.0.0.1' } };
