import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Activity,
  SlidersHorizontal,
  FolderKanban,
  ArchiveRestore,
  Plug,
  Blocks,
  Server,
  Database,
  ShieldCheck,
  ChevronRight,
} from 'lucide-react';
import type { RuntimeStatus } from '../../shared/types';
import { ExecutionPreferences, type Preferences } from '../preferences';
import { ThemeToggle } from '../theme';
import { ManagementSettings } from './ManagementSettings';
import { ProjectPrompts } from './ProjectPrompts';
import { AccountSettings } from './AccountSettings';
import { DataSettings } from './DataSettings';
import { RuntimeSettings } from './RuntimeSettings';
import { ProvidersPanel } from './ProvidersPanel';
import { ArchivedThreads } from './ArchivedThreads';
import { FeatureSettings, type FeatureFlags } from './FeatureSettings';

const categories = [
  {
    id: 'general',
    label: '常规',
    title: '常规设置',
    description: '配置工作台外观、会话默认权限与模型偏好。',
    icon: SlidersHorizontal,
    group: '工作台配置',
  },
  {
    id: 'projects',
    label: '项目',
    title: '项目配置',
    description: '为不同项目维护独立的系统提示词和协作规范。',
    icon: FolderKanban,
    group: '工作台配置',
  },
  {
    id: 'archives',
    label: '归档会话',
    title: '归档会话',
    description: '按项目查看和恢复已归档的会话。',
    icon: ArchiveRestore,
    group: '工作台配置',
  },
  {
    id: 'providers',
    label: '供应商',
    title: '供应商管理',
    description: '管理模型服务、连接配置与供应商能力。',
    icon: Plug,
    group: '工作台配置',
  },
  {
    id: 'extensions',
    label: '扩展与迁移',
    title: '扩展与数据迁移',
    description: '管理 Skills、MCP 服务以及工作台备份与迁移。',
    icon: Blocks,
    group: '工作台配置',
  },
  {
    id: 'runtime',
    label: '执行环境',
    title: '执行环境',
    description: '查看运行状态，维护 CLI 安装与服务连接。',
    icon: Server,
    group: '系统管理',
  },
  {
    id: 'data',
    label: '数据',
    title: '数据管理',
    description: '查看用量统计，管理服务器缓存与日志。',
    icon: Database,
    group: '系统管理',
  },
  {
    id: 'account',
    label: '账户',
    title: '账户与安全',
    description: '管理登录状态与工作台访问密码。',
    icon: ShieldCheck,
    group: '系统管理',
  },
] as const;

export function Settings({
  onClose,
  status,
  refresh,
  onLogout,
  preferences,
  onPreferences,
  onUsage,
  features,
  onFeaturesChange,
}: {
  onClose: () => void;
  status: RuntimeStatus | null;
  refresh: () => void;
  onLogout: () => void;
  preferences: Preferences;
  onPreferences: (value: Preferences) => void;
  onUsage: () => void;
  features: FeatureFlags;
  onFeaturesChange: (value: FeatureFlags) => void;
}) {
  const [tab, setTab] = useState(() => {
    const saved = sessionStorage.getItem('codex-cloud-settings-tab');
    return categories.find((item) => item.id === saved)?.id || 'general';
  });
  useEffect(() => {
    sessionStorage.setItem('codex-cloud-settings-tab', tab);
  }, [tab]);
  const current = categories.find((item) => item.id === tab)!;
  return (
    <main className="settings-page" aria-label="工作台设置">
      <header className="settings-page-header">
        <div>
          <div className="settings-eyebrow">工作台 / 系统管理</div>
          <h1>工作台设置</h1>
          <p>集中管理工作台配置、服务连接与系统资源</p>
        </div>
        <button className="secondary" onClick={onClose}>
          <ArrowLeft size={16} />
          返回工作台
        </button>
      </header>
      <div className="settings-overview" aria-label="系统概览">
        <div>
          <span>
            <Activity size={16} />
            服务状态
          </span>
          <strong className={status?.connected ? 'green-text' : 'amber-text'}>
            {status ? (status.connected ? '已连接' : '未连接') : '正在读取…'}
          </strong>
        </div>
        <div>
          <span>
            <Server size={16} />
            CLI 版本
          </span>
          <strong>{status?.version || '等待连接'}</strong>
        </div>
        <div>
          <span>
            <Blocks size={16} />
            运行任务
          </span>
          <strong>
            {status ? status.active.length : '—'}
            <small> 个任务执行中</small>
          </strong>
        </div>
      </div>
      <div className="settings-layout">
        <aside className="settings-navigation">
          <nav
            className="settings-tabs"
            role="tablist"
            aria-label="设置分类"
            aria-orientation="vertical"
          >
            {categories.map(({ id, label, icon: Icon, group }, index) => (
              <div className="settings-nav-item" key={id}>
                {(index === 0 || categories[index - 1].group !== group) && (
                  <div className="settings-nav-group">{group}</div>
                )}
                <button
                  id={'settings-tab-' + id}
                  role="tab"
                  aria-selected={tab === id}
                  aria-controls={'settings-panel-' + id}
                  tabIndex={tab === id ? 0 : -1}
                  onClick={() => setTab(id)}
                  onKeyDown={(event) => {
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? categories.length - 1
                          : ['ArrowDown', 'ArrowRight'].includes(event.key)
                            ? (index + 1) % categories.length
                            : ['ArrowUp', 'ArrowLeft'].includes(event.key)
                              ? (index - 1 + categories.length) % categories.length
                              : null;
                    if (next === null) return;
                    event.preventDefault();
                    setTab(categories[next].id);
                    document.getElementById('settings-tab-' + categories[next].id)?.focus();
                  }}
                >
                  <Icon size={18} />
                  <span>{label}</span>
                  <ChevronRight size={14} />
                </button>
              </div>
            ))}
          </nav>
        </aside>
        <div className="settings-content">
          <div className="settings-content-heading">
            <span className="settings-heading-icon">
              <current.icon size={22} />
            </span>
            <div>
              <h2>{current.title}</h2>
              <p>{current.description}</p>
            </div>
          </div>
          {categories.map(({ id }) => (
            <div
              key={id}
              role="tabpanel"
              id={'settings-panel-' + id}
              aria-labelledby={'settings-tab-' + id}
              hidden={tab !== id}
              tabIndex={0}
            >
              {id === 'general' && (
                <>
                  <section className="settings-section settings-appearance" aria-label="外观设置">
                    <div>
                      <h3>外观</h3>
                      <p className="muted">选择适合当前环境的界面主题</p>
                    </div>
                    <ThemeToggle />
                  </section>
                  <ExecutionPreferences value={preferences} onSave={onPreferences} />
                  <FeatureSettings value={features} onChange={onFeaturesChange} />
                </>
              )}
              {id === 'projects' && <ProjectPrompts />}
              {id === 'archives' && <ArchivedThreads />}
              {id === 'providers' && <ProvidersPanel status={status} refresh={refresh} />}
              {id === 'extensions' && <ManagementSettings />}
              {id === 'runtime' && <RuntimeSettings status={status} refresh={refresh} />}
              {id === 'data' && (
                <DataSettings status={status} refresh={refresh} onUsage={onUsage} />
              )}
              {id === 'account' && <AccountSettings onLogout={onLogout} />}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
