import {numericSelectionWords,numericSelectionRelations,numericCollectiveWords,numericQuantifiers,numericDistributionWords,numericCollectionPredicates,numericGrammarTags,numericPredicativeRelations,numericCollectiveHeads,numericOrderingHeads,numericDestinationPredicates,grammarAuxiliaries,privateNumeralSpanPattern,privateOriginMonetaryBefore,privateOriginDateBefore} from './private-value-language.mjs';
// Cardinality is evidence about an operand, not a property of a lexical verb.
// SQL renders the same valency, nominal attachment and predicate precedence.
const tags=w=>numericGrammarTags[w]||'';
function predicate(words,i,finite=false){
 let j=i-1;while(j>=0&&/^(?:RB|RBR|RBS)(?:\||$)/.test(tags(words[j])))j--;
 if(j>=0&&/^(?:DT|PRP\$|JJ|JJR|JJS)(?:\||$)/.test(tags(words[j])))return false;
 return /^(?:VB|VBD|VBP|VBZ)(?:\||$)/.test(tags(words[i]))||/(?:^|\|)(?:VB|VBD|VBP|VBZ|VBG|VBN)(?:\||$)/.test(tags(words[i]))&&(j<0&&!finite&&/(?:^|\|)(?:VB|VBD|VBG|VBN)(?:\||$)/.test(tags(words[i]))||/^(?:PRP|NNP|NNS|MD|TO|UH)(?:\||$)/.test(tags(words[j]))||/(?:^|\|)UH(?:\||$)/.test(tags(words[j]))||grammarAuxiliaries.includes(words[j]));
}
function numberSyntax(text,start,end){
 const prefix=text.slice(0,start).split(/[;.!?\n]/u).at(-1),suffix=text.slice(end).split(/[;.!?\n]/u)[0];
 const left=prefix.match(/[\p{L}\p{M}]+|[0-9]+/gu)||[],right=suffix.match(/[\p{L}\p{M}]+|[0-9]+/gu)||[];
 const prepositional=/^(?:IN|TO)(?:\||$)/.test(tags(right[0]));
 const label=/[:=—] *[([ ]*$/.test(prefix);
 let finite=-1;for(let i=0;i<left.length;i++){
  const requiredComplement=i===0&&prepositional&&numericDestinationPredicates.includes(left[i])&&predicate(left,i);
  if((predicate(left,i,true)||requiredComplement||/^(?:MD)(?:\||$)/.test(tags(left[i])))&&!(i===0&&!prepositional&&numericCollectiveHeads.includes(left[i])))finite=i;
 }
 const spine=!label&&finite>=0&&!numericCollectionPredicates.includes(left[finite])?left.slice(finite+1):left;
 const relation=spine.findIndex(w=>/^(?:IN|TO)(?:\||$)/.test(tags(w)));
 const phrase=relation>=0?spine.slice(0,relation):spine;
 let nominalHead='';
 if(prepositional)for(const w of right.slice(1)){
  if(numericCollectiveHeads.includes(w)||numericOrderingHeads.includes(w)){nominalHead=w;continue;}
  if(/(?:^|\|)(?:DT|RB|RBR|RBS)(?:\||$)/.test(tags(w))||/^(?:JJ|JJR|JJS|VBG|VBN)(?:\||$)/.test(tags(w)))continue;
  if(/^(?:NN|NNS|NNP|NNPS)(?:\||$)/.test(tags(w))){nominalHead=w;continue;}
  if(/^(?:IN|TO|CC|VB|VBD|VBP|VBZ|MD)(?:\||$)/.test(tags(w)))break;
 }
 // Required-PP valency binds a destination to the scalar object. An ordering
 // relation instead describes separate elements, independently of preposition.
 const ordering=numericOrderingHeads.includes(nominalHead);
 const destination=prepositional&&right[0]!=='as'&&finite>=0&&numericDestinationPredicates.includes(left[finite])&&!ordering;
 return {prefix,left,right,phrase,nominalHead,ordering,destination};
}
// Numeric noun labels and destination arguments are data forms, not an
// unresolved edit imperative. Parsed financial corrections still take priority.
export function ordinaryNumericForm(message){
 const text=String(message||'').normalize('NFKC').toLowerCase(),span=new RegExp(privateNumeralSpanPattern,'gu').exec(text);
 if(!span)return false;
 const context=numberSyntax(text,span.index,span.index+span[0].length);
 return context.destination||/[:=—] *[([ ]*$/.test(context.prefix)&&context.left.some(w=>numericCollectiveHeads.includes(w)||numericCollectiveWords.includes(w));
}
export function privateNumberRole(text,start,end){
 const {prefix,left,right,phrase,nominalHead,ordering,destination}=numberSyntax(text,start,end);
 if(new RegExp(privateOriginMonetaryBefore,'u').test(prefix))return 'scalar';
 if(['is','was'].includes(right[0]))return 'scalar';
 if(['are','were'].includes(right[0]))return 'collection';
 const plural=words=>words.some(w=>/^(?:NNS|NNPS)(?:\||$)/.test(tags(w)));
 const countedComplement=plural(right)&&right.some(w=>/^[0-9]+$/.test(w)||/^(?:CD)(?:\||$)/.test(tags(w))||numericQuantifiers.includes(w));
 if(!destination&&(countedComplement||numericCollectiveHeads.includes(nominalHead)||ordering))return 'collection';
 const partitive=left.at(-1)==='of'&&(/^(?:CD|DT)(?:\||$)/.test(tags(left.at(-2)))||/^[0-9]+$/.test(left.at(-2)||'')||numericCollectiveHeads.includes(left.at(-2)));
 const predicative=!destination&&plural(right)&&(numericPredicativeRelations.includes(right[0])||/^(?:VB|VBP)(?:\||$)/.test(tags(right[0])));
 if(partitive||predicative)return 'collection';
 const operation=(words,i)=>numericSelectionRelations.includes(words[i])||numericSelectionWords.includes(words[i])&&!numericDestinationPredicates.includes(words[i])&&predicate(words,i);
 if(right.some((w,i)=>operation(right,i)||numericDistributionWords.includes(w))||left.some((w,i)=>operation(left,i))||phrase.some(w=>[...numericCollectiveWords,...numericQuantifiers,...numericDistributionWords].includes(w)))return 'collection';
 // An explicit collection predicate outranks a merely singular result noun.
 if(numericPredicativeRelations.includes(right[0])&&right.some(w=>/^(?:NN|NNP)(?:\||$)/.test(tags(w))))return 'scalar';
 return plural(phrase)?'collection':'unknown';
}

// An ambiguous collection keeps calendar and member interpretations.
export function privateCalendarExclusive(text,start,end){return !(/^[0-9]+ *[./-] *[0-9]+$/u.test(text.slice(start,end).trim())&&!new RegExp(privateOriginDateBefore,'u').test(text.slice(0,start))&&privateNumberRole(text,start,end)==='collection');}
