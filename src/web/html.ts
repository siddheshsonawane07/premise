// Tiny HTML helpers: every value that reaches a page goes through `esc`.

export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Tagged template: interpolated values are escaped unless wrapped in `raw`. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    out += Array.isArray(v) ? v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('') : v instanceof Raw ? v.s : esc(v);
    out += strings[i + 1] ?? '';
  });
  return new Raw(out);
}

export class Raw {
  constructor(public readonly s: string) {}
  toString(): string { return this.s; }
}

export const raw = (s: string) => new Raw(s);

export function page(opts: { title: string; who: string; active: string; body: Raw; refresh?: number; script?: string }): string {
  // Impact (the graph algorithms) stays at /impact but is left out of the menu.
  const nav = [['/', 'Home'], ['/rules', 'Rules'], ['/guesses', 'Guesses'], ['/tasks', 'Tasks'], ['/why', 'Why']] as const;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.refresh ? raw(`<meta http-equiv="refresh" content="${Number(opts.refresh)}">`) : ''}
<title>${opts.title} · Premise</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<header class="top">
  <a class="brand" href="/">Premise</a>
  <nav>${nav.map(([href, label]) => html`<a href="${href}" class="${opts.active === href ? 'on' : ''}">${label}</a>`)}</nav>
  <span class="who">Viewing as ${opts.who}</span>
</header>
<main>${opts.body}</main>
<footer>Synthetic data: the companies and people are invented. Rule figures are public and cited. Premise supports evidence; it certifies nothing and is not legal or compliance advice.</footer>
${opts.script ? raw(opts.script) : ''}
</body>
</html>`.s;
}
