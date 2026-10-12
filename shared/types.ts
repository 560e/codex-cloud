import type { ProjectContextSettings } from './project-context.js';

export type Json = Record<string, unknown>;
export type ProviderProfile = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  models?: string[];
  modelsFetchedAt?: number;
};
export type ProviderAccess = {
  configured: boolean;
  unlocked: boolean;
  expiresAt: number | null;
  active: { id: string | null; name: string; model: string | null };
};
export type ProviderList = { profiles: ProviderProfile[]; activeId: string | null };
export type Project = Partial<ProjectContextSettings> & {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  systemPrompt?: string;
};
export type InputPart = { type: string; text?: string; path?: string; [key: string]: unknown };
export type Question = {
  id: string;
  question: string;
  header?: string;
  isSecret?: boolean;
  options?: { label: string; description?: string }[];
};
export type PlanStep = { step: string; status: string };
export type FileChange = {
  path: string;
  diff?: string;
  kind?: { type: string; move_path?: string | null };
};
export type Item = {
  id: string;
  type: string;
  text?: string;
  review?: string;
  phase?: string;
  status?: string;
  workbenchStatus?: string;
  content?: string[] | InputPart[];
  summary?: string[];
  command?: string;
  cwd?: string;
  durationMs?: number | null;
  exitCode?: number | null;
  aggregatedOutput?: string | null;
  terminalInput?: string;
  processId?: string;
  changes?: FileChange[];
  questions?: { title: string; options?: string[] }[];
  query?: string;
  action?: { query?: string; [key: string]: unknown };
  tool?: string;
  [key: string]: unknown;
};
export type UpstreamBalance = {
  errorCode?: 'timeout' | 'network' | 'http' | 'invalid_response';
  httpStatus?: number;
  attempts?: number;
  source?: 'opened' | 'completion';
  status: 'loading' | 'available' | 'unavailable' | 'error';
  checkedAt: number;
  providerName?: string;
  remaining?: number;
  beforeRemaining?: number;
  spent?: number;
  unit?: string;
  isValid?: boolean;
};
export type Turn = {
  model?: string;
  upstreamBalance?: UpstreamBalance;
  tokenUsage?: TokenCounts;
  tokenUsagePartial?: boolean;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  id: string;
  status: string;
  items: Item[];
  error?: { message: string } | null;
  plan?: PlanStep[];
  planExplanation?: string | null;
  diff?: string;
  [key: string]: unknown;
};
export type TokenCounts = {
  cachedInputTokens?: number;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
};
export type TokenUsage = {
  total?: TokenCounts;
  last?: TokenCounts;
  modelContextWindow?: number | null;
  [key: string]: unknown;
};
export type UsageRecord = {
  threadId: string;
  turnId: string;
  turnNumber: number;
  name: string;
  cwd: string;
  projectId?: string;
  projectName: string;
  prompt: string;
  status: string;
  startedAt?: number;
  completedAt?: number;
  updatedAt: number;
  counts: TokenCounts;
  partial: boolean;
  balance?: UpstreamBalance;
};
export type UsageStats = {
  cache: { inputTokens?: number; cachedInputTokens?: number; turns: number };
  records: UsageRecord[];
  page: number;
  pageSize: number;
  pages: number;
  expenses: { unit: string; spent: number; turns: number }[];
  filters: {
    projects: { id: string; name: string }[];
    threads: { id: string; name: string; projectId?: string }[];
  };
  totals: TokenCounts;
  turns: number;
  threads: {
    threadId: string;
    name: string;
    cwd: string;
    counts: TokenCounts;
    turns: number;
    updatedAt: number;
    partial: boolean;
  }[];
};
export type Thread = {
  id: string;
  name?: string | null;
  preview: string;
  cwd: string;
  updatedAt: number;
  createdAt: number;
  turns: Turn[];
  status: { type: string; activeFlags?: string[] };
  model?: string | null;
  reasoningEffort?: string | null;
  historyMode?: string;
  pinned?: boolean;
  interrupted?: boolean;
  tokenUsage?: TokenUsage;
  latestDiff?: string;
  plan?: PlanStep[];
  renderCursor?: number;
  [key: string]: unknown;
};
export type RequestParams = {
  threadId?: string;
  turnId?: string;
  reason?: string | null;
  message?: string;
  command?: string | null;
  cwd?: string;
  grantRoot?: string | null;
  permissions?: Record<string, unknown>;
  questions?: Question[];
  request?: unknown;
  [key: string]: unknown;
};
export type PendingRequest = {
  id: string;
  rpcId: string | number;
  method: string;
  params: RequestParams;
  createdAt: number;
};
export type EventParams = {
  upstreamBalance?: UpstreamBalance;
  threadId?: string;
  thread?: Thread;
  turnId?: string;
  turn?: Turn;
  item?: Item;
  itemId?: string;
  status?: Thread['status'];
  threadName?: string;
  name?: string;
  tokenUsage?: TokenUsage;
  turnTokenUsage?: TokenCounts;
  tokenUsagePartial?: boolean;
  delta?: string;
  changes?: FileChange[];
  summaryIndex?: number;
  contentIndex?: number;
  processId?: string;
  stdin?: string;
  error?: { message: string } | null;
  diff?: string;
  plan?: PlanStep[];
  explanation?: string | null;
  requestId?: string | number;
  id?: string;
  rpcId?: string | number;
  method?: string;
  params?: RequestParams;
  createdAt?: number;
  queued?: QueuedMessage[];
  message?: string;
  [key: string]: unknown;
};
export type WorkEvent = { seq: number; method: string; params: EventParams; at: number };
export type Model = {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description?: string }[];
  defaultReasoningEffort: string;
  hidden?: boolean;
};
export type QueuedMessage = {
  id: string;
  threadId: string;
  preview: string;
  state: 'queued' | 'sending' | 'paused';
  createdAt: number;
  error?: string;
};
export type Attachment = { id: string; name: string; mime: string; size: number };
export type FileEntry = { name: string; path: string; directory: boolean };
export type FilePage = { entries: FileEntry[]; total: number; nextOffset: number | null };
export type GitChanges =
  | { kind: 'git'; unstaged: string; staged: string; status: string }
  | { kind: 'folder' | 'unavailable'; message: string };
export type RuntimeStatus = {
  provider?: ProviderAccess['active'];
  connected: boolean;
  testMode?: boolean;
  version?: string;
  error?: string;
  active: { threadId: string; turnId: string; cwd: string }[];
  pending: PendingRequest[];
  queued?: QueuedMessage[];
};
export type SettingsInfo = {
  origin: string;
  sessionDays: number;
  maxConcurrent: number;
  projectRoots: string[];
  testedCli: string;
};
export type AccountInfo = {
  requiresOpenaiAuth?: boolean;
  account: { type: string; email?: string; planType?: string } | null;
};
export type StorageInfo = {
  directory: string;
  events: number;
  logFiles: number;
  logBytes: number;
  pendingDeletions: { id: string }[];
};
export type CleanupResult = {
  events?: number;
  cleared?: number;
  bytes?: number;
  failed?: string[];
};
export type ThreadPage = { data: Thread[]; nextCursor?: string | null };
export type ThreadRead = { thread: Thread; nextCursor: string | null; cursor: number };
export type ProviderCapabilities =
  | {
      available: true;
      capabilities: { namespaceTools: boolean; imageGeneration: boolean; webSearch: boolean };
    }
  | { available: false; reason: string };
