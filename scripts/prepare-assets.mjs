import sharp from 'sharp';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
mkdirSync('public',{recursive:true});
const source='C:/Users/Soumil Sawant/.codex/generated_images/01a154ff-c9a6-7b73-8e7f-7977677cd2b1/';
await sharp(source+'exec-d67197b0-e39a-4238-a1a7-0f8cf7c31b7e.png').resize(1800).webp({quality:84}).toFile('assets/hero.webp');
await sharp(source+'exec-39d003dc-728b-45a6-b7fc-f8dd2b72d31f.png').resize(1000).webp({quality:82}).toFile('assets/jazz.webp');
await sharp(source+'exec-1275adc9-120b-4ad8-9f53-cb2cea247966.png').resize(1200).webp({quality:82}).toFile('assets/electronic.webp');
await sharp(source+'exec-da240b05-f633-4315-922e-835b2fc1d8f3.png').resize(1200).webp({quality:82}).toFile('assets/classical.webp');
const geo=JSON.parse(readFileSync('.reference/countries.geojson','utf8'));
const project=([x,y])=>[(x+9)*40,(61-y)*52];
const paths=geo.features.filter(f=>['United Kingdom','Ireland'].includes(f.properties.ADMIN)).map(f=>({
  name:f.properties.ADMIN,
  d:f.geometry.coordinates.map(poly=>poly.map(ring=>ring.map((pt,i)=>{const[x,y]=project(pt);return`${i?'L':'M'}${x.toFixed(1)},${y.toFixed(1)}`;}).join(' ')+' Z').join(' ')).join(' ')
}));
writeFileSync('public/map-data.json',JSON.stringify(paths));
