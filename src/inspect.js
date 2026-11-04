// Reports TTL settings, per-company age limits and collection disk usage.

import { MongoClient } from 'mongodb';
import { MONGO_URI, DB_NAME, COLLECTION } from './lib/env.js';
import { COMPANIES, TTL_GRACE_SECONDS, retentionSecondsFor } from './lib/config.js';

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const collection = db.collection(COLLECTION);
  const collectionInfo = await db.listCollections({ name: COLLECTION }).next();

  console.log(`Target: ${DB_NAME}.${COLLECTION}`);
  console.log(`Type: ${collectionInfo?.type ?? 'not found'}`);
  console.log(`General TTL: ${collectionInfo?.options?.expireAfterSeconds ?? '-'} seconds`);
  console.log('=== 1) Index list ===');
  const indexes = await collection.indexes();
  for (const idx of indexes) {
    const isTtl = Object.prototype.hasOwnProperty.call(idx, 'expireAfterSeconds');
    console.log(
      `  ${idx.name}  key=${JSON.stringify(idx.key)}` +
        (isTtl ? `  <-- partial TTL (expireAfterSeconds=${idx.expireAfterSeconds}, filter=${JSON.stringify(idx.partialFilterExpression)})` : '')
    );
  }

  console.log('\n=== 2) serverStatus().metrics.ttl ===');
  try {
    const ttl = (await db.admin().serverStatus()).metrics.ttl;
    console.log(`  passes: ${ttl.passes}`);
    console.log(`  deletedDocuments: ${ttl.deletedDocuments} (server-wide)`);
  } catch (err) {
    console.warn(`  Could not read the TTL counter: ${err.message}`);
  }

  console.log('\n=== 3) Per-company age check ===');
  console.log(`  TTL deletes buckets; expired records may normally stay visible for another ${TTL_GRACE_SECONDS} s. ` +
    'Only records past this allowance count as a PROBLEM.');
  const now = new Date();
  const ageRows = [];
  for (const company of COMPANIES) {
    const oldest = await collection
      .find({ retentionDemo: true, companyId: company.id })
      .sort({ ts: 1 })
      .limit(1)
      .toArray();

    // TTL works from ts, not expireAt, so the counts also use ts.
    const retentionSec = retentionSecondsFor(company.id);
    const expiredBefore = new Date(now.getTime() - retentionSec * 1000);
    const overdueBefore = new Date(expiredBefore.getTime() - TTL_GRACE_SECONDS * 1000);
    const expired = await collection.countDocuments({
      retentionDemo: true, companyId: company.id, ts: { $lte: expiredBefore },
    });
    const overdue = expired === 0 ? 0 : await collection.countDocuments({
      retentionDemo: true, companyId: company.id, ts: { $lte: overdueBefore },
    });
    if (oldest.length === 0) {
      ageRows.push({
        company: company.id,
        retentionSec,
        expired,
        overdue,
        oldestAgeSec: '-',
        overLimit: '-',
        status: 'no data',
      });
      continue;
    }

    const ageSec = (now.getTime() - oldest[0].ts.getTime()) / 1000;
    ageRows.push({
      company: company.id,
      retentionSec,
      expired,
      overdue,
      oldestAgeSec: ageSec.toFixed(1),
      overLimit: expired > 0 ? `+${(ageSec - retentionSec).toFixed(1)}s` : 'no',
      status: overdue > 0 ? 'PROBLEM' : expired > 0 ? 'OK (bucket pending)' : 'OK',
    });
  }
  console.table(ageRows);

  console.log('=== 4) Disk usage (whole collection) ===');
  const [{ storageStats: disk }] = await collection.aggregate([
    { $collStats: { storageStats: { scale: 1 } } },
  ]).toArray();
  console.table([{
    // In time-series, storageStats.count is not the measurement count; the bucket count is shown.
    bucketCount: disk.timeseries?.bucketCount ?? disk.count,
    timeSeriesBucketBytes: disk.size,
    allocatedDataBytes: disk.storageSize,
    reusableBytes: disk.freeStorageSize ?? 0,
    indexBytes: disk.totalIndexSize,
    totalAllocatedBytes: disk.totalSize,
  }]);
  try {
    const dbDisk = await db.command({ dbStats: 1, scale: 1 });
    console.log(`MongoDB data volume: used=${dbDisk.fsUsedSize ?? '-'} B, ` +
      `capacity=${dbDisk.fsTotalSize ?? '-'} B (entire file system)`);
  } catch (err) {
    console.warn(`Could not read file system usage: ${err.message}`);
  }

  console.log("=== 5) explain('executionStats') for a sample query ===");
  const sampleCompany = COMPANIES[0].id;
  const explainResult = await collection
    .find({ retentionDemo: true, companyId: sampleCompany })
    .sort({ ts: -1 })
    .explain('executionStats');

  // A time-series find is rewritten with a bucket-unpacking stage; the plan can appear at the
  // top level (classic/SBE: winningPlan.queryPlan) or inside stages[].$cursor.
  function findKey(node, key) {
    if (!node || typeof node !== 'object') return undefined;
    if (Object.prototype.hasOwnProperty.call(node, key)) return node[key];
    for (const [k, value] of Object.entries(node)) {
      if (k === 'rejectedPlans') continue;
      const found = findKey(value, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  function collectStageNames(node, acc = []) {
    if (Array.isArray(node)) node.forEach((n) => collectStageNames(n, acc));
    else if (node && typeof node === 'object') {
      if (typeof node.stage === 'string') acc.push(node.stage);
      for (const value of Object.values(node)) collectStageNames(value, acc);
    }
    return acc;
  }

  const winningPlan = findKey(explainResult, 'winningPlan');
  const execStats = findKey(explainResult, 'executionStats') ?? {};
  const stages = collectStageNames(winningPlan);
  const usesIxscan = stages.includes('IXSCAN');
  const usesCollscan = stages.includes('COLLSCAN');

  console.log(`  Query: find({ retentionDemo: true, companyId: ${sampleCompany} }).sort({ ts: -1 })`);
  console.log(`  Plan stages: ${stages.join(' -> ')}`);
  console.log(`  Scan type: ${usesIxscan ? 'IXSCAN (index used)' : usesCollscan ? 'COLLSCAN (index not used!)' : 'unknown'}`);
  console.log(`  nReturned: ${execStats.nReturned}`);
  console.log(`  totalDocsExamined: ${execStats.totalDocsExamined} (bucket count in time-series)`);
  console.log(`  totalKeysExamined: ${execStats.totalKeysExamined}`);

  await client.close();
}

main().catch((err) => {
  console.error('inspect.js error:', err);
  process.exit(1);
});
