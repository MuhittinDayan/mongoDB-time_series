# Time-series migration and retention report

Date: 27 September 2026 (Europe/Istanbul). Database: `tsdb_retention_test`. MongoDB version: 8.0.32.

## Result

**4,166,281 experiment records** were moved from the old regular `metrics` collection to the new `metrics_ts` time-series collection. The old collection was not deleted. The producer was redirected to the new collection. The automatic health check first ran every 5 minutes; on 27 September 2026 its interval was raised to **1 hour**. The last manual health check returned `OK` at 2026-09-27 14:42:26 UTC, with a last-write age of 0 seconds.

## Migration sequence

1. The `MongoRetentionWriteCheck` task was disabled and the old `producer.js` process was stopped.
2. `metrics_ts` was created with `timeField: ts`, `metaField: companyId`, `granularity: seconds` and a general `expireAfterSeconds: 172800`.
3. The 12, 24 and 36-hour partial TTL indexes were created.
4. The existing records of the 100 companies were copied in batches of 2,000, in ascending `ts` order for each company. The transfer completed between 14:39:28 and 14:40:23 UTC.
5. The collection type, TTL indexes, the time of the newest record, and the IDs and measurement values of eight sample records from different groups were compared; all eight matched.
6. The producer was started against the new collection and new measurements were seen. The scheduled task was enabled again. A measurement gap of about 4 minutes occurred between stopping and restarting the producer; no synthetic experiment data was produced during it.

## How TTL is applied

| Company group | Active rule | Period added to `ts` |
| --- | --- | ---: |
| 12 hours | `ttl_12h` partial TTL | 43,200 seconds |
| 24 hours | `ttl_24h` partial TTL | 86,400 seconds |
| 36 hours | `ttl_36h` partial TTL | 129,600 seconds |
| 48 hours | The collection's general TTL rule | 172,800 seconds |

The key of the three partial indexes is `{ ts: 1 }` and their filter is the relevant `companyId` values. The 48-hour general rule and the shorter partial indexes exist at the same time. The shorter groups do not wait for 48 hours. The `expireAt` field carried over from old records does not control deletion in the new collection; `ts` and the company group do.

MongoDB time-series TTL does not remove expired documents one by one in the same second. Documents from the same company at about the same time are kept in buckets; once all records in a bucket have expired, the background TTL process deletes the bucket. With `seconds` granularity a bucket spans at most one hour, and the TTL pass runs about every 60 seconds. Additional delay is possible under load. For this reason, a small number of records past the retention limit may remain visible for a short time.

## Verification limits and next stage

The migration verified the collection type, settings, indexes and write flow. **The 12-hour partial TTL was verified in a controlled single-record test.** `npm run probe` wrote a record dated 13 hours 5 minutes in the past for `companyId: 1`; MongoDB deleted it at 2026-09-27 14:45:16 UTC. The natural 24/36/48-hour deletion cycle had not yet been observed over time. `npm run monitor` can be used for long-term observations; the results are kept in `data/retention-observations.csv`.

The old `metrics` collection's own `expireAt` TTL index is still active. Records there will also be deleted as their old periods expire; the collection is kept for now for migration verification. The two collections taking up space together during the transfer is temporary.

30-day retention and 1/2/12-hour summaries are not active. **4-hour rollups** were enabled for the experiment in a separate collection; details are below.

## Hourly liveness check

The repeat interval of the `MongoRetentionWriteCheck` task was changed from `PT5M` to `PT1H`; the task still runs `healthcheck.cmd`, which calls `src/healthcheck.js`. If the last record is older than 120 seconds during a check and the producer process does not exist, it is restarted. Because checks are now hourly, a stopped producer may go unnoticed for up to an hour. `PT1H` was verified in the task's Windows XML output. The task is configured to run while the user is logged in.

## Experimental 4-hour rollups

The source is `metrics_ts` and the target is the **regular** MongoDB collection `metrics_rollup_4h`. Each summary represents one `companyId` and a UTC-aligned 4-hour `[windowStart, windowEnd)` range. These fields are written: `count`, `min`, `max` and `avg` for temperature and humidity, first and last measurement times, the source collection and the creation time. The unique compound index `{ companyId: 1, windowStart: 1 }` prevents the same window from being inserted twice. No TTL was placed on the summary collection; summaries remain after the raw records are deleted.

`src/rollup-4h.js` processes only **completed** windows. A regular run scans the last two completed windows and inserts any that are missing, without changing existing summaries. During the first setup, `node src/rollup-4h.js --backfill` was run; for each company, complete windows entirely within the retention limit were selected. This avoids producing an incomplete summary from an old window whose raw data has been partly deleted by TTL. Late-arriving measurements do not exist in this experimental producer, so a completed window's summary is not changed afterwards.

The first run created **525 summaries**. Repeating the same backfill created **0 new summaries**. For company 1's 2026-09-27 08:00–12:00 UTC window, the summary gave `count: 14193`, an average temperature of `22.967209187627702` and an average humidity of `50.01565842316635`; these matched a raw-data query for the same window exactly.

The `MongoRetentionRollup4h` Windows task runs the job **hourly** through `rollup-4h.cmd`. The task was tested by triggering it manually: last result `0`, log status `OK`, re-inserted records `0`. The output is written to `logs/rollup-4h.log`. This task is also registered to run while the user is logged in and the device is not on battery. After a long outage, `npm run rollup:4h:backfill` can be used to fill older windows that are still fully available within retention; deleted raw data cannot be recovered.

