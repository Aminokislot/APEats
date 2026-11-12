import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('HTTP validation, recommendations, static boundaries and persistent votes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'apeats-http-')); const port=18083;
 const child=spawn(process.execPath,['server.js'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:String(port),AI_PROVIDER:'offline',VOTES_FILE:join(dir,'votes.json'),VOTE_STORAGE:'local',GEMINI_API_KEY:''},stdio:['ignore','pipe','pipe']});
 const base=`http://localhost:${port}`;
 try {
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server startup timeout')),10000);child.stdout.on('data',x=>{if(String(x).includes('APEats running')){clearTimeout(timer);resolve();}});child.on('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code));});});
  const get=p=>fetch(base+p);const post=(p,b)=>fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
  const status=await(await get('/api/status')).json();assert.equal(status.provider,'offline');
  const menu=await(await get('/api/menu')).json();assert.equal(menu.stalls.length,7);
  const result=await(await post('/api/ask',{message:'У меня аллергия на глютен, хочу неострый обед до 10 ринггит',prefs:null,history:[null]})).json();
  for(const id of result.dishIds){const d=menu.dishes.find(x=>x.id===id);assert(d.price<=10);assert(d.spicy<=1);assert(!d.allergens.includes('wheat/gluten'));}
  assert.match(result.reply,/подтверд/);
  assert.equal((await post('/api/ask',null)).status,400);
  assert.equal((await fetch(base+'/api/ask',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})).status,415);
  assert.equal((await fetch(base+'/api/poll/rate',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://other.invalid'},body:'{}'})).status,403);
  const stall=menu.stalls[0].id;
  assert.equal((await post('/api/poll/rate',{voter:'audit-user',stallId:stall,stars:4})).status,200);
  assert.equal((await post('/api/poll/rate',{voter:'audit-user',stallId:stall,stars:6})).status,400);
  const poll=await(await get('/api/poll?voter=audit-user')).json();assert.equal(poll.mine.ratings[stall],4);
  assert.equal((await get('/%2e%2e%2f.env')).status,403);
  assert.equal((await get('/app.js')).headers.get('cache-control'),'no-cache');

  // 12. Items without an illustration are served (placeholder in the page) and can be found by name.
  const noPhoto=menu.dishes.filter(d=>!d.photo);
  assert(noPhoto.length>0);
  assert(menu.dishes.some(d=>d.id==='chinese--n1' && !d.photo && d.name.toLowerCase().includes('kuey teow')));
  assert(menu.meta.lunch.presets.length>0,'budget buttons come from menu prices');

  // Find my lunch over HTTP, with saved preferences (14: preferences keep working).
  const lunch=await(await post('/api/lunch',{budget:12,spice:'not-spicy',withDrink:true,prefs:{diet:'vegetarian',avoidAllergens:['peanuts','milk']}})).json();
  assert.equal(lunch.source,'offline');
  for(const o of lunch.options){
   assert(o.totalSen<=1200);
   assert.equal(o.totalSen,o.items.reduce((s,i)=>s+i.priceSen,0));
   for(const i of o.items){const d=menu.dishes.find(x=>x.id===i.dishId);assert.equal(d.vegetarian,true);assert(d.spicy<=1);assert(!d.allergens.some(a=>['peanuts','milk'].includes(a)));assert(!d.priceEstimated);}
   assert.equal(menu.dishes.find(x=>x.id===o.items[0].dishId).role,'main');
  }
  assert.equal((await post('/api/lunch',{budget:'lots'})).status,400);
  assert.equal((await post('/api/lunch',{budget:500})).status,400);
  const swap=await(await post('/api/lunch',{budget:12,withDrink:false,mode:'swap',limit:1,exclude:lunch.options.map(o=>o.items[0].dishId)})).json();
  assert(swap.options.length<=1 && swap.options.every(o=>!lunch.options.some(x=>x.items[0].dishId===o.items[0].dishId)));
  // Questions about one dish are answered about that dish.
  const about=await(await post('/api/ask',{message:'What is this?',dishId:'chinese--n1',prefs:{}})).json();
  assert.deepEqual(about.dishIds,['chinese--n1']);
  assert.match(about.reply,/Cantonese Kuey Teow Meehoon/);
 } finally {child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));rmSync(dir,{recursive:true,force:true});}
});
