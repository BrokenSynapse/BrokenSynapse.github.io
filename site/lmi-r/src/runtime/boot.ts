import type { ApiClient, LoginUser, StatusResponse } from './apiClient';
import type { AuthSession } from './auth';
import type { ModuleRegistry } from './moduleRegistry';
import type { StateStore } from './stateStore';
import type { Theme } from './themeLoader';
import type { WindowManager } from './windowManager';
import { LmiBus } from '../core/bus/lmi-bus';
import { decodeMsgpack, encodeMsgpack } from '../core/bus/lmi-codec';
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

type TerminalLine = { kind: 'system' | 'input' | 'output' | 'error'; text: string };
type FsEntry = { type: 'file' | 'dir'; content?: string; created: number };

type TerminalState = {
  lines: TerminalLine[];
  activeApp: string;
  settingsValue: string;
  dataForgeDebug: BusDebugView | null;
  fleetlineAsset: LmiAssetRef | null;
  siftNote: string;
  fleetlineSubscribed: boolean;
  deCatalog: string[];
  cwd: string;
  fs: Map<string, FsEntry>;
  history: string[];
  historyIndex: number;
  suggestion: string;
};

const BANNER = ['LMI Ver. 19.2.1.1.2212', '\u00a9 Leviathan Exports Company.', ''];

const COMMANDS = [
  'help', 'clear', 'exit', 'reboot', 'whoami', 'uptime', 'date', 'Lfetch',
  'lx -g', 'lx -y', 'lx -b', 'lx -c', 'lx -u', 'lx -i', 'lx -h', 'lx -v', 'lx -l',
  'shell list', 'shell installed', 'shell add', 'shell remove', 'shell set', 'shell current', 'shell reset',
  'startx', 'stopx', 'tty',
  'lmx open', 'lmx close',
  'pwd', 'ls', 'cd', 'cat', 'touch', 'mkdir', 'rm', 'rmdir', 'mv', 'cp', 'open', 'stat',
  'sys status', 'sys info', 'sys repair', 'sys logs', 'sys bus', 'sys packages', 'sys storage', 'sys reset-shell',
  'svc list', 'svc status', 'svc start', 'svc stop', 'svc restart', 'svc logs',
  'perm list', 'perm app', 'perm grant', 'perm revoke',
  'debug packets', 'debug modules', 'debug state', 'debug profile', 'debug registry', 'debug clear-cache', 'debug reload',
  'kill', 'doas', 'neofetch', 'apps', 'status', 'save', 'asset demo', 'bus', 'de list', 'de install'
];

