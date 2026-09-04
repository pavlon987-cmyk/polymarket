import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';

const pg = new EmbeddedPostgres({
  databaseDir: './.pgdata',
  port: 5432,
  user: 'postgres',
  password: 'postgres',
  persistent: true,
});

if (!existsSync('./.pgdata/PG_VERSION')) {
  console.log('Initialising PostgreSQL cluster in ./.pgdata ...');
  await pg.initialise();
}

console.log('Starting PostgreSQL on 127.0.0.1:5432...');
await pg.start();

const client = pg.getPgClient('postgres');
await client.connect();

try {
  const res = await client.query("SELECT 1 FROM pg_database WHERE datname = 'app_db'");
  if (res.rowCount === 0) {
    console.log('Creating database "app_db" with UTF-8 encoding...');
    await client.query("CREATE DATABASE app_db WITH ENCODING 'UTF8' TEMPLATE template0");
    console.log('Database "app_db" created with UTF-8 encoding.');
  } else {
    console.log('Database "app_db" is ready.');
  }
} catch (err) {
  console.error('Database setup note:', err.message);
} finally {
  await client.end();
}

console.log('SUCCESS: PostgreSQL is ready and listening on 127.0.0.1:5432!');

// Keep alive if run as service / background daemon
if (process.argv.includes('--daemon')) {
  console.log('Database running in daemon mode. Press Ctrl+C to stop.');
  setInterval(() => {}, 10000);
}
