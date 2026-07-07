import { createContext, useContext } from 'react';
import type { OnboardConfig } from './config';

export const ConfigContext = createContext<OnboardConfig | null>(null);

export function useConfig(): OnboardConfig {
  const config = useContext(ConfigContext);
  if (!config) {
    throw new Error('useConfig used outside ConfigContext (boot bug)');
  }
  return config;
}
