import { useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, BarChart3 } from 'lucide-react';
import { api } from './api';
import type { TokenCounts, UsageStats } from '../shared/types';
import { tokenTotal, cacheHitRate, formatTokens as format } from '../shared/tokens';
import { formatMoney, moneyUnit } from '../shared/money';
import { shortThreadId } from './thread-id';
const exactTokens = (value?: number) =>
  value === undefined ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 0 });
const cachePercent = (counts: TokenCounts) => {
  const rate = cacheHitRate(counts);
  return rate === undefined ? '—' : `${rate.toFixed(2)}%`;
};
export function ReplyTokenUsage({ counts, partial }: { counts?: TokenCounts; partial?: boolean }) {
  return (
    <span
      className="task-metric reply-token-usage"
      aria-label="本轮 Token 用量"
      title={
        partial
          ? '仅包含本轮已记录用量；详细数据见设置中的 Token 统计'
          : counts
            ? '本轮 Token 消耗；详细数据见设置中的 Token 统计'
            : 'CLI 未提供本轮用量，不代表零消耗'
      }
    >
      <span className="task-metric-label">{partial ? 'Token · 已记录' : 'Token'}</span>
      <span className={'task-metric-value' + (counts ? '' : ' task-metric-empty')}>
        {counts ? format(tokenTotal(counts)) : '未提供'}
      </span>
    </span>
  );
}
export function TokenUsagePage({
  onClose,
  onThread,
  revision,
}: {
  onClose: () => void;
  onThread: (id: string) => void;
  revision: number;
}) {
  const [period, setPeriod] = useState('all');
  const [project, setProject] = useState('');
  const [thread, setThread] = useState('');
  const [page, setPage] = useState(1);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      if (period === 'week') start.setDate(start.getDate() - 6);
      const query = new URLSearchParams({
        since: String(period === 'all' ? 0 : start.getTime()),
        page: String(page),
      });
      if (project) query.set('project', project);
      if (thread) query.set('thread', thread);
      setLoading(true);
      void api<UsageStats>('/usage?' + query.toString(), { signal: controller.signal })
        .then((result) => {
          setStats(result);
          setError('');
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(error.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [period, project, thread, page, refresh, revision]);
  return (
    <main className="settings-page token-page" aria-label="Token 统计">
      <header className="settings-page-header">
        <h1>
          <BarChart3 size={22} /> Token 统计
        </h1>
        <button className="secondary" onClick={onClose}>
          <ArrowLeft size={15} /> 返回工作台
        </button>
      </header>
      <div className="usage-toolbar">
        <div className="button-row" aria-label="统计时间范围">
          {[
            ['all', '全部记录'],
            ['today', '今天'],
            ['week', '最近 7 天'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={period === value ? 'primary' : 'secondary'}
              aria-pressed={period === value}
              onClick={() => {
                setPeriod(value);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <button className="secondary" disabled={loading} onClick={() => setRefresh((n) => n + 1)}>
          <RefreshCw size={14} />
          {loading ? '读取中…' : '刷新统计'}
        </button>
      </div>
      <div className="usage-filters">
        <label className="field">
          <span>项目筛选</span>
          <select
            aria-label="项目筛选"
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setThread('');
              setPage(1);
            }}
          >
            <option value="">全部项目</option>
            {stats?.filters.projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>会话筛选</span>
          <select
            aria-label="会话筛选"
            value={thread}
            onChange={(e) => {
              setThread(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部会话</option>
            {stats?.filters.threads.map((item) => (
              <option key={item.id} value={item.id}>
                {shortThreadId(item.id)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <div className="usage-cards">
        {(
          [
            ['总消耗 Token', 'totalTokens'],
            ['输入 Token', 'inputTokens'],
            ['其中缓存 Token', 'cachedInputTokens'],
            ['输出 Token', 'outputTokens'],
            ['其中思考 Token', 'reasoningOutputTokens'],
          ] as const
        ).map(([label, key]) => (
          <div className="usage-card" key={key}>
            <span>{label}</span>
            <strong>{stats ? exactTokens(stats.totals[key]) : '—'}</strong>
          </div>
        ))}
        <div className="usage-card">
          <span>整体缓存命中率</span>
          <strong>{stats ? cachePercent(stats.cache) : '—'}</strong>
          <small>当前筛选内 {stats?.cache.turns ?? 0} 轮完整缓存记录</small>
        </div>
      </div>
      <div className="usage-expenses">
        <span>当前筛选：{stats ? stats.turns.toLocaleString() : '—'} 轮</span>
        <strong>
          余额消费：
          {stats?.expenses.length
            ? stats.expenses
                .map(
                  (item) =>
                    `${formatMoney(item.spent)} ${moneyUnit(item.unit)}（${item.turns} 轮有余额记录）`,
                )
                .join(' · ')
            : '—'}
        </strong>
      </div>
      <p className="small muted">
        每行代表一轮对话。缓存 Token 已包含在输入中，思考 Token 已包含在输出中。
        整体缓存命中率为当前筛选内完整记录的缓存 Token 总数 ÷ 对应输入 Token 总数，不受分页影响。
        缺失或部分缓存记录不参与命中率计算。余额消费为开始、结束余额的差值，并发或充值可能影响结果；缺少记录显示“—”。
      </p>
      <section className="settings-section">
        <h3>每轮对话明细</h3>
        <div className="usage-table-scroll">
          <table className="usage-table">
            <thead>
              <tr>
                <th>时间 / 状态</th>
                <th>项目 / 会话</th>
                <th>轮次 / 本轮问题</th>
                <th>总消耗 Token</th>
                <th>输入</th>
                <th>其中缓存</th>
                <th>缓存命中率</th>
                <th>输出</th>
                <th>其中思考</th>
                <th>余额消费</th>
                <th>剩余余额</th>
              </tr>
            </thead>
            <tbody>
              {stats?.records.map((record) => (
                <tr key={record.threadId + ':' + record.turnId}>
                  <td data-label="时间 / 状态">
                    {new Date(record.startedAt || record.updatedAt).toLocaleString()}
                    <small>
                      {(
                        {
                          inProgress: '执行中',
                          completed: '已完成',
                          failed: '执行失败',
                          interrupted: '已停止',
                        } as Record<string, string>
                      )[record.status] || '历史记录'}
                      {record.partial ? ' · 部分用量' : ''}
                    </small>
                  </td>
                  <td data-label="项目 / 会话">
                    <span>{record.projectName}</span>
                    <button
                      className="text-button usage-thread-link"
                      title={`会话 ID：${record.threadId} · ${record.name}`}
                      onClick={() => onThread(record.threadId)}
                    >
                      {shortThreadId(record.threadId)}
                    </button>
                  </td>
                  <td className="usage-prompt" data-label="轮次 / 本轮问题">
                    <strong>第 {record.turnNumber} 轮</strong>
                    <details>
                      <summary>
                        {record.prompt.slice(0, 60)}
                        {record.prompt.length > 60 ? '…' : ''}
                      </summary>
                      <p>{record.prompt}</p>
                    </details>
                  </td>
                  <td data-label="总消耗 Token">{exactTokens(tokenTotal(record.counts))}</td>
                  <td data-label="输入 Token">{exactTokens(record.counts.inputTokens)}</td>
                  <td data-label="其中缓存 Token">
                    {exactTokens(record.counts.cachedInputTokens)}
                  </td>
                  <td data-label="缓存命中率">
                    {record.partial ? '—' : cachePercent(record.counts)}
                  </td>
                  <td data-label="输出 Token">{exactTokens(record.counts.outputTokens)}</td>
                  <td data-label="其中思考 Token">
                    {exactTokens(record.counts.reasoningOutputTokens)}
                  </td>
                  <td data-label="余额消费">
                    {formatMoney(record.balance?.spent)} {moneyUnit(record.balance?.unit)}
                  </td>
                  <td data-label="剩余余额">
                    {formatMoney(record.balance?.remaining)} {moneyUnit(record.balance?.unit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {stats && !stats.records.length && (
          <p className="empty-state">当前筛选下暂无已记录的对话用量。</p>
        )}
        {stats && (
          <div className="usage-pagination">
            <button
              className="secondary"
              disabled={loading || stats.page <= 1}
              onClick={() => setPage(stats.page - 1)}
            >
              上一页
            </button>
            <span>
              第 {stats.page} / {stats.pages} 页 · 每页 {stats.pageSize} 轮
            </span>
            <button
              className="secondary"
              disabled={loading || stats.page >= stats.pages}
              onClick={() => setPage(stats.page + 1)}
            >
              下一页
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
