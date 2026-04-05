export async function query<T>(
  db: D1Database,
  sql: string,
  params: (string | number | null)[] = []
): Promise<T[]> {
  const result = await db.prepare(sql).bind(...params).all<T>();
  return result.results;
}

export async function queryOne<T>(
  db: D1Database,
  sql: string,
  params: (string | number | null)[] = []
): Promise<T | null> {
  const result = await db.prepare(sql).bind(...params).first<T>();
  return result ?? null;
}

export async function run(
  db: D1Database,
  sql: string,
  params: (string | number | null)[] = []
): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}