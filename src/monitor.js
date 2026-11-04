// Takes a per-company TTL and disk snapshot once a minute.

import { appendFile, stat } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { MONGO_URI, DB_NAME, COLLECTION } from './lib/env.js';
import { COMPANIES, retentionSecondsFor } from './lib/config.js';
import { OBSERVATIONS_CSV } from './lib/paths.js';

const REFRESH_MS = 60000;
const peakByCompany = new Map(COMPANIES.map((c) => [c.id, 0]));

function formatAge(seconds) {
  if (seconds == null) return '-';
  return `${seconds.toFixed(1)}s`;
}

async function tick(db, collection) {
  const now = new Date();
  const stats = await collection
    .aggregate([
      { $match: { retentionDemo: true } },
      {
        $group: {
          _id: '$companyId',
          count: { $sum: 1 },
          oldest: { $min: '$ts' },
          newest: { $max: '$ts' },
          expired: { $sum: { $cond: [{ $lte: ['$expireAt', now] }, 1, 0] } },
        },
      },
    ])
    .toArray();

  const statsById = new Map(stats.map((s) => [s._id, s]));
  const [{ storageStats: disk }] = await collection.aggregate([
    { $collStats: { storageStats: { scale: 1 } } },
  ]).toArray();
  let fsUsed = '';
  let fsTotal = '';
  try {
    const dbDisk = await db.command({ dbStats: 1, scale: 1 });
    fsUsed = dbDisk.fsUsedSize ?? '';
    fsTotal = dbDisk.fsTotalSize ?? '';
  } catch { /* Without permission, collection metrics still continue. */ }
  let ttlDeleted = '';
  try { ttlDeleted = String((await db.admin().serverStatus()).metrics.ttl.deletedDocuments); }
  catch { /* Without permission, the other metrics still continue. */ }

  console.log(`Retention Monitor — ${now.toISOString()} (refreshes every ${REFRESH_MS / 1000}s)`);

  const rows = COMPANIES.map((company) => {
    const s = statsById.get(company.id);
    const count = s ? s.count : 0;
    const prevPeak = peakByCompany.get(company.id);
    const peak = Math.max(prevPeak, count);
    peakByCompany.set(company.id, peak);

    let status;
    if (count === 0) status = 'no data';
    else if (count < peak) status = 'DELETION STARTED';
    else status = 'accumulating';

    const oldestAgeSec = s ? (now.getTime() - s.oldest.getTime()) / 1000 : null;

    return {
      company: company.id,
      retentionHours: retentionSecondsFor(company.id) / 3600,
      count,
      peak,
      oldestAge: formatAge(oldestAgeSec),
      expired: s?.expired ?? 0,
      status,
    };
  });

  console.table(rows);
  console.log(`Disk: time-series bucket data=${disk.size} B, allocated data=${disk.storageSize} B, ` +
    `reusable=${disk.freeStorageSize ?? 0} B, ` +
    `index=${disk.totalIndexSize} B, total allocated=${disk.totalSize} B`);
  console.log(`File system: used=${fsUsed || '-'} B, capacity=${fsTotal || '-'} B`);
  const lines = rows.map((row) => [now.toISOString(), DB_NAME, COLLECTION, row.company,
    row.retentionHours, row.count, row.expired, row.oldestAge,
    disk.size, disk.storageSize, disk.freeStorageSize ?? 0,
    disk.totalIndexSize, disk.totalSize, fsUsed, fsTotal, ttlDeleted].join(','));
  await appendFile(OBSERVATIONS_CSV, `${lines.join('\n')}\n`);
}

async function main() {
  try { await stat(OBSERVATIONS_CSV); }
  catch { await appendFile(OBSERVATIONS_CSV, 'time,db,collection,company,retentionHours,count,expired,oldestAge,logicalBytes,storageBytes,reusableBytes,indexBytes,totalBytes,fsUsedBytes,fsTotalBytes,serverTtlDeleted\n'); }
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const collection = db.collection(COLLECTION);

  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try { await tick(db, collection); }
    catch (err) { console.error('monitor tick error:', err.message); }
    finally { busy = false; }
  };
  run();
  const timer = setInterval(run, REFRESH_MS);

  process.on('SIGINT', async () => {
    clearInterval(timer);
    await client.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('monitor.js error:', err);
  process.exit(1);
});
