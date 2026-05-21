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

type TerminalLine = {
  kind: 'system' | 'input' | 'output' | 'error';
  text: string;
};

type TerminalState = {
  lines: TerminalLine[];
  activeApp: string;
  settingsValue: string;
  dataForgeDebug: BusDebugView | null;
  fleetlineAsset: LmiAssetRef | null;
  siftNote: string;
  fleetlineSubscribed: boolean;
  deCatalog: string[];
};

export function createRuntime(parts: RuntimeParts) {
  const bus = new LmiBus(parts.api, parts.modules);
  const contexts = new Map(parts.modules.list().map((module) => [module.id, createModuleContext(module.id, bus)]));
  const terminal: TerminalState = {
    lines: [
      { kind: 'system', text: 'LMI Ver. 19.2.1.1.2212' },
      { kind: 'system', text: '© Leviathan Exports Company.' },
      { kind: 'system', text: '' },
      { kind: 'system', text: 'LMI-R terminal initialized.' },
      { kind: 'system', text: 'Type "neofetch" for system identity or "help" for commands.' }
    ],
    activeApp: 'terminal',
    settingsValue: 'loading',
    dataForgeDebug: null,
    fleetlineAsset: null,
    siftNote: 'No asset selected.',
    fleetlineSubscribed: false,
    deCatalog: ['lmi-r-desktop-preview', 'fleetline-kiosk', 'dataforge-workbench']
  };
  let currentStatus: StatusResponse | null = null;
  let currentStatusText = 'Checking Rust backend...';

  async function mount(root: HTMLElement): Promise<void> {
    const rerender = () => {
      root.innerHTML = renderTerminal(parts, terminal, currentStatus, currentStatusText);
      wireTerminal(root, parts, contexts, terminal, currentStatus, currentStatusText, rerender);
    };
    ensureRuntimeSubscriptions(contexts, terminal, rerender);
    rerender();

    try {
      const status = await parts.api.status();
      parts.state.set('api.status', status);
      currentStatus = status;
      currentStatusText = 'Rust backend online';
      await hydratePersistedState(contexts, terminal);
      pushLine(terminal, 'system', 'Connected to /api-r. Packet persistence is available.');
      rerender();
    } catch (error) {
      currentStatus = null;
      currentStatusText = `Rust backend unavailable: ${String(error)}`;
      pushLine(terminal, 'error', currentStatusText);
      rerender();
    }
  }

  return { mount };
}

async function hydratePersistedState(contexts: Map<string, ModuleContext>, terminal: TerminalState): Promise<void> {
  const settings = contexts.get('settings');
  if (!settings) return;
  const saved = await settings.getState<string>('settings.demo.message');
  terminal.settingsValue = saved ?? 'No persisted value yet.';
}

function ensureRuntimeSubscriptions(contexts: Map<string, ModuleContext>, terminal: TerminalState, rerender: () => void): void {
  if (terminal.fleetlineSubscribed) return;
  contexts.get('fleetline')?.subscribe<LmiAssetRef>('asset:selected', (asset) => {
    terminal.fleetlineAsset = asset;
    pushLine(terminal, 'system', `Fleetline received asset:selected -> ${asset.id}`);
    rerender();
  });
  terminal.fleetlineSubscribed = true;
}

