import { appendFile, open, readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { MONGO_URI, DB_NAME, COLLECTION } from './env.js';

// PID yalnızca yaşıyor diye yazıcı sayılmaz: Windows ölen sürecin PID'ini başka
// bir sürece verebilir. Komut satırında producer.js olup olmadığına da bakılır.
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
    // Komut satırı okunamazsa ikinci yazıcı başlatmamak için var kabul edilir.
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
  try { oldPid = Number((await readFile(new URL('./producer-live.pid', import.meta.url), 'utf8')).trim()); }
  catch { /* PID dosyası yoksa üretici durmuş kabul edilir. */ }
  const processExists = Number.isInteger(oldPid) && oldPid > 0 && await isProducerProcess(oldPid);
  result.previousPid = oldPid ?? null;
  if (processExists) {
    result.action = 'PROCESS_PRESENT';
  } else {
    const log = await open(new URL('./producer-recovered.log', import.meta.url), 'a');
    try {
      await log.write('\n=== Watchdog yeniden baslatti: ' + checkedAt.toISOString() + ' ===\n');
      const child = spawn(process.execPath, ['producer.js'], {
        cwd: fileURLToPath(new URL('.', import.meta.url)),
        detached: true,
        windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      await writeFile(new URL('./producer-live.pid', import.meta.url), String(child.pid));
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
await appendFile(new URL('./write-health.log', import.meta.url), line + '\n');
await writeFile(new URL('./write-health-status.json', import.meta.url), line + '\n');
console.log(line);
if (result.status === 'ERROR' || result.action === 'RESTART_FAILED' || result.action === 'PROCESS_PRESENT') process.exitCode = 1;
