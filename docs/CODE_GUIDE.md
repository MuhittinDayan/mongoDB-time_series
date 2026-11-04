# Code guide: how partial TTL is set up and how data is written

Files covered (all under `src/`): `lib/config.js`, `lib/retention.js`, `setup.js`, `producer.js`, `healthcheck.js`, `rollup-4h.js`.

Giving different companies different retention periods takes two files:

- **`lib/config.js`** calculates what we want: which company is in which group, how many hours the general TTL is, and which partial TTL indexes are needed.
- **`lib/retention.js`** sets this up in MongoDB and verifies that the state in MongoDB matches the config.

`npm run setup` (`setup.js`) is the command that brings these two files together. `producer.js`, which writes the data, knows nothing about TTL; it only writes the `companyId` field correctly. MongoDB decides which rule applies.

## Step 1: `lib/config.js` — the company table

```js
const COMPANY_COUNT = 100;
const RETENTION_HOURS = [12, 24, 36, 48];

export const COMPANIES = Array.from({ length: COMPANY_COUNT }, (_, i) => ({
  id: i + 1,
  retentionHours: RETENTION_HOURS[i % RETENTION_HOURS.length],
  intervalSec: (Math.floor(i / RETENTION_HOURS.length) % 4) + 1,
}));
```

`i` runs from 0 to 99:

- **`id: i + 1`** → 1–100.
- **`retentionHours`** → `i % 4` becomes the array index (0, 1, 2, 3, 0, …). The periods rotate in turn: 12, 24, 36, 48, 12, …
- **`intervalSec`** → `i` is divided by 4 and rounded down, so each block of 4 gets the same interval. The interval rotates between 1 and 4 s.

| i | id | `i % 4` | retentionHours | `floor(i/4)` | intervalSec |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 1 | 0 | 12 | 0 | 1 |
| 1 | 2 | 1 | 24 | 0 | 1 |
| 2 | 3 | 2 | 36 | 0 | 1 |
| 3 | 4 | 3 | 48 | 0 | 1 |
| 4 | 5 | 0 | 12 | 1 | 2 |
| 16 | 17 | 0 | 12 | 4 | 1 (4 % 4 = 0) |

Result: 25 companies in each group, with 1, 2, 3 and 4-second companies evenly spread across every group.

## Step 2: `lib/config.js` — deriving TTL rules from the table

Nothing is sent to MongoDB in this step; it is only calculation. The goal is to answer this question: **which TTL rules will we set up in MongoDB?**

```js
export const RETENTION_GROUPS = [...new Set(COMPANIES.map((c) => c.retentionHours))]
  .sort((a, b) => a - b);
export const MAX_RETENTION_HOURS = RETENTION_GROUPS.at(-1);
export const PARTIAL_TTL_HOURS = RETENTION_GROUPS.filter((h) => h !== MAX_RETENTION_HOURS);

export function companyIdsFor(retentionHours) {
  return COMPANIES.filter((c) => c.retentionHours === retentionHours).map((c) => c.id);
}
```

| Variable | How it is calculated | Value | Used for |
| --- | --- | --- | --- |
| `RETENTION_GROUPS` | The periods of the 100 companies → duplicates removed with `Set` → sorted | `[12, 24, 36, 48]` | Intermediate value |
| `MAX_RETENTION_HOURS` | Last element of the sorted array (`.at(-1)`) | `48` | The collection's **general TTL** |
| `PARTIAL_TTL_HOURS` | All except the longest period | `[12, 24, 36]` | The **partial TTL indexes** to create |
| `companyIdsFor(12)` | IDs of companies with a period of 12 | `[1, 5, 9, …, 97]` | Each index's **company filter** |

**Key decision:** The longest period becomes the general TTL and the others become partial TTLs. This is required because a partial TTL can only shorten the period. The values are not written by hand; they are calculated from the table. When the table changes, they are all recalculated automatically.

