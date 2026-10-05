import { afterEach, expect, test, vi } from 'vite-plus/test';

afterEach(() => {
  vi.unstubAllEnvs();
});

test('initializes authentication with the database schema', async () => {
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-auth-schema-secret-with-enough-entropy');
  vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:9000');
  vi.stubEnv('CLIENT_DOMAIN', 'http://localhost:5173');
  vi.stubEnv('DATABASE_URL', 'postgresql://fate:echo@localhost:5432/fate');

  const { auth } = await import('../auth.tsx');
  await expect(auth.$context).resolves.toBeDefined();
});
