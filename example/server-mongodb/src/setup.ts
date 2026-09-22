import { MongoClient } from 'mongodb';
import { setupDatabase } from './models.ts';

const client = await new MongoClient(
  process.env.MONGODB_URL ?? 'mongodb://127.0.0.1:27017',
).connect();
try {
  const models = await setupDatabase(client.db(process.env.MONGODB_DATABASE ?? 'fate'));
  if (!(await models.users.findOne({}))) {
    const user = await models.users.insertOne({ name: 'Ada' });
    const post = await models.posts.insertOne({
      authorId: user._id,
      likes: 0,
      title: 'MongoDB with fate',
    });
    await models.comments.insertOne({
      authorId: user._id,
      postId: post._id,
      text: 'Native driver, validated documents.',
    });
  }
} finally {
  await client.close();
}
