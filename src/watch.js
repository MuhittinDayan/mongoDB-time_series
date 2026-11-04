// Temporary demo script: periodically prints raw documents as a table.
import { MongoClient } from 'mongodb';
import { MONGO_URI, DB_NAME, COLLECTION } from './lib/env.js';

const REFRESH_MS = 4000;

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const collection = client.db(DB_NAME).collection(COLLECTION);

  const tick = async () => {
    const now = new Date();
    const docs = await collection.find({ retentionDemo: true, companyId: 1 }).sort({ ts: -1 }).limit(20).toArray();

    console.log(`\n===== ${now.toLocaleTimeString()} | company 1, latest ${docs.length} records =====`);
    if (docs.length === 0) {
      console.log('(collection is empty)');
    } else {
      console.table(
        docs.map((d) => ({
          companyId: d.companyId,
          ts: d.ts.toLocaleTimeString(),
          remainingSec: d.expireAt ? Math.max(0, (d.expireAt.getTime() - now.getTime()) / 1000).toFixed(1) : '-',
          temperature: d.temperature,
          humidity: d.humidity,
        }))
      );
    }
  };

  await tick();
  const timer = setInterval(() => tick().catch((e) => console.error(e.message)), REFRESH_MS);

  process.on('SIGINT', () => {
    clearInterval(timer);
    client.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
