export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function paginate<T>(items: T[], total: number, page: number, pageSize: number): Paginated<T> {
  return { items, total, page, pageSize };
}
