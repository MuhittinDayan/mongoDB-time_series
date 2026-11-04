// Creates the time-series collection and the TTL rules for the retention periods.
// The periods are derived from the company table in config.js.

import { MongoClient } from 'mongodb';
import { MONGO_URI, DB_NAME, COLLECTION } from './lib/env.js';
import {
  COMPANIES,
  MAX_RETENTION_HOURS,
  PARTIAL_TTL_HOURS,
  retentionSecondsFor,
} from './lib/config.js';
import { ensureTimeSeriesCollection, ensureRetentionIndexes } from './lib/retention.js';

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log('Connected to MongoDB.');

  try {
    const db = client.db(DB_NAME);
    await ensureTimeSeriesCollection(db, COLLECTION);
    const created = await ensureRetentionIndexes(db.collection(COLLECTION));

    console.log(`Collection: ${DB_NAME}.${COLLECTION} (time-series, general TTL ${MAX_RETENTION_HOURS} hours)`);
    console.log(`Partial TTL: ${PARTIAL_TTL_HOURS.join(', ')} hours; filtered on the companyId metaField.`);
    console.log(created.length ? `Newly created indexes: ${created.join(', ')}` : 'TTL indexes are already up to date.');

    console.log('\nCompany table:');
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
  console.error('setup.js error:', err.message);
  process.exit(1);
});
