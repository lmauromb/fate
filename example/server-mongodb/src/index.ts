import { serve } from '@hono/node-server';
import { MongoClient } from 'mongodb';
import { createApp } from './app.ts';

const client = await new MongoClient(
  process.env.MONGODB_URL ?? 'mongodb://127.0.0.1:27017',
).connect();
const { app } = createApp(client.db(process.env.MONGODB_DATABASE ?? 'fate'), (request) => ({
  // Replace with your authenticated session/authorization policy in an application.
  canWrite:
    Boolean(process.env.API_TOKEN) &&
    request.headers.get('authorization') === `Bearer ${process.env.API_TOKEN}`,
}));
const server = serve({
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port: Number(process.env.PORT ?? 9030),
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () =>
    server.close(() => {
      void client.close();
    }),
  );
}
