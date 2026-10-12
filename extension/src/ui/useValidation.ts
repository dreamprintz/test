import { useEffect, useRef, useState } from 'react';
import type { CountryCode } from 'libphonenumber-js';
import { validateRows, type ColumnMapping, type ImportRow, type ParsedCsv } from '../lib/csv';
import type { ValidateRequest } from '../lib/validate.worker';

/** Validates rows in a Web Worker (debounced) so large files don't freeze the page. */
export function useValidation(parsed: ParsedCsv | null, mapping: ColumnMapping[], defaultCountry: CountryCode, existing: Map<string, string>, suppressed: Set<string>) {
  const [state, setState] = useState<{ rows: ImportRow[]; error?: string; validating: boolean }>({ rows: [], validating: false });
  const worker = useRef<Worker | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    try {
      worker.current = new Worker(new URL('../lib/validate.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      worker.current = null; // fall back to main thread
    }
    return () => worker.current?.terminate();
  }, []);

  useEffect(() => {
    if (!parsed) {
      setState({ rows: [], validating: false });
      return;
    }
    if (mapping.filter((m) => m.target === 'phone').length !== 1) {
      setState({ rows: [], error: 'Map exactly one column to Phone.', validating: false });
      return;
    }
    const id = ++seq.current;
    setState((s) => ({ ...s, validating: true }));
    const timer = setTimeout(() => {
      const w = worker.current;
      if (!w) {
        try {
          setState({ rows: validateRows(parsed, mapping, { defaultCountry, existingPhones: existing, suppressedPhones: suppressed }), validating: false });
        } catch (e) {
          setState({ rows: [], error: e instanceof Error ? e.message : String(e), validating: false });
        }
        return;
      }
      w.onmessage = (e: MessageEvent<{ id: number; rows?: ImportRow[]; error?: string }>) => {
        if (e.data.id !== seq.current) return; // stale result
        setState(e.data.error ? { rows: [], error: e.data.error, validating: false } : { rows: e.data.rows ?? [], validating: false });
      };
      const req: ValidateRequest = { id, parsed, mapping, defaultCountry, existing: [...existing], suppressed: [...suppressed] };
      w.postMessage(req);
    }, 250);
    return () => clearTimeout(timer);
  }, [parsed, mapping, defaultCountry, existing, suppressed]);

  return state;
}
