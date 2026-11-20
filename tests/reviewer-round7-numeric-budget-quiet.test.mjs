// Execute the independent reviewer's exact source and assertion bodies.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
await mkdir('work',{recursive:true});
await writeFile('work/migration-61fea77.sql',await readFile(new URL('./fixtures/private-migration-61fea77.sql',import.meta.url)));
const current=await readFile(new URL('../supabase/migrations/20261101120327_private_whatsapp_chat_memory.sql',import.meta.url));
await writeFile('work/r8-numeric-runtime-pins.json',JSON.stringify({currentMigrationSha256:createHash('sha256').update(current).digest('hex'),originalReviewerLabel:'c5ce31c',labelMeaning:'This iteration loads the current checkout migration, not the old commit.'},null,2));
// The frozen parent comparison predates the dispatch performance extension.
// Load that extension only in the current-checkout phase. Preserve every
// archived test body/assertion; only migration setup differs for the old schema.
const archived=await readFile(new URL('./reviewer-round7-numeric-budget-quiet.source.mjs',import.meta.url),'utf8');
const marker="if(version==='61fea77'&&file.includes('20261101120327'))";
if(archived.split(marker).length!==2)throw Error('Frozen numeric fixture setup drifted');
const executable=archived.replace(marker,"if(version==='61fea77'&&file==='20261120132445_dispatch_privacy_performance.sql')continue;"+marker);
await writeFile('work/r7-numeric-budget-current-dependencies.mjs',executable);
await import(new URL('../work/r7-numeric-budget-current-dependencies.mjs',import.meta.url));
