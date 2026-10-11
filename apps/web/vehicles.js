const sideCar = c => `<svg viewBox="0 0 64 28"><path d="M6 19c-2 0-3-1-3-3v-2c0-1.5 1-2.5 2.5-3l8-1.5 7-5.5c1.5-1 3-1.5 5-1.5h12c2 0 3.5.6 5 2l5 5 7 1c2 .3 3.5 1.8 3.5 4v2.5c0 1.6-1.2 2.5-3 2.5" fill="${c}" stroke="rgba(0,0,0,.25)" stroke-width="1"/><path d="M22 6.5 16.5 10h13V5.5H26c-1.5 0-2.8.3-4 1zM32 5.5V10h13l-4-3.5c-.8-.7-1.8-1-3-1z" fill="#7fb2e6" opacity=".9"/><circle cx="16" cy="20" r="5" fill="#2c2c2e"/><circle cx="16" cy="20" r="2.2" fill="#aeaeb2"/><circle cx="49" cy="20" r="5" fill="#2c2c2e"/><circle cx="49" cy="20" r="2.2" fill="#aeaeb2"/></svg>`;

const sideTruck = (c, len) => {
  const body = 8 + len * 14, cabX = body + 2, w = cabX + 16;
  return `<svg viewBox="0 0 ${w} 28"><rect x="2" y="${len === 3 ? 2 : 5}" width="${body}" height="${len === 3 ? 16 : 13}" rx="2" fill="${c}" stroke="rgba(0,0,0,.25)"/>
    <path d="M${cabX} 8h8l5 5v5c0 .6-.4 1-1 1H${cabX}z" fill="${c}" stroke="rgba(0,0,0,.25)"/><path d="M${cabX + 2} 10h5l3 3h-8z" fill="#7fb2e6"/>
    <rect x="2" y="18" width="${w - 4}" height="2" fill="#636366"/>
    <circle cx="${8 + (len > 1 ? 0 : 2)}" cy="21" r="4.5" fill="#2c2c2e"/><circle cx="${8 + (len > 1 ? 0 : 2)}" cy="21" r="2" fill="#aeaeb2"/>
    ${len > 1 ? `<circle cx="18" cy="21" r="4.5" fill="#2c2c2e"/><circle cx="18" cy="21" r="2" fill="#aeaeb2"/>` : ''}
    <circle cx="${cabX + 8}" cy="21" r="4.5" fill="#2c2c2e"/><circle cx="${cabX + 8}" cy="21" r="2" fill="#aeaeb2"/></svg>`;
};

const topCar = c => `<svg class="car-ic" viewBox="0 0 22 40"><rect x="1.5" y="1.5" width="19" height="37" rx="7" fill="${c}" stroke="rgba(0,0,0,.3)"/><path d="M4.5 11.5c4-2 9-2 13 0l-1.2 6H5.7z" fill="#3a4a5c"/><path d="M5.5 29h11l1 4c-4 1.5-9 1.5-13 0z" fill="#3a4a5c"/><rect x="5.5" y="18" width="11" height="10" rx="2" fill="${c}" opacity=".85"/></svg>`;
const topTruck = c => `<svg class="car-ic" viewBox="0 0 22 40" style="height:46px"><rect x="2" y="1.5" width="18" height="11" rx="4" fill="${c}" stroke="rgba(0,0,0,.3)"/><path d="M4.5 5c4-1.5 9-1.5 13 0l-.8 4H5.3z" fill="#3a4a5c"/><rect x="1" y="13.5" width="20" height="25" rx="2" fill="#f2f2f7" stroke="rgba(0,0,0,.35)"/><path d="M4 18h14M4 23h14M4 28h14M4 33h14" stroke="rgba(0,0,0,.12)"/></svg>`;

const sideWalker = c => `<svg viewBox="0 0 64 28"><circle cx="30" cy="4.5" r="3.5" fill="#f2c9a0"/><rect x="33" y="9" width="9" height="10" rx="2" fill="${c}" stroke="rgba(0,0,0,.25)"/><path d="M27 9h6v10h-6z" fill="#3a4a5c"/><path d="M28 19l-3 8M32 19l3 8" stroke="#3a4a5c" stroke-width="2.6" stroke-linecap="round"/><path d="M27 11l-4 5" stroke="#3a4a5c" stroke-width="2.2" stroke-linecap="round"/></svg>`;
const sideBike = c => `<svg viewBox="0 0 64 28"><circle cx="18" cy="20" r="6.5" fill="none" stroke="#2c2c2e" stroke-width="2.4"/><circle cx="46" cy="20" r="6.5" fill="none" stroke="#2c2c2e" stroke-width="2.4"/><path d="M18 20l8-11h12l8 11M26 9l6 11h6" fill="none" stroke="${c}" stroke-width="2.6" stroke-linejoin="round"/><circle cx="31" cy="3.5" r="3" fill="#f2c9a0"/><rect x="33" y="5" width="8" height="7" rx="1.5" fill="${c}" stroke="rgba(0,0,0,.25)"/></svg>`;
const topCourier = c => `<svg class="car-ic" viewBox="0 0 30 30" style="width:28px;height:28px"><circle cx="15" cy="15" r="13" fill="${c}" stroke="#fff" stroke-width="2.5"/><path d="M10 12h10l-1 8h-8z" fill="#fff"/><path d="M12.5 12a2.5 2.5 0 0 1 5 0" fill="none" stroke="#fff" stroke-width="1.6"/></svg>`;

const TARIFFS = [
  { id:'eco', group:'taxi', color:'#c8553d', nm:'Эконом', icon:() => sideCar('#c8553d') },
  { id:'comfort', group:'taxi', color:'#e5e5ea', nm:'Комфорт', icon:() => sideCar('#e5e5ea') },
  { id:'business', group:'taxi', color:'#1c1c1e', nm:'Бизнес', icon:() => sideCar('#1c1c1e') },
  { id:'cargo_s', group:'cargo', color:'#ff9f0a', nm:'Каблук', spec:'до 500 кг · 3 м³', icon:() => sideTruck('#ff9f0a', 1) },
  { id:'cargo_m', group:'cargo', color:'#ff9f0a', nm:'Газель', spec:'до 1.5 т · 9 м³', icon:() => sideTruck('#ff9f0a', 2) },
  { id:'cargo_l', group:'cargo', color:'#ff9f0a', nm:'Грузовик', spec:'до 3 т · 20 м³', icon:() => sideTruck('#ff9f0a', 3) },
  { id:'intercity', group:'intercity', color:'#5e5ce6', nm:'Вся машина', spec:'до 4 пассажиров', icon:() => sideCar('#5e5ce6') },
  { id:'courier_foot', group:'courier', color:'#30a46c', nm:'Пешком', spec:'до 5 кг · рядом', icon:() => sideWalker('#30a46c') },
  { id:'courier_bike', group:'courier', color:'#30a46c', nm:'Велокурьер', spec:'до 10 кг · до 5 км', icon:() => sideBike('#30a46c') },
  { id:'courier_car', group:'courier', color:'#30a46c', nm:'На авто', spec:'до 30 кг · по городу', icon:() => sideCar('#30a46c') },
];
const tariffOf = id => TARIFFS.find(t => t.id === id) || TARIFFS[0];
const mapIcon = id => {
  const t = tariffOf(id);
  if (t.group === 'cargo') return topTruck(t.color);
  if (t.id === 'courier_foot' || t.id === 'courier_bike') return topCourier(t.color);
  return topCar(t.color);
};
