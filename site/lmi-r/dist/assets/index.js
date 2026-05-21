const modules = [
  { id: "settings", name: "Settings.LMX", phase: "stub" },
  { id: "sift", name: "Sift.LMX", phase: "stub" },
  { id: "fleetline", name: "Fleetline.LMX", phase: "compat-planned" },
  { id: "dataforge", name: "DataForge.LMX", phase: "compat-planned" }
];

const root = document.querySelector("#app");

if (!root) {
  throw new Error("LMI-R root element missing.");
}

function render(status, statusText) {
  const moduleTiles = modules.map((mod) => `
    <button class="module-tile" type="button" data-module="${mod.id}">
      <span>${mod.name}</span>
      <small>${mod.phase}</small>
    </button>
  `).join("");

  root.innerHTML = `
    <main class="desktop" data-theme="lmi-r-dark">
      <section class="topbar">
        <div>
          <p class="eyebrow">Leviathan Mainframe Interface</p>
          <h1>LMI-R</h1>
        </div>
        <div class="session">
          <span>local-operator</span>
          <strong>placeholder</strong>
        </div>
      </section>
      <section class="workspace">
        <aside class="dock" aria-label="Module registry">
          ${moduleTiles}
        </aside>
        <section class="panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Rewrite vertical slice</p>
              <h2>Desktop Shell</h2>
            </div>
            <span class="pill">0 windows</span>
          </div>
          <div class="status-grid">
            <article><span>Backend</span><strong>${statusText}</strong></article>
            <article><span>Service</span><strong>${status?.service ?? "pending"}</strong></article>
            <article><span>API Prefix</span><strong>${status?.api_prefix ?? "/api-r"}</strong></article>
            <article><span>Database</span><strong>${status?.database ?? "data/lmi-r.sqlite"}</strong></article>
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

async function boot() {
  render(null, "Checking Rust backend...");
  try {
    const response = await fetch("/api-r/status", {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error || `API request failed: ${response.status}`);
    }
    render(body, "Rust backend online");
  } catch (error) {
    render(null, `Rust backend unavailable: ${String(error)}`);
  }
}

boot();
