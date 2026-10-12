import type { FileChange } from './types.js';

export function diffCounts(text: string) {
  const lines = parseDiff(text);
  return {
    added: lines.filter((line) => line.kind === 'add').length,
    removed: lines.filter((line) => line.kind === 'remove').length,
  };
}

// Turn-level diffs may arrive without individual fileChange items.
export function diffFiles(text: string): FileChange[] {
  const blocks = text.split(/(?=^diff --git )/m).filter((block) => block.trim());
  if (blocks.length === 1 && !blocks[0].startsWith('diff --git ')) {
    const raw = text.replace(/\r\n/g, '\n').split('\n');
    const parsed = parseDiff(text);
    const starts = parsed.flatMap((line, index) =>
      line.kind === 'meta' &&
      line.text.startsWith('--- ') &&
      parsed[index + 1]?.kind === 'meta' &&
      parsed[index + 1]?.text.startsWith('+++ ')
        ? [index]
        : [],
    );
    if (starts.length > 1)
      return starts.flatMap((start, index) =>
        diffFiles(raw.slice(start, starts[index + 1] ?? raw.length).join('\n')),
      );
  }
  const decode = (value: string) => {
    const trimmed = value.split('\t')[0].trim();
    try {
      return trimmed.startsWith('"') ? (JSON.parse(trimmed) as string) : trimmed;
    } catch {
      return trimmed;
    }
  };
  return blocks.flatMap((block) => {
    const oldPath = /^--- (.+)$/m.exec(block)?.[1];
    const newPath = /^\+\+\+ (.+)$/m.exec(block)?.[1];
    const moved = /^rename to (.+)$/m.exec(block)?.[1];
    const git = /^diff --git ("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.+)$/m.exec(block);
    const from = oldPath ? decode(oldPath) : git ? decode(git[1]) : '';
    const to = newPath ? decode(newPath) : git ? decode(git[2]) : moved || '';
    const type =
      from === '/dev/null' || /^new file mode /m.test(block)
        ? 'add'
        : to === '/dev/null' || /^deleted file mode /m.test(block)
          ? 'delete'
          : 'update';
    const name = type === 'delete' ? from : to || from;
    if (!name || name === '/dev/null') return [];
    return [
      {
        path: name.replace(/^[ab]\//, ''),
        kind: { type, ...(moved ? { move_path: decode(moved) } : {}) },
        diff: block,
      },
    ];
  });
}

export type DiffLine = {
  kind: 'add' | 'remove' | 'context' | 'meta';
  text: string;
  oldLine?: number;
  newLine?: number;
};
export function parseDiff(text: string): DiffLine[] {
  let oldLine = 0,
    newLine = 0,
    inHunk = false,
    oldRemaining = 0,
    newRemaining = 0;
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[3]);
        oldRemaining = Number(hunk[2] ?? 1);
        newRemaining = Number(hunk[4] ?? 1);
        inHunk = true;
        return { kind: 'meta', text: line };
      }
      if (
        line.startsWith('diff --git ') ||
        (!inHunk && /^(--- |\+\+\+ |index |new file|deleted file|rename |similarity )/.test(line))
      ) {
        inHunk = false;
        return { kind: 'meta', text: line };
      }
      let result: DiffLine | undefined;
      if (line.startsWith('+')) {
        result = { kind: 'add', text: line.slice(1), ...(inHunk ? { newLine: newLine++ } : {}) };
        newRemaining--;
      } else if (line.startsWith('-')) {
        result = { kind: 'remove', text: line.slice(1), ...(inHunk ? { oldLine: oldLine++ } : {}) };
        oldRemaining--;
      } else if (inHunk && line.startsWith(' ')) {
        result = { kind: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ };
        oldRemaining--;
        newRemaining--;
      }
      if (oldRemaining <= 0 && newRemaining <= 0) inHunk = false;
      if (result) return result;
      return { kind: 'meta', text: line };
    });
}