export function createRuntime(parts: RuntimeParts) {
  const bus = new LmiBus(parts.api, parts.modules);
  const contexts = new Map(parts.modules.list().map((module) => [module.id, createModuleContext(module.id, bus)]));
  const terminal: TerminalState = {
    lines: [...BANNER.map((text) => ({ kind: 'system' as const, text })), { kind: 'system', text: 'Type "help" or press Tab for command completion.' }],
    activeApp: 'terminal',
    settingsValue: 'loading',
    dataForgeDebug: null,
    fleetlineAsset: null,
    siftNote: 'No asset selected.',
    fleetlineSubscribed: false,
    deCatalog: ['lmi-r-desktop-preview', 'fleetline-kiosk', 'dataforge-workbench'],
    cwd: '/lmi-r/os',
    fs: new Map(),
    history: [],
    historyIndex: 0,
    suggestion: ''
  };
  let currentStatus: StatusResponse | null = null;
  let currentStatusText = 'Checking Rust backend...';
  let currentUser = loadSessionUser();

  async function mount(root: HTMLElement): Promise<void> {
    if (!currentUser) {
      root.innerHTML = renderLogin(currentStatusText);
      wireLogin(root, parts, async (user) => {
        currentUser = user;
        terminal.cwd = user.home_path;
        seedUserFs(terminal, user, parts);
        await mount(root);
      });
      return;
    }

    seedUserFs(terminal, currentUser, parts);
    const rerender = () => {
      root.innerHTML = renderTerminal(parts, terminal, currentUser as LoginUser, currentStatus, currentStatusText);
      wireTerminal(root, parts, contexts, terminal, currentUser as LoginUser, currentStatus, currentStatusText, rerender, () => {
        currentUser = null;
        sessionStorage.removeItem('lmi-r:user');
        void mount(root);
      });
    };

    ensureRuntimeSubscriptions(contexts, terminal, rerender);
    rerender();

    try {
      const status = await parts.api.status();
      parts.state.set('api.status', status);
      currentStatus = status;
      currentStatusText = 'Rust backend online';
      await hydratePersistedState(contexts, terminal, currentUser);
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

async function hydratePersistedState(contexts: Map<string, ModuleContext>, terminal: TerminalState, user: LoginUser): Promise<void> {
  const saved = await contexts.get('settings')?.getState<string>(userStateKey(user, 'settings.demo.message'));
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

function renderLogin(statusText: string): string {
  return `
    <main class="login-shell">
      <form id="loginForm" class="login-panel">
        <pre>${escapeHtml(BANNER.join('\n'))}</pre>
        <h1>LMI-R Access Portal</h1>
        <p>Use normal LMI credentials. On first login, LMI-R imports only username and password hash into the object store.</p>
        <label>Username<input id="loginUser" autocomplete="username" required></label>
        <label>Password<input id="loginPass" type="password" autocomplete="current-password" required></label>
        <button type="submit">Log in</button>
        <div class="login-status">${escapeHtml(statusText)}</div>
      </form>
    </main>
  `;
}

function wireLogin(root: HTMLElement, parts: RuntimeParts, onLogin: (user: LoginUser) => Promise<void>): void {
  const form = root.querySelector<HTMLFormElement>('#loginForm');
  const user = root.querySelector<HTMLInputElement>('#loginUser');
  const pass = root.querySelector<HTMLInputElement>('#loginPass');
  const status = root.querySelector<HTMLElement>('.login-status');
  user?.focus();
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (status) status.textContent = 'Authenticating...';
    void parts.api.login(user?.value ?? '', pass?.value ?? '').then(async (profile) => {
      sessionStorage.setItem('lmi-r:user', encodeSessionValue(profile));
      await onLogin(profile);
    }).catch((error) => {
      if (status) status.textContent = String(error);
    });
  });
}

function renderTerminal(parts: RuntimeParts, terminal: TerminalState, user: LoginUser, status: StatusResponse | null, statusText: string): string {
  const appList = parts.modules.list().map((module) => `<span>${module.id}</span>`).join('');
  return `
    <main class="terminal-shell" data-theme="${parts.theme.id}">
      <section class="terminal-head">
        <div><p class="eyebrow">Leviathan Mainframe Interface</p><h1>LMI-R Terminal</h1></div>
        <div class="session"><span>${escapeHtml(user.display_name || user.username)}</span><strong>${escapeHtml(status?.service ?? 'offline')}</strong></div>
      </section>
      <section class="terminal-layout">
        <section class="terminal-window" aria-label="LMI-R terminal">
          <div class="terminal-titlebar"><span>lmi-r://terminal</span><span>${escapeHtml(statusText)}</span></div>
          <div id="terminalOutput" class="terminal-output">${terminal.lines.map(renderLine).join('')}</div>
          <form id="terminalForm" class="terminal-input">
            <span>${escapeHtml(user.username)}@lmi-r:${escapeHtml(shortPwd(terminal.cwd, user))}$</span>
            <input id="terminalCommand" autocomplete="off" spellcheck="false" autofocus>
            <small id="terminalSuggestion">${escapeHtml(terminal.suggestion)}</small>
          </form>
        </section>
        <aside class="terminal-side">
          <section><h2>Apps</h2><div class="app-list">${appList}</div></section>
          <section><h2>Active</h2><strong>${escapeHtml(terminal.activeApp)}</strong><p>cwd: ${escapeHtml(terminal.cwd)}</p>${renderActiveApp(terminal)}</section>
        </aside>
      </section>
    </main>
  `;
}

function renderLine(line: TerminalLine): string {
  const text = line.kind === 'input' ? highlightCommand(line.text) : escapeHtml(line.text);
  return `<div class="term-line ${line.kind}">${text}</div>`;
}

function renderActiveApp(terminal: TerminalState): string {
  if (terminal.activeApp === 'settings') return `<p>settings.demo.message</p><code>${escapeHtml(terminal.settingsValue)}</code>`;
  if (terminal.activeApp === 'sift') return `<p>${escapeHtml(terminal.siftNote)}</p><code>Try: asset demo</code>`;
  if (terminal.activeApp === 'fleetline') return `<p>Last selected asset</p><code>${terminal.fleetlineAsset ? escapeHtml(`${terminal.fleetlineAsset.id} ${terminal.fleetlineAsset.mime ?? ''}`) : 'none'}</code>`;
  if (terminal.activeApp === 'dataforge') return `<p>Bus debug</p><pre>${escapeHtml(formatDebugValue(terminal.dataForgeDebug ?? { hint: 'run: bus' }))}</pre>`;
  return `<p>Terminal mode. Standalone desktop environments can be installed later without becoming the default shell.</p>`;
}

function wireTerminal(
  root: HTMLElement,
  parts: RuntimeParts,
  contexts: Map<string, ModuleContext>,
  terminal: TerminalState,
  user: LoginUser,
  status: StatusResponse | null,
  statusText: string,
  rerender: () => void,
  logout: () => void
): void {
  const output = root.querySelector<HTMLElement>('#terminalOutput');
  output?.scrollTo({ top: output.scrollHeight });
  const form = root.querySelector<HTMLFormElement>('#terminalForm');
  const input = root.querySelector<HTMLInputElement>('#terminalCommand');
  input?.focus();

  input?.addEventListener('input', () => {
    terminal.suggestion = complete(input.value, false);
    const hint = root.querySelector<HTMLElement>('#terminalSuggestion');
    if (hint) hint.textContent = terminal.suggestion;
  });
  input?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      terminal.historyIndex = Math.max(0, terminal.historyIndex - 1);
      input.value = terminal.history[terminal.historyIndex] ?? input.value;
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      terminal.historyIndex = Math.min(terminal.history.length, terminal.historyIndex + 1);
      input.value = terminal.history[terminal.historyIndex] ?? '';
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const next = complete(input.value, true);
      if (next) input.value = next;
      terminal.suggestion = complete(input.value, false);
      const hint = root.querySelector<HTMLElement>('#terminalSuggestion');
      if (hint) hint.textContent = terminal.suggestion;
    }
  });

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const command = input?.value.trim() ?? '';
    if (!command) return;
    terminal.history.push(command);
    terminal.historyIndex = terminal.history.length;
    terminal.suggestion = '';
    if (input) input.value = '';
    void runCommand(command, parts, contexts, terminal, user, status, statusText, logout).then(rerender);
  });
}

