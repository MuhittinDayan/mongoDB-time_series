# MongoDB time-series retention experiment

Database: `tsdb_retention_test`. The active collection, `metrics_ts`, is a real MongoDB time-series collection. The old regular `metrics` collection is kept for migration verification; new records are written only to `metrics_ts`.

## Project layout

```text
mongo-retention-test/
├── src/
│   ├── setup.js               Create or verify the collection and TTL indexes
│   ├── producer.js            Write synthetic measurements
│   ├── monitor.js             Record per-company observations every minute
│   ├── inspect.js             Print the collection type, indexes and current state
│   ├── watch.js               Print company 1's latest documents (demo)
│   ├── probe.js               Test the 12-hour partial TTL with one backdated record
│   ├── healthcheck.js         Check writes and restart a stopped producer
│   ├── rollup-4h.js           Produce 4-hour summaries
│   ├── migrate-timeseries.js  One-time migration from metrics to metrics_ts
│   └── lib/
│       ├── config.js          Company table and retention groups
│       ├── env.js             Connection settings from .env
│       ├── paths.js           Log, data and PID file locations
│       └── retention.js       Collection and TTL index setup logic
├── docs/
│   ├── CODE_GUIDE.md                    Step-by-step code walkthrough
│   ├── TIME_SERIES_MIGRATION_REPORT.md  Migration record and how to change settings
│   └── TODO.md                          Open work
├── data/retention-observations.csv      Output of monitor.js
├── logs/                                Producer, health check and rollup output
├── healthcheck.cmd                      Command run by the MongoRetentionWriteCheck task
└── rollup-4h.cmd                        Command run by the MongoRetentionRollup4h task
```

The two `.cmd` files stay in the project root because the Windows scheduled tasks point to those paths.

## Experiment settings

| Group | Companies | Raw data retention |
| --- | ---: | ---: |
| 12 hours | 25 | 12 hours |
| 24 hours | 25 | 24 hours |
| 36 hours | 25 | 36 hours |
| 48 hours | 25 | 48 hours |

The experiment started with 12 companies and was later expanded to 100. Companies are assigned to groups in turn: 1 → 12 hours, 2 → 24 hours, 3 → 36 hours, 4 → 48 hours, 5 → 12 hours, …

`companyId` is a number from 1 to 100 and is used as the time-series `metaField`. `ts` is the time field. Each company writes random temperature and humidity measurements at the 1, 2, 3 or 4-second interval set in `src/lib/config.js`.

The collection's general `expireAfterSeconds` is set to 172800 (48 hours). The `ttl_12h`, `ttl_24h` and `ttl_36h` partial TTL indexes apply only to the relevant company IDs, so a 12-hour record does not wait for 48 hours. TTL is calculated from the `ts` field; the `expireAt` field left on records is only for comparison with the old experiment and for observation. MongoDB deletes a bucket in the background after all of its records have expired; deletion at the exact threshold is not guaranteed.

30-day retention and 1, 2 and 12-hour summaries are not active at this stage. Only the experimental 4-hour summary is produced, in the regular `metrics_rollup_4h` collection; the summary remains after the raw data is deleted.

## Usage

Connection settings (`MONGO_URI`, `MONGO_DB`, `MONGO_COLLECTION`) are read by `src/lib/env.js` from the `.env` file in the project root. A system environment variable with the same name takes precedence. There are no built-in defaults, so a missing `MONGO_URI` stops the script with an error. No extra package is needed; Node's built-in `process.loadEnvFile` function is used. Experiment rules such as the company table and TTL groups are in `src/lib/config.js`.

```powershell
npm install
npm run setup
npm run produce
npm run monitor
npm run inspect
npm run rollup:4h
```

