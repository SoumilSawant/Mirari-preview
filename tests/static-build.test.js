import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root=process.cwd();
const output=path.join(root,'dist');
const walk=directory=>readdirSync(directory).flatMap(name=>{const file=path.join(directory,name);return statSync(file).isDirectory()?walk(file):[file];});

test('static launch build contains only customer files and the approved event',()=>{
  execFileSync(process.execPath,['scripts/build-static.mjs'],{cwd:root});
  const files=walk(output).map(file=>path.relative(output,file).replaceAll('\\','/')).sort();
  assert.ok(files.includes('index.html'));
  assert.ok(files.includes('404.html'));
  assert.ok(files.includes('_headers'));
  assert.ok(!files.includes('_redirects'));
  assert.equal(files.some(file=>/(^|\/)(server|admin)(\.|\/)|\.sqlite|\.env|backup|tests?\//i.test(file)),false,files.join('\n'));
  const customerFiles=['index.html','404.html','app.js','event-data.json','styles.css','launch.css'];
  const customerText=customerFiles.map(file=>readFileSync(path.join(output,file),'utf8')).join('\n');
  for(const forbidden of ['/api/','localhost','127.0.0.1','sk_test','sk_live','RESEND_API_KEY','/admin','/my-tickets','/order/'])assert.equal(customerText.includes(forbidden),false,`Unexpected ${forbidden}`);
  const data=JSON.parse(readFileSync(path.join(output,'event-data.json'),'utf8'));
  assert.deepEqual(data.map(event=>event.id),['diwali-pahat-london-2026']);
  assert.equal(data[0].externalBookingUrl,'https://buytickets.at/mirarievents/2495970');
  assert.equal(data[0].externalBookingEnabled,true);
});
