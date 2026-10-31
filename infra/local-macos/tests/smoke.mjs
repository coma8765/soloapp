import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
const require = createRequire(new URL('../../../services/client-gateway/package.json', import.meta.url));
const WebSocket = require('ws');
const origin = process.env.LOCAL_ORIGIN;
if (!origin) throw new Error('Set LOCAL_ORIGIN to the configured LAN HTTPS URL');
const ca = readFileSync(process.env.NODE_EXTRA_CA_CERTS);
async function request(path, body, token) {
  const r = await fetch(origin + path, {method:body ? 'POST' : 'GET',
    headers:{'Content-Type':'application/json', ...(token ? {Authorization:'Bearer '+token} : {})},
    body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(15000)});
  if (!r.ok) throw new Error(path + ': HTTP ' + r.status);
  return r.json();
}
async function login() {
  const body={username:'local_smoke_'+randomBytes(5).toString('hex'),password:randomBytes(24).toString('hex')};
  await request('/api/v1/auth/v1/register',body);
  return request('/api/v1/auth/v1/login',body);
}
const sessions=[await login(),await login()];
const sockets=[];
try {
  const inboxes=[];
  for (const s of sessions) {
    const ticket=await request('/api/v1/app-api/v1/chat/socket-ticket',{},s.access_token);
    const inbox=[];inboxes.push(inbox);
    const ws=new WebSocket(origin.replace('https:','wss:')+'/api/v1/app-api/v1/chat/ws',['soloapp.chat.v1','ticket.'+ticket.ticket],{ca,origin});
    sockets.push(ws);
    ws.on('message',raw=>{const m=JSON.parse(raw.toString());inbox.push(m);if(m.delivery) ws.send(JSON.stringify({type:'ack',...m.delivery}));});
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  }
  async function until(predicate,label) {
    const deadline=Date.now()+45000;
    while(Date.now()<deadline){if(predicate())return;await new Promise(r=>setTimeout(r,100));}
    throw new Error('Timeout: '+label);
  }
  await until(()=>inboxes.every(i=>i.some(m=>m.type==='history')),'history');
  const body={text:'Local isolated contour smoke test',client_id:randomBytes(16).toString('hex')};
  const sent=await request('/api/v1/app-api/v1/chat/messages',body,sessions[0].access_token);
  await until(()=>inboxes.every(i=>i.some(m=>m.type==='message' && m.message.id===sent.id)),'cross-account WebSocket delivery');
  const duplicate=await request('/api/v1/app-api/v1/chat/messages',body,sessions[0].access_token);
  if(duplicate.id!==sent.id)throw new Error('Idempotency failed');
  console.log(JSON.stringify({https:true,registration:true,login:true,websocket_accounts:2,delivery:true,idempotency:true}));
} finally {for(const ws of sockets) ws.close();}