| Command | What it does |
| --- | --- |
| `npm run setup` | Creates the time-series collection and TTL indexes or verifies their settings; does not delete existing data. |
| `npm run produce` | Runs the producer in the foreground. |
| `npm run monitor` | Appends per-company retention and storage measurements to `data/retention-observations.csv` once a minute. |
| `npm run inspect` | Shows the collection type, indexes and current state. |
| `npm run watch` | Prints company 1's latest 20 documents every 4 seconds. |
| `npm run probe` | Uses one backdated test record to check the 12-hour partial TTL. |
| `npm run rollup:4h` | Summarizes the recent completed 4-hour windows. |
| `npm run rollup:4h:backfill` | Rescans complete past windows still within retention; no second record is added for an existing summary. |
| `npm run migrate:timeseries` | Runs the one-time migration; refuses to run if the target has data. |

Do not also start `npm run produce` if the background producer is already running; a second process increases the total write rate. The steps for changing retention and rate settings are in [`docs/TIME_SERIES_MIGRATION_REPORT.md`](docs/TIME_SERIES_MIGRATION_REPORT.md).

## Scheduled tasks

The `MongoRetentionWriteCheck` scheduled task checks the active background producer once an hour. The latest result is in `logs/write-health-status.json` and past results are in `logs/write-health.log`. If the producer has stopped, the task restarts it; this may take up to an hour to be noticed. The `MongoRetentionRollup4h` task also produces the 4-hour summaries hourly, and its recent runs are in `logs/rollup-4h.log`. Both tasks are set up to run while the user is logged in.

## Viewing data in Compass

- **Summaries:** `tsdb_retention_test` → `metrics_rollup_4h`. Sample filter: `{ "companyId": 1 }`, sort: `{ "windowStart": -1 }`.
- **Raw data:** `mongodb://127.0.0.1:27017` → `tsdb_retention_test` → `metrics_ts`. Sample filter: `{ "companyId": 42, "retentionDemo": true }`. Sort by `ts` descending for the newest records.

## Per-company pagination

```javascript
const firstPage = await db.collection('metrics_ts')
  .find({ companyId: 42, retentionDemo: true })
  .sort({ ts: -1 })
  .limit(100)
  .toArray();

const nextPage = await db.collection('metrics_ts')
  .find({ companyId: 42, retentionDemo: true, ts: { $lt: firstPage.at(-1).ts } })
  .sort({ ts: -1 })
  .limit(100)
  .toArray();
```

MongoDB automatically creates the `companyId + ts` compound index. If measurements with the same `ts` value occur within one company, paginating by `ts` alone can skip records; in that case a separate pagination key must be designed.

## Why does the size look small?

`metrics_ts` stores measurements in compressed buckets by company and nearby time. `collStats.size` and the `logicalBytes` column in `data/retention-observations.csv` (an old name) should not be read as the BSON total of individual measurements for time-series; they reflect the size of the bucket records. Look at `storageSize` for the data allocated on disk and `totalSize` for the total with indexes. The old `metrics` collection also temporarily remains on disk; database-wide usage includes its size too.

This compression is a built-in feature of MongoDB time-series: column compression and `zstd` by default are applied automatically. `src/producer.js` does no compression of its own. The 4-hour summaries in `metrics_rollup_4h` are a separate calculated result, not the same process as time-series compression.

## Migration

With the producer stopped, `src/migrate-timeseries.js` copies old `metrics` data into the new `metrics_ts` collection in time order for each company. If the target collection has data, it refuses to run to prevent duplicate records. See [`docs/TIME_SERIES_MIGRATION_REPORT.md`](docs/TIME_SERIES_MIGRATION_REPORT.md) for the record of how the migration was performed and verified.

## Documents

- [`docs/CODE_GUIDE.md`](docs/CODE_GUIDE.md): how partial TTL is set up and how data is written, file by file.
- [`docs/TIME_SERIES_MIGRATION_REPORT.md`](docs/TIME_SERIES_MIGRATION_REPORT.md): the migration record, verification limits and settings changes.
- [`docs/TODO.md`](docs/TODO.md): open work.
