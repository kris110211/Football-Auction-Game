const http=require("http"),fs=require("fs"),path=require("path"),WebSocket=require("ws");

const PORT=process.env.PORT||3000;
const players=JSON.parse(fs.readFileSync(path.join(__dirname,"players.json")));
const rooms=new Map();
const TIMER=7000, MIN_SQUAD=13, MAX_SQUAD=18, BUDGET=1000;

function rc(){let c;do{c=Math.random().toString(36).slice(2,7).toUpperCase()}while(rooms.has(c));return c}
function send(w,x){if(w&&w.readyState===WebSocket.OPEN)w.send(JSON.stringify(x))}
function pub(r){
  return {
    code:r.code,
    managers:Object.values(r.managers).map(m=>({id:m.id,name:m.name,club:m.club,budget:m.budget,squad:m.squad})),
    started:r.started,current:r.current,bid:r.bid,highest:r.highest,left:r.left,
    finished:r.finished,deadline:r.deadline,hostId:r.hostId
  };
}
function broadcast(r){
  const msg=JSON.stringify({type:"state",state:pub(r)});
  Object.values(r.managers).forEach(m=>send(m.ws,msg));
}
function error(ws,message){send(ws,{type:"error",message})}

function next(r){
  clearTimeout(r.timer);
  if(!r.left.length){
    r.current=null;r.finished=true;r.deadline=null;r.bid=0;r.highest=null;
    broadcast(r);return;
  }
  const n=Math.floor(Math.random()*r.left.length);
  r.current=r.left.splice(n,1)[0];
  r.bid=players[r.current].base;
  r.highest=null;
  r.deadline=Date.now()+TIMER;
  r.timer=setTimeout(()=>autoSell(r),TIMER);
  broadcast(r);
}
function autoSell(r){
  if(!r.started||r.current===null)return;
  if(r.highest){
    const w=r.managers[r.highest];
    if(w && w.squad.length<MAX_SQUAD && w.budget>=r.bid){
      w.budget-=r.bid;w.squad.push(r.current);
    }
  }
  next(r);
}

const server=http.createServer((q,s)=>{
  let url=(q.url||"/").split("?")[0];
  let f=url==="/"?"index.html":url.replace(/^\/+/,"");
  let p=path.join(__dirname,"public",f);
  if(!p.startsWith(path.join(__dirname,"public"))){s.writeHead(403);return s.end("Forbidden")}
  fs.readFile(p,(e,d)=>{
    if(e){s.writeHead(404);return s.end("Not found")}
    let t=p.endsWith(".html")?"text/html":p.endsWith(".js")?"text/javascript":"application/json";
    s.writeHead(200,{"Content-Type":t,"Cache-Control":"no-store"});s.end(d);
  });
});
const wss=new WebSocket.Server({server});

wss.on("connection",ws=>{
  let me=null,r=null;

  ws.on("message",raw=>{
    let x;try{x=JSON.parse(raw)}catch{return error(ws,"Invalid request.");}

    if(x.type==="create"){
      if(r)return error(ws,"You are already connected to a room.");
      r={code:rc(),managers:{},started:false,current:null,bid:0,highest:null,
         left:players.map((_,i)=>i),finished:false,deadline:null,timer:null,hostId:null};
      rooms.set(r.code,r);
      me={id:Math.random().toString(36).slice(2),ws};
      r.hostId=me.id;
      send(ws,{type:"created",room:r.code,id:me.id});
      send(ws,{type:"state",state:pub(r)});
      return;
    }

    if(x.type==="join"){
      if(r)return error(ws,"You are already connected to a room.");
      const code=String(x.room||"").trim().toUpperCase();
      r=rooms.get(code);
      if(!r)return error(ws,"Room not found. Check the code.");
      if(r.started)return error(ws,"Auction already started.");
      me={id:Math.random().toString(36).slice(2),ws};
      send(ws,{type:"joined",room:r.code,id:me.id});
      send(ws,{type:"state",state:pub(r)});
      return;
    }

    if(!r||!me)return error(ws,"Connect to a room first.");

    if(x.type==="manager"){
      if(r.started)return error(ws,"The auction has already started.");
      if(r.managers[me.id])return error(ws,"You already joined as a manager.");
      const name=String(x.name||"").trim().slice(0,24);
      const club=String(x.club||"").trim();
      if(!name)return error(ws,"Enter a manager name.");
      if(!club)return error(ws,"Choose a club.");
      if(Object.values(r.managers).some(m=>m.club===club))return error(ws,"That club is already taken.");
      r.managers[me.id]={id:me.id,ws,name,club,budget:BUDGET,squad:[]};
      send(ws,{type:"manager_ok",id:me.id});
      broadcast(r);
      return;
    }

    const m=r.managers[me.id];

    if(x.type==="start"){
      if(me.id!==r.hostId)return error(ws,"Only the room creator can start.");
      if(Object.keys(r.managers).length<2)return error(ws,"Need at least 2 managers.");
      if(Object.values(r.managers).some(m=>m.squad.length>0))return error(ws,"Auction has already started.");
      r.started=true;next(r);return;
    }

    if(x.type==="bid"){
      if(!m)return error(ws,"Join as a manager before bidding.");
      if(!r.started||r.finished||r.current===null)return error(ws,"There is no active player.");
      if(Date.now()>r.deadline)return error(ws,"The 7-second timer has expired.");
      if(r.highest===me.id)return error(ws,"You are already the highest bidder.");
      const inc=[10,20,50].includes(+x.amount)?+x.amount:10;
      const newBid=r.highest?r.bid+inc:r.bid;
      if(m.squad.length>=MAX_SQUAD)return error(ws,"Your squad is full (18 players).");
      if(m.budget<newBid)return error(ws,"You cannot afford that bid.");
      r.bid=newBid;r.highest=me.id;r.deadline=Date.now()+TIMER;
      clearTimeout(r.timer);r.timer=setTimeout(()=>autoSell(r),TIMER);
      broadcast(r);return;
    }

    if(x.type==="manual_unsold"){
      if(me.id!==r.hostId)return error(ws,"Only the host can force unsold.");
      if(!r.started||r.current===null)return error(ws,"No active player.");
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
