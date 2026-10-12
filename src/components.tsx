import { formatMoney, moneyUnit } from '../shared/money';
import { balanceErrorText } from '../shared/balance';
import { ErrorBoundary } from './ErrorBoundary';
import { turnElapsed, formatElapsed } from '../shared/timing';
import { ReplyTokenUsage } from './TokenUsage';
import {
  createContext,
  useContext,
  lazy,
  memo,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Paperclip,
  ChevronDown,
  Quote,
  CornerUpLeft,
  Download,
  Brain,
  Clock3,
  Minimize2,
  ListChecks,
  Circle,
  CircleCheck,
  FileText,
  Globe2,
  FileCode2,
  LoaderCircle,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react';
import type { Item, PendingRequest, Turn, InputPart, FileChange } from '../shared/types';
import { diffCounts, diffFiles } from '../shared/diff';
import { post } from './api';
import { identity } from './identity';
import { CodeBlock, CopyButton } from './controls';
import { Diff } from './Diff';
export { CopyButton } from './controls';
export { Diff } from './Diff';
export const MessageActionContext = createContext<(text: string, quote: boolean) => void>(() => {});
export const MemoryActionContext = createContext<((text: string) => void) | null>(null);

const RichMarkdown = lazy(() => import('./Markdown'));

function FileChangeList({ changes }: { changes: FileChange[] }) {
  return changes.map((change, index) => {
    const counts = diffCounts(change.diff || '');
    return (
      <ToolDetails
        key={change.path + index}
        className="file-change-detail"
        summary={
          <summary>
            <FileText size={14} />
            <span className="change-path" title={change.path}>
              {change.path}
            </span>
            {change.diff && (
              <span
                className="change-counts"
                aria-label={`新增 ${counts.added} 行，删除 ${counts.removed} 行`}
              >
                <b className="green-text">+{counts.added}</b>
                <b className="error-text">−{counts.removed}</b>
              </span>
            )}
            <span className="badge">
              {change.kind?.move_path
                ? '移动'
                : ({ add: '新增', delete: '删除', update: '修改' } as Record<string, string>)[
                    change.kind?.type || ''
                  ] || '修改'}
            </span>
            <ChevronDown className="detail-chevron" size={14} />
          </summary>
        }
      >
        {change.kind?.move_path && (
          <div className="file-label">移动到：{change.kind.move_path}</div>
        )}
        <Diff text={change.diff || ''} />
      </ToolDetails>
    );
  });
}

function ToolDetails({
  summary,
  children,
  className,
  open = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  className: string;
  open?: boolean;
}) {
  const [expanded, setExpanded] = useState(open);
  const lastOpen = useRef(open);
  useEffect(() => {
    if (lastOpen.current !== open) {
      setExpanded(open);
      lastOpen.current = open;
    }
  }, [open]);
  return (
    <details
      className={className}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      {summary}
      {expanded && children}
    </details>
  );
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
    >
      <div className="modal-head">
        <h2 id={titleId}>{title}</h2>
        <button className="icon-btn" aria-label="关闭" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Spinner({ label = '正在加载' }: { label?: string }) {
  return (
    <span className="loading">
      <LoaderCircle size={16} className="spin" />
      {label}
    </span>
  );
}
function MessageActions({ text, user = false }: { text: string; user?: boolean }) {
  const onAction = useContext(MessageActionContext);
  const onSaveMemory = useContext(MemoryActionContext);
  return (
    <div className="message-actions">
      <CopyButton
        text={text}
        label={user ? '复制消息' : '复制 Markdown'}
        textLabel="复制"
        compact={false}
      />
      <button
        className="message-action"
        aria-label={user ? '复用消息' : '引用追问'}
        title={user ? '将内容放入输入框，编辑后发送' : '引用这条回复继续提问'}
        onClick={(event) => {
          const selection = window.getSelection();
          const message = event.currentTarget.closest('.assistant-message');
          const selected =
            !user &&
            selection &&
            message?.contains(selection.anchorNode) &&
            message.contains(selection.focusNode)
              ? selection.toString().trim()
              : '';
          onAction(selected || text, !user);
        }}
      >
        {user ? <CornerUpLeft size={14} /> : <Quote size={14} />}
        {user ? '复用' : '追问'}
      </button>
      {onSaveMemory && (
        <button
          className="message-action"
          title="将这条消息保存到记忆库"
          onClick={() => onSaveMemory(text)}
        >
          <Brain size={14} />
          保存记忆
        </button>
      )}
      {!user && (
        <button
          className="message-action"
          title="下载 Markdown"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([text], { type: 'text/markdown;charset=utf-8' }),
            );
            const link = document.createElement('a');
            link.href = url;
            link.download = 'codex-reply.md';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          <Download size={14} />
          导出
        </button>
      )}
    </div>
  );
}
function QuestionSuggestions({
  questions,
}: {
  questions: { title: string; options?: string[] }[];
}) {
  const onAction = useContext(MessageActionContext);
  return (
    <div className="question-suggestions">
      {questions.map((q, i) => (
        <div key={i}>
          <strong>{q.title}</strong>
          <div className="button-row">
            {q.options?.map((option) => (
              <button key={option} onClick={() => onAction(`${q.title}\n${option}`, false)}>
                {option}
              </button>
            ))}
          </div>
        </div>
      ))}
      <small>选择后会填入输入框，可补充内容再发送；也可以直接输入回答。</small>
    </div>
  );
}
const statusText = (status?: string) =>
  ({
    inProgress: '运行中',
    completed: '已完成',
    failed: '失败',
    declined: '已拒绝',
    interrupted: '已停止',
    pending: '待执行',
  })[status || ''] ||
  status ||
  '';
function StatusBadge({ item }: { item: Item }) {
  return (
    <span
      className={
        'tool-state ' +
        (item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0)
          ? 'error-text'
          : '')
      }
    >
      {(item.status || item.workbenchStatus) === 'inProgress' && (
        <LoaderCircle className="spin" size={12} />
      )}
      {statusText(item.status || item.workbenchStatus)}
    </span>
  );
}
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <Suspense fallback={<div className="markdown markdown-pending">{text}</div>}>
      <RichMarkdown text={text} />
    </Suspense>
  );
});
function AssistantIdentity({ model }: { model?: string }) {
  return (
    <div className="assistant-identity">
      <span className="assistant-name">Codex</span>
      <span className="assistant-role" aria-label="回复模型" title={model || '历史未记录模型'}>
        {model || '模型未记录'}
      </span>
    </div>
  );
}
export const MessageItem = memo(function MessageItem({
  item,
  running = false,
  model,
}: {
  item: Item;
  running?: boolean;
  model?: string;
}) {
  if (item.type === 'userMessage') {
    const parts = (item.content || []).filter(
      (part): part is InputPart => typeof part !== 'string',
    );
    return (
      <div className="user-message">
        <div className="user-message-content">
          <div className="user-message-bubble">
            {parts.map((part, i) => (
              <div key={i}>
                {part.type === 'text' ? (
                  part.text
                ) : (
                  <span className="attachment-label">
                    <Paperclip size={13} />{' '}
                    {part.type.includes('Image') || part.type === 'image' ? '图片附件' : '附件'}
                  </span>
                )}
              </div>
            ))}
          </div>
          <MessageActions
            user
            text={parts
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join('\n')}
          />
        </div>
      </div>
    );
  }
  if (item.type === 'agentMessage') {
    if (!item.text && !item.questions?.length && !running) return null;
    return (
      <article
        className={`assistant-message ${item.phase === 'commentary' ? 'assistant-progress' : 'assistant-answer'}`}
        aria-label="Codex 消息"
      >
        <img className="assistant-avatar" src={identity.assistantAvatarUrl} alt="" />
        <div className="message-body">
          <AssistantIdentity model={model} />
          <div className="assistant-message-bubble">
            {item.text ? (
              <Markdown text={item.text} />
            ) : running ? (
              <span className="reply-placeholder" role="status">
                正在生成回复…
              </span>
            ) : null}
            {!!item.questions?.length && <QuestionSuggestions questions={item.questions} />}
          </div>
          {!!item.text && <MessageActions text={item.text} />}
        </div>
      </article>
    );
  }
  if (item.type === 'reasoning') {
    const summary = (item.summary || []).filter((part) => part.trim()).join('\n\n');
    const content = (item.content || [])
      .filter((part): part is string => typeof part === 'string' && !!part.trim())
      .join('\n\n');
    if (!summary && !content) return null;
    return (
      <ToolDetails
        className="reasoning tool-card"
        summary={
          <summary>
            <Brain size={15} />
            <span className="tool-title">思考过程</span>
            <StatusBadge item={item} />
            <ChevronDown className="detail-chevron" size={14} />
          </summary>
        }
      >
        <div className="tool-details-body">
          {!!summary && (
            <>
              <span className="detail-label">思考摘要</span>
              <Markdown text={summary} />
            </>
          )}
          {!!content && (
            <>
              <span className="detail-label">思考详情</span>
              <Markdown text={content} />
            </>
          )}
          <CopyButton
            text={[summary, content].filter(Boolean).join('\n\n')}
            label="复制思考内容"
            compact={false}
          />
        </div>
      </ToolDetails>
    );
  }
  if (item.type === 'commandExecution')
    return (
      <ToolDetails
        className="tool-card"
        open={item.status === 'inProgress'}
        summary={
          <summary>
            <Terminal size={15} />
            <span className="tool-title" title={item.command}>
              {item.command || '执行命令'}
            </span>
            <StatusBadge item={item} />
            <ChevronDown className="detail-chevron" size={14} />
          </summary>
        }
      >
        <div className="tool-details-body">
          <div className="command-meta">
            {item.cwd && <span title={item.cwd}>目录：{item.cwd}</span>}
            {item.durationMs != null && (
              <span>
                <Clock3 size={12} />
                {(item.durationMs / 1000).toFixed(2)} 秒
              </span>
            )}
            {item.exitCode != null && <span>退出码：{item.exitCode}</span>}
          </div>
          <CodeBlock text={item.command || ''} language="命令" />
          <CodeBlock
            text={
              item.aggregatedOutput || (item.status === 'inProgress' ? '等待输出…' : '（无输出）')
            }
            language="输出"
          />
          {item.terminalInput && <CodeBlock text={item.terminalInput} language="终端输入" />}
        </div>
      </ToolDetails>
    );
  if (item.type === 'fileChange')
    return (
      <ToolDetails
        className="tool-card file-changes"
        summary={
          <summary>
            <FileCode2 size={15} />
            <span className="tool-title">修改了 {item.changes?.length || 0} 个文件</span>
            <StatusBadge item={item} />
            <ChevronDown className="detail-chevron" size={14} />
          </summary>
        }
      >
        <FileChangeList changes={item.changes || []} />
        {item.aggregatedOutput && (
          <div className="tool-details-body">
            <CodeBlock text={item.aggregatedOutput} language="修改日志" />
          </div>
        )}
      </ToolDetails>
    );
  if (item.type === 'plan')
    return (
      <div className="plan-card">
        <span className="eyebrow">执行计划</span>
        <Markdown text={item.text || ''} />
      </div>
    );
  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode')
    return (
      <div className="plan-card">
        <span className="eyebrow">
          {item.type === 'enteredReviewMode' ? '开始代码审查' : '代码审查结果'}
        </span>
        <Markdown
          text={
            item.review ||
            (item.type === 'enteredReviewMode'
              ? 'Codex 正在审查当前项目。'
              : '审查结果未提供，请查看本轮状态。')
          }
        />
      </div>
    );
  if (item.type === 'contextCompaction')
    return (
      <div className="compaction-event" role="status">
        <Minimize2 size={15} />
        <div>
          <strong>
            {item.workbenchStatus === 'inProgress'
              ? '正在压缩上下文'
              : ['failed', 'interrupted'].includes(item.workbenchStatus || '')
                ? '上下文压缩未完成'
                : '上下文已压缩'}
          </strong>
          <span>
            {item.workbenchStatus === 'inProgress'
              ? 'Codex 正在整理上下文，完成后继续任务。'
              : ['failed', 'interrupted'].includes(item.workbenchStatus || '')
                ? '压缩过程失败或被中断，请查看本轮状态后继续。'
                : '历史消息保留在会话中，模型后续使用精简后的上下文。'}
          </span>
        </div>
        {item.workbenchStatus === 'inProgress' && <LoaderCircle size={14} className="spin" />}
      </div>
    );
  if (item.type === 'webSearch')
    return (
      <ToolDetails
        className="tool-card"
        summary={
          <summary>
            <Globe2 size={15} />
            <span className="tool-title">搜索网页：{item.query || item.action?.query || ''}</span>
            <ChevronDown className="detail-chevron" size={14} />
          </summary>
        }
      >
        <div className="tool-details-body">
          <CodeBlock
            text={JSON.stringify(item.action || { query: item.query }, null, 2)}
            language="搜索信息"
          />
        </div>
      </ToolDetails>
    );
  return (
    <ToolDetails
      className="tool-card"
      summary={
        <summary>
          <Terminal size={15} />
          <span className="tool-title">
            {item.tool ||
              (
                {
                  webSearch: '搜索网页',
                  imageView: '查看图片',
                  collabAgentToolCall: '协作任务',
                  mcpToolCall: '调用工具',
                } as Record<string, string>
              )[item.type] ||
              item.type}
          </span>
          <StatusBadge item={item} />
          <ChevronDown className="detail-chevron" size={14} />
        </summary>
      }
    >
      <div className="tool-details-body">
        <CodeBlock text={JSON.stringify(item, null, 2)} language="工具详情" />
      </div>
    </ToolDetails>
  );
});
function TurnSummary({ turn }: { turn: Turn }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (turn.status !== 'inProgress' || turn.startedAt == null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [turn.status, turn.startedAt]);
  const elapsed = turnElapsed(turn, now);
  const running = turn.status === 'inProgress';
  const label = running
    ? '执行中'
    : turn.status === 'failed'
      ? '执行失败'
      : turn.status === 'interrupted'
        ? '已停止'
        : '已完成';
  const balance = turn.upstreamBalance;
  const amount = (value: number | undefined, digits: number) => {
    if (value === undefined || !Number.isFinite(value)) return '—';
    const unit = moneyUnit(balance?.unit);
    const valueText = formatMoney(value, digits);
    return unit === '$' ? `$${valueText}` : `${valueText} ${unit}`.trim();
  };
  return (
    <div className={'turn-summary task-meta ' + turn.status} aria-label="任务执行状态">
      <div className="task-summary-header">
        <span className="task-state">
          {running ? (
            <LoaderCircle className="spin" size={13} aria-hidden="true" />
          ) : turn.status === 'completed' ? (
            <CircleCheck size={13} aria-hidden="true" />
          ) : (
            <Circle size={13} aria-hidden="true" />
          )}
          {label}
        </span>
        {elapsed !== null && (
          <span className="task-time" title="包含模型思考、工具执行和审批等待，不含排队时间。">
            <span>{running ? '已用时' : '总用时'}</span>
            <time>{formatElapsed(elapsed)}</time>
          </span>
        )}
      </div>
      <div className="task-summary-stats">
        <ReplyTokenUsage counts={turn.tokenUsage} partial={turn.tokenUsagePartial} />
        {!running && balance && (
          <span
            className="task-balance"
            aria-label="上游余额"
            title={`${balance.providerName || '服务器默认配置'} · ${new Date(balance.checkedAt).toLocaleString()}${balance.source === 'opened' ? '（打开对话时查询的当前余额）' : '（任务完成时查询）'}`}
          >
            {balance.status === 'available' ? (
              <>
                <span className="task-metric task-cost">
                  <span className="task-metric-label">本轮消费</span>
                  <span className="task-metric-value">≈ {amount(balance.spent, 4)}</span>
                </span>
                <span className="task-metric task-remaining">
                  <span className="task-metric-label">剩余余额</span>
                  <span className="task-metric-value">{amount(balance.remaining, 2)}</span>
                </span>
                {balance.isValid === false && <span className="task-balance-note">账户未激活</span>}
              </>
            ) : (
              <span className="task-metric task-balance-status">
                <span className="task-metric-label">上游余额</span>
                <span className="task-metric-value task-metric-empty">
                  {balance.status === 'loading'
                    ? '查询中…'
                    : balance.status === 'unavailable'
                      ? '未配置'
                      : balanceErrorText(balance)}
                </span>
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

export const TurnView = memo(function TurnView({ turn }: { turn: Turn }) {
  const aggregateFiles = useMemo(() => diffFiles(turn.diff || ''), [turn.diff]);
  // Keep late user messages in place when a running turn is steered.
  const segments: { key: string; user: boolean; items: Item[] }[] = [];
  let responseKey = 'response-start';
  for (const item of turn.items) {
    if (item.type === 'userMessage') {
      segments.push({ key: item.id, user: true, items: [item] });
      responseKey = `response-after-${item.id}`;
    } else {
      if (!segments.length || segments[segments.length - 1].user) {
        segments.push({ key: responseKey, user: false, items: [] });
      }
      segments[segments.length - 1].items.push(item);
    }
  }
  if (!segments.length || segments[segments.length - 1].user) {
    segments.push({ key: responseKey, user: false, items: [] });
  }
  const firstResponse = segments.findIndex((segment) => !segment.user);
  return (
    <div className="turn">
      {segments.map((segment, index) =>
        segment.user ? (
          <ErrorBoundary key={segment.key} resetKey="userMessage" compact>
            <MessageItem item={segment.items[0]} />
          </ErrorBoundary>
        ) : (
          <section className="assistant-response" aria-label="Codex 回复" key={segment.key}>
            <div className="assistant-response-content">
              {index === firstResponse && (
                <>
                  {turn.plan && (
                    <div className="plan-card">
                      <div className="plan-heading">
                        <ListChecks size={16} />
                        执行计划
                      </div>
                      {turn.planExplanation && <Markdown text={turn.planExplanation} />}
                      <ol className="plan-steps">
                        {turn.plan.map((step, i) => (
                          <li key={i} className={step.status}>
                            {step.status === 'completed' ? (
                              <CircleCheck size={15} />
                            ) : step.status === 'inProgress' ? (
                              <LoaderCircle className="spin" size={15} />
                            ) : (
                              <Circle size={15} />
                            )}
                            <span>{step.step}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </>
              )}
              {segment.items.map((item) => (
                <ErrorBoundary key={item.id} resetKey={item.type} compact>
                  <MessageItem
                    item={item}
                    running={turn.status === 'inProgress'}
                    model={turn.model}
                  />
                </ErrorBoundary>
              ))}
              {index === segments.length - 1 && (
                <>
                  {turn.error && <div className="error-box">{turn.error.message}</div>}
                  {turn.status === 'interrupted' && (
                    <div className="muted small center">本次执行已停止</div>
                  )}
                  {turn.diff && (
                    <ToolDetails
                      className="tool-card turn-diff"
                      summary={
                        <summary>
                          <FileCode2 size={15} />
                          <span className="tool-title">本轮文件改动汇总</span>
                          <ChevronDown className="detail-chevron" size={14} />
                        </summary>
                      }
                    >
                      {aggregateFiles.length ? (
                        <FileChangeList changes={aggregateFiles} />
                      ) : (
                        <Diff text={turn.diff} />
                      )}
                    </ToolDetails>
                  )}
                  <TurnSummary turn={turn} />
                </>
              )}
            </div>
          </section>
        ),
      )}
    </div>
  );
});
export function Approval({
  request,
  onError,
}: {
  request: PendingRequest;
  onError: (message: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [content, setContent] = useState('{}');
  const [busy, setBusy] = useState(false);
  const questions = request.params.questions;
  const mcp = request.method === 'mcpServer/elicitation/request';
  const unanswered = questions?.some((q) => !answers[q.id]?.trim());
  const send = async (decision?: string) => {
    setBusy(true);
    try {
      await post(`/requests/${request.id}`, {
        decision,
        answers,
        ...(mcp && decision === 'accept' ? { content: JSON.parse(content) } : {}),
      });
    } catch (e) {
      onError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="approval">
      <div className="approval-heading">
        <ShieldCheck size={18} />
        <strong>{questions ? 'Codex 需要你的回答' : '等待你的批准'}</strong>
        <span className="badge amber">待处理</span>
      </div>
      <p>
        {request.params.reason ||
          request.params.message ||
          '请确认以下操作，任务会在收到答复后继续。'}
      </p>
      {request.params.command && (
        <CodeBlock text={request.params.command} language="请求执行的命令" />
      )}
      {request.params.cwd && <div className="small muted">目录：{request.params.cwd}</div>}
      {request.params.permissions && (
        <pre>{JSON.stringify(request.params.permissions, null, 2)}</pre>
      )}
      {request.params.grantRoot && <pre>{request.params.grantRoot}</pre>}
      {questions?.map((q) => (
        <div className="field" key={q.id}>
          <label htmlFor={`${request.id}-${q.id}`}>{q.question}</label>
          {q.header && <span className="small muted">{q.header}</span>}
          {!!q.options?.length && (
            <div className="option-list">
              {q.options.map((opt) => (
                <button
                  key={opt.label}
                  className={'option ' + (answers[q.id] === opt.label ? 'selected' : '')}
                  type="button"
                  disabled={busy}
                  aria-pressed={answers[q.id] === opt.label}
                  onClick={() => setAnswers({ ...answers, [q.id]: opt.label })}
                >
                  {opt.label}
                  <small>{opt.description}</small>
                </button>
              ))}
            </div>
          )}
          {q.isSecret ? (
            <input
              id={`${request.id}-${q.id}`}
              type="password"
              disabled={busy}
              autoComplete="off"
              placeholder="输入回答或补充内容"
              value={answers[q.id] || ''}
              onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
            />
          ) : (
            <textarea
              id={`${request.id}-${q.id}`}
              rows={2}
              disabled={busy}
              placeholder="输入回答或补充内容"
              value={answers[q.id] || ''}
              onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
            />
          )}
        </div>
      ))}
      {mcp && (
        <>
          <pre>{JSON.stringify(request.params.request || request.params, null, 2)}</pre>
          <label className="field">
            <span>表单回答（JSON）</span>
            <textarea value={content} onChange={(e) => setContent(e.target.value)} />
          </label>
        </>
      )}
      <div className="button-row">
        {questions ? (
          <button className="primary" disabled={busy || unanswered} onClick={() => void send()}>
            {busy ? '正在提交…' : '提交回答'}
          </button>
        ) : (
          <>
            <button className="primary" disabled={busy} onClick={() => void send('accept')}>
              批准本次
            </button>
            <button className="secondary" disabled={busy} onClick={() => void send('decline')}>
              拒绝
            </button>
          </>
        )}
      </div>
    </div>
  );
}
