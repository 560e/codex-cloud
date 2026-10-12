import { QueueEditor } from './QueueEditor';
import { ConversationExportDialog } from './ConversationExportDialog';
import { ConversationSearch } from './ConversationSearch';
import { FilePanel } from './files/FilePanel';
import { Settings } from './settings/Settings';
import { ErrorBoundary } from './ErrorBoundary';
import { readPreferences, effortOptions } from './preferences';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Circle,
  Code2,
  Download,
  OctagonX,
  FileCode2,
  Folder,
  FolderPlus,
  GitBranch,
  Globe2,
  Layers,
  Brain,
  Workflow,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { api, post } from './api';
import { FileLinkContext } from './FileLinkContext';
import { NativeTaskDialog, FileReferencePicker } from './NativeTasks';
import { TokenUsagePage } from './TokenUsage';
import { ComposerInput } from './ComposerInput';
import { formatTokens } from '../shared/tokens';
import {
  Approval,
  TurnView,
  Modal,
  Spinner,
  MessageActionContext,
  MemoryActionContext,
} from './components';
import { Select } from './controls';
import { Login, ProjectModal } from './panels';
import { MemoryPage, CollaborationPage } from './ContinuityPages';
import type { FeatureFlags } from './settings/FeatureSettings';
import { identity } from './identity';
import { applyThreadEvent } from '../shared/events';
import { applyRenderBatch, reconcileThreadSnapshot } from './event-batch';
import { shortThreadId } from './thread-id';
import { clearDrafts, useComposerDraft } from './drafts';
import { parseSocketMessage, pendingSchema } from '../shared/protocol';
import type {
  Attachment,
  Model,
  Project,
  RuntimeStatus,
  Thread,
  WorkEvent,
  ThreadPage,
  ThreadRead,
} from '../shared/types';

const title = (thread: Thread) => thread.name || thread.preview || '新会话';
const relativeTime = (seconds: number) => {
  const mins = Math.floor((Date.now() - seconds * 1000) / 60000);
  return mins < 1
    ? '刚刚'
    : mins < 60
      ? `${mins} 分钟前`
      : mins < 1440
        ? `${Math.floor(mins / 60)} 小时前`
        : new Date(seconds * 1000).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
};

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [configured, setConfigured] = useState(true);
  useEffect(() => {
    void api<{ configured: boolean; authenticated: boolean }>('/auth/status')
      .then((r) => {
        setConfigured(r.configured);
        setAuthenticated(r.authenticated);
      })
      .catch(() => setAuthenticated(false));
    const expire = () => {
      clearDrafts();
      setAuthenticated(false);
    };
    window.addEventListener('session-expired', expire);
    return () => window.removeEventListener('session-expired', expire);
  }, []);
  if (authenticated === null)
    return (
      <div className="app-loading">
        <Spinner label="正在打开工作台" />
      </div>
    );
  return authenticated ? (
    <Workspace
      onLogout={() => {
        clearDrafts();
        setAuthenticated(false);
      }}
    />
  ) : (
    <Login configured={configured} onLogin={() => setAuthenticated(true)} />
  );
}