## Step 3a: `lib/retention.js` — `ensureTimeSeriesCollection`

Ensures the collection and the **general TTL**.

```js
const expireAfterSeconds = MAX_RETENTION_HOURS * HOUR;      // 48 × 3600 = 172800
const existing = await db.listCollections({ name }).next();
```

1. **If the collection does not exist**, it creates it. The general TTL is set here:
   ```js
   await db.createCollection(name, {
     timeseries: { timeField: 'ts', metaField: 'companyId', granularity: 'seconds' },
     expireAfterSeconds,
   });
   ```
2. **If the collection exists**, it changes nothing and only checks:
   - Is it time-series, is `timeField` `ts`, and is `metaField` `companyId`? If any is not, **error**. `companyId` must be the metaField because a partial TTL filter can only be defined on the metaField.
   - Does the general TTL (`expireAfterSeconds`) match the config? If not, **error** with the command needed to fix it: `db.runCommand({ collMod: 'metrics_ts', expireAfterSeconds: … })`.

`expireAfterSeconds` is only set from code when the collection is first created. If it changes later, the code notices but does not change it itself (see `TODO.md`).

## Step 3b: `lib/retention.js` — `ensureRetentionIndexes`

Ensures **one partial TTL index** for each shorter-period group. Indexes are created **per group**, not per company: 75 companies are managed with 3 indexes. The number of indexes stays constant even if the number of companies grows.

The function works in 5 stages:

**1. Read the current state and determine the target**
```js
const indexes = await collection.indexes();                          // what exists in MongoDB now
const wanted = new Set(PARTIAL_TTL_HOURS.map((h) => `ttl_${h}h`));  // {ttl_12h, ttl_24h, ttl_36h}
```
`wanted` is not written to MongoDB; it is the in-memory list of what should exist.

**2. Are any indexes left that are no longer needed?**
```js
const stale = indexes.filter((i) => /^ttl_\d+h$/.test(i.name) && !wanted.has(i.name));
```
Indexes whose names fit the `ttl_<number>h` pattern but are not in `wanted` are added to the `problems` list. **The code does not delete them**; it puts the required `dropIndex` command in the error message.

**3. Check the index for each group**
```js
const toCreate = [];                                   // list of indexes to create
for (const hours of PARTIAL_TTL_HOURS) {               // 12, 24, 36
  const name = `ttl_${hours}h`;
  const ids = companyIdsFor(hours);
  const current = indexes.find((i) => i.name === name);
  if (!current) {                                      // missing → add to the create list
    toCreate.push({ name, hours, ids });
    continue;
  }
  const ok = JSON.stringify(current.key) === JSON.stringify({ ts: 1 }) &&   // is the key ts?
    current.expireAfterSeconds === hours * HOUR &&                          // is the period right?
    sameIds(current.partialFilterExpression?.companyId?.$in, ids);          // same company list?
  if (!ok) problems.push(/* dropIndex command */);     // exists but differs → problem
}
```

| Situation | Where it goes |
| --- | --- |
| The index **does not exist** in MongoDB | `toCreate` → will be created |
| The index **exists but has different settings** | `problems` → error, will not be created |
| The index exists with correct settings | Nowhere; it is left alone |

The name is not compared, because the index is already found by name. Three things are compared: the key, the period and the company list. `sameIds` sorts the lists before comparing, so order differences are not a problem.

**4. Stop if there are problems**
```js
if (problems.length) throw new Error(`TTL indexes are out of date: …`);
```
If there is even one problem, **nothing is created**. This avoids a half-finished state such as "two indexes new, one old".

**5. If there are no problems, create what is missing**
```js
for (const { name, hours, ids } of toCreate) {
  await collection.createIndex({ ts: 1 }, {
    name,                                                  // ttl_12h
    partialFilterExpression: { companyId: { $in: ids } },  // only these companies
    expireAfterSeconds: hours * HOUR,                      // 43200 = 12 hours
  });
}
```
This call is the whole mechanism for giving companies different periods:
- `{ ts: 1 }` → the period is calculated from the `ts` field.
- `partialFilterExpression` → the index covers only the data of the listed companies.
- `expireAfterSeconds` → this index's own deletion period.

