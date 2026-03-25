import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from "recharts";
import * as XLSX from "xlsx";

// ─────────────────────────────────────────────────────────────
// THEME — Sovereign Night
// ─────────────────────────────────────────────────────────────
const T = {
  bg:"#080c14",surf:"#0e1420",surf2:"#141c2e",border:"#1f2d45",border2:"#263450",
  accent:"#f0b429",adim:"#b8891e",teal:"#34d399",red:"#f87171",
  text:"#e8edf8",muted:"#4e6080",muted2:"#6b82a8",
  mono:"'JetBrains Mono','Fira Mono',monospace",
  sans:"'Space Grotesk','Segoe UI',sans-serif",
};

const SERVER = "http://localhost:5000";
const TICKERS = {"^NSEI":"Nifty 50","^NSEBANK":"BankNifty","GC=F":"Gold","SI=F":"Silver","^BSESN":"Sensex"};

// ─────────────────────────────────────────────────────────────
// STYLE TOKENS
// ─────────────────────────────────────────────────────────────
const inputSt={background:T.bg,border:`1px solid ${T.border}`,color:T.text,padding:"7px 11px",borderRadius:6,fontFamily:T.mono,fontSize:12,width:136,outline:"none"};
const btnPrimary={background:T.accent,color:"#080c14",border:"none",padding:"8px 22px",borderRadius:7,fontFamily:T.sans,fontWeight:700,fontSize:13,cursor:"pointer"};
const btnOutline={background:"transparent",color:T.accent,border:`1px solid ${T.adim}`,padding:"8px 16px",borderRadius:7,fontFamily:T.sans,fontWeight:600,fontSize:12,cursor:"pointer"};
const cardSt={background:T.surf,border:`1px solid ${T.border}`,borderRadius:12,padding:18};
const tdSt={padding:"9px 13px",whiteSpace:"nowrap",color:T.text,fontFamily:T.mono,fontSize:12};
const thSt={padding:"9px 13px",textAlign:"left",color:T.muted,fontWeight:400,textTransform:"uppercase",fontSize:10,letterSpacing:"0.6px",borderBottom:`1px solid ${T.border}`,whiteSpace:"nowrap",fontFamily:T.mono};

// ─────────────────────────────────────────────────────────────
// LOCAL ENGINE (used when server offline or data uploaded)
// ─────────────────────────────────────────────────────────────
const flr=(p,r)=>Math.floor(p/r)*r, cl=(p,r)=>Math.ceil(p/r)*r;
const dB=(d1,d2)=>Math.round((new Date(d2)-new Date(d1))/86400000);

function runEngine(ohlcv,startDate,endDate,rounding,offset,lotSize=1){
  const start=new Date(startDate).getTime();
  const end=new Date(endDate).getTime();
  const data=ohlcv.filter(r=>{const t=new Date(r.date).getTime();return t>=start&&t<=end;});
  if(!data.length) return {trades:[],metrics:null};
  const trades=[];
  let state="FLAT",posUnits=0,entryPrice=null,entryDate=null,cumPnL=0;
  let activeLevel=null,anchorFloor=null,anchorCeil=null,anchorDone=false,tradeId=0;
  const dailyPnL=[];
  for(const {date,open,high,low,close} of data){
    const o=open||close; // fallback if open missing
    if(!anchorDone){anchorFloor=flr(close,rounding);anchorCeil=cl(close,rounding);if(anchorCeil===anchorFloor)anchorCeil+=rounding;anchorDone=true;continue;}
    let flippedToday=false;
    if(state==="FLAT"){
      const uT=anchorCeil+offset,dT=anchorFloor-offset;
      const hitUp=high>=uT,hitDown=low<=dT;
      let goLongFirst=true;
      if(hitUp&&hitDown) goLongFirst=Math.abs(o-uT)<=Math.abs(o-dT);
      if(hitUp&&(goLongFirst||!hitDown)){state="LONG";posUnits=1;entryPrice=Math.max(o,uT);entryDate=date;tradeId++;activeLevel=flr(low,rounding);}
      else if(hitDown){state="SHORT";posUnits=1;entryPrice=Math.min(o,dT);entryDate=date;tradeId++;activeLevel=cl(high,rounding);}
    }else if(state==="LONG"){
      const snap=activeLevel,dT=snap-offset;
      if(low<=dT){const ep=Math.min(o,dT),pnl=(ep-entryPrice)*posUnits*lotSize;trades.push({trade_id:tradeId,direction:"LONG",entry_date:entryDate,entry_price:entryPrice,exit_date:date,exit_price:ep,units:posUnits,pnl_points:+(ep-entryPrice).toFixed(2),pnl:+pnl.toFixed(2),days_held:dB(entryDate,date)});flippedToday=true;state="SHORT";posUnits=1;entryPrice=ep;entryDate=date;tradeId++;activeLevel=cl(high,rounding);cumPnL+=pnl;}
      else{const nf=flr(low,rounding);if(nf>activeLevel)activeLevel=nf;}
    }else if(state==="SHORT"){
      const snap=activeLevel,uT=snap+offset;
      if(high>=uT){const ep=Math.max(o,uT),pnl=(entryPrice-ep)*posUnits*lotSize;trades.push({trade_id:tradeId,direction:"SHORT",entry_date:entryDate,entry_price:entryPrice,exit_date:date,exit_price:ep,units:posUnits,pnl_points:+(entryPrice-ep).toFixed(2),pnl:+pnl.toFixed(2),days_held:dB(entryDate,date)});flippedToday=true;state="LONG";posUnits=1;entryPrice=ep;entryDate=date;tradeId++;activeLevel=flr(low,rounding);cumPnL+=pnl;}
      else{const nc=cl(high,rounding);if(nc<activeLevel)activeLevel=nc;}
    }
    dailyPnL.push(cumPnL);
  }
  return{trades,metrics:calcM(trades,dailyPnL)};
}