async function runCommand(
  command: string,
  parts: RuntimeParts,
  contexts: Map<string, ModuleContext>,
  terminal: TerminalState,
  user: LoginUser,
  status: StatusResponse | null,
  statusText: string,
  logout: () => void
): Promise<void> {
  pushLine(terminal, 'input', command);
  const [raw, ...args] = command.split(/\s+/);
  const op = raw;
  const lower = raw.toLowerCase();

  if (lower === 'help') {
    const filter = args.join(' ').trim();
    const commands = filter ? COMMANDS.filter((item) => item.startsWith(filter)) : COMMANDS;
    pushBlock(terminal, [
      'Command groups:',
      '  lx        package/profile binding manager',
      '  lmx       app/module launcher',
      '  shell     DE/shell manager',
      '  sys       runtime/system manager',
      '  svc       services',
      '  perm      permissions',
      '  Lfetch    identity/neofetch',
      '',
      'Commands:',
      ...commands.map((item) => `  ${item}`)
    ]);
    return;
  }
  if (lower === 'clear') { terminal.lines = []; return; }
  if (lower === 'exit') { logout(); return; }
  if (lower === 'reboot') { location.reload(); return; }
  if (op === 'Lfetch' || lower === 'neofetch') { pushBlock(terminal, neofetch(parts, terminal, user, status, statusText)); return; }
  if (lower === 'apps') { pushBlock(terminal, parts.modules.list().map((module) => `${module.id.padEnd(10)} ${module.name} [${module.phase}]`)); return; }
  if (lower === 'whoami') { pushBlock(terminal, [`username: ${user.username}`, `cid: ${user.cid || 'none'}`, `admin: ${user.is_admin ? 'yes' : 'no'}`, `home: ${user.home_path}`]); return; }
  if (lower === 'uptime') { pushLine(terminal, 'output', 'session active in browser runtime'); return; }
  if (lower === 'date') { const now = new Date(); pushLine(terminal, 'output', now.toString().replace(String(now.getFullYear()), String(now.getFullYear() + 186))); return; }
  if (lower === 'pwd') { pushLine(terminal, 'output', terminal.cwd); return; }
  if (lower === 'ls') { pushBlock(terminal, listFs(terminal, clampPath(resolvePath(terminal.cwd, args[0] || '.'), user.home_path, user.is_admin))); return; }
  if (lower === 'cd') { cd(terminal, user, args[0] || user.home_path); return; }
  if (lower === 'cat') { cat(terminal, user, args[0] || ''); return; }
  if (lower === 'touch' || lower === 'mkdir') { createFs(terminal, user, args[0] || '', lower === 'mkdir' ? 'dir' : 'file'); return; }
  if (lower === 'rm' || lower === 'rmdir') { removeFs(terminal, user, args[0] || '', lower); return; }
  if (lower === 'mv' || lower === 'cp' || lower === 'open' || lower === 'stat') { pushLine(terminal, 'system', `${lower} is routed through the virtual filesystem adapter; full handler pending.`); return; }
  if (lower === 'open') { openApp(parts, terminal, args[0] ?? ''); return; }
  if (lower === 'lmx' && args[0] === 'open') { openApp(parts, terminal, args[1] ?? ''); return; }
  if (lower === 'lmx' && args[0] === 'close') { pushLine(terminal, 'system', `close requested for ${args[1] || 'active app'}`); return; }
  if (lower === 'status' || (lower === 'sys' && args[0] === 'status')) { pushBlock(terminal, [statusText, `service: ${status?.service ?? 'offline'}`, `version: ${status?.version ?? 'unknown'}`, `database: ${status?.database ?? 'unavailable'}`]); return; }
  if (lower === 'sys') { sysCommand(args, terminal); return; }
  if (lower === 'lx') { lxCommand(args, parts, terminal); return; }
  if (lower === 'shell' || lower === 'de') { shellCommand(args, terminal); return; }
  if (lower === 'startx' || lower === 'stopx' || lower === 'tty') { pushLine(terminal, 'system', `${lower}: terminal remains the base interface for now.`); return; }
  if (lower === 'svc') { pushLine(terminal, 'system', `svc ${args.join(' ') || 'list'}: service control is read-only in this slice.`); return; }
  if (lower === 'perm') { pushLine(terminal, 'system', `perm ${args.join(' ') || 'list'}: capability editor reserved for admin slice.`); return; }
  if (lower === 'debug') { debugCommand(args, terminal, parts); return; }
  if (lower === 'save') { await saveSetting(args.join(' '), contexts, terminal, user); return; }
  if (lower === 'asset' && args[0] === 'demo') { publishAsset(contexts, terminal); return; }
  if (lower === 'bus') { await busDebug(contexts, terminal); return; }
  if (lower === 'kill') { pushLine(terminal, 'system', `kill requested for ${args[0] || 'active package'}`); return; }
  if (lower === 'doas') { pushLine(terminal, user.is_admin ? 'system' : 'error', user.is_admin ? 'admin capability active' : 'doas refused: admin tag required'); return; }
  pushLine(terminal, 'error', `Command not found: ${command}`);
}

