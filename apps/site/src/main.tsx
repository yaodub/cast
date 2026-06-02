import { hydrate, prerender as ssr } from 'preact-iso';
import { App } from './App';
import './styles/tokens.css';
import './styles/skins.css';

if (typeof window !== 'undefined') {
  hydrate(<App />, document.getElementById('app')!);
}

export async function prerender(data: unknown) {
  return await ssr(<App {...(data as Record<string, unknown>)} />);
}
