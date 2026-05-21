export interface Theme {
  id: string;
  accent: string;
}

export function loadTheme(): Theme {
  return {
    id: 'lmi-r-dark',
    accent: '#45f0d6'
  };
}
