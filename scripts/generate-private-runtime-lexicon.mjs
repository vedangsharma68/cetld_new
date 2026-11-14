// Full pinned POS vocabulary in sorted text; no runtime lexicon object graph.
import lexicon from 'wink-lexicon/src/lexicon.js';import {readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const rows=Object.entries(lexicon);if(rows.some(([w,t])=>/[\n\t]/.test(w)||t.some(x=>/[\n\t|]/.test(x))))throw Error('Invalid lexical row');
const ascii=rows.filter(([w])=>/^[\x00-\x7f]*$/.test(w)),unicode=rows.filter(([w])=>!/^[\x00-\x7f]*$/.test(w));
const packed=a=>a.sort(([a],[b])=>a<b?-1:a>b?1:0).map(([w,t])=>w+'\t'+t.join('|')).join('\n');
const alpha=rows.filter(([w])=>/^[a-z]+$/.test(w)),pick=tags=>alpha.filter(([,t])=>t.some(x=>tags.includes(x))).map(([w])=>w);
const data={asciiPOS:packed(ascii),unicodePOS:packed(unicode),determiners:pick(['DT','PRP$']),adverbs:pick(['RB','RBR','RBS']),closedGrammar:pick(['DT','PRP','PRP$','MD','IN','CC','TO']),coordinators:pick(['CC'])};
const source=await readFile(new URL('../node_modules/wink-lexicon/src/lexicon.js',import.meta.url));
const out='// Generated from the complete wink-lexicon POS inventory (MIT); see docs/private-language-model-LICENSE.txt.\n// Source SHA-256 '+createHash('sha256').update(source).digest('hex')+'\n'+Object.entries(data).map(([k,v])=>'export const '+k+'='+JSON.stringify(v)+';').join('\n')+'\n';
const file=new URL('../ai/private-runtime-lexicon-data.mjs',import.meta.url);if(process.argv.includes('--check')){if(await readFile(file,'utf8')!==out)throw Error('Runtime lexical model drift');}else await writeFile(file,out);
