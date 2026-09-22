# Plan: native MongoDB support for fate

This records the native-driver plan and its implementation on `with-mongodb`, replacing the discarded Prisma 8 upgrade.

## Direction and placement

Use the official `mongodb` Node.js driver. Prisma 8 compatibility is no longer a prerequisite or deliverable for this work.

Implement the adapter inside the existing `@nkzw/fate` package:

```text
packages/fate/
  package.json                    # export, build entry, optional peer dependency
  src/server/
    mongodb.ts                    # public adapter entry point
    __tests__/                    # adapter behavior tests
```

Public import:

```ts
import { createMongoDBSourceAdapter } from '@nkzw/fate/server/mongodb';
```

`packages/fate/src/server/mongodb.ts` is its source location; `@nkzw/fate/server/mongodb` is its consumer-facing import. They are not competing packaging choices. This follows the existing `server/prisma` and `server/drizzle` organization, verified in the downloaded repository and `lmauromb/fate` fork.

The official driver stays the separately installed `mongodb` package. Declare it as an optional peer of fate, plus a development dependency for adapter builds/tests. Consumers using this adapter must install a supported driver version. Add the subpath's ESM/type/source exports and build entry. Keep MongoDB imports out of client entry points and avoid eagerly importing it from general server exports. Verify ordinary fate imports still work without the optional driver installed.

A separate `packages/fate-mongodb` workspace would make sense if independent publishing/versioning is wanted later; it would normally expose a separate package such as `@nkzw/fate-mongodb`. It is unnecessary for the initial integration.

## Architecture

Use fate's existing data views, source planner, source registry, and result resolver. The adapter implements `byId`, `byIds`, and `connection` execution, including selected relations and computed dependencies. The source runtime remains shared with Prisma and Drizzle.

Applications own the `MongoClient` connection, database selection, authentication, and session lifetime. The adapter accepts application-provided collections/context rather than opening a client per request. Configure collection mappings, references, and IDs explicitly: the native driver has no ORM relation metadata to infer them from.

Native fate protocol and tRPC can consume this source adapter. GraphQL is a separate schema/resolver integration using Pothos and DataLoader; adding the database adapter alone does not automatically replace the existing Prisma-specific GraphQL code. Share MongoDB data-access helpers where useful without making Pothos a dependency of the base adapter.

## Implemented scope

- Native source adapter with selected-field projections, hidden dependencies, references, embedded documents, counts and bounded connections.
- Application-owned connections, native ObjectId/string ID support and transaction session propagation.
- Papr typed schemas, collection validation, indexes and an explicit setup/seed command.
- Standalone example with native fate, tRPC and Pothos/DataLoader GraphQL, including mutations and live subscriptions.
- MongoDB durable mutation receipts for native offline replay, committed atomically with application effects.
- Adapter documentation, repository-distributed `fate-mongodb` skill, replica-set test setup and CI.

The example is a focused posts/users/comments integration, not a port of the existing PostgreSQL demo UI/domain model. Its context callback is the authentication boundary; a development token demonstrates mutation authorization. Applications can supply Better Auth's native MongoDB adapter. The original plan's full login UI/domain port and data migration are outside this adapter change.

GraphQL requires real resolver code as well as agent guidance. The example supplies that code, including input-key ordering, request-local caches, per-parent pagination and mutation cache invalidation. Client framework features continue to use fate's existing normalized records and transport contracts.

See `docs/integrations/mongodb.md` for contracts and explicit boundaries, including embedded entity refetch, custom sorting, Papr deployment and live delivery. See `example/server-mongodb/README.md` for executable setup/test instructions.

## Verification

Run the database suites with `FATE_MONGODB_URL` pointing to an isolated MongoDB replica set, then the root `AGENTS.md` checks: `vp check --fix` and `vp run test:all`. The dedicated MongoDB workflow enables real database tests, which are otherwise opt-in.

## References

- [fate server integration](https://fate.technology/integrations/server)
- [MongoDB driver](https://www.mongodb.com/docs/drivers/node/current/)
- [Papr](https://github.com/plexinc/papr)
- [Pothos DataLoader](https://pothos-graphql.dev/docs/plugins/dataloader)
- [Better Auth MongoDB adapter](https://better-auth.com/docs/adapters/mongo)
