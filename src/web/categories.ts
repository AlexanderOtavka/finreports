import type { CategoryDto } from "../shared/api.js";

/** The category tree, indexed for the UI. */
export class CategoryTree {
  readonly byId: Map<string, CategoryDto>;
  readonly tops: CategoryDto[];
  readonly children: Map<string, CategoryDto[]>;

  constructor(readonly all: CategoryDto[]) {
    this.byId = new Map(all.map((c) => [c.id, c]));
    this.tops = all.filter((c) => !c.parentId);
    this.children = new Map();
    for (const c of all) {
      if (!c.parentId) continue;
      const list = this.children.get(c.parentId) ?? [];
      list.push(c);
      this.children.set(c.parentId, list);
    }
  }

  name(id: string | null): string {
    if (!id) return "Uncategorized";
    return this.byId.get(id)?.name ?? id;
  }

  /** "Food and Drink › Groceries" */
  path(id: string | null): string {
    if (!id) return "Uncategorized";
    const c = this.byId.get(id);
    if (!c) return id;
    const parent = c.parentId ? this.byId.get(c.parentId) : undefined;
    return parent ? `${parent.name} › ${c.name}` : c.name;
  }

  parentName(id: string | null): string | null {
    const c = id ? this.byId.get(id) : undefined;
    return c?.parentId ? (this.byId.get(c.parentId)?.name ?? null) : null;
  }

  /** Categories whose name (or parent's name) contains every word of `query`. */
  search(query: string): CategoryDto[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    return this.all.filter((c) => {
      const hay = `${c.name} ${c.parentId ? this.name(c.parentId) : ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
}
