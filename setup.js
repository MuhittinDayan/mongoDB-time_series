// Time-series koleksiyonunu ve farklı saklama sürelerinin TTL kurallarını kurar.
// Süreler config.js'teki şirket tablosundan türetilir.

import { MongoClient } from 'mongodb';
import { MONGO_URI, DB_NAME, COLLECTION } from './env.js';
import {
  COMPANIES,
  MAX_RETENTION_HOURS,
  PARTIAL_TTL_HOURS,
  retentionSecondsFor,
} from './config.js';
import { ensureTimeSeriesCollection, ensureRetentionIndexes } from './retention.js';

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log('MongoDB bağlantısı kuruldu.');

  try {
    const db = client.db(DB_NAME);
    await ensureTimeSeriesCollection(db, COLLECTION);
    const created = await ensureRetentionIndexes(db.collection(COLLECTION));

    console.log(`Koleksiyon: ${DB_NAME}.${COLLECTION} (time-series, genel TTL ${MAX_RETENTION_HOURS} saat)`);
    console.log(`Partial TTL: ${PARTIAL_TTL_HOURS.join(', ')} saat; companyId metaField filtresi.`);
    console.log(created.length ? `Yeni kurulan indeksler: ${created.join(', ')}` : 'TTL indeksleri zaten güncel.');

    console.log('\nŞirket tablosu:');
    console.table(
      COMPANIES.map((c) => ({
        id: c.id,
        retentionHours: c.retentionHours,
        intervalSec: c.intervalSec,
        retentionSeconds: retentionSecondsFor(c.id),
      }))
    );
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('setup.js hata:', err.message);
  process.exit(1);
});
