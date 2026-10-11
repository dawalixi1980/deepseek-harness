import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readExternalHistory} from '../src/channels/feishu/history-reader.mjs';
const time=1790830000123;
const identity={botId:'bot-1',appId:'cli-1',botOpenId:'ou-bot',fingerprint:'a'.repeat(64)};
const route={messageId:'om-anchor',conversationId:'oc-team',actorId:'ou-human'};
const item=(id,delta)=>({message_id:id,chat_id:'oc-team',sender:{sender_type:'user',id_type:'open_id',id:'ou-human'},
 msg_type:'text',create_time:String(time+delta),body:{content:JSON.stringify({text:id})}});
function client(items) {
 const calls=[];
 return {calls,im:{v1:{message:{get:async()=>({code:0,data:{items:[item('om-anchor',0)]}}),list:async({params:p})=>{
 calls.push(p);
 const filtered=items.filter(x=>Number(x.create_time)>=Number(p.start_time??0)*1000 && Number(x.create_time)<Number(p.end_time??1e12)*1000)
 .sort((a,b)=>(Number(a.create_time)-Number(b.create_time))*(p.sort_type==='ByCreateTimeDesc'?-1:1));
 const offset=Number(p.page_token??0),page=filtered.slice(offset,offset+p.page_size),more=offset+p.page_size<filtered.length;
 return {code:0,data:{items:page,has_more:more,...(more?{page_token:String(offset+p.page_size)}:{})}};
 }}}}};
}
async function all(bot,options={}) {
 let cursor;const pages=[];
 for(let i=0;i<100;i++) {
  const p=await readExternalHistory(bot,identity,route,{scope:'nearby',limit:3,...options,...(cursor?{cursor}:{})});pages.push(p);
  if(!p.nextCursor)return {pages,events:pages.flatMap(p=>p.events)};
  cursor=p.nextCursor;
 }
 throw Error('continuation did not terminate');
}
test('sparse sides fill nearest supported messages outside window, anchor does not count',async()=>{
 const data=[item('om-anchor',0),item('within-before',-10000),item('within-after',10000),
 ...Array.from({length:15},(_,i)=>item('old-'+i,-400000-i*1000)),...Array.from({length:8},(_,i)=>item('new-'+i,400000+i*1000))];
 const bot=client(data);const result=await all(bot);
 const ids=result.events.map(x=>x.messageId);
 assert.equal(ids.length,16);assert.equal(new Set(ids).size,16);
 assert.deepEqual(ids.filter(x=>x.startsWith('old-')),Array.from({length:9},(_,i)=>'old-'+i));
 assert.deepEqual(ids.filter(x=>x.startsWith('new-')),Array.from({length:4},(_,i)=>'new-'+i));
 assert(result.pages.at(-1).hasMore===false);assert(bot.calls.every(p=>p.page_size===3));
});
test('dense window is fully traversed regardless of count minima and preserves boundaries without duplicates',async()=>{
 const data=[item('om-anchor',0),...Array.from({length:25},(_,i)=>item('before-'+i,-1000-i*1000)),
 ...Array.from({length:12},(_,i)=>item('after-'+i,1000+i*1000)),item('lower-bound',-300000),item('upper-bound',300000),item('outside',-400000)];
 const bot=client(data);const result=await all(bot);
 assert.equal(result.events.length,40);assert.equal(new Set(result.events.map(e=>e.messageId)).size,40);
 assert(!result.events.some(e=>e.messageId==='outside'));assert(bot.calls.every(p=>p.sort_type==='ByCreateTimeAsc'));
});
test('both fractional-second boundaries overlap API filters but remain unique across supplement phases',async()=>{
 const result=await all(client([item('om-anchor',0),item('edge-old',-300000),item('just-old',-300001),item('edge-new',300000),item('just-new',300001)]),{beforeCount:2,afterCount:2});
 assert.equal(result.events.length,5);assert.equal(new Set(result.events.map(e=>e.messageId)).size,5);
});
test('unsupported records do not satisfy minima; exhausted sparse history terminates honestly',async()=>{
 const data=[item('om-anchor',0),{...item('app',-1000),sender:{sender_type:'app',id_type:'app_id',id:'cli-1'}},item('available',-400000)];
 const result=await all(client(data));assert.deepEqual(result.events.map(e=>e.messageId),['om-anchor','available']);
 assert.equal(result.pages.reduce((n,p)=>n+p.omitted,0),1);assert(!result.pages.at(-1).hasMore);
});
test('counts are bounded, continuation cannot change anchor/count/limit, and a stopped SDK cursor refuses',async()=>{
 const bot=client([item('om-anchor',0),item('x',-1000),item('y',1000)]);
 const first=await readExternalHistory(bot,identity,route,{scope:'nearby',limit:1});
 for(const query of [{scope:'nearby',limit:1,cursor:first.nextCursor,beforeCount:1},{scope:'nearby',limit:2,cursor:first.nextCursor},
 {scope:'nearby',limit:1,cursor:'bad-json'}]) await assert.rejects(readExternalHistory(bot,identity,route,query),{code:'bad-request'});
 const prior=bot.calls.length;
 for(const value of [-1,21,1.5,'10'])await assert.rejects(readExternalHistory(bot,identity,route,{scope:'nearby',limit:1,beforeCount:value}),{code:'bad-request'});
 assert.equal(bot.calls.length,prior);
});
test('fresh anchors exhaust without querying a future supplementary start',async(t)=>{
 t.mock.method(Date,'now',()=>time+1000);
 const bot=client([item('om-anchor',0),item('older',-400000)]);
 const list=bot.im.v1.message.list;
 bot.im.v1.message.list=async args=>{
  if(args.params.end_time===undefined && Number(args.params.start_time)*1000>Date.now())
   throw Error('Lark refuses default end_time earlier than future start_time');
  return list(args);
 };
 const result=await all(bot);
 assert.deepEqual(result.events.map(e=>e.messageId),['om-anchor','older']);
 assert.equal(result.pages.at(-1).hasMore,false);
 assert.equal(bot.calls.length,2);
});
