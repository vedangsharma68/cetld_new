// Preserve the full pinned POS vocabulary in compact searchable text. The
// matcher needs membership and named-entity categories, not WordNet senses or
// lemmas as mutable JavaScript object graphs.
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import words from 'wink-lexicon/src/wn-words.js';
import senses from 'wink-lexicon/src/wn-word-senses.js';
import adjective from 'wink-lexicon/src/wn-adjective-exceptions.js';
import noun from 'wink-lexicon/src/wn-noun-exceptions.js';
import verb from 'wink-lexicon/src/wn-verb-exceptions.js';
const pack=items=>JSON.stringify([...new Set(items)].sort().join('\n'));
const data={words:pack(Object.keys(words)),zeroWords:pack(Object.entries(words).filter(([,index])=>!index).map(([word])=>word)),names:pack(Object.entries(words).filter(([,index])=>index&&senses[index][0]===15).map(([word])=>word)),exceptions:pack([...Object.keys(adjective),...Object.keys(noun),...Object.keys(verb)])};
data.collections=pack(Object.entries(words).filter(([,index])=>index&&(senses[index].includes(14)||senses[index].includes(4)&&senses[index].includes(9))).map(([word])=>word).filter(word=>/^[a-z]+$/.test(word)));
const artifact='// Generated from wink-lexicon@2.2.0 (MIT; see docs/private-language-model-LICENSE.txt); vocabulary is complete.\n'+Object.entries(data).map(([key,value])=>'export const '+key+'='+value+';').join('\n')+'\n';
const target=new URL('../ai/private-language-model.mjs',import.meta.url);
if(process.argv.includes('--check')){if(await readFile(target,'utf8')!==artifact)throw Error('Private language model requires regeneration');}
else await writeFile(target,artifact);
console.log(JSON.stringify({words:Object.keys(words).length,sha256:createHash('sha256').update(artifact).digest('hex')}));
