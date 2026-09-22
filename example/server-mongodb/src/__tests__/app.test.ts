import { createGraphQLTransport } from '@nkzw/fate';
import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';
import { createApp } from '../app.ts';
import { setupDatabase } from '../models.ts';

const request = (body: unknown) =>
  new Request('http://local/fate', {
    body: JSON.stringify(body),
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    method: 'POST',
  });

describe.runIf(Boolean(process.env.FATE_MONGODB_URL))('MongoDB application transports', () => {
  let client: MongoClient;
  let application: ReturnType<typeof createApp>;
  let postId: string;
  let secondPostId: string;
  beforeAll(async () => {
    client = await new MongoClient(process.env.FATE_MONGODB_URL!, {
      monitorCommands: true,
    }).connect();
    const db = client.db(`fate_app_${new ObjectId().toHexString()}`);
    const models = await setupDatabase(db);
    const user = await models.users.insertOne({ name: 'Ada' });
    const post = await models.posts.insertOne({ authorId: user._id, likes: 0, title: 'One' });
    const second = await models.posts.insertOne({ authorId: user._id, likes: 0, title: 'Two' });
    for (const parent of [post, second]) {
      await models.comments.insertMany(
        [1, 2, 3].map((n) => ({
          authorId: user._id,
          postId: parent._id,
          text: `Comment ${n}`,
        })),
      );
    }
    postId = post._id.toHexString();
    secondPostId = second._id.toHexString();
    application = createApp(db, (request) => ({
      canWrite: request.headers.get('authorization') === 'Bearer test',
    }));
  });
  afterAll(async () => {
    if (application) {
      await client.db(application.api.models.posts.collection!.dbName).dropDatabase();
    }
    await client?.close();
  });
  test('Pothos batches relations and preserves requested IDs, duplicates and missing nodes', async () => {
    const finds: Array<string> = [];
    const listener = (event: { command: { find?: string } }) => {
      if (event.command.find) {
        finds.push(event.command.find);
      }
    };
    client.on('commandStarted', listener);
    try {
      const response = await application.app.request('/graphql', {
        body: JSON.stringify({
          query: `{ nodes(ids: ["Post-${secondPostId}", "Post-${postId}", "Post-${postId}", "Post-${new ObjectId().toHexString()}"]) { ... on Post { title author { name } } } }`,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(await response.json()).toMatchObject({
        data: {
          nodes: [
            { author: { name: 'Ada' }, title: 'Two' },
            { author: { name: 'Ada' }, title: 'One' },
            { author: { name: 'Ada' }, title: 'One' },
            null,
          ],
        },
      });
      expect(finds).toEqual(['posts', 'users']);
    } finally {
      client.off('commandStarted', listener);
    }
  });
  test('fate GraphQL transport normalizes IDs and nested Relay connections', async () => {
    const transport = createGraphQLTransport({
      fetch: async (input, init) => application.app.fetch(new Request(input, init)),
      roots: { posts: { type: 'Post' } },
      types: [
        { fields: { author: { type: 'User' }, comments: { listOf: 'Comment' } }, type: 'Post' },
        { fields: { author: { type: 'User' } }, type: 'Comment' },
        { type: 'User' },
      ],
      url: 'http://local/graphql',
    });
    const result = await transport.fetchList!(
      'posts',
      new Set(['title', 'author.name', 'comments.text']),
      { comments: { first: 1 }, first: 2 },
    );
    expect(result).toMatchObject({
      items: [
        {
          node: {
            author: { name: 'Ada' },
            comments: { items: [{ node: { text: 'Comment 3' } }], pagination: { hasNext: true } },
            id: secondPostId,
          },
        },
        {
          node: {
            author: { name: 'Ada' },
            comments: { items: [{ node: { text: 'Comment 3' } }] },
            id: postId,
          },
        },
      ],
    });
  });
  test('GraphQL aliases isolate page arguments for each parent', async () => {
    const response = await application.app.request('/graphql', {
      body: JSON.stringify({
        query: `{ posts(first: 2) { edges { node { a: comments(first: 1) { edges { node { text } } } b: comments(last: 2) { edges { node { text } } } } } } }`,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const result = (await response.json()) as {
      data: {
        posts: {
          edges: Array<{
            node: { a: { edges: Array<unknown> }; b: { edges: Array<{ node: { text: string } }> } };
          }>;
        };
      };
      errors?: unknown;
    };
    expect(result.errors).toBeUndefined();
    for (const { node } of result.data.posts.edges) {
      expect(node.a.edges).toHaveLength(1);
      expect(node.b.edges).toHaveLength(2);
      expect(node.b.edges.map((edge: { node: { text: string } }) => edge.node.text)).toEqual([
        'Comment 2',
        'Comment 1',
      ]);
    }
  });
  test('authorized concurrent writes are atomic and anonymous writes are rejected', async () => {
    const caller = application.api.router.createCaller({ canWrite: true });
    await Promise.all(Array.from({ length: 10 }, () => caller.post.like({ id: postId })));
    const result = await caller.post.byId({ ids: [postId], select: ['likes'] });
    expect(result).toMatchObject([{ likes: 10 }]);
    await expect(
      application.api.router.createCaller({ canWrite: false }).post.like({ id: postId }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  test('native mutations return authorization errors without writing', async () => {
    const response = await application.app.request('/fate', {
      body: JSON.stringify({
        operations: [
          {
            id: 'anonymous',
            input: { id: postId },
            kind: 'mutation',
            name: 'post.like',
            select: ['likes'],
          },
        ],
        version: 1,
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(await response.json()).toMatchObject({
      results: [{ error: { code: 'UNAUTHORIZED' }, ok: false }],
    });
  });
  test('native persisted mutations replay their receipt and publish selected live updates', async () => {
    const { server } = application.api;
    const response = await server.handleLiveRequest(
      new Request('http://local/fate/live?connectionId=mongodb'),
    );
    const reader = response.body!.getReader();
    try {
      await server.handleLiveRequest(
        new Request(
          'http://local/fate/live',
          request({
            connectionId: 'mongodb',
            operations: [
              { entityId: postId, id: 'live', kind: 'subscribe', select: ['likes'], type: 'Post' },
            ],
            version: 1,
          }),
        ),
      );
      await reader.read();
      const body = {
        operations: [
          {
            id: 'mutation',
            input: { id: postId },
            kind: 'mutation',
            mutation: { id: 'offline-like', scope: 'demo-writer' },
            name: 'post.like',
            select: ['likes'],
          },
        ],
        version: 2,
      };
      const first = await (await server.handleRequest(request(body))).json();
      const repeated = await (await server.handleRequest(request(body))).json();
      expect(first).toMatchObject({ results: [{ data: { id: postId, likes: 11 }, ok: true }] });
      expect(repeated).toEqual(first);
      const event = new TextDecoder().decode((await reader.read()).value);
      expect(event).toContain('"likes":11');
      expect(event).not.toContain('title');
    } finally {
      await reader.cancel();
    }
  });
  test('GraphQL SSE refetches selected fields after a MongoDB update', async () => {
    const query = `subscription { fateLiveNode(type: "Post", id: "Post-${postId}", select: ["title"]) { id data select } }`;
    const controller = new AbortController();
    const response = await application.app.request(`/graphql?query=${encodeURIComponent(query)}`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      const pending = reader.read();
      application.api.live.emit('Post', postId, { changed: ['title'] });
      let chunk = new TextDecoder().decode((await pending).value);
      while (!chunk.includes('fateLiveNode')) {
        chunk += new TextDecoder().decode((await reader.read()).value);
      }
      expect(chunk).toContain('One');
      expect(chunk).not.toContain('likes');
    } finally {
      controller.abort();
      await reader.cancel();
    }
  });
  test('serial GraphQL mutations clear request-local caches', async () => {
    const response = await application.app.request('/graphql', {
      body: JSON.stringify({
        query: `mutation { a: likePost(id: "Post-${secondPostId}") { likes } b: likePost(id: "Post-${secondPostId}") { likes } }`,
      }),
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      method: 'POST',
    });
    const result = (await response.json()) as { data: unknown; errors?: unknown };
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ a: { likes: 1 }, b: { likes: 2 } });
  });
});
