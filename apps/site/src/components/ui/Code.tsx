import type { ComponentChildren } from 'preact';
import { CopyButton } from './CopyButton';

type Lang = 'bash' | 'yaml' | 'py' | 'ts' | 'js' | 'json' | 'markdown';

interface Props {
  lang?: Lang;
  title?: string;
  children: ComponentChildren;
  showLines?: boolean;
  noHead?: boolean;
  minimal?: boolean;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function toText(n: ComponentChildren): string {
  if (n == null || typeof n === 'boolean') return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(toText).join('');
  // VNode
  const v = n as { props?: { children?: ComponentChildren } };
  if (v.props && v.props.children !== undefined) return toText(v.props.children);
  return '';
}

function highlight(code: string, lang: Lang): string {
  if (lang === 'bash') {
    const out: string[] = [];
    const re =
      /(#[^\n]*)|("[^"]*")|(^\$\s)|(\b(?:curl|brew|npm|pip|pnpm|cast|cd|mkdir|export|git)\b)|(--?[a-z][a-z-]*)/gm;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      if (m.index > last) out.push(esc(code.slice(last, m.index)));
      const tok = m[0];
      if (m[1]) out.push('<span class="tok-c">' + esc(tok) + '</span>');
      else if (m[2]) out.push('<span class="tok-s">' + esc(tok) + '</span>');
      else if (m[3]) out.push('<span class="tok-pu">' + esc(tok) + '</span>');
      else if (m[4]) out.push('<span class="tok-f">' + esc(tok) + '</span>');
      else if (m[5]) out.push('<span class="tok-p">' + esc(tok) + '</span>');
      last = m.index + tok.length;
    }
    if (last < code.length) out.push(esc(code.slice(last)));
    return out.join('');
  }
  if (lang === 'yaml') {
    return esc(code)
      .replace(/(#.*)$/gm, '<span class="tok-c">$1</span>')
      .replace(
        /^(\s*)([a-zA-Z_][\w-]*)(\s*:)/gm,
        '$1<span class="tok-p">$2</span>$3'
      )
      .replace(/:\s*("[^"]*"|true|false|null|\d+)/g, (_m, v: string) => {
        if (/^"/.test(v)) return ': <span class="tok-s">' + v + '</span>';
        if (/^(true|false|null)$/.test(v)) return ': <span class="tok-k">' + v + '</span>';
        return ': <span class="tok-n">' + v + '</span>';
      });
  }
  if (lang === 'py') {
    const out: string[] = [];
    const re =
      /(#[^\n]*)|("""[\s\S]*?"""|'[^']*'|"[^"]*")|(\b(?:from|import|def|class|return|if|else|elif|for|in|with|as|async|await|yield|True|False|None|self|lambda|raise|try|except|finally|pass|break|continue|global|nonlocal|not|and|or)\b)|(\b\d+(?:\.\d+)?\b)|(\b[a-z_][\w]*)(?=\()/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      if (m.index > last) out.push(esc(code.slice(last, m.index)));
      const tok = m[0];
      if (m[1]) out.push('<span class="tok-c">' + esc(tok) + '</span>');
      else if (m[2]) out.push('<span class="tok-s">' + esc(tok) + '</span>');
      else if (m[3]) out.push('<span class="tok-k">' + esc(tok) + '</span>');
      else if (m[4]) out.push('<span class="tok-n">' + esc(tok) + '</span>');
      else if (m[5]) out.push('<span class="tok-f">' + esc(tok) + '</span>');
      last = m.index + tok.length;
    }
    if (last < code.length) out.push(esc(code.slice(last)));
    return out.join('');
  }
  if (lang === 'ts' || lang === 'js') {
    const out: string[] = [];
    const re =
      /(\/\/[^\n]*)|(\/\*[\s\S]*?\*\/)|(`[^`]*`|'[^']*'|"[^"]*")|(\b(?:import|from|export|default|const|let|var|function|class|return|if|else|for|in|of|await|async|new|true|false|null|undefined|interface|type|extends|implements|public|private|protected|readonly|enum|as|void|this|super)\b)|(\b\d+(?:\.\d+)?\b)|(\b[a-z_$][\w$]*)(?=\()/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      if (m.index > last) out.push(esc(code.slice(last, m.index)));
      const tok = m[0];
      if (m[1] || m[2]) out.push('<span class="tok-c">' + esc(tok) + '</span>');
      else if (m[3]) out.push('<span class="tok-s">' + esc(tok) + '</span>');
      else if (m[4]) out.push('<span class="tok-k">' + esc(tok) + '</span>');
      else if (m[5]) out.push('<span class="tok-n">' + esc(tok) + '</span>');
      else if (m[6]) out.push('<span class="tok-f">' + esc(tok) + '</span>');
      last = m.index + tok.length;
    }
    if (last < code.length) out.push(esc(code.slice(last)));
    return out.join('');
  }
  if (lang === 'json') {
    const out: string[] = [];
    const re = /("[^"]*")(\s*:)|("[^"]*")|(\btrue|false|null\b)|(\b\d+(?:\.\d+)?\b)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      if (m.index > last) out.push(esc(code.slice(last, m.index)));
      if (m[1] && m[2]) {
        out.push('<span class="tok-p">' + esc(m[1]) + '</span>' + esc(m[2]));
      } else if (m[3]) {
        out.push('<span class="tok-s">' + esc(m[3]) + '</span>');
      } else if (m[4]) {
        out.push('<span class="tok-k">' + esc(m[4]) + '</span>');
      } else if (m[5]) {
        out.push('<span class="tok-n">' + esc(m[5]) + '</span>');
      }
      last = m.index + m[0].length;
    }
    if (last < code.length) out.push(esc(code.slice(last)));
    return out.join('');
  }
  return esc(code);
}

export function Code({
  lang = 'bash',
  title,
  children,
  showLines = false,
  noHead = false,
  minimal = false,
}: Props) {
  const code = toText(children).replace(/^\n+|\n+$/g, '');
  const html = highlight(code, lang);
  const lines = html.split('\n');
  return (
    <div class="code" style={minimal ? { background: 'transparent', border: 0 } : undefined}>
      {!noHead && (
        <div class="code-head">
          <span>{title || lang}</span>
          <CopyButton text={code} />
        </div>
      )}
      <pre>
        {showLines ? (
          lines.map((l, i) => (
            <div key={i}>
              <span class="ln">{i + 1}</span>
              <span dangerouslySetInnerHTML={{ __html: l || ' ' }} />
            </div>
          ))
        ) : (
          <span dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </pre>
    </div>
  );
}
