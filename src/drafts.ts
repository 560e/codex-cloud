import { useCallback, useEffect, useState, type SetStateAction } from 'react';
import type { Attachment } from '../shared/types';

type Draft = {
  text: string;
  references: string[];
  attachments: Attachment[];
  fileReferences: string[];
};
const storageKey = 'workbench-drafts';
const empty: Draft = { text: '', references: [], attachments: [], fileReferences: [] };
export function clearDrafts() {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    /* Memory-only browser. */
  }
}
function readDrafts(): Record<string, Draft> {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .map(
          ([key, d]) =>
            [
              key,
              {
                ...d,
                fileReferences: Array.isArray(d?.fileReferences)
                  ? d.fileReferences.filter((r: unknown) => typeof r === 'string').slice(0, 10)
                  : [],
              },
            ] as [string, Draft],
        )
        .filter((entry): entry is [string, Draft] => {
          const d = entry[1];
          return (
            !!d &&
            typeof d === 'object' &&
            typeof d.text === 'string' &&
            Array.isArray(d.references) &&
            d.references.every((r: unknown) => typeof r === 'string') &&
            Array.isArray(d.attachments) &&
            d.attachments.every(
              (a: Attachment) => a && typeof a.id === 'string' && typeof a.name === 'string',
            )
          );
        }),
    );
  } catch {
    return {};
  }
}

// Session storage is isolated to this tab and cleared on logout. Each composer
// owns a separate draft, so async completions can update the original key safely.
export function useComposerDraft(key: string) {
  const [drafts, setDrafts] = useState(readDrafts);
  const draft = drafts[key] || empty;
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(drafts));
    } catch {
      /* Keep drafts in memory when browser storage is unavailable/full. */
    }
  }, [drafts]);
  const update = useCallback(
    <K extends keyof Draft>(field: K, value: SetStateAction<Draft[K]>, target = key) => {
      setDrafts((old) => {
        const current = old[target] || empty;
        const next =
          typeof value === 'function'
            ? (value as (previous: Draft[K]) => Draft[K])(current[field])
            : value;
        return { ...old, [target]: { ...current, [field]: next } };
      });
    },
    [key],
  );
  const setDraft = useCallback(
    (v: SetStateAction<string>, target?: string) => update('text', v, target),
    [update],
  );
  const setReferences = useCallback(
    (v: SetStateAction<string[]>, target?: string) => update('references', v, target),
    [update],
  );
  const setAttachments = useCallback(
    (v: SetStateAction<Attachment[]>, target?: string) => update('attachments', v, target),
    [update],
  );
  const setFileReferences = useCallback(
    (v: SetStateAction<string[]>, target?: string) => update('fileReferences', v, target),
    [update],
  );
  function moveTo(target: string) {
    setDrafts((old) => {
      const result = { ...old, [target]: old[key] || empty };
      delete result[key];
      return result;
    });
  }
  function forget(target: string) {
    setDrafts((old) => {
      const result = { ...old };
      delete result[target];
      return result;
    });
  }
  return {
    draft: draft.text,
    references: draft.references,
    attachments: draft.attachments,
    fileReferences: draft.fileReferences,
    setFileReferences,
    setDraft,
    setReferences,
    setAttachments,
    moveTo,
    forget,
  };
}
