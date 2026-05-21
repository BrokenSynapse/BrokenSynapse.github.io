import './styles.css';
import { createApiClient } from './runtime/apiClient';
import { createRuntime } from './runtime/boot';
import { createAuthSession } from './runtime/auth';
import { createStateStore } from './runtime/stateStore';
import { createWindowManager } from './runtime/windowManager';
import { loadTheme } from './runtime/themeLoader';
import { moduleRegistry } from './runtime/moduleRegistry';

const root = document.querySelector<HTMLDivElement>('#app');

if (!root) {
  throw new Error('LMI-R root element missing.');
}

const runtime = createRuntime({
  api: createApiClient('/api-r'),
  auth: createAuthSession(),
  state: createStateStore(),
  windows: createWindowManager(),
  theme: loadTheme(),
  modules: moduleRegistry
});

runtime.mount(root).catch((error: unknown) => {
  root.innerHTML = `<main class="fatal"><h1>LMI-R boot failed</h1><pre>${String(error)}</pre></main>`;
});
