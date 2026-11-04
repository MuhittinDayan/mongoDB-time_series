// Opens an independent setInterval for each company. Time-series TTL works from
// ts and the companyId metadata; expireAt is kept for observation only.

import { readFile, rm, writeFile } from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { MONGO_URI, DB_NAME, COLLECTION } from './lib/env.js';
import { COMPANIES, expireAtFor } from './lib/config.js';
import { PRODUCER_PID_FILE } from './lib/paths.js';

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log(`Write target: ${DB_NAME}.${COLLECTION}`);
  // healthcheck.js reads this PID to tell whether the producer is running.
  await writeFile(PRODUCER_PID_FILE, String(process.pid));

  const collection = client.db(DB_NAME).collection(COLLECTION);
  const timers = [];
  let totalCount = 0;
  let skippedCount = 0;

  console.log('\nProduction starting. Press Ctrl+C to stop.\n');

  for (const company of COMPANIES) {
    // A new write does not start until the previous one ends, so requests do not pile up if MongoDB slows down.
    let inFlight = false;
    const write = async () => {
      if (inFlight) {
        skippedCount += 1;
        return;
      }
      inFlight = true;
      const now = new Date();
      const expireAt = expireAtFor(company.id, now);
      const doc = {
        retentionDemo: true,
        companyId: company.id,
        ts: now,
        expireAt,
        temperature: +(18 + Math.random() * 10).toFixed(2),
        humidity: +(30 + Math.random() * 40).toFixed(2),
      };

      try {
        await collection.insertOne(doc);
        totalCount += 1;
        if (totalCount % 100 === 0) {
          console.log(`[${now.toISOString()}] Total written: ${totalCount}, skipped: ${skippedCount}`);
        }
      } catch (err) {
        console.error(`[${company.id}] write error:`, err.message);
      } finally {
        inFlight = false;
      }
    };

    write();
    timers.push(setInterval(write, company.intervalSec * 1000));
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} received, clearing timers...`);
    for (const t of timers) clearInterval(t);
    await client.close();
    try {
      // Leave the file alone if another producer has taken it over.
      if ((await readFile(PRODUCER_PID_FILE, 'utf8')).trim() === String(process.pid)) await rm(PRODUCER_PID_FILE);
    } catch { /* The PID file is already gone. */ }
    console.log('Connection closed. Total documents written:', totalCount);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('producer.js error:', err);
  process.exit(1);
});
