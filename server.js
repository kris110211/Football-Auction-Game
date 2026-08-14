const http=require("http"),fs=require("fs"),path=require("path"),WebSocket=require("ws");
const PORT=process.env.PORT||3000, players=JSON.parse(fs.readFileSync(path.join(__dirname,"players.json")));
const rooms=new Map(), TIMER=7000;
function rc(){let c;do{c=Math.random().toString(36).slice(2,7).toUpperCase()}while(rooms.has(c));return c}
function pub(r){return{code:r.code,managers:Object.values(r.managers).map(m=>({id:m.id,name:m.name,club:m.club,budget:m.budget,squad:m.squad})),started:r.started,current:r.current,bid:r.bid,highest:r.highest,left:r.left,finished:r.finished,deadline:r.deadline}}
function send(w,x){if(w&&w.readyState===1)w.send(JSON.stringify(x))}
function broadcast(r){const x=JSON.stringify({type:"state",state:pub(r)});Object.values(r.managers).forEach(m=>send(m.ws,x))}
function next(r){clearTimeout(r.timer);if(!r.left.length){r.current=null;r.finished=true;r.deadline=null;broadcast(r);return}let n=Math.floor(Math.random()*r.left.length);r.current=r.left.splice(n,1)[0];r.bid=players[r.current].base;r.highest=null;r.deadline=Date.now()+TIMER;r.timer=setTimeout(()=>autoSell(r),TIMER);broadcast(r)}
function autoSell(r){if(!r.started||r.current===null)return;if(r.highest){let w=r.managers[r.highest];if(w&&w.squad.length<18&&w.budget>=r.bid){w.budget-=r.bid;w.squad.push(r.current)}}next(r)}
const server=http.createServer((q,s)=>{let f=q.url==="/"?"index.html":q.url.replace(/^\/+/,"");let p=path.join(__dirname,"public",f);fs.readFile(p,(e,d)=>{if(e){s.writeHead(404);return s.end("Not found")}let t=p.endsWith(".html")?"text/html":p.endsWith(".js")?"text/javascript":"application/json";s.writeHead(200,{"Content-Type":t});s.end(d)})});
const wss=new WebSocket.Server({server});
wss.on("connection",ws=>{let me=null,r=null;
ws.on("message",raw=>{let x;try{x=JSON.parse(raw)}catch{return}
if(x.type==="create"){r={code:rc(),managers:{},started:false,current:null,bid:0,highest:null,left:players.map((_,i)=>i),finished:false,deadline:null,timer:null};rooms.set(r.code,r);me={id:Math.random().toString(36).slice(2),ws};send(ws,{type:"created",room:r.code,id:me.id});return}
if(x.type==="join"){r=rooms.get(String(x.room||"").toUpperCase());if(!r)return send(ws,{type:"error",message:"Room not found."});if(r.started)return send(ws,{type:"error",message:"Auction already started."});me={id:Math.random().toString(36).slice(2),ws};send(ws,{type:"joined",room:r.code,id:me.id});return}
if(!r||!me)return;
if(x.type==="manager"){let name=String(x.name||"").trim().slice(0,24),club=String(x.club||"");if(!name)return send(ws,{type:"error",message:"Enter a manager name."});if(Object.values(r.managers).some(m=>m.club===club))return send(ws,{type:"error",message:"That club is already taken."});r.managers[me.id]={id:me.id,ws,name,club,budget:1000,squad:[]};broadcast(r);return}
if(x.type==="start"){if(Object.keys(r.managers).length<2)return send(ws,{type:"error",message:"Need at least 2 managers."});if(Object.keys(r.managers)[0]!==me.id)return send(ws,{type:"error",message:"Only the host can start."});r.started=true;next(r);return}
let m=r.managers[me.id];
if(x.type==="bid"){if(!m||!r.started||r.finished||r.current===null)return;if(Date.now()>r.deadline)return;let inc=[10,20,50].includes(+x.amount)?+x.amount:10,newBid=r.highest?r.bid+inc:r.bid;if(m.budget<newBid)return send(ws,{type:"error",message:"You cannot afford that bid."});if(r.highest===me.id)return send(ws,{type:"error",message:"You are already highest bidder."});r.bid=newBid;r.highest=me.id;r.deadline=Date.now()+TIMER;clearTimeout(r.timer);r.timer=setTimeout(()=>autoSell(r),TIMER);broadcast(r);return}
if(x.type==="manual_unsold"){if(Object.keys(r.managers)[0]!==me.id)return;next(r)}
});
ws.on("close",()=>{if(me&&r&&r.managers[me.id]){r.managers[me.id].ws=null;broadcast(r)}})});
server.listen(PORT,()=>console.log("Auction server running on "+PORT));
