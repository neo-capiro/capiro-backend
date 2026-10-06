import { useMemo } from 'react';
import { App as AntApp } from 'antd';
import { useCapiroToast } from '../../vnext/components/feedback/toast.js';

/** Workspace routes run in both shells; vNext deliberately has no Ant App provider. */
export function useWorkspaceMessage() {
  const { message } = AntApp.useApp();
  const toast = useCapiroToast();
  return useMemo(() => ({
    success: (text: string) => {
      if (typeof message?.success === 'function') void message.success(text);
      else toast.success(text);
    },
    error: (text: string) => {
      if (typeof message?.error === 'function') void message.error(text);
      else toast.error(text);
    },
    info: (text: string) => {
      if (typeof message?.info === 'function') void message.info(text);
      else toast.success(text);
    },
    warning: (text: string) => {
      if (typeof message?.warning === 'function') void message.warning(text);
      else toast.error(text);
    },
  }), [message, toast]);
}
