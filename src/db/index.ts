import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.SQL_HOST || undefined,
  database: process.env.SQL_DB_NAME || undefined,
  user: process.env.SQL_USER || undefined,
  password: process.env.SQL_PASSWORD || undefined,
  port: 5432,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const db = drizzle(pool, { schema });
export { pool };
