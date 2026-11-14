// Execute the independent reviewer's exact source and assertion bodies.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
await mkdir('work',{recursive:true});
await writeFile('work/migration-61fea77.sql',await readFile(new URL('./fixtures/private-migration-61fea77.sql',import.meta.url)));
const current=await readFile(new URL('../supabase/migrations/20261101120327_private_whatsapp_chat_memory.sql',import.meta.url));
await writeFile('work/r8-numeric-runtime-pins.json',JSON.stringify({currentMigrationSha256:createHash('sha256').update(current).digest('hex'),originalReviewerLabel:'c5ce31c',labelMeaning:'This iteration loads the current checkout migration, not the old commit.'},null,2));
await import('./reviewer-round7-numeric-budget-quiet.source.mjs');
