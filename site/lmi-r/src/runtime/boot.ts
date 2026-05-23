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

type TerminalLine = { kind: 'system' | 'input' | 'output' | 'error' | 'lfetch'; text: string };
type FsEntry = { type: 'file' | 'dir'; content?: string; created: number };

type TerminalState = {
  lines: TerminalLine[];
  activeApp: string;
  activeShell: string;
  desktopRunning: boolean;
  windowMinimized: boolean;
  windowMaximized: boolean;
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
  completionKey: string;
  completionIndex: number;
  completionApplied: string;
  currentInput: string;
  pendingDoas: { args: string[] } | null;
};

const BANNER = ['LMI Ver. 19.2.1.1.2212', '\u00a9 Leviathan Exports Company.', ''];
const LFETCH_ART = String.raw`
                                        -
                      #######   %=-     =:-
                 +==-----:-::--=+*+-:=  +=:-                         #+======-===+#@
             #+=--::.:...........:+#=:.=%*=:.=                  %*=--:::....:....::-=+#
           +==-:.:::....:..........-##=:.:+*=.:===            +=-:.:.....:...::......::=+%
         +=-::.......:------:::::.::=+#*=::.=+=.-=-=       ++-:........::::::..:..::::..:-+%
       *+-::.....:--==********+++=--=*+-:=+-:.:=-.---*   *+-::..:.:--==+++*++==-:::.......:-+
     #+=--:..-:-=+**#**#####*##++##*++#%*+---:::....::=@*=-:...:-=+*#*=*####*+***+--:......:-+#
    @+=-:....-=+**+#%@@@@@@@@@@@@%*+#%#+-:=*:..-+-.....-+-:..--+*#+*%@@@@@@@@@@%#*#+=-:.-:..:-=
   @*=-:-..:-+**+%@@@@@@@ @@@@@@@@@@%#%%###=-:..-#*-:...-=::-=***@@@@@@@@@@@@@@@@@%*#*=-:....:-+
   *+-:.:.:-=*+*@@@@             @@@@@@%%##*==-:::-:=+-..+=+*##@@@@@            @@@@#**+-::...:=+
  #++-::..:=*=#@@@                   @@@@#***+==+===---:..=##@@@@                 @@@%+*+-:...::+*
 %*+=::.:--+=#@@@                       @@@#%*+=# **+=-:-=::*@@                    @@@%+*=:.:..:=+
 #*+=:.:.:==*@@@                           @%#*+=@%%@@#++==+*                       @@@#++-:...:=*#
 #*+-:..::==#@@@                            @@#+=+**-+*%%#*#                        @@@%++-.:..:-+*
 #*+-::..:=-#@@@                            @@@#++*+:::=#@@@                        @@@@*=-:..::=+#
 #*+=-..:.--*@@@                           @@@%%%@%*=:..-=%@@                       @@@%==-....-=+#
 #**=-::..--+@@@                          @@@**+*#%#+-:.:.-#@@                      @@@#=-::..:-+*#
 %#*+-:..:.--*@@@                        @@%+-::-+#%#+-:..:-*@@@                   @@@%==:...::=+#@
 @%**=-:...:-=#@@@                     @@%*-::::=+#@%*+::...:-#@@                 @@@%+=:..:.:=+*#
  @#**=:::::.:-*@@@                  @@@*=-:..:-=#%@@%*+-:....:+%@@@            @@@@%+-:...:-=+*#@
  @@#*+=-:.....-=%@@@              @@@*=-:.:.:-+##%@@@%#*-:::-:::=%@@@@       @@@@%+=:::::.:=**#@
   @@#**+-:::.:.::=*%@@@@@    @@@@@#+-::..::-=*##%@  @@#**+-::....:-+%@@@@@@@@@%#=-:..:.::-++*#@@
    @@#***+=:::....::=+*#%%%%%#*+=-:::..::--+*##@@    @@%***=-:......:::-===---::......:-=+**%@@
     @@%+**++-::.:..:....::::::...:....:-=+###%@       @@@#*#*=-::.:....:...:.....:::--=+***%@@
      @@@%+##*+=-:::.:::...:...:::.::--=+*#*%@@         @@@@**#**=---:.:..-..:-.:::==+**#*%@@@
       @@@@#+*###*+=---:--:::--:---++**###%@@@            @@@@**##**++===---=---=+**##*+%@@@@
         @@@@%*+*####****++++++***##***%@@@@                @@@@%*#####********###***#@@@@@
           @@@@@@##*++**#*###***+*##%@@@@@                    @@@@@@%%#**+++++*###%@@@@@@
              @@@@@@@@@%%%%%%%@@@@@@@@@                           @@@@@@@@@@@@@@@@@@@@
                  @@@@@@@@@@@@@@@@@                                      @@@@@@@@

               @@@                       @@@               @@@@             @@
              @=::@@                   @*::-@@           @@+::=@          @*::@
             @@=..@@                  @@+...:#@         @%-...=@@        @@*..@@
             @@=..@@                  @@+.-*..+@@     @@#..+:.=@@        @@*..@@
             @@=..@@                  @@+.-@%-.-%@   @%=.:#@:.=@@        @@*..@@
             @@=..@@                  @@+.-@@@+..*@@@%:.-@@@:.=@@        @@*..@@
             @@=..@@                  @@+.-@@@@%..=%*..#@@@@:.=@@        @@*..@@
              @=..%%%%%%%%%%#%  @##@  @@+.-@@ @@@=...-%@@ @@:.=@@  %*#@  @@*..@@  @##@
              @=............:# @*:.%@  @+.-@@   @@*.+@@@  @@:.=@  @+.:@   @*..@@ @*.-%@
              @@@@@@@@@@@@@@@@  @@@@   @@@@@     @@@@@     @@@@@   @@@@   @@@@@   @@@@
`.trimEnd();

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
  'kill', 'doas', 'vb', 'neofetch', 'apps', 'status', 'save', 'asset demo', 'bus', 'de list', 'de install'
];

