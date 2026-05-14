// Disabled.
// lmi-desktop.js now owns shell prefs, icon sizing, grid snapping, and coordinate saving.
// This file previously drew the snap ghost and fought icon drag.
window.LMI_SHELL_QOL = {
  apply(){},
  preview(){},
  save(){},
  snapAll(){},
  norm(p){ return p || {}; }
};
