import type { CategoryDto } from "../shared/api.js";
import { detailedCategoryId, primaryCategoryId, taxonomySeed, type CategoryKind } from "../shared/taxonomy.js";
import type { Queryable } from "./db.js";
import { HttpError } from "./errors.js";

/** Inserts the Plaid taxonomy; existing rows (possibly renamed) are left alone. */
export async function seedCategories(db: Queryable): Promise<number> {
  let inserted = 0;
  for (const c of taxonomySeed()) {
    const res = await db.query(
      `INSERT INTO category (id, parent_id, name, kind, plaid_primary, plaid_detailed, sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [c.id, c.parentId, c.name, c.kind, c.plaidPrimary, c.plaidDetailed, c.sort],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

interface CategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
  kind: CategoryKind;
  sort: number;
}

export async function listCategories(db: Queryable): Promise<CategoryDto[]> {
  const res = await db.query<CategoryRow>(
    "SELECT id, parent_id, name, kind, sort FROM category WHERE NOT archived ORDER BY sort, name",
  );
  return res.rows.map((r) => ({ id: r.id, parentId: r.parent_id, name: r.name, kind: r.kind, sort: r.sort }));
}

/** Name → id and id → name for every category, archived included. */
export class CategoryIndex {
  private constructor(
    private readonly byName: Map<string, string>,
    private readonly byId: Map<string, { name: string; parentId: string | null }>,
  ) {}

  static async load(db: Queryable): Promise<CategoryIndex> {
    const res = await db.query<{ id: string; name: string; parent_id: string | null }>(
      "SELECT id, name, parent_id FROM category",
    );
    return new CategoryIndex(
      new Map(res.rows.map((r) => [r.name.toLowerCase(), r.id])),
      new Map(res.rows.map((r) => [r.id, { name: r.name, parentId: r.parent_id }])),
    );
  }

  idForName(name: string | null): string | null {
    return name ? (this.byName.get(name.toLowerCase()) ?? null) : null;
  }

  nameFor(id: string): string | null {
    return this.byId.get(id)?.name ?? null;
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** The leaf for a Plaid category, falling back to its primary. */
  idForPlaid(plaid: { primary: string; detailed: string } | null): string | null {
    if (!plaid) return null;
    const leaf = detailedCategoryId(plaid.primary, plaid.detailed);
    if (this.byId.has(leaf)) return leaf;
    const top = primaryCategoryId(plaid.primary);
    return this.byId.has(top) ? top : null;
  }
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "category"
  );
}

/**
 * Creates a category. The tree is two levels deep (reports drill top-level → subcategory),
 * so a parent must itself be top-level.
 */
export async function createCategory(
  db: Queryable,
  input: { name: string; parentId: string | null; kind?: CategoryKind },
): Promise<CategoryDto> {
  const name = input.name.trim();
  if (!name) throw new HttpError(400, "name is required");
  let kind: CategoryKind = input.kind ?? "expense";
  let idBase = slugify(name);
  if (input.parentId) {
    const parent = await db.query<{ parent_id: string | null; kind: CategoryKind }>(
      "SELECT parent_id, kind FROM category WHERE id = $1",
      [input.parentId],
    );
    const row = parent.rows[0];
    if (!row) throw new HttpError(400, "unknown parent category");
    if (row.parent_id) throw new HttpError(400, "categories nest one level deep: pick a top-level parent");
    kind = input.kind ?? row.kind;
    idBase = `${input.parentId}.${idBase}`;
  }
  const existing = await db.query("SELECT 1 FROM category WHERE lower(name) = lower($1)", [name]);
  if (existing.rowCount) throw new HttpError(409, "a category with that name exists");
  let id = idBase;
  for (let n = 2; (await db.query("SELECT 1 FROM category WHERE id = $1", [id])).rowCount; n += 1) id = `${idBase}-${n}`;
  const sort = await db.query<{ sort: number }>(
    "SELECT coalesce(max(sort), 0) + 1 AS sort FROM category WHERE parent_id IS NOT DISTINCT FROM $1",
    [input.parentId],
  );
  await db.query("INSERT INTO category (id, parent_id, name, kind, sort) VALUES ($1, $2, $3, $4, $5)", [
    id,
    input.parentId,
    name,
    kind,
    sort.rows[0]!.sort,
  ]);
  return { id, parentId: input.parentId, name, kind, sort: sort.rows[0]!.sort };
}

/** Makes sure every category name the backend uses exists in the tree (top-level, as expense). */
export async function ensureBackendCategories(db: Queryable, names: Iterable<string>): Promise<number> {
  let created = 0;
  for (const raw of new Set(names)) {
    const name = raw.trim();
    if (!name) continue;
    const found = await db.query("SELECT 1 FROM category WHERE lower(name) = lower($1)", [name]);
    if (found.rowCount) continue;
    await createCategory(db, { name, parentId: null });
    created += 1;
  }
  return created;
}
