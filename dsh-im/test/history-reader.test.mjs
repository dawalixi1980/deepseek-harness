import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readExternalHistory } from '../src/channels/feishu/history-reader.mjs';
const identity = {botId:'bot-1', appId:'cli-1', botOpenId:'ou-bot', fingerprint:'a'.repeat(64)};
const route = {messageId:'om-anchor', conversationId:'oc-team', actorId:'ou-human', threadId:'omt-topic'};
const item = (id, text='hello') => ({message_id:id, chat_id:'oc-team', thread_id:'omt-topic',
 sender:{sender_type:'user', id_type:'open_id', id:'ou-human'}, msg_type:'text',
 create_time:'1790830000000', body:{content:JSON.stringify({text})}});
function client(items=[item('om-context')]) {
 const calls=[];
 return {calls, im:{v1:{message:{get:async()=>({code:0,data:{items:[item('om-anchor')]}}),
 list:async args=>{calls.push(args);return {code:0,data:{items,has_more:false}};}}}}};
}
test('uses authenticated anchor and distinguishes Chat time windows from Thread listing',async()=>{
 const bot=client();
 const result=await readExternalHistory(bot,identity,route,{scope:'nearby',limit:20});
 assert.equal(result.events[0].text,'hello'); assert.equal(result.events[0].mentionedAccount,false);
 assert.equal(bot.calls[0].params.container_id_type,'chat'); assert.equal(bot.calls[0].params.start_time,'1790829700');
 const thread=await readExternalHistory(bot,identity,route,{scope:'thread',limit:20});
 assert.equal(thread.scope,'thread'); assert.equal(bot.calls[1].params.container_id,'omt-topic');
 assert.equal(bot.calls[1].params.start_time,undefined);
});
test('omits unsupported/app/deleted messages explicitly and refuses cross-group content',async()=>{
 const bot=client([item('ok'),{...item('post'),msg_type:'post'}, {...item('deleted'),deleted:true},
 {...item('bot'),sender:{sender_type:'app',id_type:'app_id',id:'cli-1'}}]);
 const result=await readExternalHistory(bot,identity,route,{scope:'group',limit:20});
 assert.equal(result.events.length,1); assert.equal(result.omitted,3);
 await assert.rejects(readExternalHistory(client([{...item('wrong'),chat_id:'oc-other'}]),identity,route,
 {scope:'group',limit:20}),{code:'untrusted-source'});
});
test('fails closed on stale reference, permission denial, nonexistent Thread and cancellation',async()=>{
 const bot=client();
 await assert.rejects(readExternalHistory(bot,identity,{...route,actorId:'wrong'}, {scope:'group',limit:20}),{code:'stale-route'});
 assert.equal(bot.calls.length,0);
 await assert.rejects(readExternalHistory(bot,identity,{...route,threadId:undefined},{scope:'thread',limit:20}),{code:'stale-route'});
 bot.im.v1.message.get=async()=>({code:230027});
 await assert.rejects(readExternalHistory(bot,identity,route,{scope:'group',limit:20}),{code:'history-permission-denied'});
 const controller=new AbortController();controller.abort();
 await assert.rejects(readExternalHistory(client(),identity,route,{scope:'group',limit:20},controller.signal),{name:'AbortError'});
});

test('requests server names and preserves sender / mention IDs without guessing missing names', async () => {
 const named = {...item('om-named'), sender:{sender_type:'user',id_type:'open_id',id:'ou-human',sender_name:'Alex'},
 mentions:[{key:'@_user_1',id:'ou-bot',name:'QA Bot'}]};
 const bot=client([named,item('om-unnamed')]);
 const page=await readExternalHistory(bot,identity,route,{scope:'thread',limit:20});
 assert.equal(bot.calls[0].params.with_sender_name,true);
 assert.deepEqual(page.events[0].actor,{kind:'user',id:'ou-human',name:'Alex'});
 assert.deepEqual(page.events[0].mentions,[{id:'ou-bot',key:'@_user_1',name:'QA Bot'}]);
 assert.deepEqual(page.events[1].actor,{kind:'user',id:'ou-human'});
});

