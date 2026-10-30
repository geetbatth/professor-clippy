// SQLite driver smoke test: node:sqlite + FTS5, in-memory.
//
//   Node:      node scripts/sqlite-smoke.mjs
//   Electron:  ELECTRON_RUN_AS_NODE=1 npx electron scripts/sqlite-smoke.mjs
//              (or, from any shell: node scripts/run-in-electron.mjs scripts/sqlite-smoke.mjs)
//
// Prints one JSON line and exits 0 on success; exits 1 on failure.
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

/** Open an in-memory DB, build an FTS5 index and query it. Throws on failure. */
export function runSqliteSmoke() {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='rowid');
    `);
    const insert = db.prepare('INSERT INTO messages (id, body) VALUES (?, ?)');
    const index = db.prepare('INSERT INTO messages_fts (rowid, body) SELECT rowid, body FROM messages WHERE id = ?');
    for (const [id, body] of [
      ['01A', 'Deploy to production finished'],
      ['01B', 'Tests failed on the payments service'],
      ['01C', 'Remember to stretch'],
    ]) {
      insert.run(id, body);
      index.run(id);
    }
    const hits = db
      .prepare(
        `SELECT m.id, m.body FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
         WHERE messages_fts MATCH ? ORDER BY rank`,
      )
      .all('payment*');
    if (hits.length !== 1 || hits[0].id !== '01B') {
      throw new Error(`unexpected FTS5 result: ${JSON.stringify(hits)}`);
    }
    const { version } = db.prepare('SELECT sqlite_version() AS version').get();
    return {
      ok: true,
      runtime: process.versions.electron ? `electron ${process.versions.electron}` : 'node',
      node: process.versions.node,
      sqlite: version,
      fts5Hits: hits,
    };
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(runSqliteSmoke()));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
