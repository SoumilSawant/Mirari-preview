export function seed(store) {
  if (store.get('SELECT 1 FROM events')) return;
  const cities = [
    ['London',51.5074,-0.1278,'Aurora Fields','Live music','The Lantern Hall','South Bank, London','hero.webp'],
    ['Manchester',53.4808,-2.2426,'After Hours','Electronic','The Foundry','Northern Quarter, Manchester','electronic.webp'],
    ['Birmingham',52.4862,-1.8904,'The Velvet Sessions','Jazz & soul','The Velvet Room','Jewellery Quarter, Birmingham','jazz.webp'],
    ['Bristol',51.4545,-2.5879,'Under the Same Sky','Live music','Harbour Stage','Harbourside, Bristol','hero.webp'],
    ['Edinburgh',55.9533,-3.1883,'An Evening in Gold','Classical','The Assembly Room','Old Town, Edinburgh','classical.webp'],
    ['London',51.5074,-0.1278,'The Philharmonic Sessions','Classical','The Lantern Hall','South Bank, London','classical.webp']
  ];
  const base = new Date(); base.setUTCDate(base.getUTCDate()+35); base.setUTCHours(19,30,0,0);
  cities.forEach(([city,lat,lng,title,category,venue,address,image],i) => {
    const start = new Date(+base+i*7*86400000);
    store.saveEvent({id:`demo-${i+1}`,title,city,lat,lng,category,venue,address,image:`/assets/${image}`,demo:true,status:'published', startAt:start.toISOString(),doorsAt:new Date(+start-3600000).toISOString(),
      description:'An intimate evening of live performance, shared with the people who make it unforgettable. Discover the atmosphere, the artistry and the moment when the room comes alive. This is a demonstration event for exploring the Mirari booking experience; no real admission is sold.',
      lineup:'Demonstration programme — artists to be confirmed.',
      age:'Demo: ages 18+. Photo ID required.',accessibility:'Demo venue information. Contact the organiser before booking to discuss step-free access, accessible seating and companion tickets.',
      policy:'Demo bookings only. No money is taken and these tickets do not grant entry to a real event.',
      tiers:[{id:`demo-${i+1}-ga`,name:'General admission',price:3500+i*500,capacity:120},{id:`demo-${i+1}-vip`,name:'Premium admission',price:6500+i*500,capacity:30}]},'demo-seed');
  });
  for (const key of ['refunds','privacy','cookies','accessibility','terms','contact']) store.setSetting(`policy.${key}`, '');
}
