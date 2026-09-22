import { initTRPC } from '@trpc/server';
import { MongoClient, ObjectId } from 'mongodb';
import type { Db, Document, ClientSession } from 'mongodb';
import Papr, { schema, types } from 'papr';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';
import { createMutationIdempotency } from '../../idempotency.ts';
import { resolveConnection } from '../connection.ts';
import { computed, count, dataView, field, list, resolver } from '../dataView.ts';
import { createFateServer } from '../http.ts';
import { createMongoDBFate, createMongoDBSourceAdapter, mongoDBRecord } from '../mongodb.ts';
import { createMongoDBIdempotencyStore } from '../mongodbIdempotency.ts';

const oid = (n: number) => new ObjectId(n.toString(16).padStart(24, '0'));
const id = (n: number) => oid(n).toHexString();
const userView = dataView('User')({ id: true, name: true });
const tagView = dataView('Tag')({ id: true, label: true });
const commentView = dataView('Comment')({ author: userView, id: true, text: true });
const addressView = dataView('Address')({ city: true, id: true });
const postView = dataView('Post')({
  addresses: list(addressView),
  author: userView,
  authorName: computed({ resolve: (_, deps) => deps.name, select: { name: field('author.name') } }),
  comments: list(commentView),
  counts: computed({
    resolve: (_, deps) => deps,
    select: { all: count('comments'), visible: count('comments', { where: { visible: true } }) },
  }),
  id: true,
  likes: true,
  linkedTags: list(tagView),
  secret: resolver({
    authorize: () => false,
    resolve: (row) => row.private,
    select: { private: true },
  }),
  tags: list(tagView),
  title: true,
  upper: resolver({ resolve: (row) => String(row.title).toUpperCase(), select: { title: true } }),
});
type Context = { session?: ClientSession; tenant: string };
const ctx: Context = { tenant: 'a' };
const makeAdapter = (db: Db) =>
  createMongoDBSourceAdapter<Context>({
    db: () => db,
    options: ({ session }) => ({ session }),
    views: [
      { collection: 'users', view: userView, where: ({ ctx }) => ({ tenant: ctx.tenant }) },
      { collection: 'tags', view: tagView },
      { collection: 'posts', view: addressView },
      {
        collection: 'comments',
        relations: { author: { foreignKey: 'id', localKey: 'authorId' } },
        view: commentView,
        where: ({ args, ctx }) => ({
          tenant: ctx.tenant,
          ...(args?.visible === true ? { visible: true } : {}),
        }),
      },
      {
        collection: 'posts',
        relations: {
          addresses: { embedded: 'addresses', foreignKey: 'id', localKey: 'id' },
          author: { foreignKey: 'id', localKey: 'authorId' },
          comments: { foreignKey: 'postId', localKey: 'id' },
          linkedTags: {
            foreignKey: 'id',
            localKey: 'id',
            through: { collection: 'postTags', foreignKey: 'tagId', localKey: 'postId' },
          },
          tags: { foreignKey: 'id', localKey: 'tagIds' },
        },
        view: postView,
        where: ({ ctx }) => ({ tenant: ctx.tenant }),
      },
    ],
  });

test('normalizes BSON IDs recursively while preserving dates', () => {
  const date = new Date();
  expect(mongoDBRecord({ date, id: oid(1), nested: { ids: [oid(2)] } })).toEqual({
    date,
    id: id(1),
    nested: { ids: [id(2)] },
  });
});

test('validates reference metadata before executing queries', () => {
  expect(() =>
    createMongoDBSourceAdapter({ db: {} as Db, views: [{ collection: 'posts', view: postView }] }),
  ).toThrow();
});