### Why does it stop instead of fixing things automatically?

MongoDB does not automatically update an index of the same name with new settings; the old one must be dropped and a new one created. This can affect live data: if a company's period is shortened, its old data is deleted in the first TTL pass. When we changed the group distribution on 28 September 2026, the old data of 37 companies was deleted this way. That is why the decision is left to the user.

## Step 4: `setup.js` — running the two functions in order

`setup.js` itself contains no decision logic: `lib/retention.js` makes the decisions and `lib/config.js` provides the values. This file only connects, calls the two functions in order, shows the result and closes the connection.

**Imports: who provides what**
```js
import { MongoClient } from 'mongodb';                            // MongoDB driver
import { MONGO_URI, DB_NAME, COLLECTION } from './lib/env.js';    // where to connect (.env)
import { COMPANIES, MAX_RETENTION_HOURS, PARTIAL_TTL_HOURS,
         retentionSecondsFor } from './lib/config.js';            // only for printing
import { ensureTimeSeriesCollection, ensureRetentionIndexes } from './lib/retention.js'; // the real work
```
The values from `lib/config.js` are only printed in this file. `lib/retention.js` gets the values used for setup from `lib/config.js` itself.

**The real work: order matters**
```js
const db = client.db(DB_NAME);
await ensureTimeSeriesCollection(db, COLLECTION);                       // first collection + general TTL
const created = await ensureRetentionIndexes(db.collection(COLLECTION)); // then partial TTLs
```
- The collection must exist before indexes can be created; on first setup, `ensureTimeSeriesCollection` creates it.
- If `ensureTimeSeriesCollection` throws (for example because the general TTL does not match), the next line does not run and the indexes are not touched. That is why, if the general TTL changes, `collMod` runs first and `setup` after it.
- `created` is the value returned by `ensureRetentionIndexes`: `toCreate.map((i) => i.name)`, meaning the names of the indexes created in this run. If none were created, it is an empty array.

**Printing the result**
```js
console.log(`Collection: … general TTL ${MAX_RETENTION_HOURS} hours`);
console.log(`Partial TTL: ${PARTIAL_TTL_HOURS.join(', ')} hours; …`);
console.log(created.length ? `Newly created indexes: …` : 'TTL indexes are already up to date.');
console.table(COMPANIES.map(…));   // table of the 100 companies
```
If `created` has entries, the created indexes are listed; if it is empty, "already up to date" is printed.

**Errors and shutdown**
```js
} finally {
  await client.close();                            // the connection closes even on error
}
main().catch((err) => {
  console.error('setup.js error:', err.message);   // the message thrown by lib/retention.js
  process.exit(1);                                 // exit with an error code
});
```
Errors thrown by `lib/retention.js` (messages containing `collMod` / `dropIndex` commands) are printed here. Thanks to `process.exit(1)`, another script or task running `setup` can tell that it failed.

**Flow summary**
```
npm run setup
  → connect (address from .env)
  → ensureTimeSeriesCollection   on error → print message, exit (code 1)
  → ensureRetentionIndexes       on error → print message, exit (code 1)
  → print the result and the company table
  → close the connection
```

## `npm run setup` output in practice

| Scenario | `toCreate` | `problems` | Output |
| --- | --- | --- | --- |
| First setup | `ttl_12h, ttl_24h, ttl_36h` | empty | `Newly created indexes: ttl_12h, ttl_24h, ttl_36h` |
| Nothing changed | empty | empty | `TTL indexes are already up to date.` |
| Company distribution changed | — | `ttl_12h, …` | Error: `ttl_12h settings do not match config.js; …dropIndex('ttl_12h')` |
| New group added, existing ones unchanged | only the new ones | empty | Only the new indexes are created |
| General TTL changed | — | — | `ensureTimeSeriesCollection` error + `collMod` command |

