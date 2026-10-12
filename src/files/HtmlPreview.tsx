import { useEffect, useState } from 'react';
import { post } from '../api';
import { Spinner } from '../components';

export function HtmlPreview({ base, file }: { base: string; file: string }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const scope = Object.fromEntries(new URLSearchParams(base));
    void post<{ url: string }>('/html-preview', { ...scope, path: file })
      .then((result) => {
        if (live) setUrl(result.url);
      })
      .catch((cause: Error) => {
        if (live) setError(cause.message);
      });
    return () => {
      live = false;
    };
  }, [base, file]);
  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (!url) return <Spinner label="正在准备 HTML 预览" />;
  return (
    <div className="html-preview">
      <iframe
        title={`HTML 预览：${file}`}
        src={url}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
      />
      <p className="muted small">
        支持静态页面及相对路径资源；需要后端服务的页面请启动项目后访问。
      </p>
    </div>
  );
}
