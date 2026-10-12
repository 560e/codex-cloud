import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Project, ProviderAccess } from '../../shared/types';
import { newMcp, type Skill, type Mcp } from './extension-types';
export function useExtensions() {
  const [access, setAccess] = useState<ProviderAccess | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState('');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [servers, setServers] = useState<Mcp[]>([]);
  const [skillDraft, setSkillDraft] = useState<{
    name: string;
    content: string;
    editing?: boolean;
  } | null>(null);
  const [mcpDraft, setMcpDraft] = useState<Mcp | null>(null);
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [editingMcp, setEditingMcp] = useState(false);
  const [remove, setRemove] = useState<{ kind: 'skill' | 'mcp'; name: string } | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const load = async () => {
    const results = await Promise.allSettled([
      api<Skill[]>('/skills' + (project ? '?project=' + encodeURIComponent(project) : '')),
      api<{ servers: Mcp[]; statusError: string }>('/mcp'),
    ]);
    const errors: string[] = [];
    if (results[0].status === 'fulfilled') setSkills(results[0].value);
    else errors.push('Skill：' + results[0].reason.message);
    if (results[1].status === 'fulfilled') {
      setServers(results[1].value.servers);
      if (results[1].value.statusError) errors.push('MCP 状态：' + results[1].value.statusError);
    } else errors.push('MCP：' + results[1].reason.message);
    if (errors.length) setError(errors.join('；'));
  };
  useEffect(() => {
    void api<ProviderAccess>('/providers/access')
      .then(setAccess)
      .catch((e) => setError(e.message));
    void api<Project[]>('/projects')
      .then(setProjects)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (access?.unlocked) void run(load);
  }, [access?.unlocked, project]);
  const editMcp = (item?: Mcp) => {
    const draft = item || newMcp();
    setMcpDraft(draft);
    setEditingMcp(!!item);
    setArgs(draft.args.join('\n'));
    setEnv(
      Object.entries(draft.env)
        .map(([key, value]) => key + '=' + value)
        .join('\n'),
    );
  };
  return {
    access,
    setAccess,
    error,
    setError,
    message,
    setMessage,
    busy,
    setBusy,
    projects,
    setProjects,
    project,
    setProject,
    skills,
    setSkills,
    servers,
    setServers,
    skillDraft,
    setSkillDraft,
    mcpDraft,
    setMcpDraft,
    args,
    setArgs,
    env,
    setEnv,
    editingMcp,
    setEditingMcp,
    remove,
    setRemove,
    run,
    load,
    editMcp,
  };
}
export type ExtensionsController = ReturnType<typeof useExtensions>;
