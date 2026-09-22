# MongoDB example

A standalone server using the MongoDB Node.js driver, Papr collection validators, and fate data views. It exposes native fate at `/fate`, tRPC at `/trpc`, and Pothos + DataLoader GraphQL at `/graphql`. Native and GraphQL SSE endpoints support fate live views.

From the repository root:

```sh
vp install
vp run --filter @nkzw/fate build
cd example/server-mongodb
cp .env.example .env
docker compose up -d --wait
docker compose exec mongodb mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
docker compose exec mongodb mongosh --quiet --eval 'for(let n=0;n<60;n++){if(db.hello().isWritablePrimary)quit(0);sleep(1000)}quit(1)'
vp run db:setup
vp run dev
```

Initialize the replica set once per volume. MongoDB Atlas also works: replace `MONGODB_URL` and choose `MONGODB_DATABASE`. Papr validators and indexes are installed by `db:setup`, not on every server boot. Run that command with collection administration privileges; the application can use a separate, less privileged credential.

Open `http://localhost:9030/graphql` and query:

```graphql
{
  posts(first: 10) {
    edges {
      node {
        id
        title
        likes
        author {
          name
        }
        comments(first: 2) {
          edges {
            node {
              text
            }
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

Reads are public in this small example. Set `API_TOKEN` in `.env` and send `Authorization: Bearer <token>` to enable `post.like` / `likePost`. Replace the `createApp` context callback with your application's authenticated identity and authorization policy. This is a database integration example, not a port of the existing PostgreSQL demo's login UI or domain schema.

The native `post.like` endpoint supports fate's persisted mutations using the `demo-writer` scope. Receipts and writes commit in one MongoDB transaction. Real applications must derive the scope from authenticated identity, propagate the provided session to every write/read, and publish live events after commit. GraphQL and tRPC mutations follow their transports' normal semantics.

Use the same `MongoClient` pool for your application. `models.ts` defines Papr schemas and native indexes; `api.ts` defines source relations and atomic mutations; `graphql.ts` implements request-local batching, Node IDs, connections and cache invalidation; `live.ts` implements fate's GraphQL subscription fields. `app.ts` mounts all three transports.

To run database tests from the repository root:

```sh
FATE_MONGODB_URL='mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true' \
  vp test packages/fate/src/server/__tests__/mongodb.test.ts example/server-mongodb/src/__tests__/app.test.ts
```

Tests create and drop randomly named databases. The URL must point at a development/test instance. Without the variable, database tests are skipped; the dedicated GitHub workflow starts a replica set and runs them.

See [adapter documentation](../../docs/integrations/mongodb.md) and the [fate-mongodb skill](../../.agents/skills/fate-mongodb/SKILL.md) for application setup and conventions.