function openApp(parts: RuntimeParts, terminal: TerminalState, appId: string): void {
  if (!parts.modules.get(appId)) { pushLine(terminal, 'error', `Unknown app: ${appId || '(missing)'}`); return; }
  terminal.activeApp = appId;
  pushLine(terminal, 'system', `Opened ${appId} through terminal adapter.`);
}

async function saveSetting(messageRaw: string, contexts: Map<string, ModuleContext>, terminal: TerminalState, user: LoginUser): Promise<void> {
  const message = messageRaw.trim() || `Saved at ${new Date().toLocaleTimeString()}`;
  const key = userStateKey(user, 'settings.demo.message');
  await contexts.get('settings')?.setState(key, message, { persist: true, scope: 'user' });
  terminal.settingsValue = await contexts.get('settings')?.getState<string>(key) ?? message;
  terminal.activeApp = 'settings';
  pushLine(terminal, 'system', `Persisted settings.demo.message -> ${message}`);
}

function publishAsset(contexts: Map<string, ModuleContext>, terminal: TerminalState): void {
  const asset = { ref: 'asset:demo-fleetline-preview', kind: 'asset' as const, id: 'demo-fleetline-preview', mime: 'image/png', size: 4096 };
  contexts.get('sift')?.publish('asset:selected', asset);
  terminal.siftNote = `Published ${asset.id}`;
  terminal.activeApp = 'sift';
  pushLine(terminal, 'system', `Sift published asset:selected -> ${asset.id}`);
}

