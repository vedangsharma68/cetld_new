import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Hash the actual browser import graph, including transitive .mjs dependencies.
export async function buildFrontend(root=process.cwd()) {
  const files=new Map();
  async function visit(name) {
    name=path.posix.normalize(name);
    if(name.startsWith('../')||files.has(name))return;
    const source=await readFile(path.join(root,name),'utf8');files.set(name,source);
    for(const match of source.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) {
      await visit(path.posix.join(path.posix.dirname(name),match[1]));
    }
  }
  for(const file of ['app.js','styles.css','LatticeLoader.css'])await visit(file);
  const html=await readFile(path.join(root,'app/index.html'),'utf8');
  const clean=html.replace(/(<meta name="app-version" content=")[^"]+/, '$1development').replace(/\?v=[a-f0-9]{64}/g,'');
  const hash=createHash('sha256').update(process.env.VERCEL_GIT_COMMIT_SHA||'').update('\0').update(clean);
  for(const [name,source] of [...files].sort(([a],[b])=>a.localeCompare(b)))hash.update(name).update('\0').update(source).update('\0');
  const version=hash.digest('hex');
  const stamped=clean.replace('name="app-version" content="development"',`name="app-version" content="${version}"`).replace(/(\/(?:app\.js|styles\.css|LatticeLoader\.css))"/g,`$1?v=${version}"`);
  await writeFile(path.join(root,'app/index.html'),stamped);
  await writeFile(path.join(root,'app-version.json'),JSON.stringify({version})+'\n');
  return version;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await buildFrontend();
