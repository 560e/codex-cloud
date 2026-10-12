import { useEffect, useRef, useState, type RefObject, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronUp, Pencil, FileText } from 'lucide-react';

export function ComposerInput({
  value,
  onChange,
  inputRef,
  placeholder,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const lines = value.split(/\r\n|\r|\n/).length;
  const long = lines > 10;
  const [expanded, setExpanded] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const collapsed = long && !expanded;
  useEffect(() => {
    if (!long) setExpanded(false);
  }, [long]);
  useEffect(() => {
    if (collapsed && document.activeElement === document.body) toggle.current?.focus();
  }, [collapsed]);
  return (
    <>
      {long && (
        <div className="long-draft-header">
          <button
            ref={toggle}
            className="long-draft-toggle"
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展开编辑长消息' : '收起长消息'}
            onClick={() => {
              setExpanded(!expanded);
              if (!expanded) requestAnimationFrame(() => inputRef.current?.focus());
            }}
          >
            <FileText size={15} />
            <span>长消息 · {lines} 行</span>
            {collapsed ? <Pencil size={14} /> : <ChevronUp size={14} />}
            <span>{collapsed ? '展开编辑' : '收起'}</span>
          </button>
          {collapsed && (
            <p className="long-draft-preview">
              {value.split(/\r\n|\r|\n/).find((line) => line.trim()) || '空白消息'}
              <ChevronDown size={12} />
            </p>
          )}
        </div>
      )}
      {!collapsed && (
        <textarea
          ref={inputRef}
          aria-label="发送给 Codex 的消息"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          rows={long ? 10 : 3}
        />
      )}
    </>
  );
}
