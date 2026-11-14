export const THEME_STORAGE_KEY = 'dsh-huashu-design:palette:v1';
export const THEME_PRESETS = Object.freeze([
  { id: 'ocean', labelKey: 'themeOcean', color: '#2563eb' },
  { id: 'emerald', labelKey: 'themeEmerald', color: '#059669' },
  { id: 'wisteria', labelKey: 'themeWisteria', color: '#7c3aed' },
  { id: 'rose', labelKey: 'themeRose', color: '#db2777' },
  { id: 'amber', labelKey: 'themeAmber', color: '#d97706' },
  { id: 'coral', labelKey: 'themeCoral', color: '#e3533a' }
]);
export const DEFAULT_THEME = Object.freeze({ themeId: 'ocean', customColor: '#2563eb' });

export function normalizeColor(value, fallback = DEFAULT_THEME.customColor) {
  if (typeof value !== 'string') return fallback;
  const color = value.trim().toLowerCase();
  if (/^#[\da-f]{6}$/.test(color)) return color;
  if (/^#[\da-f]{3}$/.test(color)) return '#' + [...color.slice(1)].map(char => char + char).join('');
  const rgb = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  const srgb = color.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  const channels = rgb ? rgb.slice(1, 4).map(Number) : srgb ? srgb.slice(1, 4).map(value => Number(value) * 255) : null;
  if (!channels?.every(Number.isFinite)) return fallback;
  return '#' + channels.map(channel => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0')).join('');
}

export function relativeLuminance(color) {
  const hex = normalizeColor(color);
  const channels = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}
export function contrastRatio(first, second) {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}
export function readableForeground(color) {
  return contrastRatio(color, '#000000') >= contrastRatio(color, '#ffffff') ? '#000000' : '#ffffff';
}

export function normalizeTheme(value) {
  const themeId = [...THEME_PRESETS.map(item => item.id), 'host', 'custom'].includes(value?.themeId) ? value.themeId : DEFAULT_THEME.themeId;
  return { themeId, customColor: normalizeColor(value?.customColor) };
}
export function readThemePreference(storage) {
  try { return normalizeTheme(JSON.parse((storage || globalThis.localStorage)?.getItem(THEME_STORAGE_KEY) || 'null')); }
  catch { return { ...DEFAULT_THEME }; }
}
export function saveThemePreference(preference, storage) {
  const normalized = normalizeTheme(preference);
  try { const target = storage || globalThis.localStorage; if (!target?.setItem) return false; target.setItem(THEME_STORAGE_KEY, JSON.stringify(normalized)); return true; }
  catch { return false; }
}

// Every key belongs to the Huashu root. Host tokens remain read-only inputs, so
// dark/light mode updates surfaces without rebuilding or remounting the editor.
export function themeVariables(preference, hostAccent) {
  const { themeId, customColor } = normalizeTheme(preference);
  const accent = themeId === 'custom' ? customColor : themeId === 'host' ? normalizeColor(hostAccent) : THEME_PRESETS.find(item => item.id === themeId).color;
  const mix = (host, percentage) => `color-mix(in srgb, var(--dsw-alias-${host}) ${percentage}%, var(--hs-accent))`;
  return {
    '--hs-accent': accent,
    '--hs-on-accent': readableForeground(accent),
    '--hs-accent-ink': 'color-mix(in srgb, var(--hs-accent) 64%, var(--dsw-alias-label-primary))',
    '--hs-accent-soft': 'color-mix(in srgb, var(--hs-accent) 12%, var(--dsw-alias-bg-layer-1))',
    '--hs-bg-base': mix('bg-base', 98),
    '--hs-bg-layer-1': mix('bg-layer-1', 96),
    '--hs-bg-layer-2': mix('bg-layer-2', 92),
    '--hs-border-l1': mix('border-l1', 85),
    '--hs-border-l2': mix('border-l2', 70)
  };
}
