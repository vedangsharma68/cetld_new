import {numericSelectionWords,numericCollectiveWords,numericQuantifiers,numericDistributionWords,numericCollectionPredicates,numericGrammarTags} from './private-value-language.mjs';
// Cardinality is attached to a source span, never inferred from its digits.
// Both scanning and durable projection consume this role; SQL renders the
// same closed operators and pinned lexical categories.
export function privateNumberRole(text,start,end){
 const prefix=text.slice(0,start).split(/[;.!?\n]/u).at(-1),suffix=text.slice(end).split(/[;.!?\n]/u)[0];
 const left=prefix.match(/[\p{L}\p{M}]+/gu)||[],right=suffix.match(/[\p{L}\p{M}]+/gu)||[];
 if(['is','was'].includes(right[0]))return 'scalar';
 if(['are','were'].includes(right[0]))return 'collection';
 if(right.some(w=>numericDistributionWords.includes(w))||left.some(w=>[...numericSelectionWords,...numericCollectiveWords,...numericQuantifiers,...numericDistributionWords].includes(w)))return 'collection';
 let finite=-1;for(let i=0;i<left.length;i++)if((/^(?:VB|VBD|VBP|VBZ|MD)(?:\||$)/.test(numericGrammarTags[left[i]]||'')||/(?:^|\|)(?:VBD|VBP|VBZ)(?:\||$)/.test(numericGrammarTags[left[i]]||'')&&/^(?:NN|NNS|NNP|NNPS|PRP)(?:\||$)/.test(numericGrammarTags[left[i-1]]||'')))finite=i;
 const spine=finite>=0&&!numericCollectionPredicates.includes(left[finite])?left.slice(finite+1):left;
 const relation=spine.findIndex(w=>/^(?:IN|TO)(?:\||$)/.test(numericGrammarTags[w]||''));
 const phrase=relation>=0?spine.slice(0,relation):spine;
 return phrase.some(w=>/^(?:NNS|NNPS)(?:\||$)/.test(numericGrammarTags[w]||''))?'collection':'scalar';
}
