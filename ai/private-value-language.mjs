// Declarative grammar shared by the JS matcher and SQL generation.
export const PRIVATE_DATE_YEAR_PIVOT=69; // 00..69 => 2000..2069; 70..99 => 1970..1999.
export const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
export const monthPattern='(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
export const ordinals='first,second,third,fourth,fifth,sixth,seventh,eighth,ninth,tenth,eleventh,twelfth,thirteenth,fourteenth,fifteenth,sixteenth,seventeenth,eighteenth,nineteenth,twentieth,twenty first,twenty second,twenty third,twenty fourth,twenty fifth,twenty sixth,twenty seventh,twenty eighth,twenty ninth,thirtieth,thirty first'.split(',');
export const units='(?:inr|usd|eur|gbp|aed|sgd|aud|cad|chf|rs|rupees?|dollars?|euros?|pounds?)';
export const small=Object.fromEntries('zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ').map((word,i)=>[word,BigInt(i)]));
for(const [i,word] of ['twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'].entries())small[word]=BigInt((i+2)*10);
export const scales={thousand:1000n,lakh:100000n,lac:100000n,million:1000000n,crore:10000000n,billion:1000000000n};
export const fractions={half:2n,halves:2n,quarter:4n,quarters:4n};
// Private printed evidence keeps a field label separate from its value. This
// grammar applies only to explicitly tagged evidence, not arbitrary names.
export const evidenceLabel='^[a-z_][a-z0-9_ .#%()/-]{0,80}[:=] *';
export const evidenceNumericLabel='^[a-z_][a-z_ .#%()/-]{0,80} +(?=[0-9+−\\p{Sc}-])';
export const evidenceDateLabel='^(?:invoice +date|due(?: +date)?|date)(?![a-z])';
// Shared canonical grammar: SQL is generated from these same expressions.
export const currencyUnitPattern=units.replace('|rs|','|rs\\.?|');
export const namedDayPattern=`(?:[0-9]{1,2}(?:st|nd|rd|th)?|${ordinals.map(day=>day.replaceAll(' ','[ -]+')).join('|')})`;
export const dateSeparator='[ ./-]*';
export const namedYearTail=`(?:[ ,./-]*['’ʼ]? *([0-9]{4}|[0-9]{2}|[0-9]{1,3}))?`;
export const namedDatePatterns=[
 `(?:the +)?(${namedDayPattern})${dateSeparator}(?:of +)?(${monthPattern})${namedYearTail}`,
 `(${monthPattern})${dateSeparator}(?:the +)?(${namedDayPattern})${namedYearTail}`,
];
const financialQuoteHint='(?:invoices?|bills?(?! +gates)|receipts?|[0-9][0-9,.]* *, *due +[0-9])';
export const privateOriginHeader=`(?<![a-z0-9_])(?:(?:here|below|following|attached) +(?:is|are) +(?:(?:the|an?|my|our|this) +)?(?:invoices?|bills?(?! +gates)|receipts?)(?![a-z0-9_])|(?:forwarded|quoted|copied|pasted)(?: +(?:invoice|bill|receipt|message|text))* *[:>](?=.*${financialQuoteHint})|(?:invoice|bill|receipt) *(?=[:,]))`;
export const privateOriginFieldLabel='^(?:due(?: +date)?|invoice +date|bill +to|customer(?: +name)?|client(?: +name)?|amount|total) *(?::|=|is +)? *';
const namedBareDates=[`(?:the +)?${namedDayPattern}${dateSeparator}(?:of +)?${monthPattern}`,`${monthPattern}${dateSeparator}(?:the +)?${namedDayPattern}`];
export const originDateCommaPattern=`(${namedBareDates.join('|')}) *, *(['’ʼ]?[0-9]{4}|['’ʼ]?[0-9]{2})(?![0-9])`;
