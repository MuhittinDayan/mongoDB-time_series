// Verifies that the 12-hour partial TTL works, using a single backdated record.
import { MongoClient } from 'mongodb';
import { MONGO_URI, DB_NAME, COLLECTION } from './lib/env.js';

const WAIT_MS = 60_000;
const DEADLINE_MS = 7 * 60_000;

async function main() {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const collection = client.db(DB_NAME).collection(COLLECTION);
    const ttlIndex = (await collection.indexes()).find((i) =>
      i.name === 'ttl_12h' && i.key.ts === 1 && i.expireAfterSeconds === 12 * 3600);
    if (!ttlIndex) throw new Error('The 12-hour partial TTL index is missing; run npm run setup first.');

    const now = new Date();
    // The timestamp is old enough to also exceed the 1-hour maximum bucket span.
    const ts = new Date(now.getTime() - (13 * 3600 + 5 * 60) * 1000);
    const expireAt = new Date(ts.getTime() + 12 * 3600 * 1000);
    const { insertedId } = await collection.insertOne({
      retentionProbe: true,
      companyId: 1,
      ts,
      expireAt,
    });
    console.log(`Probe written: ${DB_NAME}.${COLLECTION} _id=${insertedId}`);
    console.log(`12-hour threshold: ${expireAt.toISOString()}. Bucket TTL deletion may be delayed.`);

    const deadline = Date.now() + DEADLINE_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
      const stillExists = await collection.findOne(
        { companyId: 1, ts, _id: insertedId }, { projection: { _id: 1 } });
      console.log(`${new Date().toISOString()}: ${stillExists ? 'record still exists' : 'record deleted'}`);
      if (!stillExists) {
        // The record is written already past its threshold, so "early deletion" cannot be measured here.
        console.log('TTL deletion verified in the same collection.');
        return;
      }
    }
    throw new Error('Not deleted within 7 minutes; check the TTL monitor and index state.');
  } finally {
    await client.close();
  }
}

main().catch((err) => { console.error('probe.js error:', err); process.exitCode = 1; });
