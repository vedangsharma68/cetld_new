import {readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url),bytes=await readFile(new URL('data/private-language/ko-josa.txt',root)),meta=JSON.parse(await readFile(new URL('data/private-language/ko-josa-source.json',root),'utf8'));
if(bytes.length!==meta.sourceBytes||createHash('sha256').update(bytes).digest('hex')!==meta.sourceSha256)throw Error('Korean morphology source pin mismatch');
const words=bytes.toString().trim().split('\n');if(words.length!==meta.entries||words.some(w=>!/^[\p{L}\p{M}]+$/u.test(w)))throw Error('Invalid Korean particle inventory');
const artifact='// Generated from Open Korean Text '+meta.commit+' (Apache-2.0).\n// Source attribution/pins: data/private-language/ko-josa-source.json.\n// License: docs/private-ko-morphology-LICENSE.txt.\nexport const koParticles='+JSON.stringify([...new Set(words)].sort())+';\n',target=new URL('ai/private-name-morphology.mjs',root);
if(process.argv.includes('--check')){if(await readFile(target,'utf8')!==artifact)throw Error('Private name morphology needs regeneration');}else await writeFile(target,artifact);