function Workspace({ onLogout }: { onLogout: () => void }) {
  const [features, setFeatures] = useState<FeatureFlags>({ memory: false, collaboration: false });
  const [featuresLoaded, setFeaturesLoaded] = useState(false);
  const featureRequest = useRef(0);
  const applyFeatures = useCallback((value: FeatureFlags) => {
    featureRequest.current++;
    setFeatures(value);
    setFeaturesLoaded(true);
  }, []);
  const refreshFeatures = useCallback(async () => {
    const request = ++featureRequest.current;
    try {
      const value = await api<FeatureFlags>('/features');
      if (request === featureRequest.current) {
        setFeatures(value);
        setFeaturesLoaded(true);
      }
    } catch {
      /* Retain the last known settings until reconnect. */
    }
  }, []);
  const [continuityRevision, setContinuityRevision] = useState(0);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [collaborationDraftThread, setCollaborationDraftThread] = useState<string | null>(null);
  useEffect(() => {
    void refreshFeatures();
  }, [refreshFeatures]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [projectId, setProjectId] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    sessionStorage.getItem('selectedThread'),
  );
  const [thread, setThread] = useState<Thread | null>(null);
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [online, setOnline] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const reconnectSocket = useRef<() => void>(() => {});
  const [historyError, setHistoryError] = useState<{ id: string; message: string } | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState(() => localStorage.getItem('model') || '');
  const lastProvider = useRef(localStorage.getItem('modelProvider'));
  const [effort, setEffort] = useState(() => {
    const value = localStorage.getItem('effort') || '';
    return effortOptions.some((o) => o.value === value) ? value : '';
  });
  useEffect(() => {
    if (!status?.provider) return;
    const key = JSON.stringify([status.provider.id, status.provider.model]);
    if (
      lastProvider.current !== key &&
      (lastProvider.current !== null || status.provider.id !== null)
    ) {
      setModel('');
      setEffort('');
    }
    lastProvider.current = key;
    localStorage.setItem('modelProvider', key);
  }, [status?.provider?.id, status?.provider?.model]);
  const [preferences, setPreferences] = useState(readPreferences);
  const { policy, sandbox } = preferences;
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [conversationSearchLoading, setConversationSearchLoading] = useState(false);
  const [conversationSearchError, setConversationSearchError] = useState('');
  const [archived, setArchived] = useState(false);
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [listCursor, setListCursor] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [visibleTurns, setVisibleTurns] = useState(12);
  const {
    draft,
    setDraft,
    references,
    setReferences,
    fileReferences,
    setFileReferences,
    attachments,
    setAttachments,
    moveTo,
    forget,
  } = useComposerDraft(selectedId || `new:${projectId}`);
  const [sendMode, setSendMode] = useState('queue');
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [forceDialog, setForceDialog] = useState(false);
  const [forcing, setForcing] = useState(false);
  const [customModel, setCustomModel] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadInFlight = useRef(false);
  const [usageRevision, setUsageRevision] = useState(0);
  const [showProject, setShowProject] = useState(false);
  const readPage = () =>
    ['settings', 'usage', 'memories', 'collaborations'].includes(location.hash.slice(1))
      ? location.hash.slice(1)
      : 'workbench';
  const [workspacePage, updateWorkspacePage] = useState(readPage);
  const showSettings = workspacePage === 'settings';
  const showUsage = workspacePage === 'usage';
  const showMemory = workspacePage === 'memories';
  const showCollaboration = workspacePage === 'collaborations';
  useEffect(() => {
    if (!featuresLoaded) return;
    if ((showMemory && !features.memory) || (showCollaboration && !features.collaboration)) {
      location.hash = 'settings';
      updateWorkspacePage('settings');
    }
  }, [showMemory, showCollaboration, features, featuresLoaded]);
  const setWorkspacePage = (page: string, keepSidebar = false) => {
    location.hash = page;
    updateWorkspacePage(page);
    if (!keepSidebar) setSidebarOpen(false);
  };
  const setShowSettings = (open: boolean) => setWorkspacePage(open ? 'settings' : 'workbench');
  useEffect(() => {
    const update = () => updateWorkspacePage(readPage());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const [showFiles, setShowFiles] = useState(false);
  const [fileLink, setFileLink] = useState<{ href: string; scope: string; id: number } | null>(
    null,
  );
  const fileLinkId = useRef(0);
  const openFileLink = useCallback(
    (href: string) => {
      setFileLink({ href, scope: selectedId || projectId, id: ++fileLinkId.current });
      setShowFiles(true);
    },
    [selectedId, projectId],
  );
  const [showFileSearch, setShowFileSearch] = useState(false);
  const [showFileSource, setShowFileSource] = useState(false);
  const [nativeTask, setNativeTask] = useState<{
    threadId: string;
    type: 'review' | 'compact';
  } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileProjectsOpen, setMobileProjectsOpen] = useState(false);
  const [mobileThreadsOpen, setMobileThreadsOpen] = useState(true);
  const [error, setError] = useState('');
  const [rename, setRename] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [editingQueue, setEditingQueue] = useState<string | null>(null);
  const [exportThread, setExportThread] = useState<{ id: string; title: string } | null>(null);
  const [removeProject, setRemoveProject] = useState<Project | null>(null);
  const [deleteThread, setDeleteThread] = useState<Thread | null>(null);
  const [deletingThread, setDeletingThread] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const currentId = useRef(selectedId);
  currentId.current = selectedId;
  const previousArchiveFilter = useRef(archived);
  const events = useRef<WorkEvent[]>([]);
  const eventCursor = useRef(0);
  const fetchVersion = useRef(0);
  const threadRequest = useRef<AbortController | null>(null);
  const listVersion = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachmentRevision = useRef(0);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const reuseMessage = useCallback(
    (text: string, quote: boolean) => {
      if (quote) {
        setReferences((old) => (old.includes(text) ? old : [...old, text].slice(-5)));
      } else setDraft((old) => (old ? old + '\n\n' + text : text));
      requestAnimationFrame(() => {
        composerInput.current?.focus();
        composerInput.current?.setSelectionRange(1000000, 1000000);
      });
    },
    [setReferences, setDraft],
  );
  const running = status?.active.some((r) => r.threadId === selectedId) || false;
  const queued = status?.queued?.filter((r) => r.threadId === selectedId) || [];
  const shouldQueue = (running && sendMode === 'queue') || (!running && queued.length > 0);
  useEffect(() => {
    if (stoppingId && !status?.active.some((r) => r.threadId === stoppingId)) setStoppingId(null);
  }, [status?.active, stoppingId]);
  const requests =
    status?.pending.filter((p) => p.params.threadId === selectedId || !p.params.threadId) || [];
  const selectedProject = projects.find((p) => p.id === projectId);
  const setErrorMessage = (message: string) => setError(message);

  const loadProjects = useCallback(async () => {
    setProjects(await api<Project[]>('/projects'));
  }, []);
  const loadThreads = useCallback(
    async (cursor?: string) => {
      const version = ++listVersion.current;
      const query = new URLSearchParams({
        archived: String(archived),
        ...(projectId ? { project: projectId } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const result = await api<ThreadPage>(`/threads?${query}`);
      if (version !== listVersion.current) return;
      setThreads((old) =>
        cursor
          ? [...old, ...result.data.filter((t: Thread) => !old.some((x) => x.id === t.id))]
          : result.data,
      );
      setListCursor(result.nextCursor || null);
    },
    [projectId, archived],
  );
  const loadThread = useCallback(async (id: string, cursor?: string) => {
    const version = ++fetchVersion.current;
    const requestCursor = eventCursor.current;
    threadRequest.current?.abort();
    const controller = new AbortController();
    threadRequest.current = controller;
    if (!cursor) setLoading(true);
    try {
      const result = await api<ThreadRead>(
        `/threads/${encodeURIComponent(id)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        { signal: controller.signal },
      );
      if (version !== fetchVersion.current || currentId.current !== id) return null;
      let next = result.thread as Thread;
      for (const event of events.current)
        if (event.seq > result.cursor) next = applyThreadEvent(next, event);
      // A delayed render batch must not append deltas already included in this snapshot.
      next = { ...next, renderCursor: Math.max(result.cursor, eventCursor.current) };
      setThread((old) =>
        cursor && old?.id === id
          ? {
              ...old,
              turns: [
                ...next.turns.filter((t) => !old.turns.some((o) => o.id === t.id)),
                ...old.turns,
              ],
            }
          : reconcileThreadSnapshot(old, next, events.current, requestCursor, result.cursor),
      );
      setHistoryError((old) => (old?.id === id ? null : old));
      setHistoryCursor(result.nextCursor);
      if (cursor) setVisibleTurns((count) => count + 12);
      return result.nextCursor;
    } catch (error) {
      if (
        (error as Error & { statusCode?: number }).statusCode === 404 &&
        version === fetchVersion.current &&
        currentId.current === id
      ) {
        currentId.current = null;
        setSelectedId(null);
        setThread(null);
        return;
      }
      if (!controller.signal.aborted) {
        if (currentId.current === id) setHistoryError({ id, message: (error as Error).message });
        throw error;
      }
    } finally {
      if (version === fetchVersion.current) setLoading(false);
    }
  }, []);
  const refreshStatus = useCallback(() => {
    void api<RuntimeStatus>('/status')
      .then(setStatus)
      .catch((e) => setError(e.message));
  }, []);
  const callbacks = useRef({ loadThreads, loadThread, loadProjects });
  callbacks.current = { loadThreads, loadThread, loadProjects };
  useEffect(() => {
    void loadProjects().catch((e) => setError(e.message));
    refreshStatus();
    void api<{ data: Model[] }>('/models')
      .then((r) => {
        setModels(r.data);
      })
      .catch((e) => setError(e.message));
  }, [loadProjects, refreshStatus]);
  useEffect(() => {
    listVersion.current++;
    setThreads([]);
    setListCursor(null);
    const timer = setTimeout(() => {
      void loadThreads().catch((e) => setError(e.message));
    }, 220);
    return () => clearTimeout(timer);
  }, [loadThreads]);
  useEffect(() => {
    if (previousArchiveFilter.current !== archived) {
      setSelectedId(null);
      previousArchiveFilter.current = archived;
    }
  }, [archived]);
  useEffect(() => {
    setThread((old) => (old?.id === selectedId ? old : null));
    threadRequest.current?.abort();
    fetchVersion.current++;
    setHistoryCursor(null);
    setVisibleTurns(12);
    setMenu(false);
    setConversationSearchOpen(false);
    setConversationSearchLoading(false);
    setShowFileSource(false);
    follow.current = true;
    if (selectedId) {
      sessionStorage.setItem('selectedThread', selectedId);
    } else {
      sessionStorage.removeItem('selectedThread');
      fetchVersion.current++;
      setLoading(false);
    }
  }, [selectedId]);
  async function openConversationSearch() {
    if (!selectedId || !thread) return;
    const id = selectedId;
    setConversationSearchOpen(true);
    setConversationSearchError('');
    setVisibleTurns(Number.MAX_SAFE_INTEGER);
    follow.current = false;
    if (!historyCursor) return;
    setConversationSearchLoading(true);
    try {
      let cursor: string | null = historyCursor;
      while (cursor && currentId.current === id) cursor = (await loadThread(id, cursor)) || null;
    } catch (error) {
      if (currentId.current === id)
        setConversationSearchError(error instanceof Error ? error.message : '历史读取失败');
    } finally {
      if (currentId.current === id) setConversationSearchLoading(false);
    }
  }
  useEffect(() => {
    if (!selectedId) return;
    const id = selectedId;
    const revision = attachmentRevision.current;
    const controller = new AbortController();
    void api<Attachment[]>(`/threads/${id}/attachments`, { signal: controller.signal })
      .then((files) => {
        if (!controller.signal.aborted && attachmentRevision.current === revision)
          setAttachments(files, id);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [selectedId]);
  useEffect(() => {
    if (selectedId) void loadThread(selectedId).catch((e) => setError(e.message));
    return () => threadRequest.current?.abort();
  }, [selectedId, loadThread]);
  useEffect(() => {
    localStorage.setItem('model', model);
    localStorage.setItem('effort', effort);
  }, [model, effort]);
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket;
    let timer: ReturnType<typeof setTimeout>;
    let delay = 1000;
    let handshakeTimer: ReturnType<typeof setTimeout>;
    let refreshTimer: ReturnType<typeof setTimeout>;
    let renderTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingEvents: WorkEvent[] = [];
    let bufferedEventBytes = 0;
    const flushEvents = () => {
      clearTimeout(renderTimer);
      renderTimer = undefined;
      const batch = pendingEvents;
      pendingEvents = [];
      if (!batch.length) return;
      setThread((previous) => (previous ? applyRenderBatch(previous, batch) : previous));
    };
    const refreshList = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void callbacks.current.loadThreads().catch((e) => setError(e.message));
      }, 300);
    };
    const connect = () => {
      if (disposed || navigator.onLine === false) return;
      clearTimeout(timer);
      clearTimeout(handshakeTimer);
      setOnline(false);
      setConnectionAttempt((count) => count + 1);
      socket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events?after=${eventCursor.current}`,
      );
      const connection = socket;
      handshakeTimer = setTimeout(() => connection.close(), 15000);
      socket.onmessage = (message) => {
        if (socket !== connection || disposed) return;
        let data;
        try {
          data = parseSocketMessage(String(message.data));
        } catch {
          setError('实时消息格式不兼容，正在重新连接');
          socket.close(1002);
          return;
        }
        if (data.type === 'hello') {
          flushEvents();
          setStatus(data.status);
          if (data.reset) {
            events.current = [];
            bufferedEventBytes = 0;
            eventCursor.current = data.cursor;
          }
        }
        if (data.type === 'synced') {
          void refreshFeatures();
          setContinuityRevision((value) => value + 1);
          clearTimeout(handshakeTimer);
          setConnectionAttempt(0);
          eventCursor.current = data.cursor;
          setOnline(true);
          delay = 1000;
          void callbacks.current.loadProjects().catch((e) => setError(e.message));
          refreshList();
          if (currentId.current)
            void callbacks.current.loadThread(currentId.current).catch((e) => setError(e.message));
        }
        if (data.type !== 'event') return;
        const event: WorkEvent = data.event;
        if (event.seq <= eventCursor.current) return;
        eventCursor.current = event.seq;
        events.current.push(event);
        bufferedEventBytes += message.data.length * 2;
        if (bufferedEventBytes > 4 * 1024 * 1024) {
          events.current = [event];
          bufferedEventBytes = message.data.length * 2;
        }
        if (events.current.length > 3000) events.current.splice(0, 1000);
        pendingEvents.push(event);
        if (event.method.endsWith('/delta') || event.method.endsWith('Delta')) {
          if (!renderTimer) renderTimer = setTimeout(flushEvents, 50);
        } else flushEvents();
        const p = event.params;
        if (
          ['thread/tokenUsage/updated', 'workbench/balanceUpdated', 'turn/completed'].includes(
            event.method,
          )
        )
          setUsageRevision((value) => value + 1);
        if (event.method === 'workbench/runtimeChanged')
          void api<RuntimeStatus>('/status')
            .then(setStatus)
            .catch((e) => setError(e.message));
        if (event.method === 'workbench/connected' && currentId.current)
          void callbacks.current.loadThread(currentId.current).catch((e) => setError(e.message));
        if (event.method === 'workbench/providerModelsUpdated')
          void api<{ data: Model[] }>('/models')
            .then((result) => setModels(result.data))
            .catch((e) => setError(e.message));
        if (
          event.method === 'workbench/providerChanged' ||
          event.method === 'workbench/configurationChanged'
        ) {
          if (event.method === 'workbench/providerChanged') {
            setModel('');
            setEffort('');
          }
          void api<{ data: Model[] }>('/models')
            .then((result) => setModels(result.data))
            .catch((e) => setError(e.message));
          void api<RuntimeStatus>('/status')
            .then(setStatus)
            .catch((e) => setError(e.message));
          if (currentId.current)
            void callbacks.current.loadThread(currentId.current).catch((e) => setError(e.message));
        }
        if (
          event.method === 'workbench/cacheCleared' ||
          event.method === 'workbench/resyncRequired'
        ) {
          events.current = [];
          bufferedEventBytes = 0;
          void api<RuntimeStatus>('/status')
            .then(setStatus)
            .catch((e) => setError(e.message));
          refreshList();
          if (currentId.current)
            void callbacks.current.loadThread(currentId.current).catch((e) => setError(e.message));
        }
        if (event.method === 'workbench/threadDeleted') {
          if (p.threadId) forget(p.threadId);
          events.current = [];
          setThreads((old) => old.filter((t) => t.id !== p.threadId));
          if (currentId.current === p.threadId) {
            currentId.current = null;
            threadRequest.current?.abort();
            fetchVersion.current++;
            setShowSettings(false);
            setSelectedId(null);
            setThread(null);
          }
        }
        if (
          event.method === 'workbench/featuresChanged' &&
          typeof p.memory === 'boolean' &&
          typeof p.collaboration === 'boolean'
        )
          applyFeatures({ memory: p.memory, collaboration: p.collaboration });
        if (['workbench/memoriesChanged', 'workbench/collaborationChanged'].includes(event.method))
          setContinuityRevision((value) => value + 1);
        if (
          [
            'workbench/request',
            'workbench/requestResolved',
            'turn/started',
            'turn/completed',
            'workbench/disconnected',
            'workbench/connected',
            'workbench/queueChanged',
          ].includes(event.method)
        )
          setStatus((s) => {
            if (!s) return s;
            if (event.method === 'workbench/queueChanged') return { ...s, queued: p.queued };
            if (event.method === 'workbench/request')
              return {
                ...s,
                pending: [...s.pending.filter((r) => r.id !== p.id), pendingSchema.parse(p)],
              };
            if (event.method === 'workbench/requestResolved')
              return { ...s, pending: s.pending.filter((r) => r.id !== p.id) };
            if (event.method === 'turn/started' && p.threadId && p.turn)
              return {
                ...s,
                active: [
                  ...s.active.filter((r) => r.threadId !== p.threadId),
                  { threadId: p.threadId, turnId: p.turn.id, cwd: '' },
                ],
              };
            if (event.method === 'turn/completed')
              return { ...s, active: s.active.filter((r) => r.threadId !== p.threadId) };
            if (event.method === 'workbench/disconnected')
              return { ...s, connected: false, active: [], pending: [], error: p.message };
            if (event.method === 'workbench/connected')
              return { ...s, connected: true, error: undefined };
            return s;
          });
        if (
          [
            'thread/started',
            'thread/name/updated',
            'turn/completed',
            'workbench/threadsChanged',
            'workbench/threadDeleted',
            'workbench/connected',
          ].includes(event.method)
        )
          refreshList();
        if (event.method === 'workbench/projectsChanged')
          void callbacks.current.loadProjects().catch((e) => setError(e.message));
        if (['workbench/warning', 'workbench/disconnected'].includes(event.method))
          setError(p.message || '执行器连接已变化');
      };
      socket.onclose = (e) => {
        if (socket !== connection) return;
        clearTimeout(handshakeTimer);
        flushEvents();
        setOnline(false);
        if (disposed) return;
        if (e.code === 4001) {
          onLogout();
          return;
        }
        if (navigator.onLine !== false) timer = setTimeout(connect, delay);
        delay = Math.min(delay * 1.6, 15000);
      };
      socket.onerror = () => connection.close();
    };
    const reconnect = () => {
      if (disposed) return;
      flushEvents();
      if (socket) {
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
      delay = 1000;
      connect();
    };
    reconnectSocket.current = reconnect;
    const visibility = () => {
      if (document.visibilityState === 'visible') reconnect();
    };
    const offline = () => {
      setOnline(false);
      socket?.close();
    };
    window.addEventListener('online', reconnect);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visibility);
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(refreshTimer);
      clearTimeout(handshakeTimer);
      clearTimeout(renderTimer);
      window.removeEventListener('online', reconnect);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visibility);
      reconnectSocket.current = () => {};
      pendingEvents = [];
      if (socket) {
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
    };
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [thread, requests.length]);

  async function createThread() {
    const project = selectedProject || projects[0];
    if (!project) {
      setShowProject(true);
      throw new Error('请先添加项目');
    }
    const result = await post<{ thread: Thread }>('/threads', {
      projectId: project.id,
      model: model || undefined,
      approvalPolicy: policy,
      sandbox,
    });
    return result.thread as Thread;
  }
  async function send() {
    if ((!draft.trim() && !attachments.length) || sending || uploading) return;
    attachmentRevision.current++;
    setSending(true);
    setError('');
    const text = draft;
    const files = [...attachments];
    let targetId = selectedId;
    try {
      if (!targetId) {
        const created = await createThread();
        targetId = created.id;
        moveTo(targetId);
        currentId.current = targetId;
        setSelectedId(targetId);
        setThread(created);
      }
      await post(`/threads/${targetId}/messages`, {
        text,
        attachments: files.map((f) => f.id),
        model: model || undefined,
        effort: sendEffort || undefined,
        references,
        fileReferences,
        steer: running && !shouldQueue,
        enqueue: shouldQueue,
      });
      // Update the original draft even if the user switched conversations.
      attachmentRevision.current++;
      setDraft((old) => (old === text ? '' : old), targetId);
      setAttachments(
        (old) => old.filter((file) => !files.some((sent) => sent.id === file.id)),
        targetId,
      );
      setReferences((old) => old.filter((reference) => !references.includes(reference)), targetId);
      setFileReferences(
        (old) => old.filter((reference) => !fileReferences.includes(reference)),
        targetId,
      );
      if (currentId.current === targetId) follow.current = true;
      void loadThreads().catch((e) => setError(e.message));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function synchronize() {
    reconnectSocket.current();
    try {
      const next = await api<RuntimeStatus>('/status');
      setStatus(next);
      if (!next.connected) {
        await post('/connect');
        refreshStatus();
      }
      if (currentId.current) await loadThread(currentId.current);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function continueTask() {
    if (!selectedId || running || sending) return;
    setSending(true);
    try {
      await loadThread(selectedId);
      await post(`/threads/${selectedId}/messages`, {
        text: '上次执行已经中断。请先检查会话历史和当前工作区，确认哪些步骤已经完成，再从未完成的地方继续。避免重复执行已完成的修改或命令。',
        model: model || undefined,
        effort: sendEffort || undefined,
      });
      setError('');
      refreshStatus();
      void loadThread(selectedId).catch((e) => setError(e.message));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function upload(files: FileList | File[] | null) {
    if (!files?.length) return;
    if (uploadInFlight.current || sending) {
      setError('正在上传或发送，请完成后再粘贴附件。');
      return;
    }
    const selectedFiles = [...files];
    const available = 10 - attachments.length;
    if (available <= 0 || selectedFiles.length > available) {
      setError('待发送附件最多 10 个，请先发送或移除附件。');
      return;
    }
    const oversized = selectedFiles.find((file) => file.size > 20 * 1024 * 1024);
    if (oversized) {
      setError(`「${oversized.name}」超过 20 MB，请选择较小的文件。`);
      return;
    }
    uploadInFlight.current = true;
    attachmentRevision.current++;
    setUploading(true);
    setError('');
    let targetId = selectedId;
    try {
      if (!targetId) {
        const created = await createThread();
        targetId = created.id;
        moveTo(targetId);
        currentId.current = targetId;
        setSelectedId(targetId);
      }
      for (const file of selectedFiles) {
        const form = new FormData();
        form.append('file', file);
        const uploaded = await api<Attachment>(`/threads/${targetId}/attachments`, {
          method: 'POST',
          body: form,
        });
        attachmentRevision.current++;
        setAttachments((old) => [...old.filter((a) => a.id !== uploaded.id), uploaded], targetId);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      uploadInFlight.current = false;
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function stopTask() {
    if (!selectedId) return;
    const id = selectedId;
    setStoppingId(id);
    try {
      await post(`/threads/${id}/interrupt`);
    } catch (e) {
      setError((e as Error).message);
      setStoppingId(null);
    }
  }
  async function action(actionName: string, extra = {}) {
    if (!selectedId) return;
    setMenu(false);
    const previousThread = thread;
    if (actionName === 'fork') {
      threadRequest.current?.abort();
      fetchVersion.current++;
      setThread(null);
      setLoading(true);
    }
    try {
      const result = await post<{ thread?: Thread }>(`/threads/${selectedId}/action`, {
        action: actionName,
        ...extra,
      });
      if (actionName === 'fork') {
        if (!result.thread) throw new Error('服务器未返回分叉会话');
        currentId.current = result.thread.id;
        setSelectedId(result.thread.id);
      }
      if (['archive', 'unarchive'].includes(actionName)) setSelectedId(null);
      if (actionName === 'rename') {
        setRename(null);
        await loadThread(selectedId);
      }
      await loadThreads();
    } catch (e) {
      if (actionName === 'fork') {
        setThread(previousThread);
        setLoading(false);
      }
      setError((e as Error).message);
    }
  }
  const selectedMeta = threads.find((t) => t.id === selectedId);
  const visibleThreads = onlyRunning
    ? threads.filter((t) => status?.active.some((r) => r.threadId === t.id))
    : threads;
  const sortedThreads = [...visibleThreads].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  const activeModel = model
    ? models.find((m) => m.model === model || m.id === model)
    : models.find((m) => m.isDefault);
  const supportedEfforts = activeModel?.supportedReasoningEfforts || [];
  const effectiveEffort = effort || preferences.effort;
  const sendEffort =
    !supportedEfforts.length || supportedEfforts.some((e) => e.reasoningEffort === effectiveEffort)
      ? effectiveEffort
      : '';
  const menuModels = preferences.models.length
    ? preferences.models.map(
        (id) => models.find((m) => m.model === id) || { model: id, displayName: id, hidden: false },
      )
    : models;
  const composer = (
    <div className="composer-wrap">
      {queued.length > 0 && (
        <details className="message-queue" open>
          <summary>
            待发送消息 · {queued.length}
            <span>保存在服务器</span>
          </summary>
          <div className="queue-list">
            {queued.map((item, index) => (
              <div className="queue-item" key={item.id}>
                <div>
                  <strong>
                    {index + 1}.{' '}
                    {item.state === 'paused'
                      ? '已暂停'
                      : item.state === 'sending'
                        ? '正在提交'
                        : '等待执行'}
                  </strong>
                  <p>{item.preview}</p>
                  {item.error && <small>{item.error}</small>}
                </div>
                <button
                  className="icon-btn"
                  aria-label={`编辑排队消息 ${index + 1}`}
                  disabled={item.state === 'sending'}
                  onClick={() => setEditingQueue(item.id)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  className="icon-btn"
                  aria-label={`取消排队消息 ${index + 1}`}
                  disabled={item.state === 'sending'}
                  onClick={() =>
                    void post(`/queue/${item.id}`, { action: 'cancel' }).catch((e) =>
                      setError(e.message),
                    )
                  }
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
          {queued.some((item) => item.state === 'paused') && (
            <button
              className="text-button"
              onClick={() =>
                void post(`/queue/${queued.find((item) => item.state === 'paused')!.id}`, {
                  action: 'resume',
                }).catch((e) => setError(e.message))
              }
            >
              继续此会话队列
            </button>
          )}
        </details>
      )}
      {references.length > 0 && (
        <div className="composer-references" aria-label="引用内容">
          {references.map((text, index) => (
            <div className="reference-card" key={index}>
              <details>
                <summary>
                  引用 {index + 1} · {text.slice(0, 65)}
                </summary>
                <pre>{text}</pre>
              </details>
              <button
                className="icon-btn"
                aria-label={`移除引用 ${index + 1}`}
                onClick={() => setReferences((old) => old.filter((_, i) => i !== index))}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {fileReferences.length > 0 && (
        <div className="file-reference-chips" aria-label="引用的项目文件">
          {fileReferences.map((file) => (
            <span key={file}>
              <code title={file}>{file}</code>
              <button
                className="icon-btn"
                aria-label={`移除文件引用 ${file}`}
                onClick={() => setFileReferences((old) => old.filter((p) => p !== file))}
              >
                <X size={14} />
              </button>
            </span>
          ))}
        </div>
      )}
      {running && (
        <div className="running-controls">
          <Select
            label="执行中发送方式"
            value={sendMode}
            onChange={setSendMode}
            options={[
              { value: 'queue', label: '排队发送', description: '当前任务完成后依次执行' },
              { value: 'steer', label: '立即补充', description: '将消息交给当前正在执行的任务' },
            ]}
          />
          {stoppingId === selectedId && <span role="status">正在请求停止…</span>}
        </div>
      )}
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((file) => (
            <span key={file.id}>
              <Paperclip size={12} />
              {file.name}
              <button
                aria-label={`移除 ${file.name}`}
                onClick={() => {
                  const id = selectedId;
                  if (!id) return;
                  attachmentRevision.current++;
                  void api(`/threads/${id}/attachments/${file.id}`, { method: 'DELETE' })
                    .then(() => {
                      attachmentRevision.current++;
                      setAttachments((old) => old.filter((f) => f.id !== file.id), id);
                    })
                    .catch((e) => setError(e.message));
                }}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div
        className="composer"
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (!files.length)
            for (const item of event.clipboardData.items) {
              if (item.kind === 'file') {
                const file = item.getAsFile();
                if (file) files.push(file);
              }
            }
          if (!files.length) return;
          event.preventDefault();
          void upload(files);
        }}
      >
        <ComposerInput
          key={selectedId || projectId}
          inputRef={composerInput}
          placeholder={
            shouldQueue
              ? '写下一条任务，加入服务器队列…'
              : running
                ? '补充指令，Codex 会在当前任务中接收…'
                : references.length
                  ? '针对引用内容，写下你的问题…'
                  : '描述你想完成的工作…'
          }
          value={draft}
          onChange={setDraft}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              !matchMedia('(pointer: coarse)').matches
            ) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-bottom">
          <div className="composer-controls">
            <Select
              label="模型"
              value={model}
              onChange={(value) => {
                if (value === '__custom__') {
                  setCustomModel(model);
                  return;
                }
                setModel(value);
                setEffort('');
              }}
              options={[
                {
                  value: '',
                  label: '默认模型',
                  description: models.find((m) => m.isDefault)?.displayName || '使用终端配置',
                },
                ...menuModels.map((m) => ({
                  value: m.model,
                  label: m.displayName,
                  description: m.model + (m.hidden ? ' · 额外模型' : ''),
                })),
                ...(model && !menuModels.some((m) => m.model === model)
                  ? [{ value: model, label: model, description: '自定义模型' }]
                  : []),
                {
                  value: '__custom__',
                  label: '自定义模型 ID…',
                  description: '使用终端提供商支持的模型',
                },
              ]}
            />
            <Select
              label="推理强度"
              value={effort}
              onChange={setEffort}
              options={[
                {
                  value: '',
                  label: '默认强度',
                  description: preferences.effort
                    ? `设置：${effortOptions.find((o) => o.value === preferences.effort)?.label}${sendEffort ? '' : '（当前模型不支持，跟随模型）'}`
                    : '使用模型默认设置',
                },
                ...effortOptions.map((option) => ({
                  ...option,
                  disabled:
                    supportedEfforts.length > 0 &&
                    !supportedEfforts.some((e) => e.reasoningEffort === option.value),
                  description: option.value,
                })),
              ]}
            />
            <button
              className="icon-btn"
              aria-label="添加附件"
              title="引用项目文件或上传新文件"
              disabled={uploading || sending}
              onClick={() => setShowFileSource(true)}
            >
              <Paperclip size={17} />
            </button>
            <input
              hidden
              type="file"
              ref={fileInput}
              multiple
              onChange={(e) => void upload(e.target.files)}
            />
          </div>
          <div className="button-row">
            {running && (
              <button
                className="stop-button"
                aria-label="停止任务"
                title="停止当前任务并暂停后续队列"
                disabled={stoppingId === selectedId}
                onClick={() => void stopTask()}
              >
                <Square size={13} fill="currentColor" />
              </button>
            )}
            <button
              className="send-button"
              aria-label={shouldQueue ? '加入队列' : running ? '补充指令' : '发送消息'}
              title={shouldQueue ? '加入队列' : running ? '补充指令' : '发送消息'}
              disabled={sending || uploading || !online || (!draft.trim() && !attachments.length)}
              onClick={() => void send()}
            >
              {sending || uploading ? <Spinner label="" /> : <ArrowUp size={19} />}
            </button>
          </div>
        </div>
      </div>
      {thread?.tokenUsage && (
        <details className="context-usage">
          <summary>
            <Layers size={13} />
            <span>上下文与用量</span>
            {thread.tokenUsage.modelContextWindow && (
              <span>
                最近输入 {formatTokens(thread.tokenUsage.last?.inputTokens)} / 窗口{' '}
                {formatTokens(thread.tokenUsage.modelContextWindow)}
              </span>
            )}
            <ChevronDown size={12} />
          </summary>
          <div>
            <span>累计输入：{formatTokens(thread.tokenUsage.total?.inputTokens)} tokens</span>
            <span>累计输出：{formatTokens(thread.tokenUsage.total?.outputTokens)} tokens</span>
            <span>
              其中思考：
              {formatTokens(thread.tokenUsage.total?.reasoningOutputTokens)} tokens
            </span>
          </div>
        </details>
      )}
    </div>
  );

  return (
    <div className="workspace">
      {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}
      <aside className={'sidebar ' + (sidebarOpen ? 'open' : '')}>
        <div className="sidebar-content">
          <div className="brand">
            <div className="brand-mark">
              <img src={identity.logoUrl} alt="Codex Cloud Logo" />
            </div>
            <strong>{identity.appName}</strong>
            <span className="private-label">个人版</span>
            <button
              className="icon-btn mobile-only"
              aria-label="关闭侧栏"
              onClick={() => setSidebarOpen(false)}
            >
              <X size={17} />
            </button>
          </div>
          <div className="sidebar-create-row">
            <button
              className="new-chat"
              onClick={() => {
                setShowSettings(false);
                setSelectedId(null);
                setArchived(false);
                setSidebarOpen(false);
              }}
            >
              <Plus size={17} />
              新建会话
            </button>
          </div>
          <nav className="quick-nav">
            <button
              className={
                workspacePage === 'workbench' && !projectId && !onlyRunning && !archived
                  ? 'active'
                  : ''
              }
              onClick={() => {
                setWorkspacePage('workbench', true);
                setProjectId('');
                setOnlyRunning(false);
                setArchived(false);
                setMobileThreadsOpen(true);
              }}
            >
              <Layers size={16} />
              全部会话
            </button>
            <button
              className={onlyRunning ? 'active' : ''}
              onClick={() => {
                setWorkspacePage('workbench', true);
                setOnlyRunning(!onlyRunning);
                setArchived(false);
                setMobileThreadsOpen(true);
              }}
            >
              <Circle size={15} className={status?.active.length ? 'green-text' : ''} />
              运行中<span className="count">{status?.active.length || 0}</span>
            </button>
            {features.collaboration && (
              <button
                className={showCollaboration ? 'active' : ''}
                onClick={() => {
                  setCollaborationDraftThread(null);
                  setWorkspacePage('collaborations');
                }}
              >
                <Workflow size={16} />
                协作
              </button>
            )}
            {features.memory && (
              <button
                className={showMemory ? 'active' : ''}
                onClick={() => setWorkspacePage('memories')}
              >
                <Brain size={16} />
                记忆库
              </button>
            )}
          </nav>
          <div className="section-label">
            <span className="sidebar-section-static">项目</span>
            <button
              className="sidebar-section-toggle"
              aria-label="项目"
              aria-expanded={mobileProjectsOpen}
              aria-controls="sidebar-projects"
              onClick={() => setMobileProjectsOpen((open) => !open)}
            >
              项目
              <ChevronDown size={16} aria-hidden="true" />
            </button>
            <button className="icon-btn" aria-label="添加项目" onClick={() => setShowProject(true)}>
              <Plus size={14} />
            </button>
          </div>
          <div
            id="sidebar-projects"
            className={'projects-list' + (mobileProjectsOpen ? '' : ' mobile-collapsed')}
          >
            {projects.map((project) => (
              <div
                key={project.id}
                className={'project-entry ' + (projectId === project.id ? 'active' : '')}
              >
                <button
                  title={project.path}
                  onClick={() => {
                    setProjectId(project.id);
                    setOnlyRunning(false);
                    setArchived(false);
                    setMobileThreadsOpen(true);
                  }}
                >
                  <Folder size={15} />
                  <span>{project.name}</span>
                </button>
                <button
                  className="icon-btn project-remove"
                  title="移除项目关联"
                  aria-label={`移除项目 ${project.name}`}
                  onClick={() => setRemoveProject(project)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {!projects.length && (
              <button className="empty-project" onClick={() => setShowProject(true)}>
                <FolderPlus size={15} />
                添加第一个项目
              </button>
            )}
          </div>
          <div className="section-label">
            <span className="sidebar-section-static">{archived ? '已归档' : '最近会话'}</span>
            <span className="sidebar-section-static">{threads.length}</span>
            <button
              className="sidebar-section-toggle"
              aria-label={archived ? '已归档' : '最近会话'}
              aria-expanded={mobileThreadsOpen}
              aria-controls="sidebar-threads"
              onClick={() => setMobileThreadsOpen((open) => !open)}
            >
              {archived ? '已归档' : '最近会话'}
              <span className="sidebar-section-count">{threads.length}</span>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          </div>
          <div
            id="sidebar-threads"
            className={'threads-list' + (mobileThreadsOpen ? '' : ' mobile-collapsed')}
          >
            {sortedThreads.map((t) => {
              const active = status?.active.some((r) => r.threadId === t.id);
              const pending = status?.pending.some((r) => r.params.threadId === t.id);
              return (
                <div className="thread-list-row" key={t.id}>
                  <button
                    key={t.id}
                    className={'thread-entry ' + (selectedId === t.id ? 'selected' : '')}
                    onClick={() => {
                      setShowSettings(false);
                      setSelectedId(t.id);
                      setSidebarOpen(false);
                    }}
                  >
                    <span
                      className={
                        'thread-indicator ' + (pending ? 'amber' : active ? 'green pulse' : '')
                      }
                    >
                      {!active &&
                        !pending &&
                        (t.pinned ? <Pin size={12} /> : <MessageSquare size={13} />)}
                    </span>
                    <span className="thread-info">
                      <span>{title(t)}</span>
                      <small className="thread-meta">
                        <span>
                          {pending
                            ? '等待你的处理'
                            : active
                              ? '正在执行'
                              : t.interrupted
                                ? '上次执行已中断'
                                : relativeTime(t.updatedAt)}
                        </span>
                        <span className="thread-id" title={`会话 ID：${t.id}`}>
                          (ID: {shortThreadId(t.id)} )
                        </span>
                      </small>
                    </span>
                  </button>
                  <button
                    className="icon-btn thread-delete"
                    aria-label={`删除会话 ${title(t)}`}
                    title={active ? '请先停止任务' : '永久删除会话'}
                    disabled={active || pending}
                    onClick={() => {
                      setDeleteError('');
                      setDeleteThread(t);
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
            {!threads.length && (
              <p className="sidebar-empty">{archived ? '暂无归档会话' : '你的会话会出现在这里'}</p>
            )}
            {listCursor && (
              <button
                className="text-button"
                onClick={() => void loadThreads(listCursor).catch((e) => setError(e.message))}
              >
                加载更多
              </button>
            )}
          </div>
        </div>
        <div className="sidebar-footer">
          <button className={showSettings ? 'active' : ''} onClick={() => setShowSettings(true)}>
            <Settings2 size={15} />
            设置
            <span className={'status-dot ' + (status?.connected ? 'green' : '')} />
          </button>
        </div>
      </aside>
      <main className="main" hidden={showSettings || showUsage || showMemory || showCollaboration}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-btn mobile-only"
              aria-label="打开侧栏"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={19} />
            </button>
            <span className="desktop-label">工作台</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{thread ? title(thread) : selectedProject?.name || '新建会话'}</strong>
          </div>
          <div className="topbar-actions">
            <span className="connection">
              <span className={'status-dot ' + (online && status?.connected ? 'green' : '')} />
              {online && status?.connected ? '服务器在线' : '连接中'}
            </span>
            <button
              className={'icon-btn ' + (showFiles ? 'active' : '')}
              aria-label="查看文件和改动"
              disabled={!selectedId && !projectId}
              onClick={() => {
                setFileLink(null);
                setShowFiles(!showFiles);
              }}
            >
              <FileCode2 size={18} />
            </button>
            <button
              className={'icon-btn ' + (conversationSearchOpen ? 'active' : '')}
              aria-label="搜索当前会话"
              aria-expanded={conversationSearchOpen}
              disabled={!selectedId || !thread}
              onClick={() => {
                if (conversationSearchOpen) setConversationSearchOpen(false);
                else void openConversationSearch();
              }}
            >
              <Search size={18} />
            </button>
            <div className="menu-anchor">
              <button className="icon-btn" aria-label="会话菜单" onClick={() => setMenu(!menu)}>
                <MoreHorizontal size={19} />
              </button>
              {menu && (
                <>
                  <div className="menu-dismiss" onClick={() => setMenu(false)} />
                  <div className="dropdown">
                    {selectedId && (
                      <>
                        {features.collaboration && (
                          <button
                            onClick={() => {
                              setCollaborationDraftThread(selectedId);
                              setWorkspacePage('collaborations');
                              setMenu(false);
                            }}
                          >
                            <Workflow size={14} />
                            加入协作组
                          </button>
                        )}
                        <button
                          disabled={running || sending || queued.length > 0 || archived}
                          onClick={() => {
                            setNativeTask({ threadId: selectedId, type: 'review' });
                            setMenu(false);
                          }}
                        >
                          <ShieldCheck size={14} />
                          代码审查
                        </button>
                        <button
                          disabled={running || sending || queued.length > 0 || archived}
                          onClick={() => {
                            setNativeTask({ threadId: selectedId, type: 'compact' });
                            setMenu(false);
                          }}
                        >
                          <Layers size={14} />
                          压缩上下文
                        </button>
                        <button
                          onClick={() => {
                            setExportThread({
                              id: selectedId,
                              title: thread ? title(thread) : '当前会话',
                            });
                            setMenu(false);
                          }}
                        >
                          <Download size={14} />
                          导出当前会话
                        </button>
                        <button
                          onClick={() => {
                            setRename(thread ? title(thread) : '');
                            setMenu(false);
                          }}
                        >
                          <Pencil size={14} />
                          重命名
                        </button>
                        <button
                          onClick={() => void action('pin', { pinned: !selectedMeta?.pinned })}
                        >
                          <Pin size={14} />
                          {selectedMeta?.pinned ? '取消置顶' : '置顶会话'}
                        </button>
                        <button disabled={running} onClick={() => void action('fork')}>
                          <GitBranch size={14} />
                          分叉会话
                        </button>
                        <button
                          disabled={running}
                          onClick={() => void action(archived ? 'unarchive' : 'archive')}
                        >
                          <Archive size={14} />
                          {archived ? '恢复会话' : '归档会话'}
                        </button>
                        <button
                          className="danger-text"
                          disabled={running || !thread}
                          onClick={() => {
                            setMenu(false);
                            setDeleteError('');
                            setDeleteThread(thread);
                          }}
                        >
                          <Trash2 size={14} />
                          永久删除会话
                        </button>
                      </>
                    )}
                    <button
                      className="danger-text"
                      disabled={forcing || !status?.active.length}
                      onClick={() => {
                        setMenu(false);
                        setForceDialog(true);
                      }}
                    >
                      <OctagonX size={14} />
                      强制终止执行器
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>
        {conversationSearchOpen && (
          <ConversationSearch
            key={selectedId}
            container={scroll}
            loading={conversationSearchLoading}
            error={conversationSearchError}
            onClose={() => setConversationSearchOpen(false)}
          />
        )}
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="text-button" onClick={() => void synchronize()}>
              重新同步
            </button>
            <button className="icon-btn" aria-label="关闭提示" onClick={() => setError('')}>
              <X size={15} />
            </button>
          </div>
        )}
        {!online && (
          <div className="notice connection-notice reconnect-notice" role="status">
            <RefreshCw size={14} className="spin" />
            <span>
              实时连接已断开，正在自动重连
              {connectionAttempt > 1 ? `（第 ${connectionAttempt} 次）` : ''}。会话和草稿会保留。
            </span>
            <button className="text-button" onClick={() => void synchronize()}>
              立即重连
            </button>
          </div>
        )}
        {!status?.connected && status?.error && (
          <div className="notice connection-notice">
            {status.error}
            <button className="text-button" onClick={() => void synchronize()}>
              重新连接执行器
            </button>
            <button className="text-button" onClick={() => setShowSettings(true)}>
              检查连接
            </button>
          </div>
        )}
        {status?.testMode && (
          <div className="notice connection-notice" role="status">
            测试环境：示例项目、模型和回复均为模拟数据，不会执行真实 Codex 任务。
          </div>
        )}
        <div className="main-body">
          <FileLinkContext.Provider value={openFileLink}>
            <MemoryActionContext.Provider
              value={
                features.memory
                  ? (text) => {
                      setMemoryDraft(text.slice(0, 4000));
                      setWorkspacePage('memories');
                    }
                  : null
              }
            >
              <MessageActionContext.Provider value={reuseMessage}>
                <section className="conversation">
                  {!selectedId ? (
                    <div className="welcome">
                      <div className="welcome-content">
                        <div className="welcome-topline">
                          <span className="tiny-line" />
                          个人工作空间
                        </div>
                        <div className="welcome-profile">
                          <img src={identity.avatarUrl} alt="Arran 的头像" />
                          <div>
                            <span>欢迎回来</span>
                            <strong>{identity.userName}</strong>
                          </div>
                        </div>
                        <h1>今天，想完成什么？</h1>
                        <p>一个想法，一段指令。让 Codex 接着往下做。</p>
                        <div className="project-picker">
                          <Folder size={15} />
                          <Select
                            label="选择项目"
                            value={projectId || projects[0]?.id || ''}
                            onChange={setProjectId}
                            options={[
                              { value: '', label: '选择服务器上的项目', disabled: true },
                              ...projects.map((p) => ({
                                value: p.id,
                                label: p.name,
                                description: p.path,
                              })),
                            ]}
                          />
                          <button
                            className="icon-btn"
                            aria-label="新增项目"
                            onClick={() => setShowProject(true)}
                          >
                            <Plus size={15} />
                          </button>
                        </div>
                        {composer}
                        <div className="suggestions">
                          {[
                            {
                              icon: <Code2 size={18} />,
                              title: '理解项目',
                              text: '梳理代码结构与运行方式',
                              prompt:
                                '请先阅读这个项目，介绍代码结构、核心功能，以及如何启动和测试。',
                            },
                            {
                              icon: <ShieldCheck size={18} />,
                              title: '检查问题',
                              text: '审查代码，找到潜在风险',
                              prompt:
                                '请审查这个项目的代码，找出最值得优先修复的问题，并说明依据。先不要修改文件。',
                            },
                            {
                              icon: <Sparkles size={18} />,
                              title: '开始构建',
                              text: '把想法变成可运行的功能',
                              prompt: '我想给这个项目增加一个功能：',
                            },
                          ].map((s) => (
                            <button key={s.title} onClick={() => setDraft(s.prompt)}>
                              {s.icon}
                              <strong>{s.title}</strong>
                              <span>{s.text}</span>
                              <ArrowUp size={13} />
                            </button>
                          ))}
                        </div>
                        <div className="welcome-note">
                          <Globe2 size={14} />
                          换一台设备，工作也能继续。
                        </div>
                      </div>
                      <div className="welcome-bottom">
                        <span>Codex Cloud · 私人工作台</span>
                        <span>由 Codex 提供执行能力</span>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div
                        className="messages"
                        ref={scroll}
                        onScroll={() => {
                          const el = scroll.current;
                          if (el) {
                            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
                            setAtBottom(follow.current);
                          }
                        }}
                      >
                        <div className="messages-inner">
                          {(historyCursor || (thread && thread.turns.length > visibleTurns)) && (
                            <button
                              className="text-button load-history"
                              onClick={() => {
                                follow.current = false;
                                if (thread && thread.turns.length > visibleTurns) {
                                  setVisibleTurns((count) => count + 12);
                                  return;
                                }
                                void loadThread(selectedId, historyCursor || undefined).catch((e) =>
                                  setError(e.message),
                                );
                              }}
                            >
                              加载更早的消息
                            </button>
                          )}
                          {loading && !thread && (
                            <div className="center">
                              <Spinner label="正在读取会话" />
                            </div>
                          )}
                          {historyError?.id === selectedId && (
                            <div className="history-recovery notice" role="alert">
                              <strong>会话暂时读取失败</strong>
                              <p>{historyError.message}</p>
                              <button
                                className="secondary"
                                disabled={loading}
                                onClick={() => void synchronize()}
                              >
                                {loading ? '正在同步…' : '重新读取会话'}
                              </button>
                            </div>
                          )}
                          {!running &&
                            (thread?.interrupted ||
                              ['failed', 'interrupted'].includes(
                                thread?.turns.at(-1)?.status || '',
                              )) && (
                              <div className="task-recovery notice">
                                <div>
                                  <strong>
                                    {thread?.interrupted ? '执行意外中断' : '本轮执行已停止'}
                                  </strong>
                                  <p>
                                    历史和已完成的改动保留。继续时会先核对进度，再完成剩余工作。
                                  </p>
                                </div>
                                <button
                                  className="secondary"
                                  disabled={
                                    sending ||
                                    !online ||
                                    !status?.connected ||
                                    !!queued.length ||
                                    archived
                                  }
                                  onClick={() => void continueTask()}
                                >
                                  继续执行
                                </button>
                              </div>
                            )}
                          {thread && !thread.turns.length && (
                            <div className="empty-conversation">
                              <MessageSquare size={26} />
                              <h2>从一条指令开始</h2>
                              <p>
                                Codex 将在 <code>{thread.cwd}</code> 中工作。
                              </p>
                            </div>
                          )}
                          {thread?.turns.slice(-visibleTurns).map((turn) => (
                            <ErrorBoundary
                              key={turn.id}
                              compact
                              resetKey={`${turn.id}:${turn.status}`}
                            >
                              <TurnView turn={turn} />
                            </ErrorBoundary>
                          ))}
                          {requests.map((request) => (
                            <Approval
                              key={request.id}
                              request={request}
                              onError={setErrorMessage}
                            />
                          ))}
                          {running && (
                            <div className="working-indicator">
                              <span className="working-dots">
                                <i />
                                <i />
                                <i />
                              </span>
                              {requests.length ? '等待你的处理' : 'Codex 正在工作'}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="thread-composer">
                        {!atBottom && (
                          <button
                            className="scroll-bottom"
                            aria-label="回到最新消息"
                            onClick={() => {
                              follow.current = true;
                              scroll.current?.scrollTo({
                                top: scroll.current.scrollHeight,
                                behavior: 'smooth',
                              });
                            }}
                          >
                            <ArrowDown size={15} />
                          </button>
                        )}
                        {archived ? (
                          <div className="notice">
                            此会话已归档。
                            <button
                              className="text-button"
                              onClick={() => void action('unarchive')}
                            >
                              恢复会话
                            </button>
                          </div>
                        ) : (
                          composer
                        )}
                      </div>
                    </>
                  )}
                </section>
              </MessageActionContext.Provider>
            </MemoryActionContext.Provider>
            {showFiles && (selectedId || projectId) && (
              <FilePanel
                key={`${selectedId || projectId}:${fileLink?.scope === (selectedId || projectId) ? fileLink.id : 0}`}
                target={fileLink?.scope === (selectedId || projectId) ? fileLink : undefined}
                thread={thread}
                threadId={selectedId || undefined}
                projectId={projectId}
                onClose={() => setShowFiles(false)}
              />
            )}
          </FileLinkContext.Provider>
        </div>
      </main>
      {showProject && (
        <ProjectModal
          onClose={() => setShowProject(false)}
          onCreated={(project) => {
            setProjects((old) => [...old.filter((p) => p.id !== project.id), project]);
            setProjectId(project.id);
            setShowProject(false);
          }}
        />
      )}
      {customModel !== null && (
        <Modal title="自定义模型" onClose={() => setCustomModel(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!customModel.trim()) return;
              setModel(customModel.trim());
              setEffort('');
              setCustomModel(null);
            }}
          >
            <label className="field">
              <span>模型 ID</span>
              <input
                autoFocus
                required
                maxLength={200}
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder="填写终端提供商支持的模型 ID"
              />
            </label>
            <p className="small">
              保存后可在输入框下方选择思考强度。模型与强度是否可用取决于服务器上 Codex
              的账号与提供商配置。
            </p>
            <div className="modal-actions">
              <button className="primary">使用此模型</button>
            </div>
          </form>
        </Modal>
      )}
      {editingQueue && (
        <QueueEditor key={editingQueue} id={editingQueue} onClose={() => setEditingQueue(null)} />
      )}
      {exportThread && (
        <ConversationExportDialog thread={exportThread} onClose={() => setExportThread(null)} />
      )}
      {forceDialog && (
        <Modal
          title="强制终止执行器"
          onClose={() => {
            if (!forcing) setForceDialog(false);
          }}
        >
          <p>
            将终止工作台启动的 Codex 进程及其子进程，影响工作台内全部 {status?.active.length || 0}{' '}
            个运行任务。
          </p>
          <p>所有排队消息会暂停。已经执行的命令和文件修改不会回滚，请核对结果后再继续。</p>
          <div className="modal-actions">
            <button className="secondary" disabled={forcing} onClick={() => setForceDialog(false)}>
              取消
            </button>
            <button
              className="danger"
              disabled={forcing}
              onClick={async () => {
                setForcing(true);
                try {
                  await post('/runtime/force-stop');
                  setForceDialog(false);
                  setStoppingId(null);
                  refreshStatus();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setForcing(false);
                }
              }}
            >
              {forcing ? '正在终止…' : '终止全部运行任务'}
            </button>
          </div>
        </Modal>
      )}
      {showFileSource && (
        <Modal title="添加文件" onClose={() => setShowFileSource(false)}>
          <div className="file-source-options">
            <button
              className="secondary"
              disabled={sending || (!selectedId && !projects.length)}
              onClick={() => {
                setShowFileSource(false);
                setShowFileSearch(true);
              }}
            >
              <Folder size={18} />
              <span>
                <strong>引用本项目文件</strong>
                <small>选择项目目录中的文件</small>
              </span>
            </button>
            <button
              className="secondary"
              disabled={uploading || sending}
              onClick={() => {
                setShowFileSource(false);
                fileInput.current?.click();
              }}
            >
              <Paperclip size={18} />
              <span>
                <strong>上传新文件</strong>
                <small>从当前设备选择，单文件最多 20 MB</small>
              </span>
            </button>
          </div>
        </Modal>
      )}
      {showFileSearch && (
        <FileReferencePicker
          key={selectedId || projectId}
          threadId={selectedId}
          projectId={projectId || projects[0]?.id || ''}
          selected={fileReferences}
          onSelect={(file) =>
            setFileReferences((old) => (old.includes(file) ? old : [...old, file].slice(0, 10)))
          }
          onClose={() => setShowFileSearch(false)}
        />
      )}
      {nativeTask && (
        <NativeTaskDialog
          {...nativeTask}
          onClose={() => setNativeTask(null)}
          onStarted={() => {
            refreshStatus();
            void loadThreads().catch((e) => setError(e.message));
            if (currentId.current === nativeTask.threadId)
              void loadThread(nativeTask.threadId).catch((e) => setError(e.message));
          }}
        />
      )}
      {showUsage && (
        <TokenUsagePage
          revision={usageRevision}
          onClose={() => setWorkspacePage('settings')}
          onThread={(id) => {
            setSelectedId(id);
            setWorkspacePage('workbench');
          }}
        />
      )}
      {showMemory && features.memory && (
        <MemoryPage
          projects={projects}
          defaultProjectId={projects.find((p) => p.path === thread?.cwd)?.id || selectedProject?.id}
          sourceThreadId={selectedId || undefined}
          initialText={memoryDraft}
          onSaved={() => setMemoryDraft('')}
          onSettings={() => setWorkspacePage('settings')}
          onMenu={() => setSidebarOpen(true)}
          revision={continuityRevision}
        />
      )}
      {showCollaboration && features.collaboration && (
        <CollaborationPage
          initialThreadId={collaborationDraftThread}
          onSettings={() => setWorkspacePage('settings')}
          onMenu={() => setSidebarOpen(true)}
          revision={continuityRevision}
        />
      )}
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          preferences={preferences}
          onPreferences={(value) => {
            setPreferences(value);
            setEffort('');
          }}
          status={status}
          refresh={refreshStatus}
          onUsage={() => {
            setWorkspacePage('usage');
            setSidebarOpen(false);
          }}
          features={features}
          onFeaturesChange={applyFeatures}
          onLogout={onLogout}
        />
      )}
      {deleteThread && (
        <Modal
          title="永久删除会话"
          onClose={() => {
            if (!deletingThread) setDeleteThread(null);
          }}
        >
          <p>永久删除「{title(deleteThread)}」？</p>
          <p>
            将删除服务器上的 Codex
            原生会话历史，以及工作台中该会话的数据库记录、排队消息、事件缓存和上传附件。此操作无法撤销。
          </p>
          <p className="small muted">
            项目代码、其他会话以及此前另存的备份不会删除。运行中的会话需先停止。
          </p>
          {deleteError && (
            <p className="error-box" role="alert">
              {deleteError}
            </p>
          )}
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={deletingThread}
              onClick={() => setDeleteThread(null)}
            >
              取消
            </button>
            <button
              className="danger"
              disabled={deletingThread}
              onClick={async () => {
                setDeletingThread(true);
                setDeleteError('');
                try {
                  await api(`/threads/${encodeURIComponent(deleteThread.id)}`, {
                    method: 'DELETE',
                    body: JSON.stringify({ confirm: true }),
                  });
                  setDeleteThread(null);
                  await loadThreads();
                } catch (e) {
                  setDeleteError((e as Error).message);
                } finally {
                  setDeletingThread(false);
                }
              }}
            >
              {deletingThread ? '正在永久删除…' : '确认永久删除'}
            </button>
          </div>
        </Modal>
      )}
      {rename !== null && (
        <Modal title="重命名会话" onClose={() => setRename(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action('rename', { name: rename });
            }}
          >
            <label className="field">
              <span>会话名称</span>
              <input
                autoFocus
                required
                maxLength={120}
                value={rename}
                onChange={(e) => setRename(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button className="primary">保存</button>
            </div>
          </form>
        </Modal>
      )}
      {removeProject && (
        <Modal title="移除项目关联" onClose={() => setRemoveProject(null)}>
          <p>从工作台移除「{removeProject.name}」？服务器上的代码与 Codex 会话会保留。</p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setRemoveProject(null)}>
              取消
            </button>
            <button
              className="danger"
              onClick={() => {
                void api(`/projects/${removeProject.id}`, { method: 'DELETE' })
                  .then(() => {
                    if (projectId === removeProject.id) setProjectId('');
                    setRemoveProject(null);
                    void loadProjects();
                  })
                  .catch((e) => setError(e.message));
              }}
            >
              <Trash2 size={14} />
              移除关联
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
