import { Button } from './components';

export function usePage<T>(items: T[], page: number, size = 50) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(page, pages - 1);
  return { slice: items.slice(p * size, p * size + size), pages, page: p };
}

export function Pager({ page, pages, onPage, total }: { page: number; pages: number; onPage: (p: number) => void; total: number }) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2 text-sm dark:border-slate-800">
      <span className="text-slate-500">{total.toLocaleString()} items · page {page + 1} of {pages}</span>
      <div className="flex gap-2">
        <Button size="sm" disabled={page === 0} onClick={() => onPage(page - 1)}>Previous</Button>
        <Button size="sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  );
}
