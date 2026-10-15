/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Colyseus server URL, e.g. https://game.example.com. Defaults to this host on port 2567. */
  readonly VITE_SERVER_URL?: string;
}
