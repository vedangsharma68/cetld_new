import {numericSelectionWords,numericCollectiveWords,numericQuantifiers,numericDistributionWords,numericCollectionPredicates,numericGrammarTags,numericPredicativeRelations,numericCollectiveHeads,privateOriginMonetaryBefore} from './private-value-language.mjs';
// Cardinality is attached to a source span, never inferred from its digits.
// Both scanning and durable projection consume this role; SQL renders the
// same closed operators and pinned lexical categories.
export function privateNumberRole(text,start,end){
 const prefix=text.slice(0,start).split(/[;.!?\n]/u).at(-1),suffix=text.slice(end).split(/[;.!?\n]/u)[0];
 const left=prefix.match(/[\p{L}\p{M}]+|[0-9]+/gu)||[],right=suffix.match(/[\p{L}\p{M}]+|[0-9]+/gu)||[];
 if(new RegExp(privateOriginMonetaryBefore,'u').test(prefix))return 'scalar';
 if(['is','was'].includes(right[0]))return 'scalar';
 if(['are','were'].includes(right[0]))return 'collection';
 const plural=words=>words.some(w=>/^(?:NNS|NNPS)(?:\||$)/.test(numericGrammarTags[w]||''));
 const partitive=left.at(-1)==='of'&&(/^(?:CD|DT)(?:\||$)/.test(numericGrammarTags[left.at(-2)]||'')||/^[0-9]+$/.test(left.at(-2)||'')||numericCollectiveHeads.includes(left.at(-2)));
 const predicative=plural(right)&&(numericPredicativeRelations.includes(right[0])||/^(?:VB|VBP)(?:\||$)/.test(numericGrammarTags[right[0]]||''));
 if(partitive||predicative)return 'collection';
 if(numericPredicativeRelations.includes(right[0])&&right.some(w=>/^(?:NN|NNP)(?:\||$)/.test(numericGrammarTags[w]||'')))return 'scalar';
 if(right.some(w=>numericSelectionWords.includes(w)||numericDistributionWords.includes(w))||left.some(w=>[...numericSelectionWords,...numericCollectiveWords,...numericQuantifiers,...numericDistributionWords].includes(w)))return 'collection';
 let finite=-1;for(let i=0;i<left.length;i++)if((/^(?:VB|VBD|VBP|VBZ|MD)(?:\||$)/.test(numericGrammarTags[left[i]]||'')||/(?:^|\|)(?:VBD|VBP|VBZ)(?:\||$)/.test(numericGrammarTags[left[i]]||'')&&/^(?:NN|NNS|NNP|NNPS|PRP)(?:\||$)/.test(numericGrammarTags[left[i-1]]||'')))finite=i;
 const spine=finite>=0&&!numericCollectionPredicates.includes(left[finite])?left.slice(finite+1):left;
 const relation=spine.findIndex(w=>/^(?:IN|TO)(?:\||$)/.test(numericGrammarTags[w]||''));
 const phrase=relation>=0?spine.slice(0,relation):spine;
 return phrase.some(w=>/^(?:NNS|NNPS)(?:\||$)/.test(numericGrammarTags[w]||''))?'collection':'unknown';
}
