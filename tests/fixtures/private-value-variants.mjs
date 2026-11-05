// Shared by serialized-boundary and real-SQL/handler integration suites.
export const normalizedPrivateVariants=[
  ['send 1 250 today','1 250','1250'],
  ['send 1.250,00 today','1.250,00','1250'],
  ["send 1'250 today","1'250",'1250'],
  ['is it due 31.10.2026?','31.10.2026','2026-10-31'],
  ['is it due on the thirty first of October?','thirty first of October','2026-10-31'],
  ['is it due 10/31/2026?','10/31/2026','2026-10-31'],
  ['send 1\u200b250 today','1\u200b250','1250'],
  ['send 1\u200d2\ufeff50 today','1\u200d2\ufeff50','1250'],
  ['send 1\u00a0250,00 today','1\u00a0250,00','1250'],
  ['send 1’250.00 today','1’250.00','1250'],
  ['send 1.250 today','1.250','1250'],
  ['is it due October thirty-first, 2026?','October thirty-first, 2026','2026-10-31'],
  ['is it due 2026.10.31?','2026.10.31','2026-10-31'],
  ['ask anu\u200brag today','anu\u200brag','anurag'],
];
export const normalizedOrdinaryControls=[
  'is it due next Friday?', 'send 1,2500 today', 'send 12500 today',
  'send 1 2500 today', 'send 250 today', 'send 1 today', 'send 999 today',
  'top up 100', 'we are 100 people coming',
];
