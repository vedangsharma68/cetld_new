// Execute the independent reviewer's exact source and assertion bodies.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
await mkdir('work',{recursive:true});
await import('./reviewer-round7-native-prose.source.mjs');
