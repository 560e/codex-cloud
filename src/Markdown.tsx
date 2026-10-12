import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import { useContext } from 'react';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { CodeBlock } from './controls';
import { FileLinkContext } from './FileLinkContext';
import { parseFileLink } from '../shared/file-links';

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];
type TextNode = { value?: string; children?: TextNode[]; properties?: { className?: unknown } };
const nodeText = (node: TextNode): string =>
  node.value || node.children?.map(nodeText).join('') || '';
const components: Components = {
  a: function MarkdownLink({ children, href }) {
    const openFile = useContext(FileLinkContext);
    if (href && parseFileLink(href))
      return openFile ? (
        <a
          href="#"
          title={`打开项目文件：${href}`}
          onClick={(event) => {
            event.preventDefault();
            openFile(href);
          }}
        >
          {children}
        </a>
      ) : (
        <span title="请在对应会话中打开文件">{children}</span>
      );
    if (!href || !/^(https?:\/\/|mailto:|\/\/|#)/i.test(href))
      return <span title="不支持此链接类型">{children}</span>;
    return (
      <a href={href} title={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img: ({ alt }) => <span className="muted">[图片：{alt || '图片'}]</span>,
  pre: ({ children, node }) => {
    const code = node?.children[0] as TextNode | undefined;
    const classes = String(code?.properties?.className || '');
    const language = /language-([\w+-]+)/.exec(classes)?.[1] || 'text';
    return (
      <CodeBlock text={code ? nodeText(code) : ''} language={language}>
        {children}
      </CodeBlock>
    );
  },
  table: ({ children }) => (
    <div className="markdown-table-scroll" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={(url, key) =>
          key === 'href' && parseFileLink(url) ? url : defaultUrlTransform(url)
        }
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
