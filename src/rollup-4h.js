// Summarizes completed 4-hour UTC windows into a separate, regular collection.
// Default: the last two completed windows. --backfill: all complete windows still
// within retention. Existing summaries are never changed.
import { MongoClient } from 'mongodb';
import { MONGO_URI, DB_NAME, COLLECTION } from './lib/env.js';
import { RETENTION_GROUPS, companyIdsFor } from './lib/config.js';

const TARGET = 'metrics_rollup_4h';
const WINDOW_MS = 4 * 3600 * 1000;
const BACKFILL = process.argv.includes('--backfill');

function floorWindow(date) {
  return new Date(Math.floor(date.getTime() / WINDOW_MS) * WINDOW_MS);
}

function ceilWindow(date) {
  return new Date(Math.ceil(date.getTime() / WINDOW_MS) * WINDOW_MS);
}

async function main() {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const info = await db.listCollections({ name: COLLECTION }).next();
    if (info?.type !== 'timeseries') {
      throw new Error(`${DB_NAME}.${COLLECTION} is not a time-series collection`);
    }

    const raw = db.collection(COLLECTION);
    const rollups = db.collection(TARGET);
    await rollups.createIndex(
      { companyId: 1, windowStart: 1 },
      { unique: true, name: 'companyId_1_windowStart_1' }
    );

    const now = new Date();
    const completedThrough = floorWindow(now);
    let windowsFound = 0;
    let inserted = 0;

    for (const hours of RETENTION_GROUPS) {
      const ids = companyIdsFor(hours);
      const retentionSafeStart = ceilWindow(new Date(now.getTime() - hours * 3600 * 1000));
      const recentStart = new Date(completedThrough.getTime() - 2 * WINDOW_MS);
      const start = BACKFILL || retentionSafeStart > recentStart ? retentionSafeStart : recentStart;
      if (start >= completedThrough) continue;

      const cursor = raw.aggregate([
        {
          $match: {
            retentionDemo: true,
            companyId: { $in: ids },
            ts: { $gte: start, $lt: completedThrough },
          },
        },
        {
          $group: {
            _id: {
              companyId: '$companyId',
              windowStart: {
                $dateTrunc: { date: '$ts', unit: 'hour', binSize: 4, timezone: 'UTC' },
              },
            },
            count: { $sum: 1 },
            temperatureSum: { $sum: '$temperature' },
            temperatureMin: { $min: '$temperature' },
            temperatureMax: { $max: '$temperature' },
            humiditySum: { $sum: '$humidity' },
            humidityMin: { $min: '$humidity' },
            humidityMax: { $max: '$humidity' },
            firstTs: { $min: '$ts' },
            lastTs: { $max: '$ts' },
          },
        },
      ], { allowDiskUse: true, maxTimeMS: 300000 });

      const operations = [];
      for await (const row of cursor) {
        windowsFound += 1;
        const { companyId, windowStart } = row._id;
        const windowEnd = new Date(windowStart.getTime() + WINDOW_MS);
        operations.push({
          updateOne: {
            filter: { companyId, windowStart },
            update: {
              $setOnInsert: {
                companyId,
                windowStart,
                windowEnd,
                windowHours: 4,
                count: row.count,
                temperature: {
                  min: row.temperatureMin,
                  max: row.temperatureMax,
                  avg: row.temperatureSum / row.count,
                },
                humidity: {
                  min: row.humidityMin,
                  max: row.humidityMax,
                  avg: row.humiditySum / row.count,
                },
                firstTs: row.firstTs,
                lastTs: row.lastTs,
                sourceCollection: COLLECTION,
                createdAt: now,
              },
            },
            upsert: true,
          },
        });
      }
      for (let offset = 0; offset < operations.length; offset += 1000) {
        const result = await rollups.bulkWrite(operations.slice(offset, offset + 1000),
          { ordered: false });
        inserted += result.upsertedCount;
      }
      console.log(JSON.stringify({ retentionHours: hours, start, completedThrough,
        windowsFound: operations.length, insertedSoFar: inserted }));
    }
    console.log(JSON.stringify({ status: 'OK', mode: BACKFILL ? 'backfill' : 'recent',
      windowsFound, inserted, completedThrough, checkedAt: now }));
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'ERROR', message: error.message }));
  process.exitCode = 1;
});
