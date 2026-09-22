import { createMutationIdempotency } from '@nkzw/fate/persistence/server';
import {
  createFateServer,
  createLiveEventBus,
  dataView,
  list,
  FateRequestError,
  isRecord,
} from '@nkzw/fate/server';
import { createMongoDBFate, createMongoDBIdempotencyStore } from '@nkzw/fate/server/mongodb';
import { initTRPC, TRPCError } from '@trpc/server';
import type { ClientSession, Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { createModels } from './models.ts';

export type Context = { canWrite: boolean; session?: ClientSession };
export const userView = dataView('User')({ id: true, name: true });
export const commentView = dataView('Comment')({ author: userView, id: true, text: true });
export const postView = dataView('Post')({
  author: userView,
  comments: list(commentView),
  id: true,
  likes: true,
  title: true,
});
export const likeInput = z.object({ id: z.string().regex(/^[a-f\d]{24}$/i) });

export function createAPI(db: Db, context: (request: Request) => Context | Promise<Context>) {
  const models = createModels(db);
  const t = initTRPC.context<Context>().create();
  const live = createLiveEventBus();
  const fate = createMongoDBFate<Context, typeof t.procedure>({
    db,
    options: ({ session }) => ({ session }),
    procedure: t.procedure,
    views: [
      { collection: 'users', view: userView },
      {
        collection: 'comments',
        relations: { author: { foreignKey: 'id', localKey: 'authorId' } },
        view: commentView,
      },
      {
        collection: 'posts',
        relations: {
          author: { foreignKey: 'id', localKey: 'authorId' },
          comments: { foreignKey: 'postId', localKey: 'id' },
        },
        view: postView,
      },
    ],
  });
  const like = async (ctx: Context, input: z.infer<typeof likeInput>) => {
    if (!ctx.canWrite) {
      throw new TRPCError({ code: 'UNAUTHORIZED' });
    }
    const { id } = likeInput.parse(input);
    // $inc is atomic; Papr's MongoDB validator also covers this native-driver write.
    const post = await db
      .collection('posts')
      .findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $inc: { likes: 1 } },
        { returnDocument: 'after', session: ctx.session },
      );
    if (!post) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
    if (!ctx.session) {
      live.emit('Post', id, { changed: ['likes'] });
    }
    return post;
  };
  const idempotency = createMutationIdempotency({
    scope: (ctx: Context) => (ctx.canWrite ? 'demo-writer' : ''),
    store: createMongoDBIdempotencyStore<Context>({
      client: db.client,
      db,
      withSession: (ctx, session) => ({ ...ctx, session }),
    }),
  });
  const server = createFateServer<Context>({
    context: ({ request }) => context(request),
    idempotency: {
      execute: async (operation) => {
        const result = await idempotency.execute(operation);
        // Publish only after commit. Replaying a receipt can safely trigger a refetch.
        live.emit('Post', likeInput.parse(operation.input).id, { changed: ['likes'] });
        return result;
      },
    },
    live,
    mutations: {
      'post.like': {
        input: likeInput,
        resolve: async ({
          ctx,
          input,
          select,
        }: {
          ctx: Context;
          input: z.infer<typeof likeInput>;
          select: Array<string>;
        }) => {
          try {
            await like(ctx, input);
          } catch (error) {
            if (isRecord(error) && (error.code === 'UNAUTHORIZED' || error.code === 'NOT_FOUND')) {
              throw new FateRequestError(
                error.code,
                error.code === 'UNAUTHORIZED' ? 'Authentication required.' : 'Post not found.',
              );
            }
            throw error;
          }
          return fate.resolveById({ ctx, id: input.id, input: { select }, view: postView });
        },
        type: 'Post',
      },
    },
    roots: { posts: list(postView) },
    sources: fate,
  });
  const router = t.router({
    comment: t.router(fate.procedures(commentView)),
    post: t.router({
      ...fate.procedures(postView),
      like: t.procedure.input(likeInput).mutation(async ({ ctx, input }) => {
        await like(ctx, input);
        return fate.resolveById({
          ctx,
          id: input.id,
          input: { select: ['likes'] },
          view: postView,
        });
      }),
    }),
    user: t.router(fate.procedures(userView)),
  });
  return { fate, like, live, models, router, server };
}