const APP_IDS = ['settings', 'sift', 'fleetline', 'dataforge'];
const SERVICE_IDS = ['api-rust', 'api', 'caddy', 'bus', 'storage'];
const CAPABILITY_IDS = ['state:read', 'state:write', 'entity:read', 'entity:write', 'asset:read', 'asset:write', 'debug:read'];
const COMPLETION_ORDER = ['lx -h', 'help', 'Lfetch'];
const SHELL_CATALOG = [
  ['Crisp', 'MacOS styled environment'],
  ['Xenon', 'Windows styled environment'],
  ['LXCE', '3d layered experimental environment'],
  ['Omicron', 'mobile oriented environment']
] as const;

export function createRuntime(parts: RuntimeParts) {
  const bus = new LmiBus(parts.api, parts.modules);
  const contexts = new Map(parts.modules.list().map((module) => [module.id, createModuleContext(module.id, bus)]));
  const terminal: TerminalState = {
    lines: [...BANNER.map((text) => ({ kind: 'system' as const, text })), { kind: 'system', text: 'Type "help" or press Tab for command completion.' }],
    activeApp: 'terminal',
    activeShell: 'terminal',
    desktopRunning: false,
    windowMinimized: false,
    windowMaximized: false,
    settingsValue: 'loading',
    dataForgeDebug: null,
    fleetlineAsset: null,
    siftNote: 'No asset selected.',
    fleetlineSubscribed: false,
    deCatalog: SHELL_CATALOG.map(([id]) => id),
    cwd: '/lmi-r/os',
    fs: new Map(),
    history: [],
    historyIndex: 0,
    suggestion: '',
    completionKey: '',
    completionIndex: 0,
    completionApplied: '',
    currentInput: '',
    pendingDoas: null
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
      root.innerHTML = terminal.desktopRunning
        ? renderDesktop(parts, terminal, currentUser as LoginUser, currentStatus, currentStatusText)
        : renderTerminal(parts, terminal, currentUser as LoginUser, currentStatus, currentStatusText);
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
  return `
    <main class="terminal-shell" data-theme="${parts.theme.id}">
        <section class="terminal-window" aria-label="LMI-R terminal" data-service="${escapeHtml(status?.service ?? 'offline')}" data-status="${escapeHtml(statusText)}">
          <div id="terminalOutput" class="terminal-output">
            ${terminal.lines.map(renderLine).join('')}
            <div id="terminalPrompt" class="terminal-input" tabindex="0">
              <span class="terminal-prompt-label">${escapeHtml(user.username)}@lmi-r:${escapeHtml(shortPwd(terminal.cwd, user))}$</span>
              <span id="terminalCommandMirror" class="terminal-command-mirror">${terminal.currentInput ? highlightCommand(terminal.currentInput) : '&nbsp;'}</span>
              <span id="terminalCompletionGhost" class="terminal-completion-ghost" aria-hidden="true"></span>
            </div>
          </div>
        </section>
    </main>
  `;
}

function renderDesktop(parts: RuntimeParts, terminal: TerminalState, user: LoginUser, status: StatusResponse | null, statusText: string): string {
  const shell = terminal.activeShell;
  const apps = desktopApps(parts);
  const appCards = apps.map((app) => `
    <button class="de-app" data-app="${escapeHtml(app.id)}">
      <span>${escapeHtml(app.label)}</span>
      <small>${escapeHtml(app.meta)}</small>
    </button>
  `).join('');
  const active = renderDesktopWindow(terminal, shell, user);
  if (shell === 'Omicron') {
    return `<main class="de de-omicron"><section class="de-phone"><header><b>LMI-R</b><span>${escapeHtml(user.username)}</span></header><div class="de-drawer">${appCards}</div><article>${renderDesktopApp(terminal, user)}</article><nav class="mobile-taskbar"><button data-mobile-action="back">Back</button><button data-mobile-action="home">Home</button><button data-mobile-action="apps">Apps</button></nav></section></main>`;
  }
  if (shell === 'Crisp') {
    return `<main class="de de-crisp"><header class="de-menu">LMI-R <span>${escapeHtml(status?.service ?? statusText)}</span></header><section class="de-stage">${active}<aside class="de-dock">${appCards}</aside></section></main>`;
  }
  if (shell === 'Xenon') {
    return `<main class="de de-xenon"><section class="xenon-desktop"><aside class="xenon-icons">${appCards}</aside>${active}</section><footer class="xenon-taskbar"><b>Start</b><span>${escapeHtml(user.username)}</span></footer></main>`;
  }
  return `<main class="de de-lxce"><section class="lxce-fold"><div class="fold-panel fold-left">${appCards}</div><div class="fold-panel fold-center">${active}</div><div class="fold-panel fold-right"><h2>LXCE Layer</h2><p>Modules share one bus and flex into view.</p></div></section></main>`;
}

function desktopApps(parts: RuntimeParts): Array<{ id: string; label: string; meta: string }> {
  return [
    { id: 'terminal', label: 'Terminal', meta: 'system' },
    ...parts.modules.list().map((module) => ({
      id: module.id,
      label: module.name.replace('.LMX', ''),
      meta: module.phase,
    })),
  ];
}

function renderDesktopWindow(terminal: TerminalState, shell: string, user: LoginUser): string {
  if (terminal.windowMinimized) {
    return `<button class="de-minimized" data-window-action="restore">${escapeHtml(terminal.activeApp)} minimized</button>`;
  }
  const classes = ['de-window', terminal.windowMaximized ? 'is-maximized' : '', `window-${shell.toLowerCase()}`].filter(Boolean).join(' ');
  const controls = shell === 'Crisp'
    ? `<div class="mac-lights"><button data-window-action="close"></button><button data-window-action="minimize"></button><button data-window-action="maximize"></button></div>`
    : `<div class="window-controls"><button data-window-action="minimize">_</button><button data-window-action="maximize">[]</button><button data-window-action="close">x</button></div>`;
  return `<div class="${classes}"><div class="de-titlebar">${controls}<span>${escapeHtml(appTitle(terminal.activeApp))}</span></div>${renderDesktopApp(terminal, user)}</div>`;
}

function renderDesktopApp(terminal: TerminalState, user: LoginUser | null): string {
  if (terminal.activeApp === 'terminal') {
    return `<div class="de-active de-terminal-app"><div id="terminalOutput" class="terminal-output">${terminal.lines.map(renderLine).join('')}<div id="terminalPrompt" class="terminal-input" tabindex="0"><span class="terminal-prompt-label">${escapeHtml(user?.username ?? 'LMI')}@lmi-r:${escapeHtml(shortPwd(terminal.cwd))}$</span><span id="terminalCommandMirror" class="terminal-command-mirror">${terminal.currentInput ? highlightCommand(terminal.currentInput) : '&nbsp;'}</span><span id="terminalCompletionGhost" class="terminal-completion-ghost" aria-hidden="true"></span></div></div></div>`;
  }
  return `<div class="de-active"><h1>${escapeHtml(appTitle(terminal.activeApp))}</h1>${renderActiveApp(terminal)}</div>`;
}

function appTitle(appId: string): string {
  if (appId === 'terminal') return 'Terminal';
  if (appId === 'fleetline') return 'Fleetline';
  if (appId === 'dataforge') return 'DataForge';
  return appId.charAt(0).toUpperCase() + appId.slice(1);
}

function renderLine(line: TerminalLine): string {
  if (line.kind === 'lfetch') return `<div class="term-line lfetch">${line.text}</div>`;
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
  const prompt = root.querySelector<HTMLElement>('#terminalPrompt');
  const mirror = root.querySelector<HTMLElement>('#terminalCommandMirror');
  const ghost = root.querySelector<HTMLElement>('#terminalCompletionGhost');
  const syncInput = () => {
    if (mirror) {
      const displayValue = terminal.pendingDoas ? '*'.repeat(terminal.currentInput.length) : terminal.currentInput;
      mirror.innerHTML = displayValue ? highlightCommand(displayValue) : '&nbsp;';
    }
    terminal.suggestion = terminal.pendingDoas ? '' : suggestCompletion(terminal);
    if (ghost) ghost.textContent = terminal.suggestion;
  };
  const resetCompletion = () => {
    terminal.completionKey = '';
    terminal.completionIndex = 0;
    terminal.completionApplied = '';
  };
  syncInput();
  prompt?.focus({ preventScroll: true });
  const focusCommand = () => {
    prompt?.focus({ preventScroll: true });
    output?.scrollTo({ top: output.scrollHeight });
  };
  root.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, textarea, select')) return;
    event.preventDefault();
    focusCommand();
  });
  output?.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    focusCommand();
  });
  root.querySelectorAll<HTMLElement>('[data-app]').forEach((button) => {
    button.addEventListener('click', () => {
      const appId = button.dataset.app;
      if (appId) {
        terminal.activeApp = appId;
        terminal.windowMinimized = false;
        rerender();
      }
    });
  });
  root.querySelectorAll<HTMLElement>('[data-window-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.windowAction;
      if (action === 'close') terminal.activeApp = 'terminal';
      if (action === 'minimize') terminal.windowMinimized = true;
      if (action === 'restore') terminal.windowMinimized = false;
      if (action === 'maximize') terminal.windowMaximized = !terminal.windowMaximized;
      rerender();
    });
  });
  root.querySelectorAll<HTMLElement>('[data-mobile-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.mobileAction;
      if (action === 'back') terminal.activeApp = 'terminal';
      if (action === 'home') terminal.activeApp = 'terminal';
      if (action === 'apps') terminal.activeApp = 'terminal';
      rerender();
    });
  });

  prompt?.addEventListener('paste', (event) => {
    event.preventDefault();
    terminal.currentInput += event.clipboardData?.getData('text/plain') ?? '';
    resetCompletion();
    syncInput();
  });
  const handleKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      terminal.historyIndex = Math.max(0, terminal.historyIndex - 1);
      terminal.currentInput = terminal.history[terminal.historyIndex] ?? terminal.currentInput;
      syncInput();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      terminal.historyIndex = Math.min(terminal.history.length, terminal.historyIndex + 1);
      terminal.currentInput = terminal.history[terminal.historyIndex] ?? '';
      syncInput();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      applyCompletion(terminal);
      syncInput();
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      terminal.currentInput = terminal.currentInput.slice(0, -1);
      resetCompletion();
      syncInput();
    } else if (event.key === 'Delete') {
      event.preventDefault();
      terminal.currentInput = '';
      resetCompletion();
      syncInput();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const command = terminal.currentInput.trim();
      if (!command) return;
      terminal.history.push(command);
      terminal.historyIndex = terminal.history.length;
      terminal.suggestion = '';
      resetCompletion();
      terminal.currentInput = '';
      void runCommand(command, parts, contexts, terminal, user, status, statusText, logout).then(rerender);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      terminal.currentInput += event.key;
      resetCompletion();
      syncInput();
    }
  };
  prompt?.addEventListener('keydown', handleKey);
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
  if (terminal.pendingDoas) {
    const pending = terminal.pendingDoas;
    terminal.pendingDoas = null;
    await completeDoas(command, pending.args, parts, contexts, terminal, user);
    return;
  }

  pushLine(terminal, 'input', command);
  const [raw, ...args] = command.split(/\s+/);
  const op = raw;
  const lower = raw.toLowerCase();

  if (lower === 'help') {
    const filter = args.join(' ').trim();
    if (filter === 'lx') { pushBlock(terminal, lxHelpLines()); return; }
    pushBlock(terminal, helpLines(filter));
    return;
  }
  if (lower === 'clear') { terminal.lines = []; return; }
  if (lower === 'exit') { logout(); return; }
  if (lower === 'reboot') { location.reload(); return; }
  if (lower === 'lfetch' || lower === 'neofetch') { pushLfetch(terminal, buildLfetch(parts, terminal, user, status, statusText)); return; }
  if (lower === 'apps') { pushBlock(terminal, desktopApps(parts).map((app) => `${app.id.padEnd(10)} ${app.label} [${app.meta}]`)); return; }
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
  if (lower === 'startx') { terminal.desktopRunning = terminal.activeShell !== 'terminal'; pushLine(terminal, terminal.desktopRunning ? 'system' : 'error', terminal.desktopRunning ? `${terminal.activeShell} started` : 'No desktop shell selected. Use shell set Crisp|Xenon|LXCE|Omicron.'); return; }
  if (lower === 'stopx') { terminal.desktopRunning = false; pushLine(terminal, 'system', 'desktop stopped; terminal restored'); return; }
  if (lower === 'tty') { pushLine(terminal, 'output', terminal.desktopRunning ? `${terminal.activeShell} on tty7` : 'terminal on tty1'); return; }
  if (lower === 'svc') { pushLine(terminal, 'system', `svc ${args.join(' ') || 'list'}: service control is read-only in this slice.`); return; }
  if (lower === 'perm') { pushLine(terminal, 'system', `perm ${args.join(' ') || 'list'}: capability editor reserved for admin slice.`); return; }
  if (lower === 'debug') { debugCommand(args, terminal, parts); return; }
  if (lower === 'save') { await saveSetting(args.join(' '), contexts, terminal, user); return; }
  if (lower === 'asset' && args[0] === 'demo') { publishAsset(contexts, terminal); return; }
  if (lower === 'bus') { await busDebug(contexts, terminal); return; }
  if (lower === 'kill') { pushLine(terminal, 'system', `kill requested for ${args[0] || 'active package'}`); return; }
  if (lower === 'vb') { pushLine(terminal, 'error', 'vb requires doas administrator elevation'); return; }
  if (lower === 'doas') {
    if (user.username !== 'BrokenSynapse') { pushLine(terminal, 'error', 'doas refused: BrokenSynapse admin account required'); return; }
    if (args[0] === 'vb') {
      terminal.pendingDoas = { args };
      pushLine(terminal, 'system', '[doas authenticate]: [Enter password for current account]');
      return;
    }
    pushLine(terminal, 'system', 'doas ready; provide an elevated command such as: doas vb lx -y');
    return;
  }
  pushLine(terminal, 'error', `Command not found: ${command}`);
}

