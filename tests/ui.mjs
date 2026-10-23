// Manual browser smoke test: node tests/ui.mjs. Uses an isolated demo database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';

const dir=mkdtempSync(path.join(tmpdir(),'mirari-ui-'));
const port=24000+Math.floor(Math.random()*10000),origin=`http://127.0.0.1:${port}`;
const password=randomUUID(),email='ui-test@mirari.local';
const server=spawn(process.execPath,['server.js'],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',APP_URL:origin,DATABASE_PATH:path.join(dir,'ui.sqlite'),DEMO_MODE:'true',NODE_ENV:'test',ADMIN_EMAIL:email,ADMIN_PASSWORD:password,STRIPE_SECRET_KEY:'',STRIPE_WEBHOOK_SECRET:'',RESEND_API_KEY:''},stdio:'pipe'});
let logs='';server.stdout.on('data',data=>logs+=data);server.stderr.on('data',data=>logs+=data);
let browser;
try{
  let ready=false;
  for(let i=0;i<100;i++){try{const res=await fetch(`${origin}/api/health`);if(res.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(ready,logs);
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const events=await(await fetch(`${origin}/api/events`)).json();assert.ok(events.length);
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    const page=await browser.newPage({viewport,reducedMotion:'reduce'});const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin);await page.locator('.hero h1').waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true,`Home overflows at ${viewport.width}`);
    assert.equal(await page.locator('.atlas-intro').evaluate(el=>getComputedStyle(el).opacity),'1',`Reduced-motion content hidden at ${viewport.width}`);
    const motionPage=await browser.newPage({viewport});await motionPage.goto(origin);await motionPage.locator('.event-card').first().scrollIntoViewIfNeeded();await motionPage.locator('.event-card.visible').first().waitFor();await motionPage.close();
    if(viewport.width<760){await page.locator('#menu-button').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#menu-button').getAttribute('aria-expanded'),'true');await page.keyboard.press('Escape');assert.equal(await page.locator('#menu-button').getAttribute('aria-expanded'),'false');}
    await page.locator('[data-city="Manchester"]').first().click();await page.locator('#atlas-panel').getByText('Manchester').first().waitFor();
    await page.goto(`${origin}/event/${events[0].id}`);await page.locator('#booking-form').waitFor();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true,`Event overflows at ${viewport.width}`);
    await page.locator('#booking-form select').first().selectOption('1');
    await page.locator('[name=customerName]').fill('UI Test Guest');
    await page.locator('[name=email]').fill(`ui-${viewport.width}@example.com`);
    await page.locator('[name=terms]').check();
    await page.locator('#booking-form button[type=submit]').click();
    await page.locator('#demo-pay').waitFor();await page.locator('#demo-pay').click();
    await page.locator('.order-status').getByText('paid').waitFor();
    const code=await page.locator('.ticket-code').first().textContent();assert.ok(code);
    assert.equal(await page.locator('.ticket-code-block strong').first().textContent(),'Ticket code');
    await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});
    await page.locator('.copy-code').first().click();
    await page.locator('.copy-feedback').first().getByText('Ticket code copied.').waitFor();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),code);
    await page.emulateMedia({media:'print'});
    assert.equal(await page.locator('.copy-code').first().evaluate(el=>getComputedStyle(el).display),'none');
    assert.equal(await page.locator('.ticket-code').first().isVisible(),true);
    await page.emulateMedia({media:'screen',reducedMotion:'reduce'});
    await page.goto(`${origin}/admin`);await page.locator('#admin-login').waitFor();
    await page.locator('#admin-login [name=email]').fill(email);
    await page.locator('#admin-login [name=password]').fill(password);
    await page.locator('#admin-login button[type=submit]').click();
    await page.locator('[data-tab="Orders"]').waitFor();
    await page.locator('[data-tab="Orders"]').click();await page.locator('#admin-content').getByText('UI Test Guest').first().waitFor();
    await page.locator('[data-tab="Check-in"]').click();await page.locator('#scan-form [name=token]').waitFor();
    assert.equal(await page.locator('#scan-event option').count()>1,true,`Check-in events missing at ${viewport.width}`);
    await page.locator('[data-tab="Alerts"]').click();await page.locator('#admin-content h2').getByText('Needs attention').waitFor();
    assert.deepEqual(errors,[],`Browser errors at ${viewport.width}`);
    await page.close();
  }
  console.log('Desktop and mobile customer booking + organiser journeys passed. Demo made no charges or email sends.');
}finally{
  await browser?.close();server.kill();await new Promise(resolve=>server.once('exit',resolve));
  rmSync(dir,{recursive:true,force:true});
}
