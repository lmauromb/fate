# MongoDB

`@nkzw/fate/server/mongodb` integrates the native MongoDB Node.js driver with fate's source planner. It is part of `@nkzw/fate`; it does not require a separate fate package or Prisma. Install `mongodb@^7` alongside fate. The driver is an optional peer and is only loaded through this server subpath. The integration is tested with MongoDB 8.0 and Node 24.

## Sources and references

```ts
import { createFateServer, dataView, list } from '@nkzw/fate/server';
import { createMongoDBSourceAdapter } from '@nkzw/fate/server/mongodb';
import { MongoClient } from 'mongodb';

const client = await new MongoClient(process.env.MONGODB_URL!).connect();
const user = dataView('User')({ id: true, name: true });
const post = dataView('Post')({ author: user, id: true, title: true });

const sources = createMongoDBSourceAdapter({
  db: client.db('app'),
  views: [
    { collection: 'users', view: user },
    {
      collection: 'posts',
      relations: { author: { localKey: 'authorId', foreignKey: 'id' } },
      view: post,
    },
  ],
});

const server = createFateServer({ roots: { posts: list(post) }, sources });
```

Applications own the pool, database, authentication and lifecycle. `db` can also be `(ctx) => ctx.db`. `createMongoDBFate({ db, views, procedure })` additionally binds tRPC `byId` and list procedures, following the existing adapters' API. Pothos is separate from these source procedures.

Each view requires a collection mapping. Register related views as well. Relation keys are public field names; use `fields: { authorId: 'author_id' }` for storage aliases. By default `id` maps to `_id`. Example relation metadata:

| Storage                  | Relation configuration                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| One reference            | `{ localKey: 'authorId', foreignKey: 'id' }`                                                                         |
| Child references parent  | `{ localKey: 'id', foreignKey: 'postId' }`                                                                           |
| Array of references      | `{ localKey: 'tagIds', foreignKey: 'id' }`                                                                           |
| Explicit link collection | `{ localKey: 'id', foreignKey: 'id', through: { collection: 'postTags', localKey: 'postId', foreignKey: 'tagId' } }` |
| Embedded documents       | `{ embedded: 'addresses', localKey: 'id', foreignKey: 'id' }`                                                        |

The view determines whether a relation is singular or `list(view)`. `through` and `embedded` paths use storage names. Embedded relations read the current document's object/array; their key pair is ignored. Embedded entities need stable `_id` values for fate identity and pagination. Map their views to the parent collection, but query them through the parent: embedded entities are not independently fetchable collection documents. For standalone `byId`/live refetch, model an entity as a referenced document.

Missing singular references resolve to `null`. Many-to-many link duplicates are removed. Lookup pipelines apply per-parent sorting and page limits; omitted pagination defaults to 20 children. Add indexes for foreign reference keys and configured sorts. Direct references use MongoDB's indexed equality lookup; link pipelines and large embedded arrays need workload-specific query-plan review.

## IDs and pagination

Keep BSON `ObjectId` values in storage and foreign references. The adapter validates incoming 24-character hex IDs and normalizes outgoing BSON IDs to strings. `idType: 'string'` opts into collections with string `_id` values. `mongoDBRecord(document)` recursively converts ObjectIds, preserving dates; this utility does not rename `_id`. Prefer resolving mutation responses through the adapter to apply aliases and selected-field masking.

The default feed order is descending `_id`, with strict range boundaries and a lookahead row. A native MongoDB cursor is the driver's result iterator; fate's cursor is the page boundary sent to the client. They serve different purposes.

ObjectId order is deterministic and approximately chronological, not an exact creation timestamp across processes. No extra timestamp field is required for feed pagination. Store business timestamps separately when needed.

`orderBy` supports scalar fields with an ID tie-breaker. Add the corresponding compound index. For custom ordering, the cursor's document must still exist and satisfy the source filter so its sort values can be retrieved. An `_id`-only boundary works even after that record is deleted. Use consistently typed scalar sort fields; mixed BSON types and array sort fields are outside this cursor contract. Embedded cursor pagination supports ordering by the embedded ID.

## Selection and authorization

The adapter projects selected fields, fetches hidden computed/resolver dependencies, hydrates selected relations, and lets fate apply its view masking and field authorization. `computed({ select: { total: count('comments', { where: { visible: true } }) }, ... })` uses a native MongoDB filter. For a count-only relation, register its metadata with `view: commentView` even when the public post view omits `comments`.

