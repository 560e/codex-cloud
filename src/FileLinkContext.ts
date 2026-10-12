import { createContext } from 'react';

export const FileLinkContext = createContext<((href: string) => void) | null>(null);