async function busDebug(contexts: Map<string, ModuleContext>, terminal: TerminalState): Promise<void> {
  terminal.dataForgeDebug = await contexts.get('dataforge')?.callAction('debug.bus') as BusDebugView;
  terminal.activeApp = 'dataforge';
  pushBlock(terminal, [`registered modules: ${terminal.dataForgeDebug.registeredModules.length}`, `known topics: ${terminal.dataForgeDebug.knownTopics.join(', ') || 'none'}`, `recent packets: ${terminal.dataForgeDebug.recentPackets.length}`, `pending requests: ${terminal.dataForgeDebug.pendingRequestCount}`]);
}

function lxCommand(args: string[], parts: RuntimeParts, terminal: TerminalState): void {
  const flag = args[0] || '-h';
  if (flag === '-v' || flag === '-l') pushBlock(terminal, parts.modules.list().map((module) => `${module.id} ${module.name}`));
  else if (flag === '-h') pushBlock(terminal, COMMANDS.filter((cmd) => cmd.startsWith('lx ')));
  else pushLine(terminal, 'system', `lx ${args.join(' ')} accepted by package manager shim.`);
}

function shellCommand(args: string[], terminal: TerminalState): void {
  if (args[0] === 'list' || args[0] === 'installed') pushBlock(terminal, terminal.deCatalog.map((id) => `${id}    available later`));
  else if (['add', 'remove', 'set', 'install'].includes(args[0] || '')) pushLine(terminal, 'system', `${args.join(' ')} queued; terminal remains base shell.`);
  else if (args[0] === 'current') pushLine(terminal, 'output', 'terminal');
  else if (args[0] === 'reset') pushLine(terminal, 'system', 'default shell reset to terminal');
  else pushBlock(terminal, COMMANDS.filter((cmd) => cmd.startsWith('shell ') || cmd.startsWith('de ')));
}

function sysCommand(args: string[], terminal: TerminalState): void {
  const what = args[0] || 'info';
  if (what === 'bus') { pushLine(terminal, 'output', 'LMI Bus active'); return; }
  if (what === 'reset-shell') { terminal.activeApp = 'terminal'; pushLine(terminal, 'system', 'terminal-only mode restored'); return; }
  pushLine(terminal, 'system', `sys ${what}: generic runtime report available through debug commands.`);
}

function debugCommand(args: string[], terminal: TerminalState, parts: RuntimeParts): void {
  const what = args[0] || 'modules';
  if (what === 'modules') pushBlock(terminal, parts.modules.list().map((module) => `${module.id}: ${module.capabilities.join(',')}`));
  else if (what === 'state') pushBlock(terminal, [`cwd=${terminal.cwd}`, `active=${terminal.activeApp}`, `history=${terminal.history.length}`]);
  else if (what === 'profile') pushLine(terminal, 'system', 'profile is visible through whoami');
  else if (what === 'clear-cache') pushLine(terminal, 'system', 'runtime cache clear requested');
  else if (what === 'reload') location.reload();
  else pushLine(terminal, 'system', `debug ${what}: see bus command for packet view`);
}