// Explicit opt-in keeps unit tests independent of a local database. CI runs this suite with a replica set.
describe.runIf(Boolean(process.env.FATE_MONGODB_URL))('MongoDB source integration', () => {
  let client: MongoClient;
  let db: Db;
  let adapter: ReturnType<typeof makeAdapter>;
  beforeAll(async () => {
    client = await new MongoClient(process.env.FATE_MONGODB_URL!, {
      monitorCommands: true,
    }).connect();
    db = client.db(`fate_test_${new ObjectId().toHexString()}`);
    adapter = makeAdapter(db);
    await db.collection('users').insertMany([
      { _id: oid(1), name: 'Ada', password: 'hidden', tenant: 'a' },
      { _id: oid(2), name: 'Other tenant', tenant: 'b' },
    ]);
    await db.collection('posts').insertMany(
      [1, 2, 3, 4].map((n) => ({
        _id: oid(n),
        addresses: [
          { _id: oid(10), city: 'Monterrey' },
          { _id: oid(11), city: 'Austin' },
        ],
        authorId: oid(n === 4 ? 2 : 1),
        likes: 0,
        private: 'hidden',
        tagIds: [oid(1), oid(2)],
        tenant: 'a',
        title: `Post ${n}`,
      })),
    );
    await db.collection('comments').insertMany(
      [1, 2, 3, 4].flatMap((post) =>
        [1, 2, 3].map((n) => ({
          _id: oid(post * 10 + n),
          authorId: oid(1),
          postId: oid(post),
          tenant: 'a',
          text: `Comment ${n}`,
          visible: n !== 2,
        })),
      ),
    );
    await db
      .collection('comments')
      .insertOne({ _id: oid(99), postId: oid(1), tenant: 'b', text: 'Hidden tenant' });
    await db.collection('tags').insertMany([
      { _id: oid(1), label: 'MongoDB' },
      { _id: oid(2), label: 'fate' },
    ]);
    await db.collection('postTags').insertMany([
      { postId: oid(1), tagId: oid(1) },
      { postId: oid(1), tagId: oid(1) },
      { postId: oid(1), tagId: oid(2) },
    ]);
  });
  afterAll(async () => {
    await db?.dropDatabase();
    await client?.close();
  });

  test('resolves projections, hidden dependencies, filtered counts, array references and links in one aggregate', async () => {
    const commands: Array<string> = [];
    const listener = (event: { commandName: string }) => commands.push(event.commandName);
    client.on('commandStarted', listener);
    try {
      const [post] = await adapter.resolveByIds({
        ctx,
        ids: [id(1)],
        input: {
          select: [
            'title',
            'author.name',
            'counts',
            'authorName',
            'secret',
            'upper',
            'tags.label',
            'linkedTags.label',
          ],
        },
        view: postView,
      });
      expect(post).toMatchObject({
        author: { id: id(1), name: 'Ada' },
        authorName: 'Ada',
        counts: { all: 3, visible: 2 },
        id: id(1),
        secret: null,
        title: 'Post 1',
        upper: 'POST 1',
      });
      expect(post.tags).toMatchObject({ items: expect.any(Array) });
      expect((post.tags as { items: Array<unknown> }).items).toHaveLength(2);
      expect((post.linkedTags as { items: Array<unknown> }).items).toHaveLength(2);
      expect(post).not.toHaveProperty('private');
      expect(post).not.toHaveProperty('_id');
      expect(post.author).not.toHaveProperty('password');
      expect(commands.filter((command) => command === 'aggregate')).toHaveLength(1);
    } finally {
      client.off('commandStarted', listener);
    }
  });
  test('hidden relation dependency is fetched without exposing the relation', async () => {
    const result = await adapter.resolveById({
      ctx,
      id: id(1),
      input: { select: ['authorName'] },
      view: postView,
    });
    expect(result).toEqual({ authorName: 'Ada', id: id(1) });
  });
  test('preserves batch ordering and missing IDs, filters inaccessible relations', async () => {
    const result = await adapter.resolveByIds({
      ctx,
      ids: [id(4), id(99), id(1), id(4)],
      input: { select: ['author.name'] },
      view: postView,
    });
    expect(result.map((row) => row.id)).toEqual([id(4), id(1), id(4)]);
    expect(result[0].author).toBeNull();
  });
  const page = (args: Document) =>
    resolveConnection({
      ctx,
      input: { args, select: ['title'] },
      query: (options) => adapter.resolveConnection({ ...options, view: postView }),
    });
  test('pages both directions without double-skipping and accepts a deleted ID boundary', async () => {
    const first = await page({ first: 2 });
    expect(first.items.map(({ node }) => (node as { id: string }).id)).toEqual([id(4), id(3)]);
    const second = await page({ after: id(3), first: 2 });
    expect(second.items.map(({ node }) => (node as { id: string }).id)).toEqual([id(2), id(1)]);
    expect(second.pagination.hasNext).toBe(false);
    const previous = await page({ before: id(2), last: 2 });
    expect(previous.items.map(({ node }) => (node as { id: string }).id)).toEqual([id(4), id(3)]);
    const nonexistent = await page({ after: id(5), first: 2 });
    expect(nonexistent.items.map(({ node }) => (node as { id: string }).id)).toEqual([
      id(4),
      id(3),
    ]);
    await expect(page({ after: 'invalid' })).rejects.toThrow('ObjectId');
  });
  test('limits nested references independently per parent with scoped filters', async () => {
    const results = await adapter.resolveByIds({
      ctx,
      ids: [id(1), id(2)],
      input: {
        args: { comments: { first: 1, visible: true } },
        select: ['comments.text', 'comments.author.name'],
      },
      view: postView,
    });
    for (const post of results) {
      expect(post.comments).toMatchObject({
        items: [{ node: { author: { name: 'Ada' }, text: 'Comment 3' } }],
        pagination: { hasNext: true },
      });
    }
  });
  test('projects embedded entities and paginates bounded document arrays', async () => {
    const result = await adapter.resolveById({
      ctx,
      id: id(1),
      input: { args: { addresses: { first: 1 } }, select: ['addresses.city'] },
      view: postView,
    });
    expect(result?.addresses).toMatchObject({
      items: [{ node: { city: 'Austin', id: id(11) } }],
      pagination: { hasNext: true },
    });
  });
  test('sorts nullable scalar fields with ID tie-breakers and storage aliases', async () => {
    const view = dataView('Sorted')({ id: true, rank: true });
    await db.collection('sorted').insertMany([
      { _id: oid(1), position: null },
      { _id: oid(2), position: 1 },
      { _id: oid(3), position: 1 },
      { _id: oid(4), position: 2 },
    ]);
    const sorted = createMongoDBSourceAdapter({
      db,
      views: [
        {
          collection: 'sorted',
          fields: { rank: 'position' },
          orderBy: [{ direction: 'asc', field: 'rank' }],
          view,
        },
      ],
    });
    const read = (args: Document) =>
      resolveConnection({
        ctx,
        input: { args, select: ['rank'] },
        query: (options) => sorted.resolveConnection({ ...options, view }),
      });
    expect((await read({ first: 2 })).items).toMatchObject([
      { node: { id: id(1), rank: null } },
      { node: { id: id(2), rank: 1 } },
    ]);
    expect((await read({ after: id(2), first: 2 })).items).toMatchObject([
      { node: { id: id(3) } },
      { node: { id: id(4) } },
    ]);
    expect((await read({ before: id(3), last: 2 })).items).toMatchObject([
      { node: { id: id(1) } },
      { node: { id: id(2) } },
    ]);
  });
  test('supports explicit string IDs and does not treat them as ObjectIds', async () => {
    const view = dataView('StringID')({ id: true, title: true });
    await db.collection<{ _id: string; title: string }>('stringIDs').insertMany([
      { _id: 'a', title: 'A' },
      { _id: 'b', title: 'B' },
    ]);
    const adapter = createMongoDBSourceAdapter({
      db,
      views: [{ collection: 'stringIDs', idType: 'string', view }],
    });
    expect(
      await adapter.resolveByIds({
        ctx,
        ids: ['b', 'missing', 'a'],
        input: { select: ['title'] },
        view,
      }),
    ).toEqual([
      { id: 'b', title: 'B' },
      { id: 'a', title: 'A' },
    ]);
  });
  test('hydrates hidden dependencies through multiple reference levels', async () => {
    const manager = dataView('Manager')({ id: true, name: true });
    const author = dataView('AuthorWithManager')({ id: true, manager });
    const post = dataView('ManagedPost')({
      author,
      id: true,
      managerName: computed({
        resolve: (_, deps) => deps.name,
        select: { name: field('author.manager.name') },
      }),
    });
    await db.collection('users').updateOne({ _id: oid(1) }, { $set: { managerId: oid(2) } });
    const adapter = createMongoDBSourceAdapter({
      db,
      views: [
        { collection: 'users', view: manager },
        {
          collection: 'users',
          relations: { manager: { foreignKey: 'id', localKey: 'managerId' } },
          view: author,
        },
        {
          collection: 'posts',
          relations: { author: { foreignKey: 'id', localKey: 'authorId' } },
          view: post,
        },
      ],
    });
    expect(
      await adapter.resolveById({ ctx, id: id(1), input: { select: ['managerName'] }, view: post }),
    ).toEqual({ id: id(1), managerName: 'Other tenant' });
  });
  test('hydrates nested embedded arrays without querying them as collections', async () => {
    const unit = dataView('Unit')({ id: true, name: true });
    const building = dataView('Building')({ id: true, units: list(unit) });
    const campus = dataView('Campus')({ buildings: list(building), id: true });
    await db.collection('campuses').insertOne({
      _id: oid(1),
      buildings: [{ _id: oid(2), units: [{ _id: oid(3), name: 'Lab' }] }],
    });
    const adapter = createMongoDBSourceAdapter({
      db,
      views: [
        { collection: 'campuses', view: unit },
        {
          collection: 'campuses',
          relations: { units: { embedded: 'units', foreignKey: 'id', localKey: 'id' } },
          view: building,
        },
        {
          collection: 'campuses',
          relations: { buildings: { embedded: 'buildings', foreignKey: 'id', localKey: 'id' } },
          view: campus,
        },
      ],
    });
    expect(
      await adapter.resolveById({
        ctx,
        id: id(1),
        input: { select: ['buildings.units.name'] },
        view: campus,
      }),
    ).toMatchObject({
      buildings: { items: [{ node: { units: { items: [{ node: { name: 'Lab' } }] } } }] },
    });
  });
  test('supports tRPC procedures and the native source contract', async () => {
    const t = initTRPC.context<Context>().create();
    const simple = dataView('Simple')({ id: true, title: true });
    const fate = createMongoDBFate({
      db,
      procedure: t.procedure,
      views: [{ collection: 'posts', view: simple }],
    });
    const router = t.router({ simple: t.router(fate.procedures(simple)) });
    const caller = router.createCaller(ctx);
    const result = await caller.simple.byId({ ids: [id(1)], select: ['title'] });
    expect(result).toEqual([{ id: id(1), title: 'Post 1' }]);
    const native = createFateServer({
      context: () => ctx,
      roots: { posts: list(simple) },
      sources: fate,
    });
    const response = await native.handleRequest(
      new Request('http://local/fate', {
        body: JSON.stringify({
          operations: [
            { id: 'one', ids: [id(1)], kind: 'byId', select: ['title'], type: 'Simple' },
            { args: { first: 1 }, id: 'page', kind: 'list', name: 'posts', select: ['title'] },
          ],
          version: 1,
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      results: [
        { data: [{ id: id(1), title: 'Post 1' }], id: 'one', ok: true },
        {
          data: { items: [{ node: { id: id(4) } }], pagination: { hasNext: true } },
          id: 'page',
          ok: true,
        },
      ],
    });
  });
  test('propagates transaction sessions to reads and rolls back writes', async () => {
    const session = client.startSession();
    try {
      await expect(
        session.withTransaction(async () => {
          await db
            .collection('posts')
            .updateOne({ _id: oid(1) }, { $set: { title: 'Uncommitted' } }, { session });
          const result = await adapter.resolveById({
            ctx: { ...ctx, session },
            id: id(1),
            input: { select: ['title'] },
            view: postView,
          });
          expect(result?.title).toBe('Uncommitted');
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect((await db.collection('posts').findOne({ _id: oid(1) }))?.title).toBe('Post 1');
    } finally {
      await session.endSession();
    }
  });
  test('durable replay serializes concurrent calls and rolls back effects with receipts', async () => {
    const store = createMongoDBIdempotencyStore<Context>({
      client,
      db,
      withSession: (ctx, session) => ({ ...ctx, session }),
    });
    const idempotency = createMutationIdempotency({ scope: (ctx: Context) => ctx.tenant, store });
    const operation = {
      ctx,
      identity: { id: 'once', scope: 'a' },
      input: {},
      name: 'counter.increment',
      resolve: async ({ session }: Context) => {
        const row = await db
          .collection('counter')
          .findOneAndUpdate(
            { _id: oid(1) },
            { $inc: { value: 1 } },
            { returnDocument: 'after', session, upsert: true },
          );
        return { date: new Date('2026-01-01'), value: row!.value };
      },
      select: ['value'],
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => idempotency.execute(operation)),
    );
    for (const result of results) {
      expect(result).toEqual({ date: new Date('2026-01-01'), value: 1 });
    }
    expect((await db.collection('counter').findOne({ _id: oid(1) }))?.value).toBe(1);
    await expect(idempotency.execute({ ...operation, input: { changed: true } })).rejects.toThrow(
      'different input',
    );
    await expect(
      idempotency.execute({ ...operation, identity: { id: 'once', scope: 'b' } }),
    ).rejects.toThrow('scope');
    const replay = createMutationIdempotency({
      scope: (ctx: Context) => ctx.tenant,
      store: createMongoDBIdempotencyStore<Context>({
        client,
        db,
        withSession: (ctx, session) => ({ ...ctx, session }),
      }),
    });
    expect(
      await replay.execute({ ...operation, identity: { ...operation.identity, replayOnly: true } }),
    ).toEqual(results[0]);
    await expect(
      idempotency.execute({
        ...operation,
        identity: { id: 'rollback', scope: 'a' },
        resolve: async (ctx) => {
          await operation.resolve(ctx);
          throw new Error('rollback');
        },
      }),
    ).rejects.toThrow('rollback');
    expect((await db.collection('counter').findOne({ _id: oid(1) }))?.value).toBe(1);
    await expect(
      replay.execute({ ...operation, identity: { id: 'rollback', replayOnly: true, scope: 'a' } }),
    ).rejects.toThrow('not found');
  });
  test('Papr collection validation rejects invalid native driver writes and updates', async () => {
    const papr = new Papr();
    const model = papr.model(
      'validated',
      schema({
        likes: types.number({ minimum: 0, required: true }),
        title: types.string({ required: true }),
      }),
    );
    papr.initialize(db);
    await papr.updateSchemas();
    const inserted = await model.insertOne({ likes: 0, title: 'Valid' });
    await expect(
      db.collection('validated').insertOne({ likes: 0, title: 123 }),
    ).rejects.toMatchObject({ code: 121 });
    await expect(
      db.collection('validated').updateOne({ _id: inserted._id }, { $set: { likes: -1 } }),
    ).rejects.toMatchObject({ code: 121 });
    await db.collection('validated').updateOne({ _id: inserted._id }, { $inc: { likes: 1 } });
    expect((await model.findOne({ _id: inserted._id }))?.likes).toBe(1);
  });
});
