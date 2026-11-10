import createTagger from 'wink-pos-tagger';
import lexicon from 'wink-lexicon';

// A pinned, local POS model supplies grammatical categories across vocabulary
// and modifiers. No text leaves the process, and no per-message lexicon or
// transcript cache is retained. Entity identity still comes from the registry.
const tagger=createTagger();
export const privateLanguageTags=word=>Object.hasOwn(lexicon.lexicon,word.toLowerCase())?lexicon.lexicon[word.toLowerCase()]:[];
export function privateLanguageSyntax(text) {
  if(!/[a-z]/i.test(text))return [];
  let cursor=0;
  return tagger.tagSentence(text).flatMap(token=>{
    const index=text.indexOf(token.value,cursor);if(index<0)return [];
    cursor=index+token.value.length;
    const word=token.value.toLowerCase(),known=Object.hasOwn(lexicon.lexicon,word);
    return [{word:token.value,pos:token.pos,alternatives:known?lexicon.lexicon[word]:[token.pos],known,start:index,end:cursor}];
  });
}