## The result in MongoDB

```
ttl_12h  expireAfterSeconds=43200   companyId $in [1, 5, 9, …, 97]
ttl_24h  expireAfterSeconds=86400   companyId $in [2, 6, 10, …, 98]
ttl_36h  expireAfterSeconds=129600  companyId $in [3, 7, 11, …, 99]
+ collection setting: expireAfterSeconds=172800 (all companies)
```

- **Company 5** is in the `ttl_12h` list. Both this index and the general TTL apply; the TTL monitor deletes its data at 12 hours, before the general TTL's 48th hour is reached.
- **Company 4** is in no partial list. Only the general TTL applies; its data is deleted at 48 hours.

## Step 5: `producer.js` — writing the data

In the experiment it stands in for sensors: for each company it produces measurements at set intervals and writes them to MongoDB. It knows nothing about TTL; its link to deletion is the `companyId` and `ts` fields in the documents it writes.

**Startup**
```js
const client = new MongoClient(MONGO_URI);
await client.connect();
await writeFile(PRODUCER_PID_FILE, String(process.pid));   // logs/producer-live.pid ← its own process number
const timers = [];          // each company's timer (to clear on shutdown)
let totalCount = 0;         // total written
let skippedCount = 0;       // skipped (because the previous write had not finished)
```
The PID file is for `healthcheck.js`; the health check uses this number to tell whether the producer is running.

**A separate writer for each company**
```js
for (const company of COMPANIES) {       // 100 companies
  let inFlight = false;                   // is this company's write in progress?
  const write = async () => { … };        // write function specific to this company
  write();                                                        // write once immediately
  timers.push(setInterval(write, company.intervalSec * 1000));    // then every 1-4 s
}
```
Each company has its own `write` function and `inFlight` variable: the 100 independent timers do not wait for each other. `write()` is called directly the first time; because `setInterval` first runs after one interval, the first record would otherwise be 1-4 s late.

Write rate: in each group, 7 companies write every 1 s and 6 each write every 2, 3 and 4 s → about 54 records per second in total.

**A single write**

a) Overlap check:
```js
if (inFlight) { skippedCount += 1; return; }   // skip this turn if the previous write has not finished
inFlight = true;
```
If MongoDB slows down, pending requests do not pile up and fill memory.

b) Building the document — this is where the TTL link is:
```js
const now = new Date();
const doc = {
  retentionDemo: true,                          // marks an experiment record
  companyId: company.id,                        // metaField → which partial TTL it falls under
  ts: now,                                      // timeField → the TTL period starts here
  expireAt: expireAtFor(company.id, now),       // observation only, TTL does not use it
  temperature: +(18 + Math.random() * 10).toFixed(2),   // 18–28 °C
  humidity: +(30 + Math.random() * 40).toFixed(2),      // 30–70%
};
```

| Field | Role | Relation to TTL |
| --- | --- | --- |
| `companyId` | metaField | **Which rule:** if the value is in the `$in` list of `ttl_12h`, it falls under that index; buckets are also separated by it |
| `ts` | timeField | **When:** deletion happens when `ts + period` has passed |
| `expireAt` | Ordinary field | None. Left over from the old collection; only `monitor.js` and `watch.js` show it |
| `retentionDemo` | Ordinary field | None. Separates experiment records from the `probe.js` test record |
| `temperature`, `humidity` | Measurement | None |

All the producer has to do for partial TTL to work is write `companyId` correctly. It does not need to know which group the company is in; MongoDB knows that from the index filter.

c) Writing:
```js
try {
  await collection.insertOne(doc);
  totalCount += 1;
  if (totalCount % 100 === 0) console.log(`… Total written: …, skipped: …`);
} catch (err) {
  console.error(`[${company.id}] write error:`, err.message);   // the producer does not stop
} finally {
  inFlight = false;          // release the lock on success or failure
}
```
- `insertOne` sends one document; MongoDB adds it to that company's open bucket.
- On an error, only that write is lost; it tries again on the next turn.
- Without `finally`, a single error would permanently lock that company's writes.
- One log line every 100 records (`logs/producer-recovered.log` when started by the health check).

