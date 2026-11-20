const apiPath = '/horizon-chat/api/';
const desktopEndpoint = globalThis.__HORIZON_DESKTOP_API__;

export const isDesktop = typeof desktopEndpoint === 'string';

export function apiUrl(route) {
  return (isDesktop ? desktopEndpoint : apiPath) + route;
}

export function apiAsset(value) {
  if (isDesktop && typeof value === 'string' && value.startsWith(apiPath)) {
    return apiUrl(value.slice(apiPath.length));
  }
  return value;
}

export function apiFetch(route, options) {
  return fetch(apiUrl(route), isDesktop ? { ...options, credentials: 'omit', referrerPolicy: 'no-referrer' } : options);
}

export function apiEvents() {
  return new EventSource(apiUrl('events'));
}
