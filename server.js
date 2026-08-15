const http=require("http"),fs=require("fs"),path=require("path"),WebSocket=require("ws");
const PORT=process.env.PORT||3000;
const players=JSON.parse(fs.readFileSync(path.join(__dirname,"players.json"),"utf8"));
const rooms=new Map(),TIMER=7000,MIN_MANAGERS=6,MAX_MANAGERS=8,MIN_SQUAD=13,MAX_SQUAD=18;

function rc(){let c;do{c=Math.random().toString(36).slice(2,7).toUpperCase()}while(rooms.has(c));return c}
function managerView(m){
  const total=m.squad.reduce((s,i)=>s+(players[i].overall||0),0);
  const avg=m.squad.length?total/m.squad.length:0;
  return {id:m.id,name:m.name,club:m.club,budget:m.budget,squad:m.squad,totalOvr:total,avgOvr:Number(avg.toFixed(1))};
}
function results(r){
  const list=Object.values(r.managers).map(m=>{
    const v=managerView(m);
    return {...v,eligible:v.squad.length>=MIN_SQUAD&&v.squad.length<=MAX_SQUAD,eliminated:v.squad.length<MIN_SQUAD};
  });
  const eligible=list.filter(m=>m.eligible).sort((a,b)=>b.totalOvr-a.totalOvr||b.avgOvr-a.avgOvr||b.squad.length-a.squad.length||b.budget-a.budget);
  list.forEach((m,i)=>{m.rank=null});
  eligible.forEach((m,i)=>{m.rank=i+1});
  const winner=eligible[0]||null;
  return {winnerId:winner?.id||null,winner:winner?winner.name:null,managers:list};
}
function pub(r){
  return {
    code:r.code,
    managers:Object.values(r.managers).map(managerView),
    started:r.started,current:r.current,bid:r.bid,highest:r.highest,
    left:r.left,finished:r.finished,deadline:r.deadline,
    results:r.results||null
  };
}
function send(w,x){if(w&&w.readyState===1)w.send(JSON.stringify(x))}
function broadcast(r){
  const x=JSON.stringify({type:"state",state:pub(r)});
  Object.values(r.managers).forEach(m=>send(m.ws,x));
}
function finish(r){
  clearTimeout(r.timer);
  r.current=null;r.deadline=null;r.finished=true;r.results=results(r);
  broadcast(r);
}
function next(r){
  clearTimeout(r.timer);
  if(!r.left.length){finish(r);return}
  const n=Math.floor(Math.random()*r.left.length);
  r.current=r.left.splice(n,1)[0];
  r.bid=players[r.current].base;
  r.highest=null;
  r.deadline=Date.now()+TIMER;
  r.timer=setTimeout(()=>autoSell(r),TIMER);
  broadcast(r);
}
function autoSell(r){
  if(!r.started||r.current===null||r.finished)return;
  if(r.highest){
    const w=r.managers[r.highest];
    if(w&&w.squad.length<MAX_SQUAD&&w.budget>=r.bid){
      w.budget-=r.bid;
      w.squad.push(r.current);
    }
  }
  next(r);
}

const server=http.createServer((q,s)=>{
  let f=q.url==="/"?"index.html":q.url.replace(/^\/+/,"");
  if(f.includes("..")){s.writeHead(400);return s.end("Bad request")}
  const p=path.join(__dirname,"public",f);
  fs.readFile(p,(e,d)=>{
    if(e){s.writeHead(404);return s.end("Not found")}
    const t=p.endsWith(".html")?"text/html":p.endsWith(".js")?"text/javascript":"application/json";
    s.writeHead(200,{"Content-Type":t,"Cache-Control":"no-store"});s.end(d)
  })
});
const wss=new WebSocket.Server({server});

wss.on("connection",ws=>{
  let me=null,r=null;
  ws.on("message",raw=>{
    let x;try{x=JSON.parse(raw)}catch{return}

    if(x.type==="create"){
      r={code:rc(),managers:{},started:false,current:null,bid:0,highest:null,left:players.map((_,i)=>i),
         finished:false,deadline:null,timer:null,results:null};
      rooms.set(r.code,r);
      me={id:Math.random().toString(36).slice(2),ws};
      send(ws,{type:"created",room:r.code,id:me.id});
      return;
    }

    if(x.type==="join"){
      r=rooms.get(String(x.room||"").toUpperCase());
      if(!r)return send(ws,{type:"error",message:"Room not found."});
      if(r.started)return send(ws,{type:"error",message:"Auction already started."});
      if(Object.keys(r.managers).length>=MAX_MANAGERS)return send(ws,{type:"error",message:"Room is full (8 managers maximum)."});
      me={id:Math.random().toString(36).slice(2),ws};
      send(ws,{type:"joined",room:r.code,id:me.id});
      send(ws,{type:"state",state:pub(r)});
      return;
    }

    if(!r||!me)return;

    if(x.type==="manager"){
      if(r.started)return send(ws,{type:"error",message:"The auction has already started."});
      if(r.managers[me.id])return send(ws,{type:"error",message:"You are already a manager in this room."});
      const name=String(x.name||"").trim().slice(0,24);
      const club=String(x.club||"");
      if(!name)return send(ws,{type:"error",message:"Enter a manager name."});
      if(!club)return send(ws,{type:"error",message:"Choose a club."});
      if(Object.keys(r.managers).length>=MAX_MANAGERS)return send(ws,{type:"error",message:"Room is full (8 managers maximum)."});
      if(Object.values(r.managers).some(m=>m.club===club))return send(ws,{type:"error",message:"That club is already taken."});
      r.managers[me.id]={id:me.id,ws,name,club,budget:1000,squad:[]};
      send(ws,{type:"manager_ok"});
      broadcast(r);
      return;
    }

    if(x.type==="start"){
      if(r.started)return;
      if(Object.keys(r.managers).length<MIN_MANAGERS)return send(ws,{type:"error",message:"Need at least 6 managers to start."});
      if(Object.keys(r.managers)[0]!==me.id)return send(ws,{type:"error",message:"Only the host can start."});
      r.started=true;next(r);return;
    }

    const m=r.managers[me.id];

    if(x.type==="bid"){
      if(!m||!r.started||r.finished||r.current===null)return;
      if(m.squad.length>=MAX_SQUAD)return send(ws,{type:"error",message:"Your squad is full (18 players)."});
      if(Date.now()>=r.deadline)return send(ws,{type:"error",message:"Bidding has closed for this player."});
      const inc=[10,20,50].includes(+x.amount)?+x.amount:10;
      const newBid=r.highest?r.bid+inc:r.bid;
      if(r.highest===me.id)return send(ws,{type:"error",message:"You are already the highest bidder."});
      if(m.budget<newBid)return send(ws,{type:"error",message:"You cannot afford that bid."});
      r.bid=newBid;r.highest=me.id;r.deadline=Date.now()+TIMER;
      clearTimeout(r.timer);r.timer=setTimeout(()=>autoSell(r),TIMER);
      broadcast(r);return;
    }

    if(x.type==="manual_unsold"){
      if(Object.keys(r.managers)[0]!==me.id)return send(ws,{type:"error",message:"Only the host can force a player unsold."});
      if(!r.started||r.finished||r.current===null)return;
      next(r);return;
    }
  });

  ws.on("close",()=>{
    if(me&&r&&r.managers[me.id]){
      r.managers[me.id].ws=null;
      broadcast(r);
    }
  });
});
server.listen(PORT,()=>console.log("Auction server running on "+PORT));
