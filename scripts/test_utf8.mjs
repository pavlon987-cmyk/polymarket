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
  console.log('Initialising standard cluster...');
  await pg.initialise();
}

console.log('Starting cluster...');
await pg.start();

const client = pg.getPgClient('postgres');
await client.connect();

try {
  await client.query('DROP DATABASE IF EXISTS app_db');
  console.log('Attempting CREATE DATABASE app_db WITH ENCODING UTF8 ...');
  await client.query("CREATE DATABASE app_db WITH ENCODING 'UTF8' TEMPLATE template0");
  console.log('SUCCESS! app_db created with ENCODING UTF8!');
} catch (err) {
  console.error('Failed to create with UTF8:', err.message);
} finally {
  await client.end();
  await pg.stop();
}
