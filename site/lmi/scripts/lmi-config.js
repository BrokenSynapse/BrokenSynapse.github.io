window.LMI_CONFIG = {
  appName: 'Leviathan Military Interlink',
  manifestPath: 'module-manifest.json',
  localKeys: {
    relayUrl: 'LMI_RELAY_URL',
    relaySavedAt: 'LMI_RELAY_SAVED_AT',
    user: 'LMI_LAST_USER',
    installed: 'LMI_INSTALLED_APPS',
    layout: 'LMI_DESKTOP_LAYOUT'
  }
};

window.LMI_NORMALIZE_ASSET_URL = function normalizeLmiAssetUrl(value) {
  let src = String(value || '').trim().replace(/\\/g, '/').replace(/^LMC:\s*/i, '');
  if (!src || /^(default|none|null|x)$/i.test(src)) return '';

  const githubAsset = src.match(/^https:\/\/github\.com\/BrokenSynapse\/BrokenSynapse\.github\.io\/blob\/main\/(?:site\/)?(?:lmi\/)?assets\/(.+?)\?raw=true$/i);
  if (githubAsset) src = '/lmi/assets/' + githubAsset[1];

  if (/^https?:\/\//i.test(src) || /^data:/i.test(src)) return src;

  if (src.startsWith('/assets/')) src = '/lmi' + src;
  if (src.startsWith('assets/')) src = '/lmi/' + src;
  if (src.startsWith('lmi/assets/')) src = '/' + src;

  if (src && !src.startsWith('/')) {
    src = '/lmi/assets/' + src.replace(/^\/+/, '').replace(/^assets\//, '').replace(/^lmi\/assets\//, '');
  }

  return src.replace(/\/+/g, '/');
};
