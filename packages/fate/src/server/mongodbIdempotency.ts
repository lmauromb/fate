import type { ClientSession, Db, MongoClient } from 'mongodb';
import type { IdempotencyStore, MutationReceipt } from '../idempotency.ts';
import { isRecord } from '../record.ts';

type ReceiptDocument = {
  _id: string;
  receipt?: MutationReceipt;
  version: number;
};

/** Durable receipts and application writes share a replica-set transaction. Never TTL receipts. */
export function createMongoDBIdempotencyStore<Context>({
  client,
  collection = 'fateMutationReceipts',
  db,
  withSession,
}: {
  client: MongoClient;
  collection?: string;
  db: Db;
  withSession: (ctx: Context, session: ClientSession) => Context;
}): IdempotencyStore<Context> {
  const receipts = db.collection<ReceiptDocument>(collection);
  return {
    async transaction(ctx, scope, id, run) {
      const key = JSON.stringify([scope, id]);
      // Create a persistent lock row before the transaction. Concurrent transactions update
      // this same row first; MongoDB retries write conflicts using a fresh snapshot.
      try {
        await receipts.updateOne({ _id: key }, { $setOnInsert: { version: 0 } }, { upsert: true });
      } catch (error) {
        if (!isRecord(error) || error.code !== 11_000) {
          throw error;
        }
        if (!(await receipts.findOne({ _id: key }))) {
          throw error;
        }
      }
      const session = client.startSession();
      try {
        return await session.withTransaction(
          async () => {
            const row = await receipts.findOneAndUpdate(
              { _id: key },
              { $inc: { version: 1 } },
              { returnDocument: 'after', session },
            );
            if (!row) {
              throw new Error('MongoDB mutation receipt lock disappeared.');
            }
            return run({
              context: withSession(ctx, session),
              read: async () => row.receipt,
              write: async (receipt) => {
                await receipts.updateOne({ _id: key }, { $set: { receipt } }, { session });
              },
            });
          },
          { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
        );
      } finally {
        await session.endSession();
      }
    },
  };
}
