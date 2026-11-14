/**
 * Minimal syntax highlighter for the handbook reader.
 *
 * Why hand-rolled: the reader must stay a pure React element tree (never an HTML
 * string), and the plugin is bundled into a single file by esbuild. A general
 * highlighter would add roughly a megabyte for eight languages we actually use.
 *
 * Contract: `highlight(code, lang)` returns `[{ text, kind }]`. Concatenating the
 * `text` of every segment MUST reproduce the input byte for byte. Callers render
 * the segments as <span class="hs-tok-<kind>">, so nothing here can inject markup.
 * Unknown languages return a single `plain` segment.
 */

// Longest match first: block comments and quoted strings must win over operators.
const COMMON_C = [
  { kind: 'comment', re: /^\/\*[\s\S]*?(?:\*\/|$)/ },
  { kind: 'comment', re: /^\/\/[^\n]*/ },
  { kind: 'string', re: /^`(?:\\[\s\S]|[^`\\])*`?/ },
  { kind: 'string', re: /^"(?:\\[\s\S]|[^"\\\n])*"?/ },
  { kind: 'string', re: /^'(?:\\[\s\S]|[^'\\\n])*'?/ },
  { kind: 'number', re: /^(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/ },
  { kind: 'keyword', re: /^(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|get|if|import|in|instanceof|let|new|of|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield)\b/ },
  { kind: 'constant', re: /^(?:true|false|null|undefined|NaN|Infinity)\b/ },
  { kind: 'function', re: /^[A-Za-z_$][\w$]*(?=\s*\()/ },
  { kind: 'property', re: /^[A-Za-z_$][\w$]*(?=\s*:)/ },
  { kind: 'word', re: /^[A-Za-z_$][\w$]*/ },
  { kind: 'punct', re: /^[^\sA-Za-z_$\d]/ },
];

const BASH = [
  { kind: 'comment', re: /^#[^\n]*/ },
  { kind: 'string', re: /^"(?:\\[\s\S]|[^"\\])*"?/ },
  { kind: 'string', re: /^'[^']*'?/ },
  { kind: 'keyword', re: /^(?:if|then|else|elif|fi|for|in|do|done|while|until|case|esac|function|return|exit|local|export|source|shift|set|unset)\b/ },
  { kind: 'variable', re: /^\$\{[^}]*\}?/ },
  { kind: 'variable', re: /^\$[\w@*#?$!-]+/ },
  { kind: 'operator', re: /^(?:&&|\|\||[|&;<>])/ },
  { kind: 'number', re: /^\d+(?:\.\d+)?\b/ },
  { kind: 'flag', re: /^(?<=\s)--?[A-Za-z][\w-]*/ },
  { kind: 'word', re: /^[A-Za-z_][\w-]*/ },
  { kind: 'punct', re: /^[^\s\w]/ },
];

const CSS_RULES = [
  { kind: 'comment', re: /^\/\*[\s\S]*?(?:\*\/|$)/ },
  { kind: 'string', re: /^"(?:\\[\s\S]|[^"\\\n])*"?/ },
  { kind: 'string', re: /^'(?:\\[\s\S]|[^'\\\n])*'?/ },
  { kind: 'selector', re: /^[.#][\w-]+/ },
  { kind: 'variable', re: /^--[\w-]+/ },
  { kind: 'atrule', re: /^@[\w-]+/ },
  { kind: 'number', re: /^-?(?:\d*\.\d+|\d+)(?:px|rem|em|%|vh|vw|vmin|vmax|s|ms|deg|fr|pt|ch)?\b/ },
  { kind: 'property', re: /^[a-zA-Z-]+(?=\s*:)/ },
  { kind: 'constant', re: /^[a-zA-Z-]+(?=[;)])/ },
  { kind: 'word', re: /^[A-Za-z_][\w-]*/ },
  { kind: 'punct', re: /^[^\s\w]/ },
];

const MARKDOWN = [
  { kind: 'comment', re: /^<!--[\s\S]*?(?:-->|$)/ },
  { kind: 'string', re: /^`[^`\n]*`?/ },
  { kind: 'keyword', re: /^#{1,6}[ \t][^\n]*/ },
  { kind: 'bold', re: /^\*\*[^*\n]+\*\*/ },
  { kind: 'bold', re: /^__[^_\n]+__/ },
  { kind: 'italic', re: /^\*[^*\n]+\*/ },
  { kind: 'link', re: /^\[[^\]\n]*\]\([^)\n]*\)/ },
  { kind: 'bullet', re: /^(?:[-*+]|\d+\.)(?=\s)/ },
  { kind: 'quote', re: /^>[^\n]*/ },
  { kind: 'word', re: /^[^\s`*_[\]()#>]+/ },
  { kind: 'punct', re: /^./ },
];

const ALIASES = {
  js: 'js', javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'js', typescript: 'js', tsx: 'js',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash', powershell: 'bash', ps1: 'bash',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', xml: 'html', svg: 'html', vue: 'html',
  markdown: 'markdown', md: 'markdown',
  python: 'python', py: 'python', py3: 'python',
};

const PLAIN = [{ kind: 'plain', re: /^[\s\S]+/ }];

/** Resolve a fence info string (`js title=foo`) to a rule set key. */
export function highlightLanguage(lang) {
  const name = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
  if (!name) return '';
  const mapped = ALIASES[name];
  if (mapped) return mapped;
  // html is tokenized with the C rules plus tag handling in `tokenizeHtml`.
  return name === 'html' ? 'html' : '';
}

const PYTHON = [
  { kind: 'comment', re: /^#[^\n]*/ },
  { kind: 'string', re: /^[rbfuRBFU]{0,2}"""[\s\S]*?(?:"""|$)/ },
  { kind: 'string', re: /^[rbfuRBFU]{0,2}'''[\s\S]*?(?:'''|$)/ },
  { kind: 'string', re: /^[rbfuRBFU]{0,2}"(?:\\[\s\S]|[^"\\\n])*"?/ },
  { kind: 'string', re: /^[rbfuRBFU]{0,2}'(?:\\[\s\S]|[^'\\\n])*'?/ },
  { kind: 'number', re: /^(?:0[xX][\da-fA-F]+|0[bB][01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?j?)\b/ },
  { kind: 'keyword', re: /^(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/ },
  { kind: 'constant', re: /^(?:True|False|None|NotImplemented|Ellipsis)\b/ },
  { kind: 'constant', re: /^(?:self|cls)\b/ },
  { kind: 'function', re: /^[A-Za-z_]\w*(?=\s*\()/ },
  { kind: 'property', re: /^[A-Za-z_]\w*(?=\s*=)/ },
  { kind: 'atrule', re: /^@[A-Za-z_][\w.]*/ },
  { kind: 'word', re: /^[A-Za-z_]\w*/ },
  { kind: 'punct', re: /^[^\sA-Za-z_\d]/ },
];

const RULES = { js: COMMON_C, bash: BASH, css: CSS_RULES, markdown: MARKDOWN, python: PYTHON };

// Tags need their own pass because attributes repeat; reuse COMMON_C inside them.
const HTML_TAG = /^<\/?[A-Za-z][\w:-]*(?:\s[^>]*)?\/?>/;
const HTML_ATTR = /^[A-Za-z_:][-\w:.]*(?=\s*=)/;

function tokenizeHtml(code) {
  const out = [];
  let rest = code;
  while (rest.length) {
    const tag = rest.match(HTML_TAG);
    if (tag) {
      // Split a tag into name / attribute names / delimiters, preserving text.
      const text = tag[0];
      let inner = text;
      while (inner.length) {
        const open = inner.match(/^<\/?[A-Za-z][\w:-]*/);
        if (open) { out.push({ text: open[0], kind: 'tag' }); inner = inner.slice(open[0].length); continue }
        const attr = inner.match(HTML_ATTR);
        if (attr) { out.push({ text: attr[0], kind: 'property' }); inner = inner.slice(attr[0].length); continue }
        const value = inner.match(/^"[^"]*"?|^'[^']*'?/);
        if (value) { out.push({ text: value[0], kind: 'string' }); inner = inner.slice(value[0].length); continue }
        const ch = inner[0];
        out.push({ text: ch, kind: 'punct' });
        inner = inner.slice(1);
      }
      rest = rest.slice(text.length);
      continue;
    }
    const comment = rest.match(/^<!--[\s\S]*?(?:-->|$)/);
    if (comment) { out.push({ text: comment[0], kind: 'comment' }); rest = rest.slice(comment[0].length); continue }
    // Text between tags stays plain so entities are never decoded.
    const text = rest.match(/^[^<]+/);
    const chunk = text ? text[0] : rest[0];
    out.push({ text: chunk, kind: text ? 'plain' : 'punct' });
    rest = rest.slice(chunk.length);
  }
  return out;
}

function tokenizeWith(rules) {
  return function tokenize(code) {
    const out = [];
    let rest = code;
    while (rest.length) {
      let matched = false;
      for (const rule of rules) {
        const m = rest.match(rule.re);
        if (!m || !m[0].length) continue;
        out.push({ text: m[0], kind: rule.kind });
        rest = rest.slice(m[0].length);
        matched = true;
        break;
      }
      if (!matched) {
        // A rule set must never swallow text silently: emit one char as plain.
        out.push({ text: rest[0], kind: 'plain' });
        rest = rest.slice(1);
      }
    }
    return out;
  };
}

const TOKENIZERS = {
  js: tokenizeWith(COMMON_C),
  bash: tokenizeWith(BASH),
  css: tokenizeWith(CSS_RULES),
  markdown: tokenizeWith(MARKDOWN),
  python: tokenizeWith(PYTHON),
  html: tokenizeHtml,
};

/**
 * Split code into segments. Unsupported languages return one `plain` segment so
 * the caller renders exactly what the fence contained.
 */
export function highlight(code, lang) {
  const text = String(code ?? '');
  if (!text) return [];
  const key = highlightLanguage(lang);
  const tokenize = key ? TOKENIZERS[key] : null;
  if (!tokenize) return [{ text, kind: 'plain' }];
  return tokenize(text);
}

/** Concatenated segment text; used by tests to prove highlighting is lossless. */
export function highlightedText(segments) {
  return (segments || []).map(segment => segment.text).join('');
}
