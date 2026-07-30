import { pool } from './db';
import type { IocType, UpsertInput } from './validation';

/** A row as stored/returned. `value` is always the normalized form. */
export interface IocRecord {
  type: IocType;
  value: string;
  source: string;
  score: number;
  added_at: string;
}

/**
 * Point lookup by (type, value). Parameterized query — no string interpolation,
 * so SQL injection is structurally impossible regardless of input.
 */
export async function findIoc(type: IocType, value: string): Promise<IocRecord | null> {
  const { rows } = await pool.query<IocRecord>(
    `SELECT type, value, source, score, added_at
       FROM ioc
      WHERE type = $1 AND value = $2`,
    [type, value],
  );
  return rows[0] ?? null;
}

/** Idempotent upsert (safe to retry) — ON CONFLICT updates the existing row. */
export async function upsertIoc(input: UpsertInput): Promise<IocRecord> {
  const { rows } = await pool.query<IocRecord>(
    `INSERT INTO ioc (type, value, source, score)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (type, value)
     DO UPDATE SET source = EXCLUDED.source, score = EXCLUDED.score, added_at = now()
       RETURNING type, value, source, score, added_at`,
    [input.type, input.value, input.source, input.score],
  );
  // INSERT ... RETURNING always yields exactly one row.
  return rows[0] as IocRecord;
}