Set server-owned filters on each source:

```ts
{
  collection: 'posts',
  view: post,
  where: ({ ctx, args }) => ({
    tenantId: ctx.tenantId,
    ...(args?.published === true ? { published: true } : {}),
  }),
}
```

These filters apply to root reads, nested references, counts and custom-order cursor lookups. Configure each collection's policy explicitly. `extra: { where }` adds a server filter using storage names and BSON values. Never pass raw client JSON as `where`, operators, sort keys or collection names. Resolver dependencies accept `field: true`, nested `select`, and root `_count.select`; use source callbacks for relation filtering. Prisma/SQL-specific dependency options are not translated.

## Papr validation

Install `papr@^17` in the application. Papr supplies inferred TypeScript document types and MongoDB `$jsonSchema` validation:

```ts
import Papr, { schema, types } from 'papr';

const papr = new Papr();
const posts = papr.model(
  'posts',
  schema({
    title: types.string({ required: true, minLength: 1 }),
    likes: types.number({ required: true, minimum: 0 }),
  }),
);
papr.initialize(db);
await papr.updateSchemas(); // explicit setup/deployment step
await posts.insertOne({ title: 'Hello', likes: 0 });
```

Once installed, validators reject invalid inserts and updates through the native driver too. Papr defaults, timestamps and hooks execute only when writing through Papr; native writes must provide those values themselves. Validate request inputs separately and use indexes for uniqueness. MongoDB does not add foreign keys or cascading deletes: implement reference integrity and cleanup in application code/transactions. Plan validator changes and data backfills explicitly; `updateSchemas()` does not migrate existing documents.

## Transactions, persistence and live views

Pass `options: (ctx) => ({ session: ctx.session, maxTimeMS: 5000 })` to the source adapter. Every query, lookup and cursor-anchor read uses those options. Use the same client's session for all writes. Transactions and change streams require a replica set or sharded deployment.

`createMongoDBIdempotencyStore({ client, db, withSession })` implements fate's durable mutation receipt store:

```ts
import { createMutationIdempotency } from '@nkzw/fate/persistence/server';
import { createMongoDBIdempotencyStore } from '@nkzw/fate/server/mongodb';

const idempotency = createMutationIdempotency({
  scope: (ctx) => ctx.authenticatedScope,
  store: createMongoDBIdempotencyStore({
    client,
    db,
    withSession: (ctx, session) => ({ ...ctx, session }),
  }),
});
```

Pass `idempotency` to `createFateServer`. Receipts and mutation writes commit together, with concurrent same-identity requests serialized across processes. Keep receipts indefinitely; do not add a TTL. Transaction callbacks may run more than once. Propagate the supplied context session, avoid parallel operations within a transaction, and publish live events or external side effects only after commit. The example demonstrates this wiring with the native persistence protocol.

Fate's optimistic cache updates, hydration and React/Vue clients operate on the resulting normalized records. Native and GraphQL live updates use fate's event bus; database changes are not observed automatically. Publish events from mutation handlers after successful writes. For writes outside the app, build a change-stream bridge with resume handling and authorization-aware refetches. Multi-process delivery needs a shared/durable bus; the example uses fate's in-memory bus.

## GraphQL and agent guidance

The [MongoDB example](https://github.com/lmauromb/fate/tree/with-mongodb/example/server-mongodb) contains working Pothos + DataLoader resolvers, Relay Node IDs and connections, mutations, and fate live subscription fields. Its tests use fate's GraphQL transport against the schema. Pothos does not infer a schema from MongoDB; define the application's GraphQL types and relations explicitly. Keep loaders request-local, preserve input-key order, partition relation loaders by arguments and clear affected cached records after writes.

Use the repository's `.agents/skills/fate-mongodb/SKILL.md` when building an application with this integration. The example's simple token authorization is replaceable with an authenticated context, including Better Auth's native MongoDB adapter; align auth collection names and schema validation separately from application models.

See [MongoDB's driver documentation](https://www.mongodb.com/docs/drivers/node/current/), [Papr](https://github.com/plexinc/papr), and [Pothos DataLoader](https://pothos-graphql.dev/docs/plugins/dataloader).
