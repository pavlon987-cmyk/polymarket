import EmbeddedPostgres from 'embedded-postgres';

const pg = new EmbeddedPostgres({
  databaseDir: './.pgdata',
  port: 5432,
  user: 'postgres',
  password: 'postgres',
  persistent: true,
});

await pg.start();
const client = pg.getPgClient('app_db');
await client.connect();

await client.query('CREATE TABLE IF NOT EXISTS test (name text)');
await client.query('INSERT INTO test VALUES ($1)', ['🎮 Esports LoL Sniper']);
const res = await client.query('SELECT * FROM test');
console.log('SUCCESS! Read from UTF-8 app_db:', res.rows[res.rows.length - 1]);

await client.query('DROP TABLE test');
await client.end();
await pg.stop();
