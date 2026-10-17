// Assembly script (authoring convenience only - the delivered index.html needs
// no build step). It concatenates the engine parts into one script and, when
// the page template exists, inlines CSS + JS into a single dist/index.html.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'src');
const dist = path.join(here, 'dist');

const engineParts = ['engine.part1.js', 'engine.part2.js', 'engine.part3.js', 'engine.part4.js']
  .map((f) => fs.readFileSync(path.join(src, f), 'utf8'));

const engine = engineParts.join('\n');

fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(
  path.join(dist, 'engine.js'),
  engine + '\n\n' +
  'if (typeof globalThis !== "undefined") {\n' +
  '  globalThis.__ENGINE_FACTORY__ = EngineCore;\n' +
  '  globalThis.__BASELINE_FACTORY__ = BaselineEngine;\n' +
  '}\n'
);

const pagePath = path.join(src, 'page.html');
if (fs.existsSync(pagePath)) {
  const css = fs.readFileSync(path.join(src, 'style.css'), 'utf8');
  const ui = ['ui1.js', 'ui2.js', 'ui3.js']
    .map((f) => fs.readFileSync(path.join(src, f), 'utf8'))
    .join('\n');
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) +
    ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  const page = fs.readFileSync(pagePath, 'utf8')
    .replace('<span id="buildTag">dev</span>', () => '<span id="buildTag">' + stamp + '</span>')
    .replace('/*__CSS__*/', () => css)
    .replace('/*__ENGINE__*/', () => engine)
    .replace('/*__UI__*/', () => ui);
  fs.writeFileSync(path.join(dist, 'index.html'), page);
  console.log('built dist/index.html', fs.statSync(path.join(dist, 'index.html')).size, 'bytes');
}
console.log('built dist/engine.js', fs.statSync(path.join(dist, 'engine.js')).size, 'bytes');
