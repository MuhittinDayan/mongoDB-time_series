# To do

## Make `setup` update the general TTL automatically when it is extended

**Status:** `ensureTimeSeriesCollection` in `src/lib/retention.js` throws an error and stops if the collection's general TTL (`expireAfterSeconds`) does not match `src/lib/config.js`. The value is only set from code when the collection is first created; after that it must be changed by hand with `collMod`.

**To do:**

- [ ] If the general TTL is being **extended** (new value > current value): `setup` should run `collMod` itself. This direction is safe because no data is deleted.
- [ ] If the general TTL is being **shortened**: stop and print the command, as it does now. When the period is shortened, old data is deleted in the first TTL pass, so the user must make this decision.
- [ ] Update the "How to change settings" section in the README and the report.

## Adding a new retention group (example: 32 and 72 hours)

**Warning:** Adding a new period to the `RETENTION_HOURS` array in `src/lib/config.js` changes the group of almost all 100 companies (`i % 4` → `i % 6`). The company lists of the existing partial indexes change, and old data of companies whose period gets shorter is deleted.

**To add it without data loss:**

- [ ] Build a structure that adds new companies (101, 102, …) to `src/lib/config.js` without disturbing the distribution of the existing 100 companies.
- [ ] Raise the general TTL to the new longest period (72 hours): `db.runCommand({ collMod: 'metrics_ts', expireAfterSeconds: 259200 })`. If the item above is done, `setup` does this step itself.
- [ ] `npm run setup`: the missing `ttl_32h` and `ttl_48h` are created; the existing `ttl_12h`, `ttl_24h` and `ttl_36h` are unchanged, so they are left alone.
- [ ] Restart the producer so the new companies start writing.
- [ ] Verify the new indexes and groups with `npm run inspect`.

Note: until the general TTL is raised to 72 hours and `ttl_48h` is created, data of the 48-hour companies may stay for up to 72 hours; it is not deleted early. `src/rollup-4h.js`, `src/inspect.js` and `src/monitor.js` read the groups from `src/lib/config.js`, so they need no changes.