function neofetch(parts: RuntimeParts, terminal: TerminalState, user: LoginUser, status: StatusResponse | null, statusText: string): string[] {
  return [
    '      __    __  __  __   ___        ___',
    '     / /   /  |/  |/ /  / _ \\ ____ / _ \\',
    '    / /__ / /|_/| / /__/ , _//___// , _/',
    '   /____//_/   /_/____/_/|_|     /_/|_|',
    '',
    'OS: LMI Ver. 19.2.1.1.2212',
    `Host: ${user.username}`,
    'Kernel: LMI Bus packet layer',
    'Shell: fish 19.2.1',
    `Backend: ${statusText}`,
    `Service: ${status?.service ?? 'offline'}`,
    `Apps: ${parts.modules.list().map((module) => module.id).join(', ')}`,
    `CWD: ${terminal.cwd}`,
    `DE: terminal`
  ];
}

function seedUserFs(terminal: TerminalState, user: LoginUser, parts: RuntimeParts): void {
  const now = Date.now();
  ['/lmi-r', '/lmi-r/os', '/lmi-r/os/users', user.home_path, `${user.home_path}/apps`, `${user.home_path}/home`, `${user.home_path}/tmp`].forEach((path) => {
    if (!terminal.fs.has(path)) terminal.fs.set(path, { type: 'dir', created: now });
  });
  for (const module of parts.modules.list()) {
    const appPath = `${user.home_path}/apps/${module.id}.lmx`;
    if (!terminal.fs.has(appPath)) terminal.fs.set(appPath, { type: 'file', created: now, content: `${module.name}\nphase=${module.phase}\ncapabilities=${module.capabilities.join(',')}\n` });
  }
  const profile = `${user.home_path}/profile.txt`;
  if (!terminal.fs.has(profile)) terminal.fs.set(profile, { type: 'file', created: now, content: `user=${user.username}\ncid=${user.cid}\nadmin=${user.is_admin}\nhome=${user.home_path}\n` });
  terminal.cwd = clampPath(terminal.cwd, user.home_path, user.is_admin);
}

function cd(terminal: TerminalState, user: LoginUser, input: string): void {
  const target = clampPath(resolvePath(terminal.cwd, input), user.home_path, user.is_admin);
  if (terminal.fs.get(target)?.type !== 'dir') { pushLine(terminal, 'error', `Not a directory: ${target}`); return; }
  terminal.cwd = target;
}

function cat(terminal: TerminalState, user: LoginUser, input: string): void {
  const target = clampPath(resolvePath(terminal.cwd, input), user.home_path, user.is_admin);
  const entry = terminal.fs.get(target);
  if (!entry || entry.type !== 'file') { pushLine(terminal, 'error', `Not a file: ${target}`); return; }
  pushBlock(terminal, String(entry.content ?? '').split('\n'));
}

function createFs(terminal: TerminalState, user: LoginUser, input: string, type: FsEntry['type']): void {
  const target = clampPath(resolvePath(terminal.cwd, input), user.home_path, user.is_admin);
  if (!target || target === user.home_path || terminal.fs.has(target)) { pushLine(terminal, 'error', `Invalid path: ${target}`); return; }
  const parent = target.split('/').slice(0, -1).join('/') || '/';
  if (terminal.fs.get(parent)?.type !== 'dir') { pushLine(terminal, 'error', `Parent missing: ${parent}`); return; }
  terminal.fs.set(target, { type, content: '', created: Date.now() });
  pushLine(terminal, 'system', `${type === 'dir' ? 'mkdir' : 'touch'} ${target}`);
}

function removeFs(terminal: TerminalState, user: LoginUser, input: string, op: string): void {
  const target = clampPath(resolvePath(terminal.cwd, input), user.home_path, user.is_admin);
  if (target === user.home_path) { pushLine(terminal, 'error', 'Refusing to remove home.'); return; }
  const entry = terminal.fs.get(target);
  if (!entry) { pushLine(terminal, 'error', `No such path: ${target}`); return; }
  if (op === 'rmdir' && entry.type !== 'dir') { pushLine(terminal, 'error', `Not a directory: ${target}`); return; }
  terminal.fs.delete(target);
  pushLine(terminal, 'system', `removed ${target}`);
}

