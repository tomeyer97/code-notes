// The Postgres pool for refunds and jobs (orders move here from SQLite one table at a time).
import pg from 'pg'

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
