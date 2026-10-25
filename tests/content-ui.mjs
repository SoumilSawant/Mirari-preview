// Manual browser check of approved content using an isolated, charge-free database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Store } from '../lib/store.js';

const root=path.dirname(fileURLToPath(import.meta.url));
const project=path.dirname(root);
const dir=mkdtempSync(path.join(tmpdir(),'mirari-content-ui-'));
const filename=path.join(dir,'content.sqlite');
const manifest=JSON.parse(readFileSync(path.join(project,'content/diwali-pahat-london-2026.json'),'utf8'));
const store=new Store(filename,{mode:'stripe-test'});
store.saveEvent(manifest,'content-ui');store.db.close();
const port=24000+Math.floor(Math.random()*10000),origin=`http://127.0.0.1:${port}`;
const adminEmail='content-ui@mirari.local',adminPassword=randomUUID();
const server=spawn(process.execPath,['server.js'],{cwd:project,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',APP_URL:origin,DATABASE_PATH:filename,APP_MODE:'stripe-test',DEMO_MODE:'false',NODE_ENV:'test',ADMIN_EMAIL:adminEmail,ADMIN_PASSWORD:adminPassword,STRIPE_SECRET_KEY:'sk_test_content_ui_fake',STRIPE_WEBHOOK_SECRET:'whsec_content_ui_fake',RESEND_API_KEY:''},stdio:'pipe'});
let logs='';server.stdout.on('data',data=>logs+=data);server.stderr.on('data',data=>logs+=data);
let browser;
try{
  let ready=false;
  for(let i=0;i<100;i++){try{if((await fetch(`${origin}/api/health`)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(ready,logs);
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const screenshots=path.join(project,'output/screenshots');mkdirSync(screenshots,{recursive:true});
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    const page=await browser.newPage({viewport,reducedMotion:'reduce'}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin);await page.locator('.hero h1').waitFor();
    assert.match(await page.locator('#demo-notice').textContent(),/STRIPE TEST MODE/);
    assert.match(await page.locator('.hero h1').textContent(),/Experience culture.*Feel the connection/s);
    assert.equal(await page.locator('.experience-card').count(),5);
    await page.locator('.about-img').scrollIntoViewIfNeeded();
    await page.locator('.about-img').evaluate(img=>img.decode());
    await page.evaluate(()=>window.scrollTo(0,0));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true);
    await page.screenshot({path:path.join(screenshots,`mirari-content-${viewport.width}-home.png`),fullPage:true});
    await page.goto(`${origin}/event/${manifest.id}`);await page.locator('.event-poster img').waitFor();
    assert.equal(await page.locator('.event-poster img').evaluate(img=>img.complete&&img.naturalWidth>0),true);
    assert.equal(await page.locator('#booking-form').isVisible(),false);
    assert.match(await page.locator('.booking-panel').textContent(),/Tickets are coming soon/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true);
    await page.screenshot({path:path.join(screenshots,`mirari-content-${viewport.width}-event.png`),fullPage:true});
    await page.goto(`${origin}/admin`);await page.locator('#admin-login').waitFor();
    await page.locator('#admin-login [name=email]').fill(adminEmail);
    await page.locator('#admin-login [name=password]').fill(adminPassword);
    await page.locator('#admin-login button[type=submit]').click();
    await page.locator('[data-tab="Events"]').click();
    await page.locator('.admin-row').getByText(manifest.title).waitFor();
    await page.locator('.admin-row [data-edit]').click();
    assert.equal(await page.locator('#event-editor [name=status]').inputValue(),'announced');
    assert.equal(await page.locator('#event-editor [name=imageFit]').inputValue(),'contain');
    assert.equal(await page.locator('.tier-editor').count(),0);
    assert.deepEqual(errors,[]);
    await page.close();
  }
  console.log('Mirari content and unpriced announcement passed at 1440px and 390px; no checkout was available.');
}finally{
  await browser?.close();server.kill();await new Promise(resolve=>server.once('exit',resolve));
  rmSync(dir,{recursive:true,force:true});
}
