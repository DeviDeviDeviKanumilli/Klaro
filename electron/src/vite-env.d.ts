/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

type EmbeddedServerLifecycleStatus =
  | 'starting'
  | 'ready'
  | 'crashed'
  | 'port_busy';

interface Window {
  electron?: {
    toggleOverlay: () => void;
    setClickThrough: (enabled: boolean) => void;
    onServerStatus: (callback: (status: EmbeddedServerLifecycleStatus) => void) => void;
  };
}
