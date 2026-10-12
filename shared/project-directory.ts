// Join a browser-entered subdirectory without depending on the browser OS.
export function projectDirectory(root: string, child: string): string {
  const name = child.trim();
  if (/^[\\/]|^[a-z]:/i.test(name) || name.includes('\0'))
    throw new Error('只需填写根目录下的子目录名称');
  const parts = name.split(/[\\/]/).filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.'))
    throw new Error('子目录不能包含 . 或 ..');
  const separator = /^[a-z]:[\\/]/i.test(root) ? '\\' : '/';
  return parts.length ? root.replace(/[\\/]+$/, '') + separator + parts.join(separator) : root;
}
