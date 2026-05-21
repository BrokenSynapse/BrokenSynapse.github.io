import type { ApiClient, StatusResponse } from './apiClient';
import type { AuthSession } from './auth';
import type { ModuleRegistry } from './moduleRegistry';
import type { StateStore } from './stateStore';
import type { Theme } from './themeLoader';
import type { WindowManager } from './windowManager';

interface RuntimeParts {
  api: ApiClient;
  auth: AuthSession;
  state: StateStore;
  windows: WindowManager;
  theme: Theme;
  modules: ModuleRegistry;
}

export function createRuntime(parts: RuntimeParts) {
  async function mount(root: HTMLElement): Promise<void> {
    root.innerHTML = renderShell(parts, null, 'Checking Rust backend...');

    try {
      const status = await parts.api.status();
      parts.state.set('api.status', status);
      root.innerHTML = renderShell(parts, status, 'Rust backend online');
    } catch (error) {
      root.innerHTML = renderShell(parts, null, `Rust backend unavailable: ${String(error)}`);
    }
  }

  return { mount };
}

function renderShell(parts: RuntimeParts, status: StatusResponse | null, statusText: string): string {
  const modules = parts.modules.list().map((mod) => `
    <button class="module-tile" type="button" data-module="${mod.id}">
      <span>${mod.name}</span>
      <small>${mod.phase}</small>
    </button>
  `).join('');

  return `
    <main class="desktop" data-theme="${parts.theme.id}">
      <section class="topbar">
        <div>
          <p class="eyebrow">Leviathan Mainframe Interface</p>
          <h1>LMI-R</h1>
        </div>
        <div class="session">
          <span>${parts.auth.actorTag}</span>
          <strong>${parts.auth.mode}</strong>
        </div>
      </section>

      <section class="workspace">
        <aside class="dock" aria-label="Module registry">
          ${modules}
        </aside>

        <section class="panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Rewrite vertical slice</p>
              <h2>Desktop Shell</h2>
            </div>
            <span class="pill">${parts.windows.count()} windows</span>
          </div>
          <div class="status-grid">
            <article>
              <span>Backend</span>
              <strong>${statusText}</strong>
            </article>
            <article>
              <span>Service</span>
              <strong>${status?.service ?? 'pending'}</strong>
            </article>
            <article>
              <span>API Prefix</span>
              <strong>${status?.api_prefix ?? '/api-r'}</strong>
            </article>
            <article>
              <span>Database</span>
              <strong>${status?.database ?? 'data/lmi-r.sqlite'}</strong>
            </article>
          </div>
          <div class="window-preview">
            <h3>Compatibility Track</h3>
            <p>Old LMI modules stay on /lmi while new modules are rebuilt behind typed runtime contracts here.</p>
          </div>
        </section>
      </section>
    </main>
  `;
}