**Shutdown**
```js
const shutdown = async (signal) => {
  if (stopping) return;                       // ignore a second call
  stopping = true;
  for (const t of timers) clearInterval(t);   // stop the 100 timers
  await client.close();
  if (the number in the PID file is mine) await rm(PRODUCER_PID_FILE);
  process.exit(0);
};
process.on('SIGINT', …);    // Ctrl+C
process.on('SIGTERM', …);   // termination request
```
The PID file is deleted only if the number in it belongs to this process; if another producer has taken over, it is left alone. If the process is killed with Task Manager or `Stop-Process`, this function does not run; that is not a problem because the health check verifies that the PID really belongs to `producer.js`.

**Flow summary**
```
start → connect → write the PID file
  → for each of the 100 companies:
       write once immediately, then every intervalSec seconds:
         previous write still in progress → skip
         build { companyId, ts, … } → insertOne
  → Ctrl+C / SIGTERM → stop timers → close the connection → delete the PID file
```

From the TTL perspective: the producer writes `companyId` and `ts`, and MongoDB puts the document in a bucket. If `companyId` is in a partial TTL list, that index's period applies; otherwise the general TTL applies. The TTL monitor does the deleting.

## Step 6: `healthcheck.js` — keeping the producer running

The `MongoRetentionWriteCheck` task on Windows runs this file **hourly** through `healthcheck.cmd`. The question it answers: **"Is data still being written? If not, do I need to restart the producer?"** Unlike the other scripts, it has no `main()` function; the code runs once from top to bottom and ends.

**Stage 1: Is the data fresh?**
```js
const maxAgeSeconds = Number(process.env.HEALTH_MAX_AGE_SECONDS ?? 120);   // threshold: 120 s
const result = { checkedAt: …, status: 'ERROR' };   // stays like this if it cannot connect
const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });

const latest = await collection.findOne(
  { retentionDemo: true, companyId: 1 },                          // company 1's
  { sort: { ts: -1 }, projection: { ts: 1, companyId: 1 } });     // newest record
result.ageSeconds = Math.round((checkedAt - latest.ts) / 1000);
result.status = result.ageSeconds <= maxAgeSeconds ? 'OK' : 'STALE';
```
Only company 1 is checked: because it writes every second, its last record should be a few seconds old if the producer is running. The query uses the `companyId + ts` index and reads one record.

| Status | Meaning |
| --- | --- |
| `OK` | Last record ≤ 120 s ago |
| `STALE` | Last record > 120 s ago or none at all; the producer may have stopped |
| `ERROR` | Could not connect to MongoDB |

**Stage 2: If stale, check the producer and start it if needed**

This runs only on `STALE`, not on `ERROR` (starting the producer while MongoDB is down is pointless).

a) Is the producer process really gone? The number in `logs/producer-live.pid` is passed to `isProducerProcess`:
1. `process.kill(pid, 0)`: is a live process using this number? (Signal 0 does not kill; it only asks.) If not → `false`.
2. If so, its command line is read (PowerShell on Windows, `/proc` on Linux).
3. If the command line does not contain `producer.js` → `false`.

Checks 2 and 3 are needed because Windows can reassign a dead process's number to another process. If the command line cannot be read, it returns `true`: when unsure, not starting a second producer is safer than writing twice.

b) Decision: if the process exists, `PROCESS_PRESENT` (left alone, only reported); if not, it is restarted.

