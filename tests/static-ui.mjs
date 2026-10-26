import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root=path.resolve('dist');
const screenshots=path.resolve('output','static-launch');
mkdirSync(screenshots,{recursive:true});
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webp':'image/webp','.png':'image/png','.txt':'text/plain; charset=utf-8','.xml':'application/xml'};
const protectedRoute=pathname=>pathname==='/admin'||pathname.startsWith('/admin/')||pathname==='/my-tickets'||pathname.startsWith('/order/')||pathname.startsWith('/checkout/');
const appRoute=pathname=>pathname==='/'||pathname==='/events'||pathname.startsWith('/event/');
const server=createServer((request,response)=>{
  const pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);
  let relative=pathname.slice(1)||'index.html',status=200;
  if(protectedRoute(pathname)||(!appRoute(pathname)&&!path.extname(relative))){relative='404.html';status=404;}
  else if(appRoute(pathname)&&pathname!=='/'){relative='index.html';}
  const file=path.resolve(root,relative);
  if(!file.startsWith(root+path.sep)&&file!==path.join(root,'index.html')){response.writeHead(404);response.end();return;}
  try{if(!statSync(file).isFile())throw new Error();response.writeHead(status,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});response.end(readFileSync(file));}
  catch{response.writeHead(404,{'Content-Type':'text/html; charset=utf-8'});response.end(readFileSync(path.join(root,'404.html')));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    const page=await browser.newPage({viewport,reducedMotion:'reduce'});
    const failures=[];const requests=[];
    page.on('pageerror',error=>failures.push(error.message));
    page.on('requestfailed',request=>failures.push(`${request.url()} ${request.failure()?.errorText}`));
    page.on('request',request=>requests.push(request.url()));
    await page.goto(origin,{waitUntil:'networkidle'});
    await page.getByRole('heading',{name:/Experience culture/i}).waitFor();
    assert.equal(await page.locator('.event-card').count(),1);
    assert.equal(await page.locator('.brand').evaluate(brand=>{const header=brand.closest('header').getBoundingClientRect(),logo=brand.getBoundingClientRect();return logo.top>=header.top&&logo.bottom<=header.bottom;}),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true);
    assert.equal(await page.locator('text=Stripe Test Mode').count(),0);
    assert.equal(await page.locator('a[href="/my-tickets"]').count(),0);
    await page.screenshot({path:path.join(screenshots,`home-${viewport.width}.png`),fullPage:true});
    await page.goto(`${origin}/event/diwali-pahat-london-2026`,{waitUntil:'networkidle'});
    await page.getByRole('heading',{name:'Diwali Pahat London 2026'}).waitFor();
    const booking=page.getByRole('link',{name:/Book tickets/}).last();
    assert.equal(await booking.getAttribute('href'),'https://buytickets.at/mirarievents/2495970');
    assert.equal(await booking.getAttribute('target'),null);
    assert.match(await page.locator('.facts').innerText(),/11:00–15:00 · GMT/);
    assert.equal(await page.locator('.event-poster img').evaluate(image=>image.getBoundingClientRect().height>image.getBoundingClientRect().width),true);
    await page.screenshot({path:path.join(screenshots,`event-${viewport.width}.png`),fullPage:true});
    assert.equal(requests.some(url=>url.includes('/api/')),false);
    assert.deepEqual(failures,[]);
    await page.close();
  }
  const blocked=await browser.newPage();
  const response=await blocked.goto(`${origin}/admin`);
  assert.equal(response.status(),404);
  await blocked.getByRole('heading',{name:'Page not found.'}).waitFor();
  await blocked.close();
  console.log('Static Mirari UI passed at 1440px and 390px with direct routing, reduced motion and no backend requests.');
}finally{
  await browser?.close();
  await new Promise(resolve=>server.close(resolve));
}
