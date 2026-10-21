// Unit and handler tests for the Cadence Edge Function.
type Handler = (req:Request)=>Response|Promise<Response>;
let handler:Handler|null=null;
(Deno as any).serve=(fn:Handler)=>{handler=fn;return{finished:Promise.resolve(),shutdown:async()=>{},ref(){},unref(){},addr:{hostname:"test",port:0}};};
const SUPABASE="https://fake.supabase.test";
Deno.env.set("SUPABASE_URL",SUPABASE);
Deno.env.set("SUPABASE_PUBLISHABLE_KEYS",JSON.stringify({default:"sb_publishable_test"}));
Deno.env.set("SUPABASE_SECRET_KEYS",JSON.stringify({default:"sb_secret_test"}));
Deno.env.set("REGULATORY_CALENDAR_CRON_TOKEN","calendar-cron-token-with-at-least-32-chars");
Deno.env.set("RESEND_API_KEY","re_test");
Deno.env.set("REGULATORY_CALENDAR_FROM_EMAIL","cadence@example.test");
const fake:{anonymous:boolean;role:string|null;entries:any[];deliveries:any[];emails:any[];nextId:number}={anonymous:false,role:"admin",entries:[],deliveries:[],emails:[],nextId:1};
function reset(){fake.anonymous=false;fake.role="admin";fake.entries=[];fake.deliveries=[];fake.emails=[];fake.nextId=1;}
function json(v:unknown,status=200){return new Response(JSON.stringify(v),{status,headers:{"Content-Type":"application/json"}});}
const realFetch=globalThis.fetch;
globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const u=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url),method=String(init?.method||"GET").toUpperCase(),path=u.pathname,body=init?.body?JSON.parse(String(init.body)):{};
  if(u.hostname==="api.resend.com"){fake.emails.push({body});return json({id:"email_"+fake.emails.length});}
  if(u.origin!==SUPABASE)return realFetch(input,init);
  if(path==="/auth/v1/user")return json({id:"11111111-2222-4333-8444-555555555555",is_anonymous:fake.anonymous,email:"team@example.test",email_confirmed_at:"2026-01-01T00:00:00Z"});
  if(path==="/rest/v1/regulatory_calendar_members")return json(fake.role?[{email:"team@example.test",role:fake.role,active:true}]:[]);
  if(path==="/rest/v1/regulatory_calendar_entries"){
    const id=u.searchParams.get("id")?.replace(/^eq\./,"");
    if(method==="GET")return json(fake.entries.filter(e=>(!id||e.id===id)&&(u.searchParams.get("archived")!=="eq.false"||e.archived!==true)&&(u.searchParams.get("reminder_enabled")!=="eq.true"||e.reminder_enabled===true)));
    if(method==="POST"){const e={id:"00000000-0000-4000-8000-"+String(fake.nextId++).padStart(12,"0"),created_at:"2026-01-01T00:00:00Z",...body};fake.entries.push(e);return json([e]);}
    if(method==="PATCH"){const e=fake.entries.find(x=>x.id===id);if(!e)return json([]);Object.assign(e,body);return json([e]);}
  }
  if(path==="/rest/v1/regulatory_calendar_reminder_deliveries"){
    if(method==="GET")return json(fake.deliveries.filter(d=>d.entry_id===u.searchParams.get("entry_id")?.replace(/^eq\./,"")&&d.occurrence_date===u.searchParams.get("occurrence_date")?.replace(/^eq\./,"")&&d.recipient_email===u.searchParams.get("recipient_email")?.replace(/^eq\./,"")));
    if(method==="POST"){fake.deliveries.push(body);return json(null,201);}
  }
  return json({message:"unexpected "+method+" "+path},500);
}) as typeof fetch;
const api=await import("./index.ts");
if(!handler)throw new Error("calendar-api did not register a handler");
function assertEquals(actual:unknown,expected:unknown,message=""){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(message+" expected "+JSON.stringify(expected)+" got "+JSON.stringify(actual));}
Deno.test("monthly and quarterly recurrence remains anchored at the original day",()=>{
  assertEquals(api.occurrenceDates({start_date:"2026-01-31",recurrence:"monthly"},"2026-02-01","2026-04-30"),["2026-02-28","2026-03-31","2026-04-30"]);
  assertEquals(api.occurrenceDates({start_date:"2026-01-31",recurrence:"quarterly"},"2026-04-01","2026-10-31"),["2026-04-30","2026-07-31","2026-10-31"]);
});
Deno.test("invalid categories, dates, URLs and reminder addresses are rejected",()=>{
  const base={title:"FR Y-14Q expected update",category:"expected_update",start_date:"2026-10-31",recurrence:"quarterly",reminder_enabled:true,reminder_days_before:7,reminder_emails:["team@example.test"]};
  assertEquals(api.normalizeEntry(base).recurrence,"quarterly");
  for(const bad of [{...base,start_date:"2026-02-30"},{...base,category:"arbitrary"},{...base,source_url:"javascript:alert(1)"},{...base,reminder_emails:["nope"]},{...base,reminder_days_before:91}]){
    let rejected=false;try{api.normalizeEntry(bad);}catch(_){rejected=true;}if(!rejected)throw new Error("invalid entry accepted: "+JSON.stringify(bad));
  }
});
Deno.test("missing sessions, anonymous sessions and unknown team members are denied",async()=>{
  reset();
  let res=await handler!(new Request("https://fn.test/calendar-api?action=list",{method:"GET",headers:{origin:"https://gauravdarwesh.github.io"}}));assertEquals(res.status,401);
  fake.anonymous=true;
  res=await handler!(new Request("https://fn.test/calendar-api?action=list",{method:"GET",headers:{origin:"https://gauravdarwesh.github.io",authorization:"Bearer anon"}}));assertEquals(res.status,403);
  fake.anonymous=false;fake.role=null;
  res=await handler!(new Request("https://fn.test/calendar-api?action=list",{method:"GET",headers:{origin:"https://gauravdarwesh.github.io",authorization:"Bearer user"} }));assertEquals(res.status,403);
});
Deno.test("team members can create entries while viewers are read-only",async()=>{
  reset();const headers={"Content-Type":"application/json",origin:"https://gauravdarwesh.github.io",authorization:"Bearer user"};
  const body={action:"save",entry:{title:"FR Y-14Q expected update",category:"expected_update",start_date:"2026-12-31",recurrence:"quarterly",reminder_enabled:false,reminder_days_before:7,reminder_emails:[]}};
  let res=await handler!(new Request("https://fn.test/calendar-api",{method:"POST",headers,body:JSON.stringify(body)}));assertEquals([res.status,fake.entries.length],[200,1]);
  fake.role="viewer";
  res=await handler!(new Request("https://fn.test/calendar-api",{method:"POST",headers,body:JSON.stringify(body)}));assertEquals(res.status,403);
});
Deno.test("scheduler token and delivery ledger prevent duplicate emails",async()=>{
  reset();const today=new Date().toISOString().slice(0,10),tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
  fake.entries=[{id:"00000000-0000-4000-8000-000000000099",title:"FR Y-14Q",start_date:tomorrow,recurrence:"quarterly",reminder_enabled:true,reminder_days_before:1,reminder_emails:["team@example.test"],completed_dates:[],archived:false}];
  const denied=await handler!(new Request("https://fn.test/calendar-api",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"send-reminders"})}));assertEquals(denied.status,401);
  const headers={"Content-Type":"application/json","x-calendar-cron-token":"calendar-cron-token-with-at-least-32-chars"};
  let res=await handler!(new Request("https://fn.test/calendar-api",{method:"POST",headers,body:JSON.stringify({action:"send-reminders"})}));
  assertEquals([res.status,(await res.json()).sent,fake.emails.length,fake.deliveries.length],[200,1,1,1]);
  res=await handler!(new Request("https://fn.test/calendar-api",{method:"POST",headers,body:JSON.stringify({action:"send-reminders"})}));
  assertEquals([(await res.json()).sent,fake.emails.length],[0,1]);
});
