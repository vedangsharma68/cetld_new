import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
import lexicon from 'wink-lexicon/src/lexicon.js';import {privateLexicalEntries,privateLexicalTags,privateNumericGrammarTags} from '../ai/private-runtime-lexicon.mjs';
test('compact runtime retains every pinned lexical row and complete ordered POS readings',()=>{
 const packed=new Map(privateLexicalEntries());assert.equal(packed.size,Object.keys(lexicon).length);
 for(const [word,tags] of Object.entries(lexicon))assert.deepEqual(privateLexicalTags(word),tags,word);
 const primary=/^(?:NN|NNS|NNP|NNPS|PRP|PRP\$|DT|VB|VBD|VBP|VBZ|VBG|VBN|MD|IN|TO|CD|RB|RBR|RBS|UH|EX|JJ|JJR|JJS)$/;
 const expected=Object.fromEntries(Object.entries(lexicon).filter(([w,t])=>/^[a-z]+$/.test(w)&&primary.test(t[0])).map(([w,t])=>[w,t.join('|')]));assert.deepEqual(JSON.parse(JSON.stringify(privateNumericGrammarTags)),expected);
});
test('compact lexical model and reference frames reproduce from their full build-time inventories',()=>{
 for(const file of ['generate-private-runtime-lexicon.mjs','generate-private-reference-frames.mjs'])assert.doesNotThrow(()=>execFileSync(process.execPath,['scripts/'+file,'--check'],{stdio:'pipe'}));
});
