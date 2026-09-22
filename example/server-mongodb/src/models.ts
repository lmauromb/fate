import type { Db } from 'mongodb';
import Papr, { schema, types } from 'papr';

const userSchema = schema({ name: types.string({ required: true }) });
const postSchema = schema({
  authorId: types.objectId({ required: true }),
  likes: types.number({ minimum: 0, required: true }),
  title: types.string({ minLength: 1, required: true }),
});
const commentSchema = schema({
  authorId: types.objectId({ required: true }),
  postId: types.objectId({ required: true }),
  text: types.string({ minLength: 1, required: true }),
});

export type UserDocument = (typeof userSchema)[0];
export type PostDocument = (typeof postSchema)[0];
export type CommentDocument = (typeof commentSchema)[0];

export function createModels(db: Db) {
  const papr = new Papr();
  const users = papr.model('users', userSchema);
  const posts = papr.model('posts', postSchema);
  const comments = papr.model('comments', commentSchema);
  papr.initialize(db);
  return { comments, papr, posts, users };
}

/** Run explicitly at deployment, using credentials allowed to create/collMod collections. */
export async function setupDatabase(db: Db) {
  const models = createModels(db);
  await models.papr.updateSchemas();
  await db.collection('posts').createIndex({ _id: -1, authorId: 1 });
  await db.collection('comments').createIndex({ _id: -1, postId: 1 });
  return models;
}
