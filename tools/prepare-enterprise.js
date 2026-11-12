// Exports the current menu for a future Gemini Enterprise agent: docs/enterprise/menu-source.md (document to
// connect as the agent's source), menu.csv (review table), menu-snapshot.json and menu-review.json (changes since
// the last export). Nothing is uploaded: the Enterprise connection is still pending organizer access.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadMenu} from '../lib/menu-data.js';
import {budgetPriceSen,ROLE_LABELS,BASE_LABELS,spiceLabel} from '../public/shared/filters.js';
const root=new URL('../',import.meta.url);
const menu=loadMenu({dataDir:fileURLToPath(new URL('data/',root)),publicDir:fileURLToPath(new URL('public/',root))});
const dir=new URL('docs/enterprise/',root);mkdirSync(dir,{recursive:true});
const snapshot=menu.dishes.map(d=>({id:d.id,name:d.name,cuisine:d.cuisine,role:d.role,base:d.base??null,price:d.price,priceMax:d.priceMax??d.price,
  budgetPriceRm:budgetPriceSen(d)==null?null:budgetPriceSen(d)/100,priceText:d.priceText,priceEstimated:!!d.priceEstimated,priceCondition:d.priceCondition??null,
  vegetarian:d.vegetarian,vegan:d.vegan===true,spicy:d.spicy,allergens:d.allergens,available:d.available,days:d.days,availableAfter:d.availableAfter??null,
  includes:d.includes??[],origin:d.origin??'menu-board',description:d.blurb||d.description}));
const previousURL=new URL('menu-snapshot.json',dir);
const previous=existsSync(previousURL)?JSON.parse(readFileSync(previousURL)):[];
const old=new Map(previous.map(d=>[d.id,d]));const current=new Set(snapshot.map(d=>d.id));
const added=snapshot.filter(d=>!old.has(d.id));const changed=snapshot.filter(d=>old.has(d.id)&&JSON.stringify(old.get(d.id))!==JSON.stringify(d));const removed=previous.filter(d=>!current.has(d.id));
const csvCell=v=>'"'+String(v??'').replaceAll('"','""')+'"';
const headers=Object.keys(snapshot[0]);
writeFileSync(new URL('menu.csv',dir),[headers.join(','),...snapshot.map(d=>headers.map(k=>csvCell(Array.isArray(d[k])?d[k].join(';'):d[k])).join(','))].join('\n'));
const updated=`Menu data compiled ${menu.meta.sourceCompiledOn ?? 'unknown'}; imported ${menu.meta.generatedAt}.`;
const text=`# APEats menu source

${updated} Generated from photos of the campus menu boards. All listed outlets serve halal food (checked in person by the team).
Descriptions, spice and allergens are estimates of the usual recipe, not vendor certification. "Vegan confirmed: false" means
unconfirmed, not proof of animal ingredients. Role says whether an item is a main dish, side, drink, dessert or add-on; only
main dishes count as a lunch. Budget price is the highest shown price; "none" means the price is estimated or missing and
must not be used under a budget.

`+snapshot.map(d=>`## ${d.name}
ID: ${d.id}
Counter: ${d.cuisine}
Role: ${ROLE_LABELS[d.role]}${d.base?` (${BASE_LABELS[d.base]})`:''}
Price: ${d.priceText} (${d.priceEstimated?'estimate':'menu board'})${d.priceCondition?` - ${d.priceCondition}`:''}
Budget price: ${d.budgetPriceRm==null?'none':`RM${d.budgetPriceRm.toFixed(2)}`}
Vegetarian: ${d.vegetarian}
Vegan confirmed: ${d.vegan}
Spice (estimate): ${spiceLabel(d)}
Likely allergens (estimate): ${d.allergens==null?'unknown':(d.allergens.join(', ')||'none in the estimate; verify')}
Days: ${(d.days??[]).join(', ')||'no day restriction recorded'}${d.availableAfter?`\nPrinted menu: available after ${d.availableAfter}`:''}
Availability: ${d.available===true?'on the menu':d.available===false?'marked not available':'not confirmed'}
${d.includes.length?`Comes with (menu board): ${d.includes.join(', ')}\n`:''}Description: ${d.description}
`).join('\n');
writeFileSync(new URL('menu-source.md',dir),text);
writeFileSync(previousURL,JSON.stringify(snapshot,null,2));
const report={generatedAt:new Date().toISOString(),sourceGeneratedAt:menu.meta.generatedAt,sourceCompiledOn:menu.meta.sourceCompiledOn,visibleItems:snapshot.length,
  byRole:Object.fromEntries(Object.keys(ROLE_LABELS).map(r=>[r,snapshot.filter(d=>d.role===r).length])),unconfirmedVegan:snapshot.filter(d=>!d.vegan).length,
  estimatedPrices:snapshot.filter(d=>d.priceEstimated).length,missingDiet:snapshot.filter(d=>d.vegetarian==null).length,
  added:added.map(d=>d.id),changed:changed.map(d=>d.id),removed:removed.map(d=>d.id),sha256:createHash('sha256').update(text).digest('hex'),enterpriseUploaded:false};
writeFileSync(new URL('menu-review.json',dir),JSON.stringify(report,null,2));
console.log(`Prepared ${snapshot.length} menu entries; ${added.length} added, ${changed.length} changed, ${removed.length} removed since the last export. Files in docs/enterprise. Nothing uploaded.`);
