const baseTag = document.querySelector('base')?.getAttribute('href') ?? '/';

/** Runtime application base, e.g. "" for "/" or "/app/wcdc". */
export const APP_BASE = baseTag.replace(/\/+$/, '');
export const API_BASE = `${APP_BASE}/api`;