c) Restart:
```js
const log = await open(PRODUCER_RECOVERED_LOG, 'a');
const child = spawn(process.execPath, [PRODUCER_SCRIPT], {
  cwd: ROOT_DIR,
  detached: true,                       // the producer keeps running after the health check ends
  windowsHide: true,
  stdio: ['ignore', log.fd, log.fd],    // output and errors go to the log file
});
await new Promise(… 'spawn' / 'error' …);   // wait until it has really started
child.unref();                              // the health check can exit without waiting
await writeFile(PRODUCER_PID_FILE, String(child.pid));
result.action = 'RESTARTED';
```

**Stage 3: Save the result**
```js
await appendFile(WRITE_HEALTH_LOG, line + '\n');      // history
await writeFile(WRITE_HEALTH_STATUS, line + '\n');    // latest state
if (ERROR || RESTART_FAILED || PROCESS_PRESENT) process.exitCode = 1;
```
Exit code 1 appears as "last run failed" in Windows Task Scheduler.

| `status` | `action` | What happened | Exit code |
| --- | --- | --- | ---: |
| `OK` | — | The producer is running | 0 |
| `STALE` | `RESTARTED` | The producer had stopped and was restarted | 0 |
| `STALE` | `PROCESS_PRESENT` | The process exists but is not writing; left alone | 1 |
| `STALE` | `RESTART_FAILED` | Could not be restarted | 1 |
| `ERROR` | — | Could not connect to MongoDB | 1 |

**Limitations:** the check runs hourly (a stop may go unnoticed for up to 1 hour); only company 1 is checked; a hung producer (`PROCESS_PRESENT`) is not resolved automatically.

## Step 7: `rollup-4h.js` — 4-hour summaries

The `MongoRetentionRollup4h` task on Windows runs this file **hourly** through `rollup-4h.cmd` (output: `logs/rollup-4h.log`). It calculates the statistics of 4-hour windows for each company from raw measurements and writes them to a separate, **regular** collection (`metrics_rollup_4h`). This collection has no TTL: summaries remain after the raw data is deleted.

**Settings and helpers**
```js
const TARGET = 'metrics_rollup_4h';
const WINDOW_MS = 4 * 3600 * 1000;                        // 4 hours
const BACKFILL = process.argv.includes('--backfill');    // npm run rollup:4h:backfill

function floorWindow(date) { … Math.floor(date / WINDOW_MS) * WINDOW_MS … }   // round down
function ceilWindow(date)  { … Math.ceil(date / WINDOW_MS) * WINDOW_MS … }    // round up
```
Windows start at 00:00, 04:00, 08:00, 12:00, 16:00 and 20:00 UTC (03:00, 07:00, … Turkey time). `floorWindow(09:27)` → 08:00, `ceilWindow(09:27)` → 12:00.

**Preparation**
```js
if (info?.type !== 'timeseries') throw …;     // is the source really time-series?
await rollups.createIndex({ companyId: 1, windowStart: 1 }, { unique: true, … });
```
The unique index prevents a second summary for the same company + same window at the database level.

**Which windows are summarized?** A summary is correct only if all of the window's data is available. There are two limits:

```js
const completedThrough = floorWindow(now);   // upper limit
for (const hours of RETENTION_GROUPS) {      // each retention group separately
  const ids = companyIdsFor(hours);
  const retentionSafeStart = ceilWindow(now − hours);           // lower limit (safe)
  const recentStart = completedThrough − 2 × 4 hours;           // last 2 windows in normal mode
  const start = BACKFILL || retentionSafeStart > recentStart ? retentionSafeStart : recentStart;
  if (start >= completedThrough) continue;
```

- **Upper limit (`completedThrough`) → round down:** The current window has not finished yet; summarizing it would leave it incomplete. At 09:27 the upper limit is 08:00, so the 08:00–12:00 window is skipped.
- **Lower limit (`retentionSafeStart`) → round up:** The window containing the retention limit may be partly deleted. At 09:27, the limit for the 12-hour group is 21:27 the previous day; rounded up, it is 00:00. The 20:00–00:00 window is skipped because 20:00–21:27 may have been deleted.
- **Normal mode:** The last 2 completed windows (at 09:27, 00:00–04:00 and 04:00–08:00). Because the task runs hourly, a window is processed several times; if one run is missed, the next makes up for it.
- **`--backfill`:** All completed windows from the safe limit onward.
- The later of the two starting points is chosen, so normal mode also does not go behind the safe limit.