function renderTerminal(
  parts: RuntimeParts,
  terminal: TerminalState,
  status: StatusResponse | null,
  statusText: string
): string {
  const appList = parts.modules.list().map((module) => `<span>${module.id}</span>`).join('');
  return `
    <main class="terminal-shell" data-theme="${parts.theme.id}">
      <section class="terminal-head">
        <div>
          <p class="eyebrow">Leviathan Mainframe Interface</p>
          <h1>LMI-R Terminal</h1>
        </div>
        <div class="session">
          <span>${escapeHtml(parts.auth.actorTag)}</span>
          <strong>${escapeHtml(status?.service ?? 'offline')}</strong>
        </div>
      </section>

      <section class="terminal-layout">
        <section class="terminal-window" aria-label="LMI-R terminal">
          <div class="terminal-titlebar">
            <span>lmi-r://terminal</span>
            <span>${escapeHtml(statusText)}</span>
          </div>
          <div id="terminalOutput" class="terminal-output">
            ${terminal.lines.map(renderLine).join('')}
          </div>
          <form id="terminalForm" class="terminal-input">
            <span>operator@lmi-r:~$</span>
            <input id="terminalCommand" autocomplete="off" spellcheck="false" autofocus>
          </form>
        </section>

        <aside class="terminal-side">
          <section>
            <h2>Apps</h2>
            <div class="app-list">${appList}</div>
          </section>
          <section>
            <h2>Active</h2>
            <strong>${escapeHtml(terminal.activeApp)}</strong>
            ${renderActiveApp(terminal)}
          </section>
        </aside>
      </section>
    </main>
  `;
}

function renderLine(line: TerminalLine): string {
  return `<div class="term-line ${line.kind}">${escapeHtml(line.text)}</div>`;
}

function renderActiveApp(terminal: TerminalState): string {
  if (terminal.activeApp === 'settings') {
    return `<p>settings.demo.message</p><code>${escapeHtml(terminal.settingsValue)}</code>`;
  }
  if (terminal.activeApp === 'sift') {
    return `<p>${escapeHtml(terminal.siftNote)}</p><code>Try: asset demo</code>`;
  }
  if (terminal.activeApp === 'fleetline') {
    return `<p>Last selected asset</p><code>${terminal.fleetlineAsset ? escapeHtml(`${terminal.fleetlineAsset.id} ${terminal.fleetlineAsset.mime ?? ''}`) : 'none'}</code>`;
  }
  if (terminal.activeApp === 'dataforge') {
    return `<p>Bus debug</p><pre>${escapeHtml(JSON.stringify(terminal.dataForgeDebug ?? { hint: 'run: bus' }, null, 2))}</pre>`;
  }
  return `<p>Terminal mode. Standalone desktop environments can be installed later without becoming the default shell.</p>`;
}

function wireTerminal(
  root: HTMLElement,
  parts: RuntimeParts,
  contexts: Map<string, ModuleContext>,
  terminal: TerminalState,
  status: StatusResponse | null,
  statusText: string,
  rerender: () => void
): void {
  const output = root.querySelector<HTMLElement>('#terminalOutput');
  output?.scrollTo({ top: output.scrollHeight });
  const form = root.querySelector<HTMLFormElement>('#terminalForm');
  const input = root.querySelector<HTMLInputElement>('#terminalCommand');
  input?.focus();

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const command = input?.value.trim() ?? '';
    if (!command) return;
    if (input) input.value = '';
    void runCommand(command, parts, contexts, terminal, status, statusText).then(rerender);
  });
}

