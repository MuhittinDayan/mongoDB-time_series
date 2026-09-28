// Durdurulmuş üreticinin verilerini yeni time-series koleksiyonuna taşır.
// Kaynağa dokunmaz; hedef doluysa ikinci kez çalışmayı reddeder.
import { MongoClient } from 'mongodb';
import { MONGO_URI, DB_NAME, COLLECTION } from './env.js';
import { COMPANIES } from './config.js';
import { ensureTimeSeriesCollection, ensureRetentionIndexes } from './retention.js';

const SOURCE = 'metrics';
const TARGET = COLLECTION;
const BATCH_SIZE = 2000;

async function main() {
  const client = new MongoClient(MONGO_URI, { maxPoolSize: 5 });
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const source = db.collection(SOURCE);
    const target = db.collection(TARGET);
    const sourceInfo = await db.listCollections({ name: SOURCE }).next();
    if (sourceInfo?.type !== 'collection') throw new Error(`${SOURCE} normal koleksiyon bulunamadı`);

    await ensureTimeSeriesCollection(db, TARGET);

    // Time-series'te estimatedDocumentCount ölçüm değil bucket sayar; tek kayıt yeterli.
    if (await target.findOne({}, { projection: { _id: 1 } })) {
      throw new Error(`${TARGET} dolu; tekrar aktarım çift kayda neden olur`);
    }

    await ensureRetentionIndexes(target);

    const startedAt = new Date();
    console.log(JSON.stringify({ event: 'start', startedAt, source: SOURCE, target: TARGET }));
    let totalCopied = 0;
    for (const company of COMPANIES) {
      const cursor = source.find({ retentionDemo: true, companyId: company.id, ts: { $type: 'date' } })
        .sort({ ts: 1 })
        .batchSize(BATCH_SIZE);
      let batch = [];
      let companyCopied = 0;
      try {
        for await (const doc of cursor) {
          batch.push(doc);
          if (batch.length >= BATCH_SIZE) {
            await target.insertMany(batch, { ordered: true });
            companyCopied += batch.length;
            batch = [];
          }
        }
        if (batch.length) {
          await target.insertMany(batch, { ordered: true });
          companyCopied += batch.length;
        }
      } finally {
        await cursor.close();
      }
      totalCopied += companyCopied;
      console.log(JSON.stringify({ event: 'company', companyId: company.id, copied: companyCopied, totalCopied }));
    }
    console.log(JSON.stringify({ event: 'complete', totalCopied, completedAt: new Date() }));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'error', message: error.message, stack: error.stack }));
  process.exitCode = 1;
});