test('pagination is bounded, forwarded unchanged, and never follows a page automatically', async () => {
 const bot = client();
 bot.im.v1.message.list = async args => {
  bot.calls.push(args);
  return {code:0,data:{items:[item('om-next')],has_more:true,page_token:'opaque-next'}};
 };
 const page=await readExternalHistory(bot,identity,route,{scope:'thread',limit:1,cursor:'opaque-current'});
 assert.equal(bot.calls.length,1);assert.equal(bot.calls[0].params.page_token,'opaque-current');
 assert.equal(page.hasMore,true);assert.equal(page.nextCursor,'opaque-next');assert.equal(page.events.length,1);
 assert.equal(page.coverage,'provider-visible-human-text');
 bot.im.v1.message.list=async()=>({code:0,data:{items:[item('1'),item('2')],has_more:false}});
 await assert.rejects(readExternalHistory(bot,identity,route,{scope:'group',limit:1}),{code:'history-unavailable'});
 bot.im.v1.message.list=async()=>({code:0,data:{items:[],has_more:true,page_token:''}});
 await assert.rejects(readExternalHistory(bot,identity,route,{scope:'group',limit:1}),{code:'history-unavailable'});
});

test('invalid limits, cursor and route IDs refuse before making SDK calls', async () => {
 const bot=client();bot.im.v1.message.get=async()=>{throw Error('must not read');};
 for(const query of [{scope:'search',limit:1},{scope:'group',limit:0},{scope:'group',limit:21},
 {scope:'group',limit:1.5},{scope:'group',limit:1,cursor:''},{scope:'group',limit:1,cursor:'x'.repeat(4097)}])
  await assert.rejects(readExternalHistory(bot,identity,route,query),{code:'bad-request'});
 await assert.rejects(readExternalHistory(bot,identity,{...route,messageId:''},{scope:'group',limit:1}),{code:'bad-request'});
 await assert.rejects(readExternalHistory(bot,identity,{...route,parentId:1},{scope:'group',limit:1}),{code:'bad-request'});
});

test('all anchor route fields and returned thread membership are checked', async () => {
 for(const key of ['messageId','conversationId','actorId','threadId','rootId','parentId']) {
  const bot=client();
  await assert.rejects(readExternalHistory(bot,identity,{...route,[key]:'wrong'},{scope:'thread',limit:20}),{code:'stale-route'});
  assert.equal(bot.calls.length,0);
 }
 await assert.rejects(readExternalHistory(client([{...item('wrong'),thread_id:'omt-other'}]),identity,route,
 {scope:'thread',limit:20}),{code:'untrusted-source'});
 const bot=client();bot.im.v1.message.get=async()=>({code:0,data:{items:[{...item('om-anchor'),thread_id:undefined}]}});
 await assert.rejects(readExternalHistory(bot,identity,{...route,threadId:undefined},{scope:'thread',limit:20}),{code:'thread-unavailable'});
});

test('late cancellation discards anchor and page even when SDK ignores signal', async () => {
 for(const stage of ['get','list']) {
  const bot=client();const abort=new AbortController();const original=bot.im.v1.message[stage];
  bot.im.v1.message[stage]=async(...args)=>{const result=await original(...args);abort.abort();return result;};
  await assert.rejects(readExternalHistory(bot,identity,route,{scope:'group',limit:20},abort.signal),{name:'AbortError'});
  if(stage==='get')assert.equal(bot.calls.length,0);
 }
});

test('malformed and oversized text is counted as omitted, never returned unbounded', async () => {
 const bad=[{...item('bad-json'),body:{content:'{'}},item('too-large','x'.repeat(16001)),
 {...item('bad-mentions'),mentions:{}}, {...item('bad-time'),create_time:'no'},item('good')];
 const page=await readExternalHistory(client(bad),identity,route,{scope:'thread',limit:20});
 assert.equal(page.events.length,1);assert.equal(page.events[0].messageId,'good');assert.equal(page.omitted,4);
 for(const data of [{items:null,has_more:false},{items:[],has_more:'false'}]) {
  const bot=client();bot.im.v1.message.list=async()=>({code:0,data});
  await assert.rejects(readExternalHistory(bot,identity,route,{scope:'group',limit:20}),{code:'history-unavailable'});
 }
});