function listFs(terminal: TerminalState, dir: string): string[] {
  if (terminal.fs.get(dir)?.type !== 'dir') return [`Not a directory: ${dir}`];
  const prefix = `${dir}/`;
  const names = [...terminal.fs.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length).split('/')[0]).filter(Boolean);
  return [...new Set(names)].sort().map((name) => `${terminal.fs.get(`${dir}/${name}`)?.type === 'dir' ? 'dir ' : 'file'} ${name}`);
}

function resolvePath(cwd: string, input: string): string {
  const raw = input.startsWith('/') ? input : `${cwd}/${input || '.'}`;
  const out: string[] = [];
  for (const part of raw.split('/').filter(Boolean)) {
    if (part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

function clampPath(path: string, home: string, isAdmin: boolean): string {
  if (isAdmin) return path.startsWith('/lmi-r/os') ? path : '/lmi-r/os';
  return path === home || path.startsWith(`${home}/`) ? path : home;
}

function shortPwd(path: string, user: LoginUser): string {
  if (path === user.home_path) return '~';
  return path.startsWith(`${user.home_path}/`) ? `~/${path.slice(user.home_path.length + 1)}` : path;
}

function complete(value: string, apply: boolean): string {
  const trimmed = value.trimStart();
  if (!trimmed) return apply ? '' : COMMANDS.slice(0, 8).join('  ');
  const matches = COMMANDS.filter((cmd) => cmd.toLowerCase().startsWith(trimmed.toLowerCase()));
  if (apply) return matches.length === 1 ? matches[0] : value;
  return matches.slice(0, 6).join('  ');
}

function highlightCommand(value: string): string {
  const tokens = value.split(/(\s+)/);
  let wordIndex = 0;
  return tokens.map((token) => {
    if (/^\s+$/.test(token)) return token;
    const safe = escapeHtml(token);
    const cls = commandTokenClass(token, wordIndex, value);
    wordIndex++;
    return cls ? `<span class="${cls}">${safe}</span>` : safe;
  }).join('');
}

function commandTokenClass(token: string, index: number, full: string): string {
  if (index === 0) return 'tok-cmd';
  if (token.startsWith('-')) return 'tok-flag';
  if (token.startsWith('/') || token.startsWith('~/') || token === '..' || token === '.') return 'tok-path';
  if (index === 1 && /^(lx|shell|lmx|sys|svc|perm|debug|de)$/.test(full.split(/\s+/)[0] || '')) return 'tok-subcmd';
  if (/^[a-z0-9._-]+\.lmx$/i.test(token) || /^(settings|sift|fleetline|dataforge)$/i.test(token)) return 'tok-app';
  return '';
}

function loadSessionUser(): LoginUser | null {
  try {
    const value = sessionStorage.getItem('lmi-r:user');
    return value ? (decodeMsgpack(base64ToBytes(value)) as LoginUser) : null;
  } catch {
    sessionStorage.removeItem('lmi-r:user');
    return null;
  }
}

function encodeSessionValue(value: unknown): string {
  return bytesToBase64(encodeMsgpack(value));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function formatDebugValue(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value.map((item, index) => `${pad}${index}: ${formatDebugValue(item, indent + 2).trimStart()}`).join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return '{}';
    return entries.map(([key, item]) => `${pad}${key}: ${typeof item === 'object' && item !== null ? '\n' + formatDebugValue(item, indent + 2) : formatDebugValue(item, 0)}`).join('\n');
  }
  return String(value);
}

function userStateKey(user: LoginUser, key: string): string {
  return `users.${user.username}.${key}`;
}

function pushLine(terminal: TerminalState, kind: TerminalLine['kind'], text: string): void {
  terminal.lines.push({ kind, text });
  if (terminal.lines.length > 160) terminal.lines.splice(0, terminal.lines.length - 160);
}

function pushBlock(terminal: TerminalState, lines: string[]): void {
  lines.forEach((line) => pushLine(terminal, 'output', line));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}
