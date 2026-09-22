import { useGraphQLSSE as graphQLSSE } from '@graphql-yoga/plugin-graphql-sse';
import { trpcServer } from '@hono/trpc-server';
import { createHonoFateHandler } from '@nkzw/fate/server';
import { createYoga } from 'graphql-yoga';
import { Hono } from 'hono';
import type { Db } from 'mongodb';
import { createAPI, type Context } from './api.ts';
import { createGraphQLContext, createSchema } from './graphql.ts';

export function createApp(db: Db, context: (request: Request) => Context | Promise<Context>) {
  const api = createAPI(db, context);
  const yoga = createYoga({
    context: async ({ request }) => createGraphQLContext(await context(request)),
    fetchAPI: { Headers, ReadableStream, Request, Response, TransformStream },
    plugins: [graphQLSSE()],
    schema: createSchema(db, api),
  });
  const app = new Hono();
  app.all('/fate', createHonoFateHandler(api.server));
  app.all('/fate/*', createHonoFateHandler(api.server));
  app.use(
    '/trpc/*',
    trpcServer({ createContext: (_, c) => context(c.req.raw), router: api.router }),
  );
  app.all('/graphql', (c) => yoga.fetch(c.req.raw));
  app.all('/graphql/*', (c) => yoga.fetch(c.req.raw));
  return { api, app };
}
