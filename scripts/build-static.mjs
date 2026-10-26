import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output=path.join(root,'dist');
if(path.dirname(output)!==root||path.basename(output)!=='dist')throw new Error('Refusing to replace an unexpected output directory.');
rmSync(output,{recursive:true,force:true});
mkdirSync(path.join(output,'assets'),{recursive:true});

const copy=(source,destination)=>cpSync(path.join(root,source),path.join(output,destination));
copy('static-launch/index.html','index.html');
copy('static-launch/app.js','app.js');
copy('static-launch/launch.css','launch.css');
copy('styles.css','styles.css');
copy('public/fonts.css','fonts.css');
copy('public/map-data.json','map-data.json');
for(const name of ['hero.webp','jazz.webp','diwali-pahat-2026.webp','mirari-logo-transparent.png'])copy(`assets/${name}`,`assets/${name}`);

const source=JSON.parse(readFileSync(path.join(root,'content/diwali-pahat-london-2026.json'),'utf8'));
const event={...source,status:'published',externalBookingEnabled:true,tiers:[]};
if(event.externalBookingUrl!=='https://buytickets.at/mirarievents/2495970')throw new Error('Unexpected Ticket Tailor destination.');
if(event.startAt!=='2026-11-08T11:00:00.000Z'||event.endAt!=='2026-11-08T15:00:00.000Z')throw new Error('Unexpected event schedule.');
writeFileSync(path.join(output,'event-data.json'),`${JSON.stringify([event],null,2)}\n`);

writeFileSync(path.join(output,'_redirects'),'/event/* /index.html 200\n/events /index.html 200\n/admin /404.html 404\n/admin/* /404.html 404\n/my-tickets /404.html 404\n/order/* /404.html 404\n/checkout/* /404.html 404\n');
writeFileSync(path.join(output,'_headers'),`/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests\n\n/assets/*\n  Cache-Control: public, max-age=604800\n`);
writeFileSync(path.join(output,'robots.txt'),'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /my-tickets\nDisallow: /order/\nSitemap: https://mirari.events/sitemap.xml\n');
writeFileSync(path.join(output,'sitemap.xml'),'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://mirari.events/</loc></url><url><loc>https://mirari.events/events</loc></url><url><loc>https://mirari.events/event/diwali-pahat-london-2026</loc></url></urlset>\n');
writeFileSync(path.join(output,'404.html'),readFileSync(path.join(root,'static-launch/index.html'),'utf8').replace('<meta name="robots" content="index,follow">','<meta name="robots" content="noindex,follow">').replace('<title>Mirari · Where Culture Comes Alive</title>','<title>Page not found · Mirari</title>'));

if(!existsSync(path.join(output,'index.html')))throw new Error('Static build did not create index.html.');
process.stdout.write(`Static Mirari site built at ${output}\n`);