async function runCommand(
  command: string,
  parts: RuntimeParts,
  contexts: Map<string, ModuleContext>,
  terminal: TerminalState,
  status: StatusResponse | null,
  statusText: string
): Promise<void> {
  pushLine(terminal, 'input', command);
  const [raw, ...args] = command.split(/\s+/);
  const op = raw.toLowerCase();

  if (op === 'help') {
    pushBlock(terminal, [
      'Commands:',
      '  neofetch          show LMI-R system identity',
      '  apps              list available apps',
      '  open <app>        focus a stub app',
      '  status            show Rust backend status',
      '  save <text>       persist Settings state through LMI Bus',
      '  asset demo        publish Sift asset:selected event',
      '  bus               DataForge bus debug snapshot',
      '  de list           list future desktop environments',
      '  de install <id>   placeholder installer for future standalone DEs',
      '  clear             clear terminal output'
    ]);
    return;
  }

  if (op === 'clear') {
    terminal.lines = [];
    return;
  }

  if (op === 'neofetch') {
    pushBlock(terminal, neofetch(parts, terminal, status, statusText));
    return;
  }

  if (op === 'apps') {
    pushBlock(terminal, parts.modules.list().map((module) => `${module.id.padEnd(10)} ${module.name} [${module.phase}]`));
    return;
  }

  if (op === 'open') {
    const appId = args[0] ?? '';
    if (!parts.modules.get(appId)) {
      pushLine(terminal, 'error', `Unknown app: ${appId || '(missing)'}`);
      return;
    }
    terminal.activeApp = appId;
    pushLine(terminal, 'system', `Opened ${appId} through terminal shell.`);
    return;
  }

  if (op === 'status') {
    pushBlock(terminal, [
      statusText,
      `service: ${status?.service ?? 'offline'}`,
      `version: ${status?.version ?? 'unknown'}`,
      `database: ${status?.database ?? 'unavailable'}`
    ]);
    return;
  }

  if (op === 'save') {
    const message = args.join(' ').trim() || `Saved at ${new Date().toLocaleTimeString()}`;
    await contexts.get('settings')?.setState('settings.demo.message', message, { persist: true, scope: 'user' });
    terminal.settingsValue = await contexts.get('settings')?.getState<string>('settings.demo.message') ?? message;
    terminal.activeApp = 'settings';
    pushLine(terminal, 'system', `Persisted settings.demo.message -> ${message}`);
    return;
  }

  if (op === 'asset' && args[0] === 'demo') {
    const asset = { ref: 'asset:demo-fleetline-preview', kind: 'asset' as const, id: 'demo-fleetline-preview', mime: 'image/png', size: 4096 };
    contexts.get('sift')?.publish('asset:selected', asset);
    terminal.siftNote = `Published ${asset.id}`;
    terminal.activeApp = 'sift';
    pushLine(terminal, 'system', `Sift published asset:selected -> ${asset.id}`);
    return;
  }

  if (op === 'bus') {
    terminal.dataForgeDebug = await contexts.get('dataforge')?.callAction('debug.bus') as BusDebugView;
    terminal.activeApp = 'dataforge';
    pushBlock(terminal, [
      `registered modules: ${terminal.dataForgeDebug.registeredModules.length}`,
      `known topics: ${terminal.dataForgeDebug.knownTopics.join(', ') || 'none'}`,
      `recent packets: ${terminal.dataForgeDebug.recentPackets.length}`,
      `pending requests: ${terminal.dataForgeDebug.pendingRequestCount}`
    ]);
    return;
  }

  if (op === 'de') {
    if (args[0] === 'list') {
      pushBlock(terminal, terminal.deCatalog.map((id) => `${id}    available later`));
      return;
    }
    if (args[0] === 'install') {
      const id = args[1] ?? '';
      if (!terminal.deCatalog.includes(id)) {
        pushLine(terminal, 'error', `Unknown DE package: ${id || '(missing)'}`);
        return;
      }
      pushLine(terminal, 'system', `${id} queued for future DE installer. Terminal remains the base shell.`);
      return;
    }
  }

  pushLine(terminal, 'error', `Command not found: ${command}`);
}

function neofetch(parts: RuntimeParts, terminal: TerminalState, status: StatusResponse | null, statusText: string): string[] {
  return [
    '      __    __  __  __   ___        ___',
    '     / /   /  |/  |/ /  / _ \\ ____ / _ \\',
    '    / /__ / /|_/| / /__/ , _//___// , _/',
    '   /____//_/   /_/____/_/|_|     /_/|_|',
    '',
    `OS: LMI-R Terminal Runtime`,
    `Kernel: LMI Bus packet layer`,
    `Shell: terminal-first`,
    `Backend: ${statusText}`,
    `Service: ${status?.service ?? 'offline'}`,
    `Apps: ${parts.modules.list().map((module) => module.id).join(', ')}`,
    `Active App: ${terminal.activeApp}`,
    `DE: none installed; terminal is base interface`
  ];
}

function pushLine(terminal: TerminalState, kind: TerminalLine['kind'], text: string): void {
  terminal.lines.push({ kind, text });
  if (terminal.lines.length > 120) terminal.lines.splice(0, terminal.lines.length - 120);
}

function pushBlock(terminal: TerminalState, lines: string[]): void {
  lines.forEach((line) => pushLine(terminal, 'output', line));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}
