---
name: fate-mongodb
description: Build fate applications using the native MongoDB driver and Papr validation, including native HTTP, tRPC, and Pothos/DataLoader GraphQL integrations.
---

Use the existing `@nkzw/fate/server/mongodb` adapter. Read [the adapter guide](https://github.com/lmauromb/fate/blob/with-mongodb/docs/integrations/mongodb.md) for configuration and [the runnable example](https://github.com/lmauromb/fate/blob/with-mongodb/example/server-mongodb/README.md) for setup. Do not generate a second source executor or introduce Prisma to access MongoDB.

Keep `MongoClient` application-owned and reuse its pool. Store BSON `_id` and reference ObjectIds; expose string `id` values through the adapter. Explicitly configure string IDs when required by an existing database. Default to descending `_id` feed pagination. ObjectId timestamps give approximate chronology, not exact business timestamps.

Define Papr schemas and infer document types from them. Install validators with an explicit setup/deployment command. Native driver writes obey collection validation but do not run Papr defaults, timestamps or hooks. Handle unique indexes, reference integrity, cascades and backfills explicitly.

Register every view's collection and relation metadata. Prefer embedding for bounded owned data; use references for entities needing independent by-ID fetching, live subscriptions or large growing relationships. Embedded IDs must be stable. Apply authorization/tenant filters separately to each source; build filters from validated arguments rather than forwarding user operators. Use native MongoDB count filters and scalar sort fields.

Choose the requested transport:

- Native fate/tRPC: start with [api.ts](https://github.com/lmauromb/fate/blob/with-mongodb/example/server-mongodb/src/api.ts). Reuse the source adapter and resolve selected mutation responses through it. Keep writes atomic with MongoDB operators or transactions.
- GraphQL: start with [graphql.ts](https://github.com/lmauromb/fate/blob/with-mongodb/example/server-mongodb/src/graphql.ts) and [live.ts](https://github.com/lmauromb/fate/blob/with-mongodb/example/server-mongodb/src/live.ts). Implement Pothos types and Relay connections explicitly. DataLoader is request-local, matches results to input IDs, separates relation pagination arguments, and clears affected entries after mutations. Apply the same authorization policy to loader reads as source reads. The example's reads are public.
- Persisted native mutations: use `createMongoDBIdempotencyStore` with a server-derived authenticated scope. Propagate its session to every mutation read/write. Never expire receipts. Emit events after commit because transaction callbacks can retry.

Replace the example token gate with the application's authentication. For Better Auth, use its MongoDB adapter with the shared client and align its ID strategy/collection names; do not reuse the example's minimal Papr user schema for all auth/plugin fields without adapting it.

Verify changed behavior against a real test MongoDB replica set: selected-field masking, authorization, missing references, paging in both directions, per-parent limits, atomic writes, and validation failures. For GraphQL, exercise fate's transport and check loader batching/argument isolation. For persistence, test concurrent replay and rollback. `FATE_MONGODB_URL` enables the repository's MongoDB suites; they create/drop randomly named test databases. Follow the repository's normal build/check requirements too.

When working inside the fork, read the corresponding local files under `docs/integrations/` and `example/server-mongodb/` first. Otherwise use the linked sources.
