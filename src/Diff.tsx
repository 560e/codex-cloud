import { memo, useMemo, useState } from 'react';
import { Columns2, Rows3, WrapText } from 'lucide-react';
import { parseDiff, type DiffLine } from '../shared/diff';
import { CopyButton } from './controls';

export const Diff = memo(function Diff({ text }: { text: string }) {
  const lines = useMemo(() => parseDiff(text), [text]);
  const [split, setSplit] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [limit, setLimit] = useState(300);
  const shown = lines.slice(0, limit);
  const pairs: { left?: DiffLine; right?: DiffLine; meta?: DiffLine }[] = [];
  if (split)
    for (let i = 0; i < shown.length; i++) {
      const line = shown[i];
      if (line.kind === 'meta') pairs.push({ meta: line });
      else if (line.kind === 'context') pairs.push({ left: line, right: line });
      else {
        const removed: DiffLine[] = [],
          added: DiffLine[] = [];
        while (i < shown.length && ['add', 'remove'].includes(shown[i].kind)) {
          (shown[i].kind === 'add' ? added : removed).push(shown[i]);
          i++;
        }
        i--;
        for (let j = 0; j < Math.max(removed.length, added.length); j++)
          pairs.push({ left: removed[j], right: added[j] });
      }
    }
  return (
    <div className={'diff-view ' + (wrap ? 'wrap' : 'nowrap')}>
      <div className="diff-toolbar">
        <span className="diff-counts">
          <b className="green-text">+{lines.filter((l) => l.kind === 'add').length}</b>
          <b className="error-text">−{lines.filter((l) => l.kind === 'remove').length}</b>
        </span>
        <div className="button-row">
          <button
            className="icon-btn"
            aria-label={split ? '切换统一对比' : '切换并排对比'}
            title={split ? '统一对比' : '并排对比'}
            onClick={() => setSplit(!split)}
          >
            {split ? <Rows3 size={15} /> : <Columns2 size={15} />}
          </button>
          <button
            className={'icon-btn ' + (wrap ? 'active' : '')}
            aria-label="差异自动换行"
            aria-pressed={wrap}
            title="差异自动换行"
            onClick={() => setWrap(!wrap)}
          >
            <WrapText size={15} />
          </button>
          <CopyButton text={text} label="复制差异" />
        </div>
      </div>
      <div className="diff-scroll" tabIndex={0} aria-label="文件差异">
        {!text.trim() ? (
          <p className="muted diff-empty">没有可展示的文本差异</p>
        ) : split ? (
          <div className="diff-split" role="table" aria-label="并排差异">
            <div className="diff-split-head" role="row">
              <span role="columnheader">修改前</span>
              <span role="columnheader">修改后</span>
            </div>
            {pairs.map((p, i) =>
              p.meta ? (
                <div className="diff-meta" key={i} role="row">
                  <span role="cell" aria-colspan={2}>
                    {p.meta.text}
                  </span>
                </div>
              ) : (
                <div className="diff-pair" key={i} role="row">
                  {[p.left, p.right].map((line, side) => (
                    <div
                      key={side}
                      role="cell"
                      className={'diff-cell ' + (line ? 'line-' + line.kind : 'line-empty')}
                    >
                      <span className="line-number" aria-hidden="true">
                        {side === 0 ? line?.oldLine : line?.newLine}
                      </span>
                      <code>{line?.text || ' '}</code>
                    </div>
                  ))}
                </div>
              ),
            )}
          </div>
        ) : (
          <div className="diff-unified">
            {shown.map((line, i) =>
              line.kind === 'meta' ? (
                <div className="diff-meta" key={i}>
                  {line.text}
                </div>
              ) : (
                <div className={'diff-line line-' + line.kind} key={i}>
                  <span className="line-number" aria-hidden="true">
                    {line.oldLine}
                  </span>
                  <span className="line-number" aria-hidden="true">
                    {line.newLine}
                  </span>
                  <span className="diff-sign">
                    {line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}
                  </span>
                  <code>{line.text || ' '}</code>
                </div>
              ),
            )}
          </div>
        )}
      </div>
      {lines.length > limit && (
        <button className="text-button diff-more" onClick={() => setLimit((n) => n + 300)}>
          显示更多差异（剩余 {lines.length - limit} 行）
        </button>
      )}
    </div>
  );
});