function calcM(trades,dailyPnL=[]){
  if(!trades.length)return null;
  const win=trades.filter(t=>t.pnl_points>0),los=trades.filter(t=>t.pnl_points<=0);
  const lng=trades.filter(t=>t.direction==="LONG"),sht=trades.filter(t=>t.direction==="SHORT");
  const s=(a,k)=>a.reduce((x,t)=>x+t[k],0);
  const gp=s(win,"pnl"),gl=Math.abs(s(los,"pnl"));
  let cum=0,peak=0,maxDD=0;
  trades.forEach(t=>{cum+=t.pnl;if(cum>peak)peak=cum;if(cum-peak<maxDD)maxDD=cum-peak;});
  const mc=(arr,tgt)=>{let m=0,c=0;arr.forEach(v=>{c=v===tgt?c+1:0;m=Math.max(m,c);});return m;};
  const wins=trades.map(t=>t.pnl_points>0);
  return{
    total_trades:trades.length,win_rate:+(win.length/trades.length*100).toFixed(1),
    total_pnl_points:+s(trades,"pnl").toFixed(0),profit_factor:gl>0?+(gp/gl).toFixed(2):"∞",
    expectancy_points:+(s(trades,"pnl_points")/trades.length).toFixed(0),
    avg_win_points:win.length?+(s(win,"pnl_points")/win.length).toFixed(0):0,
    avg_loss_points:los.length?+(s(los,"pnl_points")/los.length).toFixed(0):0,
    max_win_points:+Math.max(...trades.map(t=>t.pnl_points)).toFixed(0),
    max_loss_points:+Math.min(...trades.map(t=>t.pnl_points)).toFixed(0),
    max_drawdown_points:+maxDD.toFixed(0),avg_days_held:+(s(trades,"days_held")/trades.length).toFixed(1),
    max_consec_wins:mc(wins,true),max_consec_losses:mc(wins,false),
    long_trades:lng.length,short_trades:sht.length,
    long_win_rate:lng.length?+(lng.filter(t=>t.pnl_points>0).length/lng.length*100).toFixed(1):0,
    short_win_rate:sht.length?+(sht.filter(t=>t.pnl_points>0).length/sht.length*100).toFixed(1):0,
    long_pnl:+s(lng,"pnl").toFixed(0),short_pnl:+s(sht,"pnl").toFixed(0),
    ...calculateDdDurations(dailyPnL)
  };
}

function calculateDdDurations(series) {
  if(!series || !series.length) return { max_drawdown_duration: 0, avg_drawdown_duration: 0 };
  let peak = 0, dds = [], cur = 0;
  series.forEach(v => {
    const val = Number(v) || 0;
    if (val >= peak) {
      if (cur > 0) dds.push(cur);
      peak = val;
      cur = 0;
    } else {
      cur++;
    }
  });
  if (cur > 0) dds.push(cur);
  return {
    max_drawdown_duration: dds.length ? Math.max(...dds) : 0,
    avg_drawdown_duration: dds.length ? +(dds.reduce((a, b) => a + b, 0) / dds.length).toFixed(1) : 0
  };
}

function sweepLocal(ohlcv,startDate,endDate,roundings,offsets,lotSize){
  const rows=[];
  roundings.forEach(r=>offsets.forEach(o=>{const{metrics:m}=runEngine(ohlcv,startDate,endDate,r,o,lotSize);if(m)rows.push({rounding:r,offset:o,...m});}));
  return rows.sort((a,b)=>(b.profit_factor==="∞"?999:+b.profit_factor)-(a.profit_factor==="∞"?999:+a.profit_factor));
}

