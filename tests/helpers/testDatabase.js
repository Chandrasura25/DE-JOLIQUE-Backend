import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Starts a throwaway real Postgres server for integration tests. */
export async function startTestDatabase() {
  const port = await freePort();
  const databaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jolique-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir,
    port,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('jolique_test');

  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/jolique_test`,
    async stop() {
      // pg.stop() can hang on Windows; fall back to killing the postmaster.
      const stopped = await Promise.race([
        pg.stop().then(() => true, () => false),
        new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (!stopped) {
        const pidFile = await fs.readFile(path.join(databaseDir, 'postmaster.pid'), 'utf8').catch(() => '');
        const pid = Number.parseInt(pidFile.split('\n')[0], 10);
        if (pid) {
          try {
            // Kill the whole tree so Postgres worker processes don't linger.
            if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
            else process.kill(pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }
      await fs.rm(databaseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
  };
}
