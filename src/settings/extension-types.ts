export type Skill = {
  name: string;
  description: string;
  path: string;
  scope: string;
  enabled: boolean;
  editable: boolean;
};
export type Mcp = {
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  bearerTokenEnvVar: string;
  status?: { authStatus?: string; tools?: Record<string, unknown> } | null;
};
export const newMcp = (): Mcp => ({
  name: '',
  enabled: true,
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  url: '',
  bearerTokenEnvVar: '',
});
