import { resolveConnection, type ConnectionResult } from '@nkzw/fate/server';
import SchemaBuilder from '@pothos/core';
import DataloaderPlugin from '@pothos/plugin-dataloader';
import RelayPlugin from '@pothos/plugin-relay';
import DataLoader from 'dataloader';
import { valueFromASTUntyped } from 'graphql';
import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { type Context, type createAPI, postView } from './api.ts';
import { registerLive } from './live.ts';
import type { CommentDocument, PostDocument, UserDocument } from './models.ts';

export type PothosTypes = {
  Context: GraphQLContext;
  Scalars: { JSON: { Input: unknown; Output: unknown } };
};
type API = ReturnType<typeof createAPI>;
type GraphQLContext = Context & {
  commentPages: Map<string, DataLoader<string, ConnectionResult<{ id: string }>>>;
};
type PageArgs = {
  after?: string | null;
  before?: string | null;
  first?: number | null;
  last?: number | null;
};
const pageArgs = (args: PageArgs) =>
  Object.fromEntries(Object.entries(args).filter(([, value]) => value != null));
const relayPage = (page: ConnectionResult<{ id: string }>) => ({
  edges: page.items.map(({ cursor, node }) => ({ cursor, node: node.id })),
  pageInfo: {
    endCursor: page.pagination.nextCursor ?? null,
    hasNextPage: page.pagination.hasNext,
    hasPreviousPage: page.pagination.hasPrevious,
    startCursor: page.items[0]?.cursor ?? null,
  },
});

export const createGraphQLContext = (ctx: Context): GraphQLContext => ({
  ...ctx,
  commentPages: new Map(),
});

export function createSchema(db: Db, api: API) {
  type Options = ConstructorParameters<typeof SchemaBuilder<PothosTypes>>[0];
  // Other examples globally augment Pothos with required Prisma/scope-auth options.
  // Validate the options for our installed plugins, then exclude that monorepo-only requirement.
  const options: Pick<Options, 'plugins' | 'relay'> = {
    plugins: [DataloaderPlugin, RelayPlugin],
    relay: {
      cursorType: 'String',
      decodeGlobalID: (value) => {
        const separator = value.indexOf('-');
        if (separator < 1) {
          throw new Error('Invalid node ID');
        }
        return { id: value.slice(separator + 1), typename: value.slice(0, separator) };
      },
      encodeGlobalID: (type, id) => `${type}-${id}`,
    },
  };
  const builder = new SchemaBuilder<PothosTypes>(options as Options);
  const User = builder.loadableNode('User', {
    fields: (t) => ({ name: t.exposeString('name') }),
    id: { resolve: (user) => user._id.toHexString() },
    load: (ids: Array<string>) =>
      db
        .collection<UserDocument>('users')
        .find(
          { _id: { $in: ids.map((id) => new ObjectId(id)) } },
          { projection: { _id: 1, name: 1 } },
        )
        .toArray(),
    sort: (user) => user._id.toHexString(),
  });
  const Comment = builder.loadableNode('Comment', {
    fields: (t) => ({
      author: t.field({ resolve: (comment) => comment.authorId.toHexString(), type: User }),
      text: t.exposeString('text'),
    }),
    id: { resolve: (comment) => comment._id.toHexString() },
    load: (ids: Array<string>) =>
      db
        .collection<CommentDocument>('comments')
        .find(
          { _id: { $in: ids.map((id) => new ObjectId(id)) } },
          { projection: { _id: 1, authorId: 1, text: 1 } },
        )
        .toArray(),
    sort: (comment) => comment._id.toHexString(),
  });
  const Post = builder.loadableNode('Post', {
    fields: (t) => ({
      author: t.field({ resolve: (post) => post.authorId.toHexString(), type: User }),
      comments: t.connection({
        resolve: async (post, args, ctx) => {
          const scoped = pageArgs(args);
          const key = JSON.stringify(scoped);
          let loader = ctx.commentPages.get(key);
          if (!loader) {
            loader = new DataLoader(async (ids: ReadonlyArray<string>) => {
              const posts = await api.fate.resolveByIds({
                ctx,
                ids: [...ids],
                input: {
                  args: { comments: Object.keys(scoped).length ? scoped : { first: 20 } },
                  select: ['comments.id'],
                },
                view: postView,
              });
              const byId = new Map(posts.map((row) => [String(row.id), row.comments]));
              return ids.map((id) => byId.get(id) as ConnectionResult<{ id: string }>);
            });
            ctx.commentPages.set(key, loader);
          }
          return relayPage(await loader.load(post._id.toHexString()));
        },
        type: Comment,
      }),
      likes: t.exposeInt('likes'),
      title: t.exposeString('title'),
    }),
    id: { resolve: (post) => post._id.toHexString() },
    load: (ids: Array<string>) =>
      db
        .collection<PostDocument>('posts')
        .find(
          { _id: { $in: ids.map((id) => new ObjectId(id)) } },
          { projection: { _id: 1, authorId: 1, likes: 1, title: 1 } },
        )
        .toArray(),
    sort: (post) => post._id.toHexString(),
  });
  builder.queryType({
    fields: (t) => ({
      posts: t.connection({
        resolve: async (_, args, ctx) =>
          relayPage(
            await resolveConnection({
              ctx,
              input: { args: pageArgs(args), select: ['id'] },
              query: (options) =>
                api.fate.resolveConnection({ ...options, view: postView }) as Promise<
                  Array<{ id: string }>
                >,
            }),
          ),
        type: Post,
      }),
    }),
  });
  builder.mutationType({
    fields: (t) => ({
      likePost: t.field({
        args: { id: t.arg.globalID({ for: Post, required: true }) },
        resolve: async (_, { id }, ctx) => {
          await api.like(ctx, { id: id.id });
          Post.getDataloader(ctx).clear(id.id);
          return id.id;
        },
        type: Post,
      }),
    }),
  });
  builder.scalarType('JSON', {
    parseLiteral: (node) => valueFromASTUntyped(node),
    parseValue: (value) => value,
    serialize: (value) => value,
  });
  registerLive(builder, api);
  return builder.toSchema();
}
