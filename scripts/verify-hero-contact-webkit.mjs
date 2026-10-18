import {verifyHeroContact} from './verify-hero-contact.mjs';

// Start WebKitWebDriver on :9515, serve the worktree on :8765, then pass
// the MiniBrowser binary. This uses the same checks as the Playwright runner.
const binary = process.argv[2];
if (!binary) throw Error('Usage: node scripts/verify-hero-contact-webkit.mjs /path/to/MiniBrowser');
const origin = 'http://127.0.0.1:9515';
async function command(path, body) {
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const {value} = await response.json();
  if (value?.error) throw Error(JSON.stringify(value));
  return value;
}
const session = await command('/session', {capabilities: {alwaysMatch: {
  'webkitgtk:browserOptions': {args: ['--automation'], binary},
}}});
console.log('WebKitGTK', session.capabilities.browserVersion);
const prefix = '/session/' + session.sessionId;
let viewportWidth;
const page = {
  async goto(url) {
    await command(prefix + '/frame', {id: null});
    await command(prefix + '/url', {url});
    // GTK's toolbar enforces a ~447px minimum window width. An iframe gives
    // the page an exact 390px CSS viewport without scaling native controls.
    await command(prefix + '/execute/sync', {
      script: `document.body.innerHTML = '<iframe id="verification-viewport" src="/" style="border:0;width:${viewportWidth}px;height:900px"></iframe>';`, args: [],
    });
    const frame = await command(prefix + '/element', {using: 'css selector', value: '#verification-viewport'});
    await command(prefix + '/frame', {id: frame});
    await command(prefix + '/execute/async', {
      script: 'const done=arguments[0];if(document.readyState === "complete")done();else addEventListener("load",()=>done(),{once:true});', args: [],
    });
  },
  async evaluate(fn) {
    const value = await command(prefix + '/execute/async', {
      script: `const done=arguments[arguments.length-1]; Promise.resolve((${fn.toString()})()).then(result=>done({result}),error=>done({error:String(error)}));`, args: [],
    });
    if (value.error) throw Error(value.error);
    return value.result;
  },
};
try {
  await command(prefix + '/timeouts', {script: 30000, pageLoad: 30000});
  for (const width of [390, 768, 1440]) {
    viewportWidth = width;
    await command(prefix + '/window/rect', {width: Math.max(600, width + 50), height: 1000});
    await verifyHeroContact(page, 'WebKitGTK ' + width);
  }
} finally {
  await fetch(origin + prefix, {method: 'DELETE'});
}
