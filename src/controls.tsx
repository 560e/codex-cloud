import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Copy, WrapText } from 'lucide-react';

export function CopyButton({
  text,
  label = '复制',
  textLabel,
  compact = true,
}: {
  text: string;
  label?: string;
  textLabel?: string;
  compact?: boolean;
}) {
  const [result, setResult] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const focused = document.activeElement as HTMLElement | null;
        const input = document.createElement('textarea');
        input.value = text;
        input.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.append(input);
        try {
          input.select();
          if (!document.execCommand('copy')) throw new Error('clipboard');
        } finally {
          input.remove();
          focused?.focus();
        }
      }
      setResult('已复制');
    } catch {
      setResult('复制失败，请选中文本复制');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult(''), 2200);
  }
  return (
    <span className="copy-control">
      <button
        type="button"
        className={compact ? 'icon-btn' : 'message-action'}
        aria-label={label}
        title={result || label}
        onClick={() => void copy()}
      >
        {result === '已复制' ? <Check size={14} /> : <Copy size={14} />}
        {!compact && <span>{result === '已复制' ? result : textLabel || label}</span>}
      </button>
      <span className={result.startsWith('复制失败') ? 'copy-error' : 'sr-only'} role="status">
        {result}
      </span>
    </span>
  );
}

export function CodeBlock({
  text,
  language = 'text',
  children,
  preClassName = '',
}: {
  text: string;
  language?: string;
  children?: ReactNode;
  preClassName?: string;
}) {
  const [wrap, setWrap] = useState(true);
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language}</span>
        <div className="button-row">
          <button
            type="button"
            className={'icon-btn ' + (wrap ? 'active' : '')}
            aria-label="自动换行"
            aria-pressed={wrap}
            title={wrap ? '关闭自动换行' : '开启自动换行'}
            onClick={() => setWrap(!wrap)}
          >
            <WrapText size={14} />
          </button>
          <CopyButton text={text} label="复制代码" />
        </div>
      </div>
      <pre className={(wrap ? 'code-wrap ' : 'code-nowrap ') + preClassName} tabIndex={0}>
        {children || <code>{text}</code>}
      </pre>
    </div>
  );
}

export type SelectOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};
export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 240, maxHeight: 300 });
  const typed = useRef({ text: '', at: 0 });
  const selected = options.find((o) => o.value === value);
  function close(restore = false) {
    setOpen(false);
    if (restore) trigger.current?.focus();
  }
  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close(true);
  }
  function show() {
    if (disabled) return;
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value && !o.disabled),
      ),
    );
    setOpen(true);
  }
  function move(delta: number) {
    let index = active;
    for (let i = 0; i < options.length; i++) {
      index = (index + delta + options.length) % options.length;
      if (!options[index].disabled) {
        setActive(index);
        break;
      }
    }
  }
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 12;
      const top = (viewport?.offsetTop ?? 0) + 12;
      const right = left + (viewport?.width ?? innerWidth) - 24;
      const bottom = top + (viewport?.height ?? innerHeight) - 24;
      const below = Math.max(0, bottom - rect.bottom - 6);
      const above = Math.max(0, rect.top - top - 6);
      const up = below < Math.min(240, options.length * 44 + 12) && above > below;
      const height = Math.max(0, Math.min(320, up ? above : below, bottom - top));
      const width = Math.max(0, Math.min(Math.max(rect.width, 240), right - left));
      setPosition({
        left: Math.max(left, Math.min(rect.left, right - width)),
        top: up
          ? Math.max(
              top,
              Math.min(
                bottom - height,
                rect.top - Math.min(height, popup.current?.scrollHeight || height) - 6,
              ),
            )
          : Math.max(top, Math.min(rect.bottom + 6, bottom - height)),
        width,
        maxHeight: height,
      });
    };
    update();
    const pointer = (e: PointerEvent) => {
      if (
        !trigger.current?.contains(e.target as Node) &&
        !popup.current?.contains(e.target as Node)
      )
        close();
    };
    const focus = (e: FocusEvent) => {
      if (
        !trigger.current?.contains(e.target as Node) &&
        !popup.current?.contains(e.target as Node)
      )
        close();
    };
    const scroll = (e: Event) => {
      if (!popup.current?.contains(e.target as Node)) update();
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('focusin', focus);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('focusin', focus);
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [open, options.length]);
  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, id]);
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={'select-trigger ' + (open ? 'is-open' : '')}
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        disabled={disabled}
        title={selected?.label || label}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            close();
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            close(true);
            return;
          }
          if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(e.key)) {
            e.preventDefault();
            if (!open) {
              show();
              return;
            }
            if (e.key === 'Enter' || e.key === ' ') choose(active);
            else if (e.key === 'Home')
              setActive(
                Math.max(
                  0,
                  options.findIndex((o) => !o.disabled),
                ),
              );
            else if (e.key === 'End') setActive(options.findLastIndex((o) => !o.disabled));
            else move(e.key === 'ArrowDown' ? 1 : -1);
          } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            typed.current = {
              text:
                (Date.now() - typed.current.at < 700 ? typed.current.text : '') +
                e.key.toLowerCase(),
              at: Date.now(),
            };
            const i = options.findIndex(
              (o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.text),
            );
            if (!open) show();
            if (i >= 0) setActive(i);
          }
        }}
      >
        <span>{selected?.label || value || label}</span>
        <ChevronDown size={14} />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            id={id}
            className="select-popup"
            role="listbox"
            aria-label={label}
            style={position}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${id}-${index}`}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                className={
                  'select-option ' +
                  (index === active ? 'highlighted ' : '') +
                  (option.value === value ? 'selected' : '')
                }
                onPointerMove={() => {
                  if (!option.disabled) setActive(index);
                }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(index)}
              >
                <div>
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </div>
                {option.value === value && <Check size={15} />}
              </div>
            ))}
            {!options.length && <div className="muted select-empty">暂无可选项</div>}
          </div>,
          trigger.current?.closest('dialog') || document.body,
        )}
    </>
  );
}
