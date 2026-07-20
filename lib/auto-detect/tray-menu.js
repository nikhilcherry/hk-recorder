/**
 * Builds an Electron menu-item template for toggling auto-detect from the
 * tray menu (see lib/trigger.js's _rebuildTrayMenu). Splice the returned
 * item into that template's array.
 */
function buildAutoDetectMenuItem(engine, { onToggle } = {}) {
  return {
    label: 'Auto-Detect Highlights',
    type: 'checkbox',
    checked: engine.isEnabled(),
    click: () => {
      engine.setEnabled(!engine.isEnabled());
      if (onToggle) onToggle(engine.isEnabled());
    },
  };
}

module.exports = { buildAutoDetectMenuItem };
