/** Fixture writes are allowed only against an explicitly disposable local DB. */
export function assertDisposableDatabase(): void {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (
    process.env.CI_DISPOSABLE_POSTGRES !== '1' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  ) {
    throw new Error(
      'Strategy integration fixtures require an explicitly disposable local PostgreSQL database',
    );
  }
}
