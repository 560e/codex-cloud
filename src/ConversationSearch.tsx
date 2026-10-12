import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { ArrowDown, ArrowUp, Search, X } from 'lucide-react';

const allHighlight = 'codex-cloud-conversation-search';
const activeHighlight = 'codex-cloud-conversation-search-active';

function clearHighlights() {
  CSS.highlights?.delete(allHighlight);
  CSS.highlights?.delete(activeHighlight);
}

function findMatches(container: HTMLElement, query: string): Range[] {
  const matches: Range[] = [];
  const needle = query.toLocaleLowerCase();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
      if (parent.closest('button, script, style, textarea, .message-actions, .working-indicator'))
        return NodeFilter.FILTER_REJECT;
      const closed = parent.closest('details:not([open])');
      if (closed && !parent.closest('summary')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode()) && matches.length < 2000) {
    const text = node.textContent?.toLocaleLowerCase() || '';
    let offset = 0;
    while ((offset = text.indexOf(needle, offset)) !== -1 && matches.length < 2000) {
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + query.length);
      matches.push(range);
      offset += Math.max(query.length, 1);
    }
  }
  return matches;
}

export function ConversationSearch({
  container,
  loading,
  error,
  onClose,
}: {
  container: RefObject<HTMLDivElement | null>;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [active, setActive] = useState(0);
  const matches = useRef<Range[]>([]);
  const input = useRef<HTMLInputElement>(null);

  const reveal = useCallback(
    (index: number) => {
      const range = matches.current[index];
      const viewport = container.current;
      if (!range || !viewport) return;
      setActive(index);
      if (CSS.highlights) CSS.highlights.set(activeHighlight, new Highlight(range));
      const target = range.getBoundingClientRect();
      const frame = viewport.getBoundingClientRect();
      viewport.scrollTo({
        top: viewport.scrollTop + target.top - frame.top - frame.height / 2,
        behavior: 'smooth',
      });
    },
    [container],
  );

  useEffect(() => {
    input.current?.focus();
    return clearHighlights;
  }, []);

  useEffect(() => {
    const viewport = container.current;
    if (!viewport || !query.trim()) {
      matches.current = [];
      clearHighlights();
      setCount(0);
      setActive(0);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      const found = findMatches(viewport, query.trim());
      matches.current = found;
      setCount(found.length);
      setActive(0);
      if (CSS.highlights) {
        if (found.length) CSS.highlights.set(allHighlight, new Highlight(...found));
        else CSS.highlights.delete(allHighlight);
      }
      if (found.length) reveal(0);
      else CSS.highlights?.delete(activeHighlight);
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(update, 120);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(viewport, { childList: true, characterData: true, subtree: true });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      clearHighlights();
    };
  }, [container, query, reveal]);

  function move(step: number) {
    if (matches.current.length)
      reveal((active + step + matches.current.length) % matches.current.length);
  }

  return (
    <div
      className="conversation-search"
      role="dialog"
      aria-label="搜索当前会话"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className="conversation-search-heading">
        <strong>搜索当前会话</strong>
        <button className="icon-btn" aria-label="关闭搜索" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <div className="conversation-search-controls">
        <Search size={17} aria-hidden="true" />
        <input
          ref={input}
          aria-label="搜索关键词"
          placeholder="搜索当前会话内容"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            }
          }}
        />
      </div>
      <div className="conversation-search-footer">
        <span className="conversation-search-count" aria-live="polite">
          {query.trim()
            ? count
              ? `${active + 1} / ${count}`
              : loading
                ? '搜索中…'
                : '无匹配'
            : '输入关键词'}
        </span>
        <div className="conversation-search-navigation">
          <button
            className="conversation-search-nav"
            aria-label="上一个匹配"
            disabled={!count}
            onClick={() => move(-1)}
          >
            <ArrowUp size={16} />
            上一个
          </button>
          <button
            className="conversation-search-nav"
            aria-label="下一个匹配"
            disabled={!count}
            onClick={() => move(1)}
          >
            <ArrowDown size={16} />
            下一个
          </button>
        </div>
      </div>
      {loading && <small>正在加载完整会话历史…</small>}
      {error && <small className="error-text">历史加载失败：{error}。可搜索已加载的内容。</small>}
    </div>
  );
}