Groups are processed separately because the safe limit differs with each group's period.

**Calculation: aggregation**
```js
raw.aggregate([
  { $match: { retentionDemo: true, companyId: { $in: ids }, ts: { $gte: start, $lt: completedThrough } } },
  { $group: {
      _id: { companyId: '$companyId',
             windowStart: { $dateTrunc: { date: '$ts', unit: 'hour', binSize: 4, timezone: 'UTC' } } },
      count: { $sum: 1 },
      temperatureSum: { $sum: '$temperature' }, temperatureMin: { $min: … }, temperatureMax: { $max: … },
      humiditySum: …, humidityMin: …, humidityMax: …,
      firstTs: { $min: '$ts' }, lastTs: { $max: '$ts' },
  } },
], { allowDiskUse: true, maxTimeMS: 300000 });
```
- `$match`: the group's companies and the selected time range. The `companyId` + `ts` filter makes MongoDB open only the relevant buckets.
- `$group`: each measurement is rounded with `$dateTrunc` to the start of its 4-hour window (10:37 → 08:00). One row per company + window: count, sum, min, max, first/last time.
- `allowDiskUse`: can write to disk if memory is not enough. `maxTimeMS`: 5 minutes at most.

**Writing: only what is missing**
```js
operations.push({ updateOne: {
  filter: { companyId, windowStart },
  update: { $setOnInsert: {
    companyId, windowStart, windowEnd, windowHours: 4, count,
    temperature: { min, max, avg: temperatureSum / count },
    humidity:    { min, max, avg: humiditySum / count },
    firstTs, lastTs, sourceCollection: COLLECTION, createdAt: now,
  } },
  upsert: true,
} });
…
await rollups.bulkWrite(operations.slice(offset, offset + 1000), { ordered: false });
```
- `upsert: true` + `$setOnInsert`: if the summary is missing it is inserted; if it exists it is **not changed at all**. Processing the same window again is harmless (on 27 September, repeating the backfill produced 0 new records).
- The average is calculated by dividing the sum by the count.
- `bulkWrite` runs in batches of 1000; thanks to `ordered: false`, an error in one operation does not stop the others.

**Output:** one line per group, then a summary at the end:
```json
{"status":"OK","mode":"recent","windowsFound":100,"inserted":0,"completedThrough":"2026-09-28T08:00:00.000Z",…}
```
`windowsFound`: the number of company-window pairs found; `inserted`: the number of new summaries added in this run.

**Sample summary document**
```js
{ companyId: 1, windowStart: 2026-09-27T08:00Z, windowEnd: 2026-09-27T12:00Z, windowHours: 4,
  count: 14193, temperature: { min, max, avg: 22.97 }, humidity: { min, max, avg: 50.02 },
  firstTs, lastTs, sourceCollection: 'metrics_ts', createdAt }
```

**Limitations**
- Late-arriving data does not enter the summary: once a window's summary is written, it does not change. In the experiment, data always arrives on time; real sensors would need a waiting period or recalculation.
- Deleted raw data does not come back; no summary can be produced from it.
- The group distribution changed on 28 September 2026. Because the old data of companies whose periods were extended had already been deleted, `--backfill` should not be run before 30 September 2026; it would produce incorrect summaries from incomplete windows.

## Known limitation

Group membership lives inside the index (the `$in` list). Adding a company or changing a company's group requires `dropIndex` + `npm run setup`. In a real system it is better to write the group into the data itself (`meta: { companyId, tier: '12h' }`) and filter the index on `tier`; new companies can then be added without touching the index. See `TODO.md` for the steps to add a new group.
