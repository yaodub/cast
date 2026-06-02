import { useEffect, useState } from 'preact/hooks';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'cast-theme';

function readInitial(): Theme {
  if (typeof localStorage === 'undefined') return 'light';
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(readInitial);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // localStorage unavailable (privacy mode); ignore
    }
  }, [theme]);

  return [theme, setTheme];
}