function openApp(parts: RuntimeParts, terminal: TerminalState, appId: string): void {
  if (appId !== 'terminal' && !parts.modules.get(appId)) { pushLine(terminal, 'error', `Unknown app: ${appId || '(missing)'}`); return; }
  terminal.activeApp = appId;
  terminal.windowMinimized = false;
  pushLine(terminal, 'system', `Opened ${appId} through terminal adapter.`);
}

function helpLines(filter: string): string[] {
  const groups = [
    ['lx', 'package/profile binding manager'],
    ['lmx', 'app/module launcher'],
    ['shell', 'DE/shell manager'],
    ['sys', 'runtime/system manager'],
    ['svc', 'services'],
    ['perm', 'permissions'],
    ['Lfetch', 'identity/neofetch']
  ];
  const commands = filter ? COMMANDS.filter((item) => item.toLowerCase().startsWith(filter.toLowerCase())) : COMMANDS;
  return [
    'Command groups:',
    ...groups.map(([name, description]) => `  ${name.padEnd(8)} ${description}`),
    '',
    'Commands:',
    ...formatColumns(commands.map((item) => `  ${item}`), 3, 24)
  ];
}

function formatColumns(items: string[], columns: number, width: number): string[] {
  const rows: string[] = [];
  for (let index = 0; index < items.length; index += columns) {
    rows.push(items.slice(index, index + columns).map((item) => item.padEnd(width)).join('').trimEnd());
  }
  return rows;
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

async function busDebug(contexts: Map<string, ModuleContext>, terminal: TerminalState, verbose = false): Promise<void> {
  terminal.dataForgeDebug = await contexts.get('dataforge')?.callAction('debug.bus') as BusDebugView;
  pushBlock(terminal, [`registered modules: ${terminal.dataForgeDebug.registeredModules.length}`, `known topics: ${terminal.dataForgeDebug.knownTopics.join(', ') || 'none'}`, `recent packets: ${terminal.dataForgeDebug.recentPackets.length}`, `pending requests: ${terminal.dataForgeDebug.pendingRequestCount}`]);
  if (verbose) pushVerbosePackets(terminal, terminal.dataForgeDebug);
}

function lxCommand(args: string[], parts: RuntimeParts, terminal: TerminalState): void {
  const flag = args[0] || '-h';
  if (flag === '-v' || flag === '-l') pushBlock(terminal, parts.modules.list().map((module) => `${module.id} ${module.name}`));
  else if (flag === '-h') pushBlock(terminal, lxHelpLines());
  else pushLine(terminal, 'system', `lx ${args.join(' ')} accepted by package manager shim.`);
}

function lxHelpLines(): string[] {
  return [
    'lx -b [package]  - banish package',
    '                  uninstall / remove user access / unpin from DE if present',
    '',
    'lx -c [package]  - clear package cache',
    '',
    'lx -g [package]  - gather package',
    '                  install / allow user access / pin to DE if present',
    '',
    'lx -h            - show lx help menu',
    '',
    'lx -i [package]  - inspect package details',
    '',
    'lx -l            - list installed packages',
    '',
    'lx -u            - update modules and main interface',
    '',
    'lx -v            - view available packages',
    '',
    'lx -y            - gather from yonder',
    '                  refresh package registry'
  ];
}

async function completeDoas(password: string, args: string[], parts: RuntimeParts, contexts: Map<string, ModuleContext>, terminal: TerminalState, user: LoginUser): Promise<void> {
  if (user.username !== 'BrokenSynapse') { pushLine(terminal, 'error', 'doas refused: BrokenSynapse admin account required'); return; }
  try {
    const authenticated = await parts.api.login(user.username, password);
    if (authenticated.username !== 'BrokenSynapse' || !authenticated.is_admin) {
      pushLine(terminal, 'error', 'doas refused: admin authentication failed');
      return;
    }
  } catch {
    pushLine(terminal, 'error', 'doas refused: admin authentication failed');
    return;
  }
  if (args[0] === 'vb') await runVerboseCommand(args.slice(1), parts, terminal, user, contexts);
  else pushLine(terminal, 'error', `doas refused: unsupported elevated command ${args.join(' ') || '(empty)'}`);
}

async function runVerboseCommand(args: string[], parts: RuntimeParts, terminal: TerminalState, user: LoginUser, contexts: Map<string, ModuleContext>): Promise<void> {
  const command = args.join(' ').trim();
  if (!command) { pushLine(terminal, 'error', 'vb requires a command'); return; }
  pushLine(terminal, 'output', `>${command}`);
  pushBlock(terminal, ['>[verbose data]', `>actor=${user.username}`, '>scope=administrator']);
  const [raw, ...innerArgs] = command.split(/\s+/);
  if (raw.toLowerCase() === 'bus') {
    await busDebug(contexts, terminal, true);
  }
  else if (raw.toLowerCase() === 'lx') {
    lxCommand(innerArgs, parts, terminal);
    pushVerbosePackets(terminal, terminal.dataForgeDebug);
  }
  else pushLine(terminal, 'system', `${command}: verbose command wrapper completed`);
}

function pushVerbosePackets(terminal: TerminalState, debug: BusDebugView | null): void {
  const packets = debug?.recentPackets.slice(-6) ?? [];
  pushLine(terminal, 'output', `>packet-count=${packets.length}`);
  for (const packet of packets) {
    const target = packet.target ? `${packet.target.kind}:${packet.target.id}` : 'broadcast';
    pushLine(terminal, 'output', `>packet id=${packet.id.slice(0, 8)} op=${packet.op} ${packet.source.kind}:${packet.source.id}->${target} scope=${packet.scope}`);
    if (packet.payload !== undefined) pushLine(terminal, 'output', `>payload ${formatDebugValue(packet.payload).replace(/\n/g, ' ')}`);
  }
}

function shellCommand(args: string[], terminal: TerminalState): void {
  const requested = matchShell(args.slice(1).join(' ') || args[1] || '');
  if (args[0] === 'list') pushBlock(terminal, SHELL_CATALOG.map(([id, description]) => `${id.padEnd(8)} ${description}`));
  else if (args[0] === 'installed') pushBlock(terminal, ['terminal', ...SHELL_CATALOG.map(([id]) => id)]);
  else if (['add', 'install', 'set'].includes(args[0] || '')) {
    if (!requested) { pushLine(terminal, 'error', 'Unknown shell. Use shell list.'); return; }
    terminal.activeShell = requested;
    pushLine(terminal, 'system', `${requested} selected. Run startx to enter it.`);
  }
  else if (args[0] === 'remove') pushLine(terminal, 'error', 'Core LMI-R shells cannot be removed in this build.');
  else if (args[0] === 'current') pushLine(terminal, 'output', terminal.desktopRunning ? `${terminal.activeShell} (running)` : terminal.activeShell);
  else if (args[0] === 'reset') { terminal.activeShell = 'terminal'; terminal.desktopRunning = false; pushLine(terminal, 'system', 'default shell reset to terminal'); }
  else pushBlock(terminal, COMMANDS.filter((cmd) => cmd.startsWith('shell ') || cmd.startsWith('de ')));
}

function matchShell(value: string): string | null {
  const clean = value.trim().toLowerCase();
  const hit = SHELL_CATALOG.find(([id]) => id.toLowerCase() === clean);
  return hit?.[0] ?? null;
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

function buildLfetch(parts: RuntimeParts, terminal: TerminalState, user: LoginUser, status: StatusResponse | null, statusText: string): string {
  const started = status?.started_at ? Date.now() - status.started_at : performance.now();
  const memory = browserMemoryLine();
  const details = [
    `<span class="lfetch-user">${escapeHtml(user.username)}@brokensynapse-us</span>`,
    `<span class="lfetch-rule">--------------------------</span>`,
    field('OS', 'LMI 19.2.1.1.2212'),
    field('Host', `${escapeHtml(user.cid || 'acc_name')}-${hashAccount(user.username)}`),
    field('Kernel', 'Linux 19.2.1-22-generic'),
    field('Uptime', formatDuration(started)),
    field('Packages', `${parts.modules.list().length} (lmx)`),
    field('Shell', 'fish 19.2.1'),
    field('Terminal', '/dev/pts/0'),
    field('CPU', 'LXC Trinity 2200 (96) @ 9800 MHz'),
    field('GPU', 'JI Cashout 3301'),
    field('Memory', `${memory.usedGiB} GiB / 3072 GiB (${memory.percent}%)`),
    field('Disk (/)', '36.82 GiB / 245.02 GiB (<span class="lfetch-green">15%</span>) - xfs'),
    field('Local IP (enp0s3)', 'reported by browser/network layer'),
    field('Locale', 'en_US.UTF-8'),
    '',
    '<span class="lfetch-swatches"><i style="--c:#4a4a4a"></i><i style="--c:#e84242"></i><i style="--c:#12b826"></i><i style="--c:#d4b80f"></i><i style="--c:#174fe0"></i><i style="--c:#8e1fb2"></i><i style="--c:#38a2d7"></i><i style="--c:#d8d8d8"></i></span>',
    '<span class="lfetch-swatches"><i style="--c:#777"></i><i style="--c:#ff5d5d"></i><i style="--c:#24d43a"></i><i style="--c:#fff38a"></i><i style="--c:#6285ff"></i><i style="--c:#cd18bf"></i><i style="--c:#79dde0"></i><i style="--c:#fff"></i></span>'
  ];
  return `<div class="lfetch-grid"><pre>${escapeHtml(LFETCH_ART)}</pre><pre>${details.join('\n')}</pre></div>`;
}

function browserMemoryLine(): { usedGiB: string; percent: string } {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  const usedBytes = memory?.usedJSHeapSize ?? 0;
  const usedGiB = usedBytes / 1024 / 1024 / 1024;
  return {
    usedGiB: usedGiB.toFixed(3),
    percent: ((usedGiB / 3072) * 100).toFixed(6)
  };
}

function field(label: string, value: string): string {
  return `<span class="lfetch-label">${label}:</span> ${value}`;
}

function hashAccount(value: string): string {
  let hash = 0;
  for (const char of value) hash = (Math.imul(31, hash) + char.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(16).padStart(5, '0').slice(0, 5);
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
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

type CompletionPlan = { key: string; matches: string[] };

function suggestCompletion(terminal: TerminalState): string {
  if (!terminal.currentInput.trimStart()) return '';
  const plan = completionPlan(terminal.currentInput);
  if (!plan.matches.length) return '';
  const index = terminal.completionKey === plan.key ? terminal.completionIndex % plan.matches.length : 0;
  const candidate = plan.matches[index] ?? plan.matches[0];
  return candidate.toLowerCase().startsWith(terminal.currentInput.toLowerCase()) ? candidate.slice(terminal.currentInput.length) : '';
}

function applyCompletion(terminal: TerminalState): void {
  const plan = completionPlan(terminal.currentInput);
  if (!plan.matches.length) return;
  const sameCycle = terminal.completionKey === plan.key && terminal.completionApplied === terminal.currentInput;
  terminal.completionKey = plan.key;
  terminal.completionIndex = sameCycle ? (terminal.completionIndex + 1) % plan.matches.length : 0;
  terminal.currentInput = plan.matches[terminal.completionIndex] ?? terminal.currentInput;
  terminal.completionApplied = terminal.currentInput;
}

function completionPlan(value: string): CompletionPlan {
  const input = value.trimStart();
  if (!input) return { key: 'root', matches: orderCompletions([...new Set(COMMANDS.map((cmd) => cmd.split(/\s+/)[0]))]) };

  const spaced = /\s$/.test(input);
  const words = input.trimEnd().split(/\s+/);
  const first = words[0]?.toLowerCase() ?? '';
  const currentWord = spaced ? '' : words[words.length - 1] ?? '';
  const prefix = spaced ? input : input.slice(0, input.length - currentWord.length);
  const argStage = argumentStageMatches(input, words, currentWord, prefix, spaced);
  if (argStage.matches.length) return argStage;

  const commandStage = commandStageMatches(input, first, currentWord, prefix, spaced);
  if (commandStage.matches.length) return commandStage;

  return { key: `literal:${input}`, matches: orderCompletions(COMMANDS.filter((cmd) => cmd.toLowerCase().startsWith(input.toLowerCase()))) };
}

function commandStageMatches(input: string, first: string, currentWord: string, prefix: string, spaced: boolean): CompletionPlan {
  const grouped = COMMANDS.filter((cmd) => cmd.toLowerCase().startsWith(`${first} `));
  if (grouped.length && (!input.includes(' ') || COMMANDS.some((cmd) => cmd.toLowerCase() === input.toLowerCase()))) {
    return { key: `cmd:${first}`, matches: orderCompletions(grouped) };
  }
  if (input.includes(' ')) {
    const siblings = COMMANDS.filter((cmd) => {
      if (!cmd.toLowerCase().startsWith(prefix.toLowerCase())) return false;
      const tail = cmd.slice(prefix.length);
      return spaced || tail.toLowerCase().startsWith(currentWord.toLowerCase()) || cmd.toLowerCase() === input.toLowerCase();
    });
    return { key: `cmd:${first}`, matches: orderCompletions(siblings.length ? siblings : grouped) };
  }
  return { key: `root:${first}`, matches: orderCompletions(COMMANDS.filter((cmd) => cmd.toLowerCase().startsWith(input.toLowerCase()))) };
}

function argumentStageMatches(input: string, words: string[], currentWord: string, prefix: string, spaced: boolean): CompletionPlan {
  const command = words.slice(0, spaced ? words.length : -1).join(' ').toLowerCase();
  const values = argumentValues(command);
  if (!values.length) return { key: '', matches: [] };
  const exact = !spaced && values.some((value) => value.toLowerCase() === currentWord.toLowerCase());
  const matches = values
    .filter((value) => spaced || exact || value.toLowerCase().startsWith(currentWord.toLowerCase()))
    .map((value) => `${prefix}${value}`);
  return { key: `arg:${command}`, matches };
}

function argumentValues(command: string): string[] {
  if (command === 'lmx open' || command === 'lmx close' || command === 'perm app') return APP_IDS;
  if (command === 'shell add' || command === 'shell remove' || command === 'shell set' || command === 'de install') return SHELL_CATALOG.map(([id]) => id);
  if (/^svc (status|start|stop|restart|logs)$/.test(command)) return SERVICE_IDS;
  if (command === 'perm grant' || command === 'perm revoke') return CAPABILITY_IDS;
  return [];
}

function orderCompletions(matches: string[]): string[] {
  return [...matches].sort((a, b) => {
    const preferredA = COMPLETION_ORDER.indexOf(a);
    const preferredB = COMPLETION_ORDER.indexOf(b);
    if (preferredA !== -1 || preferredB !== -1) return (preferredA === -1 ? 999 : preferredA) - (preferredB === -1 ? 999 : preferredB);
    return a.localeCompare(b);
  });
}

function longestCommonPrefix(values: string[]): string {
  if (!values.length) return '';
  let prefix = values[0];
  for (const value of values.slice(1)) {
    while (!value.toLowerCase().startsWith(prefix.toLowerCase()) && prefix) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
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
  const words = full.trimStart().split(/\s+/);
  const root = words[0] || '';
  if (index === 0) return token === 'doas' ? 'tok-doas' : 'tok-cmd';
  if (root === 'doas') {
    if (index === 1 && token === 'vb') return 'tok-doas';
    if (index === 2) return 'tok-cmd';
    if (index > 2 && token.startsWith('-')) return 'tok-flag';
  }
  if (token.startsWith('-')) return 'tok-flag';
  if (token.startsWith('/') || token.startsWith('~/') || token === '..' || token === '.') return 'tok-path';
  if (index === 1 && /^(lx|shell|lmx|sys|svc|perm|debug|de)$/.test(root)) return 'tok-subcmd';
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

function pushLfetch(terminal: TerminalState, html: string): void {
  terminal.lines.push({ kind: 'lfetch', text: html });
  if (terminal.lines.length > 160) terminal.lines.splice(0, terminal.lines.length - 160);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
}
