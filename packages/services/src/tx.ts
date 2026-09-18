import type pg from 'pg';

/**
 * Runs `fn` inside a database transaction. All service mutations use this so
 * that the state change and its audit event commit or roll back together
 * (working rule 7 — no state change without its audit row).
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
