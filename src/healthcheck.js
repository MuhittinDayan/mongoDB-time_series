// Checks that data is still being written and restarts a stopped producer.
// Runs once per invocation; the MongoRetentionWriteCheck scheduled task calls it.

import { appendFile, open, readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { MongoClient } from 'mongodb';
import { MONGO_URI, DB_NAME, COLLECTION } from './lib/env.js';
import {
  PRODUCER_PID_FILE,
  PRODUCER_RECOVERED_LOG,
  PRODUCER_SCRIPT,
  ROOT_DIR,
  WRITE_HEALTH_LOG,
  WRITE_HEALTH_STATUS,
} from './lib/paths.js';

// A live PID alone does not prove it is the producer: Windows can reassign a dead
// process's PID to another process. The command line is also checked for producer.js.
async function isProducerProcess(pid) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; }
  try {
    const commandLine = process.platform === 'win32'
      ? (await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { windowsHide: true, timeout: 30000 })).stdout
      : await readFile(`/proc/${pid}/cmdline`, 'utf8');
    return /producer\.js/.test(commandLine);
  } catch {
    // If the command line cannot be read, assume it exists so a second producer is not started.
    return true;
  }
}

const checkedAt = new Date();
const maxAgeSeconds = Number(process.env.HEALTH_MAX_AGE_SECONDS ?? 120);
const result = { checkedAt: checkedAt.toISOString(), status: 'ERROR' };
const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
try {
  await client.connect();
  const latest = await client.db(DB_NAME).collection(COLLECTION)
    .findOne({ retentionDemo: true, companyId: 1 },
      { sort: { ts: -1 }, projection: { ts: 1, companyId: 1 } });
  result.lastWrite = latest?.ts?.toISOString() ?? null;
  result.companyId = latest?.companyId ?? null;
  result.ageSeconds = latest?.ts ? Math.round((checkedAt - latest.ts) / 1000) : null;
  result.status = result.ageSeconds != null && result.ageSeconds <= maxAgeSeconds ? 'OK' : 'STALE';
} catch (error) {
  result.error = error.message;
} finally {
  await client.close();
}

if (result.status === 'STALE') {
  let oldPid;
  try { oldPid = Number((await readFile(PRODUCER_PID_FILE, 'utf8')).trim()); }
  catch { /* Without a PID file, the producer is assumed to be stopped. */ }
  const processExists = Number.isInteger(oldPid) && oldPid > 0 && await isProducerProcess(oldPid);
  result.previousPid = oldPid ?? null;
  if (processExists) {
    result.action = 'PROCESS_PRESENT';
  } else {
    const log = await open(PRODUCER_RECOVERED_LOG, 'a');
    try {
      await log.write('\n=== Watchdog restarted the producer: ' + checkedAt.toISOString() + ' ===\n');
      const child = spawn(process.execPath, [PRODUCER_SCRIPT], {
        cwd: ROOT_DIR,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      await writeFile(PRODUCER_PID_FILE, String(child.pid));
      result.action = 'RESTARTED';
      result.newPid = child.pid;
    } catch (error) {
      result.action = 'RESTART_FAILED';
      result.error = error.message;
    } finally {
      await log.close();
    }
  }
}

const line = JSON.stringify(result);
await appendFile(WRITE_HEALTH_LOG, line + '\n');
await writeFile(WRITE_HEALTH_STATUS, line + '\n');
console.log(line);
if (result.status === 'ERROR' || result.action === 'RESTART_FAILED' || result.action === 'PROCESS_PRESENT') process.exitCode = 1;
