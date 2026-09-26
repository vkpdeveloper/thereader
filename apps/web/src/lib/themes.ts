export interface ColorRoles {
  bg: string;
  panel: string;
  element: string;
  border: string;
  borderActive: string;
  fg: string;
  muted: string;
  subtle: string;
  blue: string;
  purple: string;
  green: string;
  orange: string;
  pink: string;
  cyan: string;
  paper?: string;
  ink?: string;
}

const defaultRoles: ColorRoles = {
  bg: '#000000',
  panel: '#101010',
  element: '#1f1f1f',
  border: '#1f1f1f',
  borderActive: '#676767',
  fg: '#ededed',
  muted: '#a1a1a1',
  subtle: '#676767',
  blue: '#52a8ff',
  purple: '#c472fb',
  green: '#62c073',
  orange: '#ff9907',
  pink: '#f75f8f',
  cyan: '#1da9b0',
};

const dracula: ColorRoles = {
  bg: '#282a36',
  panel: '#21222c',
  element: '#44475a',
  border: '#44475a',
  borderActive: '#6272a4',
  fg: '#f8f8f2',
  muted: '#bf c7d5',
  subtle: '#6272a4',
  blue: '#8be9fd',
  purple: '#bd93f9',
  green: '#50fa7b',
  orange: '#ffb86c',
  pink: '#ff79c6',
  cyan: '#8be9fd',
};

const nord: ColorRoles = {
  bg: '#2e3440',
  panel: '#3b4252',
  element: '#434c5e',
  border: '#434c5e',
  borderActive: '#4c566a',
  fg: '#eceff4',
  muted: '#d8dee9',
  subtle: '#7b88a1',
  blue: '#88c0d0',
  purple: '#b48ead',
  green: '#a3be8c',
  orange: '#d08770',
  pink: '#bf616a',
  cyan: '#8fbcbb',
};

const tokyoNight: ColorRoles = {
  bg: '#1a1b26',
  panel: '#16161e',
  element: '#292e42',
  border: '#232433',
  borderActive: '#414868',
  fg: '#c0caf5',
  muted: '#a9b1d6',
  subtle: '#565f89',
  blue: '#7aa2f7',
  purple: '#bb9af7',
  green: '#9ece6a',
  orange: '#ff9e64',
  pink: '#f7768e',
  cyan: '#7dcfff',
};

const catppuccinMocha: ColorRoles = {
  bg: '#1e1e2e',
  panel: '#181825',
  element: '#313244',
  border: '#313244',
  borderActive: '#585b70',
  fg: '#cdd6f4',
  muted: '#a6adc8',
  subtle: '#6c7086',
  blue: '#89b4fa',
  purple: '#cba6f7',
  green: '#a6e3a1',
  orange: '#fab387',
  pink: '#f38ba8',
  cyan: '#89dceb',
};

const gruvbox: ColorRoles = {
  bg: '#282828',
  panel: '#1d2021',
  element: '#3c3836',
  border: '#3c3836',
  borderActive: '#665c54',
  fg: '#ebdbb2',
  muted: '#a89984',
  subtle: '#928374',
  blue: '#83a598',
  purple: '#d3869b',
  green: '#b8bb26',
  orange: '#fe8019',
  pink: '#fb4934',
  cyan: '#8ec07c',
};

export const presets: Record<string, ColorRoles> = {
  default: defaultRoles,
  dracula,
  nord,
  'tokyo-night': tokyoNight,
  'catppuccin-mocha': catppuccinMocha,
  gruvbox,
};

export const presetNames: Record<string, string> = {
  default: 'Default',
  dracula: 'Dracula',
  nord: 'Nord',
  'tokyo-night': 'Tokyo Night',
  'catppuccin-mocha': 'Catppuccin Mocha',
  gruvbox: 'Gruvbox',
};

export function setTheme(id: string) {
  const roles = presets[id] ?? defaultRoles;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(roles)) {
    if (key === 'paper' || key === 'ink') continue;
    root.style.setProperty(`--${key}`, value);
  }
  root.style.setProperty('--paper', roles.paper ?? roles.bg);
  root.style.setProperty('--ink', roles.ink ?? roles.fg);
}
