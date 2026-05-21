import type { ApiClient, StatusResponse } from './apiClient';
import type { AuthSession } from './auth';
import type { ModuleRegistry } from './moduleRegistry';
import type { StateStore } from './stateStore';
import type { Theme } from './themeLoader';
import type { WindowManager } from './windowManager';
import { LmiBus } from '../core/bus/lmi-bus';
import type { BusDebugView, LmiAssetRef } from '../core/bus/lmi-types';
import { createModuleContext, type ModuleContext } from '../sdk/module-context';

interface RuntimeParts {
  api: ApiClient;
  auth: AuthSession;
  state: StateStore;
  windows: WindowManager;
  theme: Theme;
  modules: ModuleRegistry;
}

export function createRuntime(parts: RuntimeParts) {
  const bus = new LmiBus(parts.api, parts.modules);
  const contexts = new Map(parts.modules.list().map((module) => [module.id, createModuleContext(module.id, bus)]));
  const viewState = {
    settingsValue: 'loading',
    dataForgeDebug: null as BusDebugView | null,
    fleetlineAsset: null as LmiAssetRef | null,
    siftNote: 'No asset published yet.',
    fleetlineSubscribed: false
  };
  let currentStatus: StatusResponse | null = null;
  let currentStatusText = 'Checking Rust backend...';

  async function mount(root: HTMLElement): Promise<void> {
    const rerender = () => {
      root.innerHTML = renderShell(parts, contexts, viewState, currentStatus, currentStatusText);
      wireStubModules(root, contexts, viewState, rerender);
    };
    rerender();

    try {
      const status = await parts.api.status();
      parts.state.set('api.status', status);
      currentStatus = status;
      currentStatusText = 'Rust backend online';
      await hydrateStubState(contexts, viewState);
      rerender();
    } catch (error) {
      currentStatus = null;
      currentStatusText = `Rust backend unavailable: ${String(error)}`;
      rerender();
    }
  }

  return { mount };
}

async function hydrateStubState(contexts: Map<string, ModuleContext>, viewState: { settingsValue: string }): Promise<void> {
  const settings = contexts.get('settings');
  if (!settings) return;
  const saved = await settings.getState<string>('settings.demo.message');
  viewState.settingsValue = saved ?? 'No persisted value yet.';
}

function renderShell(
  parts: RuntimeParts,
  contexts: Map<string, ModuleContext>,
  viewState: { settingsValue: string; dataForgeDebug: BusDebugView | null; fleetlineAsset: LmiAssetRef | null; siftNote: string; fleetlineSubscribed: boolean },
  status: StatusResponse | null,
  statusText: string
): string {
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
          <div class="module-grid">
            ${renderSettingsModule(viewState.settingsValue)}
            ${renderSiftModule(viewState.siftNote)}
            ${renderFleetlineModule(viewState.fleetlineAsset)}
            ${renderDataForgeModule(viewState.dataForgeDebug)}
          </div>
        </section>
      </section>
    </main>
  `;
}

function renderSettingsModule(value: string): string {
  return `
    <article class="module-card">
      <h3>Settings.LMX</h3>
      <p>Persists one shell preference through ctx.setState().</p>
      <strong>${escapeHtml(value)}</strong>
      <button type="button" data-action="settings-save">Persist demo value</button>
    </article>
  `;
}

function renderSiftModule(note: string): string {
  return `
    <article class="module-card">
      <h3>Sift.LMX</h3>
      <p>Publishes a fake asset:selected event through the bus.</p>
      <strong>${escapeHtml(note)}</strong>
      <button type="button" data-action="sift-publish">Publish asset:selected</button>
    </article>
  `;
}

function renderFleetlineModule(asset: LmiAssetRef | null): string {
  return `
    <article class="module-card">
      <h3>Fleetline.LMX</h3>
      <p>Subscribes to asset:selected without importing Sift.</p>
      <strong>${asset ? `${escapeHtml(asset.id)} (${escapeHtml(asset.mime ?? 'asset')})` : 'Waiting for asset event.'}</strong>
    </article>
  `;
}

function renderDataForgeModule(debug: BusDebugView | null): string {
  return `
    <article class="module-card wide">
      <h3>DataForge.LMX</h3>
      <p>Requests bus debug through ctx.callAction().</p>
      <button type="button" data-action="dataforge-debug">Refresh bus debug</button>
      <pre>${escapeHtml(JSON.stringify(debug ?? { status: 'No debug snapshot yet.' }, null, 2))}</pre>
    </article>
  `;
}

function wireStubModules(
  root: HTMLElement,
  contexts: Map<string, ModuleContext>,
  viewState: { settingsValue: string; dataForgeDebug: BusDebugView | null; fleetlineAsset: LmiAssetRef | null; siftNote: string },
  rerender: () => void
): void {
  const settings = contexts.get('settings');
  const sift = contexts.get('sift');
  const fleetline = contexts.get('fleetline');
  const dataforge = contexts.get('dataforge');

  if (!viewState.fleetlineSubscribed) {
    fleetline?.subscribe<LmiAssetRef>('asset:selected', (asset) => {
      viewState.fleetlineAsset = asset;
      rerender();
    });
    viewState.fleetlineSubscribed = true;
  }

  root.querySelector('[data-action="settings-save"]')?.addEventListener('click', () => {
    void settings?.setState('settings.demo.message', `Saved at ${new Date().toLocaleTimeString()}`, { persist: true, scope: 'user' })
      .then(() => settings.getState<string>('settings.demo.message'))
      .then((value) => {
        viewState.settingsValue = value ?? 'Saved.';
        rerender();
      });
  });

  root.querySelector('[data-action="sift-publish"]')?.addEventListener('click', () => {
    const asset = { ref: 'asset:demo-fleetline-preview', kind: 'asset' as const, id: 'demo-fleetline-preview', mime: 'image/png', size: 4096 };
    sift?.publish('asset:selected', asset);
    viewState.siftNote = `Published ${asset.id}`;
    rerender();
  });

  root.querySelector('[data-action="dataforge-debug"]')?.addEventListener('click', () => {
    void dataforge?.callAction('debug.bus').then((debug) => {
      viewState.dataForgeDebug = debug as BusDebugView;
      rerender();
    });
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}
