import test from 'node:test';
import assert from 'node:assert/strict';
import {offlineRecommend,recommend} from '../lib/recommend.js';
import {constraintsFor} from '../lib/constraints.js';
import {parseEnterpriseResponse,enterpriseEndpoint,askEnterprise} from '../lib/enterprise.js';
const base={category:'Rice',available:true,days:null,spicy:0,price:8,priceText:'RM8.00',allergens:[],vegetarian:true,stallId:'s'};
const dishes=[{...base,id:'egg',name:'Egg rice',allergens:['egg']},{...base,id:'wheat',name:'Roti',allergens:['wheat/gluten','milk']},{...base,id:'vegan',name:'Verified vegan rice',vegan:true},{...base,id:'chicken',name:'Chicken',vegetarian:false,price:12,priceText:'RM12.00'},{...base,id:'hot',name:'Hot rice',spicy:5},{...base,id:'unknown',name:'Unknown',spicy:null,vegetarian:null,allergens:null},{...base,id:'later',name:'Monday only',days:['Monday']},{...base,id:'sold',name:'Sold out',available:false},{...base,id:'range',name:'Range',price:8,priceText:'RM8–12'},{...base,id:'estimate',name:'Estimated',priceEstimated:true}];
const args=(message,prefs={})=>({message,prefs,dishes,stalls:[{id:'s',name:'Stall'}],clock:{weekday:6},history:[],ratings:{}});
test('gluten exclusion in English and Russian applies to fallback',()=>{for(const q of ['I am allergic to gluten, lunch RM10','У меня аллергия на глютен, обед до 10 ринггит']){const r=offlineRecommend(args(q));assert(!r.dishIds.includes('wheat'));assert(!r.dishIds.includes('unknown'));assert.match(r.reply,/confirm|подтверд/);}});
test('vegan requires affirmative data, not just vegetarian',()=>{assert.deepEqual(offlineRecommend(args('I am vegan, RM10')).dishIds,['vegan']);});
test('unconfirmed vegan menu fails closed',()=>{const a=args('vegan');a.dishes=dishes.filter(d=>!d.vegan);assert.deepEqual(offlineRecommend(a).dishIds,[]);});
test('Russian non-spicy and English variants exclude spicy and unknown',()=>{for(const q of ['неострый обед','не острый обед','без острого','not spicy','nothing spicy','non-spicy']){const c=constraintsFor(q,{});assert.equal(c.spice,'not-spicy');const r=offlineRecommend(args(q));assert(!r.dishIds.includes('hot'));assert(!r.dishIds.includes('unknown'));}});
test('upper bound of a price range and estimated price cannot pass hard budget',()=>{const a=args('RM10');a.dishes=dishes.filter(d=>['range','estimate','chicken'].includes(d.id));assert.deepEqual(offlineRecommend(a).dishIds,[]);});
test('saved restrictions and conversation allergies are retained',()=>{const a=args('under RM10',{diet:'vegetarian'});a.history=[{role:'user',text:'I am allergic to gluten'}];const c=constraintsFor(a.message,a.prefs,a.history);assert.deepEqual(c.avoidAllergens,['wheat/gluten']);assert.equal(c.diet,'vegetarian');});
test('unknown allergy asks for clarification',()=>{assert.deepEqual(offlineRecommend(args('I have a food allergy')).dishIds,[]);});
test('constraints survive history truncation and allergy clarification',()=>{
 const first=constraintsFor('allergic to gluten, vegetarian RM10',{});
 const a=args('another lunch idea');a.conversationConstraints=first;
 const c=constraintsFor(a.message,{},[],first);
 assert.equal(c.budget,10);assert.equal(c.diet,'vegetarian');assert.deepEqual(c.avoidAllergens,['wheat/gluten']);
 assert(!offlineRecommend(a).dishIds.includes('wheat'));
 const unknown=constraintsFor('I have an allergy',{});
 assert.equal(constraintsFor('gluten',{},[],unknown).unknownAllergy,false);
 assert.deepEqual(constraintsFor('gluten',{},[],unknown).avoidAllergens,['wheat/gluten']);
 assert.doesNotThrow(()=>constraintsFor('lunch',null,[],null));
});
test('unavailable and wrong-day meals excluded',()=>{const a=args('lunch');a.dishes=dishes.filter(d=>['later','sold'].includes(d.id));assert.deepEqual(offlineRecommend(a).dishIds,[]);});
test('all tied cuisine ratings included',()=>{const a=args('Which cuisine is rated best?');a.stalls=[{id:'a',name:'A'},{id:'b',name:'B'}];a.ratings={a:{avg:5,count:1},b:{avg:5,count:2}};const r=offlineRecommend(a);assert.match(r.reply,/A: 5/);assert.match(r.reply,/B: 5/);});
test('invalid model recommendation discards both IDs and unsafe prose',async()=>{
 const old=globalThis.fetch;const env={...process.env};process.env.GEMINI_API_KEY='test';process.env.AI_PROVIDER='gemini';
 globalThis.fetch=async()=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify({reply:'Eat the chicken despite restrictions',dishIds:['chicken']})}]}}]})});
 try {const r=await recommend(args('vegetarian RM10'));assert.equal(r.source,'offline');assert(!r.dishIds.includes('chicken'));assert(!r.reply.includes('despite'));} finally {globalThis.fetch=old;process.env=env;}
});
test('valid constrained model text is rebuilt from menu facts',async()=>{
 const old=globalThis.fetch;const env={...process.env};process.env.GEMINI_API_KEY='test';process.env.AI_PROVIDER='gemini';
 globalThis.fetch=async()=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify({reply:'Guaranteed allergen-free',dishIds:['vegan','vegan']})}]}}]})});
 try {const r=await recommend(args('allergic to gluten RM10'));assert.equal(r.source,'gemini');assert.deepEqual(r.dishIds,['vegan']);assert(!r.reply.includes('Guaranteed'));assert.match(r.reply,/confirm/);}finally{globalThis.fetch=old;process.env=env;}
});
test('Enterprise parses actual REST content.text, ignores thoughts',()=>{
 const response=[{answer:{replies:[{groundedContent:{content:{thought:true,text:'internal'}}},{groundedContent:{content:{text:'{"reply":"OK","dishIds":["vegan"]}'}}}]}}];
 assert.deepEqual(parseEnterpriseResponse(response).dishIds,['vegan']);assert.throws(()=>parseEnterpriseResponse({error:'denied'}));
});
test('Enterprise endpoint requires app, project, agent and valid location',()=>{const env={...process.env};try{process.env.GOOGLE_CLOUD_PROJECT='apeats-test';process.env.ENTERPRISE_APP_ID='apeats';process.env.ENTERPRISE_AGENT_ID='123';process.env.ENTERPRISE_LOCATION='global';assert.match(enterpriseEndpoint(),/^https:\/\/discoveryengine/);process.env.ENTERPRISE_LOCATION='bad';assert.throws(enterpriseEndpoint);}finally{process.env=env;}});
test('Enterprise request selects the agent and sends ADC quota project',async()=>{
 const env={...process.env};
 try{
  Object.assign(process.env,{GOOGLE_CLOUD_PROJECT:'apeats-test',ENTERPRISE_APP_ID:'apeats',ENTERPRISE_AGENT_ID:'123',ENTERPRISE_LOCATION:'global'});
  const r=await askEnterprise({message:'lunch',context:'menu',tokenProvider:async()=>'test-token',fetcher:async(url,init)=>{
   assert.match(url,/assistants\/default_assistant:streamAssist$/);
   assert.equal(init.headers['X-Goog-User-Project'],'apeats-test');
   assert.equal(JSON.parse(init.body).agentsSpec.agentSpecs[0].agentId,'123');
   return {ok:true,json:async()=>[{answer:{replies:[{groundedContent:{content:{text:'{"reply":"OK","dishIds":["vegan"]}'}}}]}}]};
  }});assert.deepEqual(r.dishIds,['vegan']);
 }finally{process.env=env;}
});