In Compass, summaries can be seen by opening `tsdb_retention_test.metrics_rollup_4h` with the filter `{ "companyId": 1 }` and the sort `{ "windowStart": -1 }`. The 4-hour windows start at 00:00, 04:00, 08:00, 12:00, 16:00 and 20:00 UTC.

## What each file does

| File | Purpose and settings to change |
| --- | --- |
| `src/lib/env.js` / `.env` | MongoDB address, database and collection name. Read from the `.env` file; the address format is validated. |
| `src/lib/paths.js` | Locations of the project's log, data and PID files. |
| `src/lib/config.js` | `retentionHours` and `intervalSec` values for the 100 companies (the experiment started with 12 companies and was later expanded to 100; companies are assigned to the 12/24/36/48-hour groups in turn). The source from which retention groups and TTL periods are derived. |
| `src/setup.js` / `src/lib/retention.js` | Verifies the time-series collection; creates the general TTL (the longest period) and the shorter partial TTL indexes derived from `src/lib/config.js`. On a mismatch, prints the required `collMod`/`dropIndex` command. |
| `src/producer.js` | Writes synthetic temperature/humidity records at the intervals in `src/lib/config.js`. `expireAt` is for observation; time-series TTL does not use it. |
| `src/healthcheck.js` | Looks at company 1's latest write and restarts a stopped producer if it is older than 120 seconds. |
| `src/monitor.js` / `src/inspect.js` | Show per-company retention, disk and index state. |
| `src/probe.js` | Tests 12-hour partial TTL deletion with a single backdated record. |
| `src/migrate-timeseries.js` | One-time tool for moving old `metrics` data **only into an empty** `metrics_ts` collection. It does not run again on a target that has data. |
| `src/rollup-4h.js` | Summarizes completed 4-hour windows; `--backfill` fills safe past windows. |
| `rollup-4h.cmd` / `logs/rollup-4h.log` | The hourly Windows task's command and run output. |

## How to change settings

**If only the write interval changes:** change the relevant company's `intervalSec` value in `src/lib/config.js` and restart the running `src/producer.js` process. MongoDB indexes do not change. Starting a second `npm run produce` while the current background producer is running doubles the write rate.

**If a retention group or company ID changes:** edit only the company table in `src/lib/config.js`. The longest period becomes the collection's general TTL, and the others are automatically derived from the table as partial TTL indexes. Existing settings in MongoDB do not change just because the file was edited; if `npm run setup` sees a mismatch, it stops and prints the required command:

1. Temporarily stop the producer and the `MongoRetentionWriteCheck` scheduled task, so writes do not happen under two different rules during the change.
2. If the general TTL changes, run `db.runCommand({ collMod: 'metrics_ts', expireAfterSeconds: 172800 })` in `mongosh` with the relevant value in seconds. The `172800` in the example is the current 48 hours; 30 days would be `2592000`.
3. Remove the old partial TTL indexes whose content changes, for example `db.metrics_ts.dropIndex('ttl_12h')`. Then run `npm run setup` in the project folder; this command recreates the indexes according to the current `src/lib/config.js` and `src/setup.js`. If `setup` is run before the general TTL is updated with `collMod`, it fails with a settings mismatch.
4. Check the collection TTL, group filters and second values with `db.getCollectionInfos({ name: 'metrics_ts' })` and `db.metrics_ts.getIndexes()`. Restart the producer and enable the scheduled task; verify that the last write is current with `node src/healthcheck.js`.

Shortening a period can make old measurements eligible for deletion immediately. Changing a company's retention group also applies the new rule to the existing measurements under the same `companyId`; records already deleted do not come back. The expired counter in `src/monitor.js` is calculated from `expireAt`, so the company table and the producer must be updated together; `expireAt` on previously written records keeps reflecting the past policy.

A real 30-day experiment requires separately modeling 15–20 projects, a 10-second stream and a rollup policy. This experiment's 100-company producer and partial indexes should not be taken directly as that target design.

## Interpreting size measurements

Around 20:37 Turkey time on 27 September 2026, `metrics_ts` contained about **4.5 million measurements**. A sample measurement alone was 122 bytes of BSON; the same measurements stored as separate documents would come to about 524 MiB. The time-series collection's `collStats.size` was about 35.7 MiB, its `storageSize` about 27.3 MiB, and its indexes about 0.5 MiB. This difference comes from company/time buckets, column compression and small, similar synthetic measurements. This ratio should not be assumed for real production documents.

**Compression is a built-in feature of MongoDB time-series.** The collection stores measurements in buckets; MongoDB applies column compression and `zstd` by default. `src/producer.js` does not run a compression algorithm of its own. The experimental 4-hour rollup is also separate from this compression: `src/rollup-4h.js` writes computed statistics to the regular `metrics_rollup_4h` collection. Compression preserves access to individual measurements, while a summary represents many measurements in one statistics document.

The old regular `metrics` collection still takes up disk space. At the same moment, its `storageSize` was about 148 MiB and its indexes about 216 MiB. The few hundred summaries in `metrics_rollup_4h` are much smaller. The name of the `logicalBytes` column in the `src/monitor.js` CSV file is left over from the old regular collection; on `metrics_ts` rows it should not be read as the total BSON size of individual measurements.

## Sources

- MongoDB partial TTL: https://www.mongodb.com/docs/v8.0/core/index-ttl/
- MongoDB time-series automatic removal: https://www.mongodb.com/docs/v8.0/core/timeseries/timeseries-automatic-removal/
- MongoDB time-series data migration: https://www.mongodb.com/docs/v8.0/core/timeseries/timeseries-migrate-with-aggregation/
- MongoDB time-series compression: https://www.mongodb.com/docs/manual/core/timeseries/timeseries-compression/
