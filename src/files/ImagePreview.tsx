import { useEffect, useId, useRef, useState } from 'react';
import { Expand, Minus, Plus, X } from 'lucide-react';
import { Spinner } from '../components';
import './images.css';

export function ImagePreview({ src, file }: { src: string; file: string }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    void fetch(src, { signal: controller.signal, credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) {
          const result = await response.json().catch(() => null);
          throw new Error(result?.error || '图片加载失败，请刷新重试');
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);
  if (error)
    return (
      <p className="error-box" role="alert">
        {error}
      </p>
    );
  return (
    <section className="image-preview" aria-label="图片预览">
      {!size.width && <Spinner label="正在加载图片" />}
      {url && (
        <button
          className="image-preview-open"
          aria-label="放大查看图片"
          disabled={!size.width}
          onClick={() => setExpanded(true)}
        >
          <img
            src={url}
            alt={file}
            onLoad={(event) =>
              setSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setError('图片无法解码或格式不受浏览器支持，请下载查看')}
          />
        </button>
      )}
      {!!size.width && (
        <div className="image-preview-meta">
          <span>
            {size.width} × {size.height}
          </span>
          <button className="secondary" onClick={() => setExpanded(true)}>
            <Expand size={15} />
            放大查看
          </button>
        </div>
      )}
      {expanded && (
        <ImageLightbox url={url} file={file} size={size} onClose={() => setExpanded(false)} />
      )}
    </section>
  );
}

function ImageLightbox({
  url,
  file,
  size,
  onClose,
}: {
  url: string;
  file: string;
  size: { width: number; height: number };
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [scale, setScale] = useState<number | null>(null);
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    element.showModal();
    const area = viewport.current!;
    const observer = new ResizeObserver(() =>
      setFit(
        Math.min(1, (area.clientWidth - 32) / size.width, (area.clientHeight - 32) / size.height),
      ),
    );
    observer.observe(area);
    return () => {
      observer.disconnect();
      element.close();
      previousFocus?.focus();
    };
  }, [size.width, size.height]);
  const zoom = scale ?? fit;
  const changeZoom = (factor: number) => setScale(Math.min(8, Math.max(0.05, zoom * factor)));
  return (
    <dialog
      ref={dialog}
      className="image-lightbox"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id={titleId}>{file}</h2>
        <button className="icon-btn" aria-label="关闭图片预览" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="image-lightbox-toolbar" role="group" aria-label="图片缩放">
        <button
          className="secondary"
          aria-label="缩小图片"
          disabled={zoom <= 0.05}
          onClick={() => changeZoom(1 / 1.25)}
        >
          <Minus size={16} />
        </button>
        <output aria-label="缩放比例">{Math.round(zoom * 100)}%</output>
        <button
          className="secondary"
          aria-label="放大图片"
          disabled={zoom >= 8}
          onClick={() => changeZoom(1.25)}
        >
          <Plus size={16} />
        </button>
        <button className="secondary" onClick={() => setScale(1)}>
          原始大小
        </button>
        <button className="secondary" onClick={() => setScale(null)}>
          适应窗口
        </button>
      </div>
      <div
        ref={viewport}
        className="image-lightbox-viewport"
        tabIndex={0}
        aria-label="图片查看区域"
      >
        <div className="image-lightbox-canvas">
          <img
            src={url}
            alt={file}
            style={{ width: size.width * zoom, height: size.height * zoom }}
            draggable={false}
          />
        </div>
      </div>
    </dialog>
  );
}