function parseCSV(text){
  const lines=text.trim().split("\n");
  const headers=lines[0].split(",").map(h=>h.trim().replace(/"/g,"").toLowerCase());
  return lines.slice(1).map(line=>{const vals=line.split(",").map(v=>v.trim().replace(/"/g,""));const obj={};headers.forEach((h,i)=>{obj[h]=vals[i];});return{date:obj.date,open:+obj.open,high:+obj.high,low:+obj.low,close:+obj.close,volume:+(obj.volume||0)};}).filter(r=>r.date&&!isNaN(r.close));
}

// ─────────────────────────────────────────────────────────────
// UI ATOMS
// ─────────────────────────────────────────────────────────────
function StatCard({label,value,sub,variant}){
  const color=variant==="pos"?T.teal:variant==="neg"?T.red:variant==="gold"?T.accent:T.text;
  return(<div style={{background:T.surf,border:`1px solid ${T.border}`,borderRadius:10,padding:"13px 15px",borderTop:`2px solid ${color}44`}}><div style={{fontSize:10,color:T.muted,fontFamily:T.mono,textTransform:"uppercase",letterSpacing:"0.8px",marginBottom:6}}>{label}</div><div style={{fontSize:18,fontWeight:700,color,lineHeight:1,fontFamily:T.mono}}>{value}</div>{sub&&<div style={{fontSize:10,color:T.muted2,marginTop:4,fontFamily:T.mono}}>{sub}</div>}</div>);
}
function SecTitle({children}){return(<div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:"1px",color:T.muted2,fontFamily:T.mono,marginBottom:14,display:"flex",alignItems:"center",gap:8}}><span style={{width:3,height:14,background:T.accent,borderRadius:2,display:"inline-block"}}/>{children}</div>);}
const TTip=({active,payload,label})=>{if(!active||!payload?.length)return null;return(<div style={{background:T.surf2,border:`1px solid ${T.border2}`,borderRadius:6,padding:"8px 12px",fontFamily:T.mono,fontSize:11}}><div style={{color:T.muted2,marginBottom:4}}>{label}</div>{payload.map((p,i)=>(<div key={i} style={{color:+p.value>=0?T.teal:T.red}}>{p.name}: {+p.value>=0?"+":""}{(+p.value).toFixed(0)}</div>))}</div>);};
const fmtN=n=>(n>=0?"+":"")+Number(n).toLocaleString("en-IN");
const fmtPt=n=>(n>=0?"+":"")+n;

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
export default function App(){
  const [ticker,setTicker]=useState("^NSEI");
  const [startDate,setStartDate]=useState("2020-01-01");
  const [endDate,setEndDate]=useState(new Date().toISOString().split("T")[0]);
  const [rounding,setRounding]=useState(500);
  const [offset,setOffset]=useState(10);
  const [lotSize,setLotSize]=useState(1);
  const [result,setResult]=useState(null);
  const [loading,setLoading]=useState(false);
  const [activeTab,setActiveTab]=useState("overview");
  const [tradeFilter,setTradeFilter]=useState("ALL");
  const [sweepR,setSweepR]=useState("250,500,750,1000");
  const [sweepO,setSweepO]=useState("5,10,15,20");
  const [sweepRows,setSweepRows]=useState([]);
  const [serverOnline,setServerOnline]=useState(null);
  const [statusMsg,setStatusMsg]=useState("Checking server…");
  const [uploadedData,setUploadedData]=useState(null);
  const [uploadedFileName,setUploadedFileName]=useState(null);
  const [saved,setSaved]=useState([]);
  const [errorMsg,setErrorMsg]=useState("");
  const fileRef=useRef();

  useEffect(()=>{
    fetch(`${SERVER}/health`,{signal:AbortSignal.timeout(2000)})
      .then(r=>r.ok?r.json():Promise.reject())
      .then(()=>{setServerOnline(true);setStatusMsg("Server live · Select instrument & click ▶ Run for real data");})
      .catch(()=>{setServerOnline(false);setStatusMsg("Server offline · Upload CSV/JSON to use locally");});
  },[]);

  const handleRun=useCallback(async()=>{
    setLoading(true);setErrorMsg("");
    try{
      if(serverOnline&&!uploadedData){
        const res=await fetch(`${SERVER}/api/backtest`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ticker,start:startDate,end:endDate,rounding,offset,lot_size:lotSize}),signal:AbortSignal.timeout(30000)});
        if(!res.ok){const e=await res.json();throw new Error(e.error);}
        const data=await res.json();
        setResult(data);
        setStatusMsg(`${data.trades.length} trades · ${ticker} · R=${rounding} · Offset=${offset} · Live via yfinance`);
      }else if(uploadedData){
        const res=runEngine(uploadedData,startDate,endDate,rounding,offset,lotSize);
        setResult({trades:res.trades,metrics:res.metrics,params:{ticker:uploadedFileName,rounding,offset}});
        setStatusMsg(`${res.trades.length} trades · ${uploadedFileName||"Uploaded data"} · R=${rounding} · Offset=${offset}`);
      }else{
        setErrorMsg("Server offline. Upload a CSV or JSON file, or run: python server.py");
      }
    }catch(e){setErrorMsg(e.message?.includes("fetch")?"Cannot reach server. Run: python server.py":e.message);}
    setLoading(false);
  },[serverOnline,uploadedData,uploadedFileName,ticker,startDate,endDate,rounding,offset,lotSize]);

  const handleSweep=useCallback(async()=>{
    setLoading(true);setErrorMsg("");
    const rs=sweepR.split(",").map(Number).filter(Boolean);
    const os=sweepO.split(",").map(Number).filter(Boolean);
    try{
      if(serverOnline&&!uploadedData){
        const res=await fetch(`${SERVER}/api/sweep`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ticker,start:startDate,end:endDate,roundings:rs,offsets:os,lot_size:lotSize}),signal:AbortSignal.timeout(60000)});
        if(!res.ok)throw new Error("Sweep failed");
        setSweepRows(await res.json());
      }else if(uploadedData){
        setSweepRows(sweepLocal(uploadedData,startDate,endDate,rs,os,lotSize));
      }else{
        setErrorMsg("Server offline. Upload data to run sweep locally.");
      }
      setActiveTab("sweep");
    }catch(e){setErrorMsg(e.message);}
    setLoading(false);
  },[serverOnline,uploadedData,ticker,startDate,endDate,sweepR,sweepO,lotSize]);

  const handleFile=e=>{
    const file=e.target.files[0];if(!file)return;
    if(file.name.endsWith(".xlsx")||file.name.endsWith(".xls")){
      const reader=new FileReader();
      reader.onload=ev=>{
        try{
          const wb=XLSX.read(ev.target.result,{type:"array"});
          const ws=wb.Sheets[wb.SheetNames[0]];
          const raw=XLSX.utils.sheet_to_json(ws);
          const parsed=raw.map(row=>{
            const getK=key=>row[Object.keys(row).find(k=>k.trim().toLowerCase()===key)];
            return{date:getK("date"),open:+getK("open"),high:+getK("high"),low:+getK("low"),close:+getK("close"),volume:+(getK("volume")||0)};
          }).filter(r=>r.date&&!isNaN(r.close));
          setUploadedData(parsed);setUploadedFileName(file.name);setStatusMsg(`Loaded Excel · ${parsed.length} rows · Click ▶ Run`);
        }catch(err){setErrorMsg("Excel parse error: "+err.message);}
      };
      reader.readAsArrayBuffer(file);
      return;
    }
    const reader=new FileReader();
    reader.onload=ev=>{
      try{
        if(file.name.endsWith(".json")){
          const data=JSON.parse(ev.target.result);
          if(data.trades){setResult(data);setStatusMsg(`Loaded JSON · ${data.trades.length} trades`);return;}
          if(Array.isArray(data)){setUploadedData(data);setUploadedFileName(file.name);setStatusMsg(`Loaded ${data.length} rows · Click ▶ Run`);return;}
        }else{
          const parsed=parseCSV(ev.target.result);
          setUploadedData(parsed);setUploadedFileName(file.name);setStatusMsg(`Loaded CSV · ${parsed.length} rows · Click ▶ Run`);
        }
      }catch(err){setErrorMsg("File parse error: "+err.message);}
    };
    reader.readAsText(file);
  };

  const trades=result?.trades||[];
  const m=result?.metrics;
  const handleSave=(m)=>{
    if(!m)return;
    const item={
      id:Date.now(),
      ticker:result?.params?.ticker||ticker,
      period:`${startDate} to ${endDate}`,
      rounding:m.rounding||rounding,
      offset:m.offset||offset,
      trades:m.total_trades||m.trades,
      win_rate:m.win_rate,
      profit_factor:m.profit_factor,
      pnl:m.total_pnl_points,
      expectancy:m.expectancy_points||m.expectancy,
      max_dd:m.max_drawdown_points||m.max_dd,
      max_dd_dur: m.max_drawdown_duration || 0,
      avg_days:m.avg_days_held||m.avg_days
    };
    setSaved(s=>[item,...s]);
    setStatusMsg("Backtest Saved to comparison tab!");
  };
  const pnlData=useMemo(()=>{let cum=0;return trades.map(t=>({date:(t.exit_date||"").slice(5),cum:+(cum+=t.pnl_points).toFixed(0)}));},[trades]);
  const distData=useMemo(()=>{if(!trades.length)return[];const pts=trades.map(t=>t.pnl_points);const mn=Math.min(...pts),mx=Math.max(...pts),bins=18,step=(mx-mn)/bins||1;return Array.from({length:bins},(_,i)=>{const lo=mn+i*step;return{label:Math.round(lo),count:pts.filter(p=>p>=lo&&p<lo+step).length,pos:lo>=0};});},[trades]);
  const daysData=useMemo(()=>{if(!trades.length)return[];const days=trades.map(t=>t.days_held);const mx=Math.max(...days)||1,bins=Math.min(12,mx+1),step=Math.ceil((mx+1)/bins);return Array.from({length:bins},(_,i)=>({label:`${i*step}d`,count:days.filter(d=>d>=i*step&&d<(i+1)*step).length}));},[trades]);
  const tradesWithCum=useMemo(()=>{let cum=0;return trades.map(t=>({...t,runCum:+(cum+=t.pnl).toFixed(0)}));},[trades]);
  const filteredTrades=useMemo(()=>{const f=tradeFilter;return tradesWithCum.filter(t=>f==="LONG"?t.direction==="LONG":f==="SHORT"?t.direction==="SHORT":f==="WIN"?t.pnl_points>0:f==="LOSS"?t.pnl_points<=0:true);},[tradesWithCum,tradeFilter]);

  return(
    <div style={{background:T.bg,minHeight:"100vh",color:T.text,fontFamily:T.sans,paddingBottom:52}}>

      {/* Header */}
      <div style={{background:T.surf,borderBottom:`1px solid ${T.border}`,padding:"13px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:50}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:34,height:34,background:T.accent,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:13,color:T.bg,fontFamily:T.mono,letterSpacing:"-1px"}}>TW</div>
          <div><div style={{fontWeight:700,fontSize:15}}>Turtlewealth</div><div style={{fontSize:10,color:T.muted,fontFamily:T.mono}}>Growth Mantra PMS · SEBI INP000006758</div></div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          {serverOnline!==null&&(
            <div style={{fontSize:10,fontFamily:T.mono,color:serverOnline?T.teal:T.red,display:"flex",alignItems:"center",gap:6}}>
              <span style={{width:6,height:6,borderRadius:"50%",background:serverOnline?T.teal:T.red,display:"inline-block"}}/>
              {serverOnline?"Server live — real data":"Server offline — upload mode"}
            </div>
          )}
          <div style={{background:`${T.accent}18`,border:`1px solid ${T.adim}55`,color:T.accent,padding:"5px 14px",borderRadius:20,fontSize:11,fontFamily:T.mono}}>Long-Short Rounding Strategy</div>
        </div>
      </div>

      {/* Config */}
      <div style={{background:T.surf,borderBottom:`1px solid ${T.border}`,padding:"12px 24px",display:"flex",alignItems:"flex-end",gap:14,flexWrap:"wrap"}}>
        {uploadedFileName ? (
          <div><div style={{fontSize:10,color:T.teal,fontFamily:T.mono,textTransform:"uppercase",letterSpacing:"0.8px",marginBottom:4}}>Custom Data</div>
            <div style={{...inputSt,width:"auto",background:`${T.teal}11`,borderColor:`${T.teal}44`,color:T.teal,display:"flex",alignItems:"center",gap:8,padding:"7px 11px"}}>
              <span style={{maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={uploadedFileName}>{uploadedFileName}</span>
              <button onClick={()=>{setUploadedData(null);setUploadedFileName(null);setStatusMsg("Ready");}} style={{background:"transparent",border:"none",color:T.teal,cursor:"pointer",padding:0,fontSize:14,lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center",marginLeft:4}}>×</button>
            </div>
          </div>
        ) : (
          <div><div style={{fontSize:10,color:T.muted,fontFamily:T.mono,textTransform:"uppercase",letterSpacing:"0.8px",marginBottom:4}}>Instrument</div>
            <select value={ticker} onChange={e=>setTicker(e.target.value)} style={{...inputSt,width:145}}>
              {Object.entries(TICKERS).map(([v,l])=><option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        )}
        {[{label:"Start Date",el:<input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} style={inputSt}/>},{label:"End Date",el:<input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} style={inputSt}/>},{label:"Rounding",el:<input type="number" value={rounding} onChange={e=>setRounding(+e.target.value)} style={inputSt} step={50} min={10}/>},{label:"Offset",el:<input type="number" value={offset} onChange={e=>setOffset(+e.target.value)} style={inputSt} step={1} min={0}/>},{label:"Lot Size",el:<input type="number" value={lotSize} onChange={e=>setLotSize(+e.target.value)} style={inputSt} step={1} min={1}/>}].map(({label,el})=>(
          <div key={label}><div style={{fontSize:10,color:T.muted,fontFamily:T.mono,textTransform:"uppercase",letterSpacing:"0.8px",marginBottom:4}}>{label}</div>{el}</div>
        ))}
        <div style={{alignSelf:"flex-end",display:"flex",gap:8}}>
          <button onClick={()=>fileRef.current.click()} style={btnOutline}>↑ CSV / JSON / Excel</button>
          <input ref={fileRef} type="file" accept=".csv,.json,.xlsx,.xls" style={{display:"none"}} onChange={handleFile}/>
          <button onClick={handleRun} style={{...btnPrimary,opacity:loading?0.6:1}} disabled={loading}>{loading?"Loading…":"▶ Run"}</button>
          {!loading && result && activeTab==="overview" && <button onClick={()=>handleSave(m)} style={{...btnOutline,color:T.accent}}>Save Result</button>}
        </div>
      </div>

      {/* Tabs */}
      <div style={{background:T.surf,borderBottom:`1px solid ${T.border}`,padding:"0 24px",display:"flex"}}>
        {["overview","trades","sweep","saved"].map(tab=>(
          <button key={tab} onClick={()=>setActiveTab(tab)} style={{background:"none",border:"none",padding:"11px 20px",color:activeTab===tab?T.accent:T.muted,fontSize:12,fontFamily:T.mono,cursor:"pointer",borderBottom:activeTab===tab?`2px solid ${T.accent}`:"2px solid transparent",textTransform:"capitalize",fontWeight:activeTab===tab?700:400}}>{tab}</button>
        ))}
      </div>

      <div style={{padding:24}}>
        {errorMsg&&<div style={{background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",color:T.red,padding:"12px 16px",borderRadius:8,fontFamily:T.mono,fontSize:12,marginBottom:16}}>{errorMsg}</div>}
        {!serverOnline&&!uploadedData&&!result&&!loading&&<div style={{background:`${T.accent}0d`,border:`1px solid ${T.adim}44`,color:T.accent,padding:"12px 16px",borderRadius:8,fontFamily:T.mono,fontSize:12,marginBottom:16}}>Run <strong>python server.py</strong> for live yfinance data — or upload a CSV/JSON to run offline.</div>}
        {loading&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:280,color:T.muted2,fontFamily:T.mono,fontSize:13}}>Fetching real data & running backtest…</div>}
        {!loading&&!result&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:280,color:T.muted,fontFamily:T.mono,fontSize:13}}>Configure params and click ▶ Run</div>}

        {/* OVERVIEW */}
        {activeTab==="overview"&&m&&!loading&&(
          <>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(148px,1fr))",gap:10,marginBottom:18}}>
              <StatCard label="Total Trades" value={m.total_trades} variant=""/>
              <StatCard label="Win Rate" value={m.win_rate+"%"} variant={m.win_rate>=50?"pos":"neg"}/>
              <StatCard label="Profit Factor" value={m.profit_factor} variant={m.profit_factor!=="∞"&&m.profit_factor>=1?"pos":"neg"}/>
              <StatCard label="Total P&L" value={fmtN(m.total_pnl_points)+" pts"} variant={m.total_pnl_points>=0?"pos":"neg"}/>
              <StatCard label="Expectancy" value={fmtPt(m.expectancy_points)+" pts"} sub="per trade" variant={m.expectancy_points>=0?"pos":"neg"}/>
              <StatCard label="Avg Win" value={"+"+m.avg_win_points+" pts"} variant="pos"/>
              <StatCard label="Avg Loss" value={m.avg_loss_points+" pts"} variant="neg"/>
              <StatCard label="Max Drawdown" value={fmtN(m.max_drawdown_points)+" pts"} variant="neg"/>
              <StatCard label="Best Trade" value={"+"+m.max_win_points+" pts"} variant="pos"/>
              <StatCard label="Worst Trade" value={m.max_loss_points+" pts"} variant="neg"/>
              <StatCard label="Avg Hold" value={m.avg_days_held+"d"} variant="gold"/>
              <StatCard label="Max DD Duration" value={m.max_drawdown_duration+"d"} sub="longest" variant="neg"/>
              <StatCard label="Avg DD Duration" value={m.avg_drawdown_duration+"d"} sub="recovery" variant="neg"/>
              <StatCard label="Consec W/L" value={`${m.max_consec_wins} / ${m.max_consec_losses}`} sub="wins / losses" variant=""/>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:14,marginBottom:14}}>
              <div style={cardSt}><SecTitle>Cumulative P&L — Points</SecTitle>
                <ResponsiveContainer width="100%" height={210}><LineChart data={pnlData}><CartesianGrid strokeDasharray="3 3" stroke={T.border}/><XAxis dataKey="date" tick={{fill:T.muted,fontSize:9,fontFamily:T.mono}} interval="preserveStartEnd"/><YAxis tick={{fill:T.muted,fontSize:9,fontFamily:T.mono}}/><Tooltip content={<TTip/>}/><ReferenceLine y={0} stroke={T.border2} strokeWidth={1}/><Line type="monotone" dataKey="cum" stroke={T.accent} strokeWidth={2} dot={false} name="Cum P&L"/></LineChart></ResponsiveContainer>
              </div>
              <div style={cardSt}><SecTitle>P&L Distribution</SecTitle>
                <ResponsiveContainer width="100%" height={210}><BarChart data={distData}><CartesianGrid strokeDasharray="3 3" stroke={T.border}/><XAxis dataKey="label" tick={{fill:T.muted,fontSize:9,fontFamily:T.mono}} interval={3}/><YAxis tick={{fill:T.muted,fontSize:9,fontFamily:T.mono}}/><Tooltip content={<TTip/>}/><Bar dataKey="count" name="Trades">{distData.map((d,i)=><Cell key={i} fill={d.pos?`${T.teal}bb`:`${T.red}bb`}/>)}</Bar></BarChart></ResponsiveContainer>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:14}}>
              <div style={cardSt}><SecTitle>Long vs Short P&L</SecTitle>
                <ResponsiveContainer width="100%" height={160}><BarChart data={[{name:"Long",pnl:m.long_pnl},{name:"Short",pnl:m.short_pnl}]}><CartesianGrid strokeDasharray="3 3" stroke={T.border}/><XAxis dataKey="name" tick={{fill:T.muted,fontSize:11,fontFamily:T.mono}}/><YAxis tick={{fill:T.muted,fontSize:9,fontFamily:T.mono}}/><Tooltip content={<TTip/>}/><ReferenceLine y={0} stroke={T.border2}/><Bar dataKey="pnl" name="P&L"><Cell fill={m.long_pnl>=0?T.teal:T.red}/><Cell fill={m.short_pnl>=0?T.teal:T.red}/></Bar></BarChart></ResponsiveContainer>
              </div>
              <div style={cardSt}><SecTitle>Direction Breakdown</SecTitle>
                {[{k:"Overall Win Rate",v:m.win_rate+"%",pos:m.win_rate>=50},{k:"Long Win Rate",v:m.long_win_rate+"%",pos:m.long_win_rate>=50},{k:"Short Win Rate",v:m.short_win_rate+"%",pos:m.short_win_rate>=50},{k:"Long Trades",v:m.long_trades,pos:true},{k:"Short Trades",v:m.short_trades,pos:true},{k:"Long P&L pts",v:fmtN(m.long_pnl),pos:m.long_pnl>=0},{k:"Short P&L pts",v:fmtN(m.short_pnl),pos:m.short_pnl>=0}].map(({k,v,pos})=>(
                  <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:`1px solid ${T.border}`,fontSize:11,fontFamily:T.mono}}><span style={{color:T.muted2}}>{k}</span><span style={{color:pos?T.teal:T.red,fontWeight:700}}>{v}</span></div>
                ))}
              </div>
              <div style={cardSt}><SecTitle>Days Held Distribution</SecTitle>
                <ResponsiveContainer width="100%" height={160}><BarChart data={daysData}><CartesianGrid strokeDasharray="3 3" stroke={T.border}/><XAxis dataKey="label" tick={{fill:T.muted,fontSize:9,fontFamily:T.mono}}/><YAxis tick={{fill:T.muted,fontSize:9,fontFamily:T.mono}}/><Tooltip content={<TTip/>}/><Bar dataKey="count" fill={`${T.accent}bb`} name="Trades"/></BarChart></ResponsiveContainer>
              </div>
            </div>
          </>
        )}

        {/* TRADES */}
        {activeTab==="trades"&&!loading&&(
          <div style={{background:T.surf,border:`1px solid ${T.border}`,borderRadius:12,overflow:"hidden"}}>
            <div style={{padding:"13px 18px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:"1px",color:T.muted2,fontFamily:T.mono}}>Trade Log — {filteredTrades.length} trades</div>
              <div style={{display:"flex",gap:4}}>
                {["ALL","LONG","SHORT","WIN","LOSS"].map(f=>(
                  <button key={f} onClick={()=>setTradeFilter(f)} style={{padding:"3px 11px",borderRadius:4,fontSize:10,fontFamily:T.mono,cursor:"pointer",background:tradeFilter===f?T.accent:"transparent",color:tradeFilter===f?T.bg:T.muted,border:`1px solid ${tradeFilter===f?T.accent:T.border}`,fontWeight:700}}>{f}</button>
                ))}
              </div>
            </div>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr>{["#","Dir","Entry Date","Entry","Exit Date","Exit","Units","Days","P&L pts","P&L ₹","Running Cum"].map(h=><th key={h} style={thSt}>{h}</th>)}</tr></thead>
                <tbody>
                  {filteredTrades.map(t=>{const pc=t.pnl_points>=0?T.teal:T.red,cc=t.runCum>=0?T.teal:T.red;return(
                    <tr key={`${tradeFilter}-${t.trade_id}`} style={{borderBottom:`1px solid ${T.border}22`}}>
                      <td style={tdSt}>{t.trade_id}</td>
                      <td style={tdSt}><span style={{padding:"3px 9px",borderRadius:4,fontSize:10,fontWeight:700,letterSpacing:1,background:t.direction==="LONG"?`${T.teal}18`:`${T.red}18`,color:t.direction==="LONG"?T.teal:T.red}}>{t.direction}</span></td>
                      <td style={tdSt}>{t.entry_date}</td><td style={tdSt}>{(+t.entry_price).toFixed(0)}</td>
                      <td style={tdSt}>{t.exit_date}</td><td style={tdSt}>{(+t.exit_price).toFixed(0)}</td>
                      <td style={tdSt}>{t.units}</td><td style={tdSt}>{t.days_held}</td>
                      <td style={{...tdSt,color:pc,fontWeight:700}}>{fmtPt(t.pnl_points)}</td>
                      <td style={{...tdSt,color:pc}}>{fmtN(t.pnl)}</td>
                      <td style={{...tdSt,color:cc,fontWeight:700}}>{fmtN(t.runCum)}</td>
                    </tr>);
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* SWEEP */}
        {activeTab==="sweep"&&!loading&&(
          <div style={cardSt}><SecTitle>Parameter Sweep — Robustness Test</SecTitle>
            <div style={{display:"flex",gap:14,alignItems:"flex-end",flexWrap:"wrap",marginBottom:18}}>
              {[{label:"Rounding values (comma)",val:sweepR,set:setSweepR},{label:"Offset values (comma)",val:sweepO,set:setSweepO}].map(({label,val,set})=>(
                <div key={label}><div style={{fontSize:10,color:T.muted,fontFamily:T.mono,textTransform:"uppercase",letterSpacing:"0.8px",marginBottom:4}}>{label}</div><input value={val} onChange={e=>set(e.target.value)} style={{...inputSt,width:210}}/></div>
              ))}
              <button onClick={handleSweep} style={{...btnOutline,alignSelf:"flex-end"}} disabled={loading}>Run Sweep</button>
            </div>
            {sweepRows.length>0&&(
              <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead><tr>
                    {["Rounding","Offset","Trades","Win Rate","Profit Factor","Total P&L pts","Expectancy","Max DD","DD Dur"].map(h=><th key={h} style={thSt}>{h}</th>)}
                    <th style={thSt}>Action</th>
                  </tr>
                </thead>
                <tbody>{sweepRows.map((r,i)=>{const pfNum=r.profit_factor==="∞"?999:+r.profit_factor,pfColor=pfNum>=1.5?T.teal:pfNum>=1?T.accent:T.red;return(
                  <tr key={`${r.rounding}-${r.offset}`} style={{borderBottom:`1px solid ${T.border}22`,background:i===0?`${T.accent}08`:"transparent"}}>
                    <td style={tdSt}>{r.rounding}</td><td style={tdSt}>{r.offset}</td><td style={tdSt}>{r.total_trades}</td>
                    <td style={{...tdSt,color:r.win_rate>=50?T.teal:T.red}}>{r.win_rate}%</td>
                    <td style={{...tdSt,color:pfColor,fontWeight:700}}>{r.profit_factor}</td>
                    <td style={{...tdSt,color:r.total_pnl_points>=0?T.teal:T.red}}>{fmtN(r.total_pnl_points)}</td>
                    <td style={{...tdSt,color:r.expectancy_points>=0?T.teal:T.red}}>{fmtPt(r.expectancy_points)}</td>
                    <td style={{...tdSt,color:T.red}}>{fmtN(r.max_drawdown_points)}</td>
                    <td style={tdSt}>{r.max_drawdown_duration}d</td>
                    <td style={tdSt}>
                      <button onClick={()=>handleSave(r)} style={{background:"none",border:"none",color:T.accent,cursor:"pointer",fontSize:10,textTransform:"uppercase",fontWeight:700,letterSpacing:0.5}}>Save</button>
                    </td>
                  </tr>);})}
                </tbody>
              </table></div>
            )}
          </div>
        )}

        {/* SAVED */}
        {activeTab==="saved" && (
          <div style={cardSt}><SecTitle>Saved Comparisons — {saved.length} runs</SecTitle>
            <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr style={{borderBottom:`1px solid ${T.border}`}}>
                {["Instrument","Period","R","O","Tr","Win%","PF","P&L","Exp","MaxDD","DD Dur","AvgD",""].map(h=><th key={h} style={thSt}>{h}</th>)}
              </tr></thead>
              <tbody>
                {saved.map(r=>(
                  <tr key={r.id} style={{borderBottom:`1px solid ${T.border}22`}}>
                    <td style={{...tdSt,color:T.accent}}>{r.ticker}</td>
                    <td style={{...tdSt,fontSize:10,color:T.muted2}}>{r.period}</td>
                    <td style={tdSt}>{r.rounding}</td><td style={tdSt}>{r.offset}</td>
                    <td style={tdSt}>{r.trades}</td>
                    <td style={{...tdSt,color:r.win_rate>=50?T.teal:T.red}}>{r.win_rate}%</td>
                    <td style={{...tdSt,color:r.profit_factor>=1?T.teal:T.red,fontWeight:700}}>{r.profit_factor}</td>
                    <td style={{...tdSt,color:r.pnl>=0?T.teal:T.red}}>{fmtN(r.pnl)}</td>
                    <td style={tdSt}>{fmtPt(r.expectancy)}</td>
                    <td style={{...tdSt,color:T.red}}>{fmtN(r.max_dd)}</td>
                    <td style={{...tdSt,color:T.red}}>{r.max_dd_dur}d</td>
                    <td style={tdSt}>{r.avg_days}</td>
                    <td style={tdSt}><button onClick={()=>setSaved(s=>s.filter(x=>x.id!==r.id))} style={{background:"none",border:"none",color:T.red,cursor:"pointer",fontSize:16}}>&times;</button></td>
                  </tr>
                ))}
                {!saved.length && <tr><td colSpan={13} style={{padding:40,textAlign:"center",color:T.muted2,fontFamily:T.mono}}>No saved backtests yet. Run a backtest then click "Save Result".</td></tr>}
              </tbody>
            </table></div>
            {saved.length > 0 && <button onClick={()=>setSaved([])} style={{...btnOutline,color:T.red,borderColor:`${T.red}44`,marginTop:15,fontSize:10}}>Clear All Saved</button>}
          </div>
        )}
      </div>

      {/* Status */}
      <div style={{position:"fixed",bottom:0,left:0,right:0,background:T.surf,borderTop:`1px solid ${T.border}`,padding:"7px 24px",display:"flex",alignItems:"center",gap:12,fontFamily:T.mono,fontSize:11,color:T.muted,zIndex:50}}>
        <span style={{width:6,height:6,borderRadius:"50%",background:loading?T.accent:serverOnline?T.teal:T.red,display:"inline-block",flexShrink:0}}/>
        <span>{statusMsg}</span>
        <span style={{marginLeft:"auto"}}>Turtlewealth Research · Growth Mantra PMS · SEBI INP000006758</span>
      </div>
    </div>
  );
}
