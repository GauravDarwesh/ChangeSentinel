import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const DEFAULT_URL = "https://pysoukwmnwwgilkwafdy.supabase.co";
const CATEGORIES = new Set(["expected_update", "deadline", "meeting", "internal_task", "other"]);
const RECURRENCES = new Set(["none", "weekly", "monthly", "quarterly", "yearly"]);
const ALLOWED_ORIGINS = new Set([
  "https://gauravdarwesh.github.io", "http://localhost:5173", "http://127.0.0.1:5173",
  "http://localhost:5500", "http://127.0.0.1:5500"
]);

function objectEnv(name: string): Record<string, string> {
  try { const v = Deno.env.get(name); return v ? JSON.parse(v) : {}; } catch (_) { return {}; }
}
function config() {
  const pub = objectEnv("SUPABASE_PUBLISHABLE_KEYS"), secret = objectEnv("SUPABASE_SECRET_KEYS");
  return {
    url: (Deno.env.get("SUPABASE_URL") || DEFAULT_URL).replace(/\/+$/, ""),
    publishable: pub.default || Deno.env.get("SUPABASE_ANON_KEY") || "",
    service: secret.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    cron: Deno.env.get("REGULATORY_CALENDAR_CRON_TOKEN") || "",
    resend: Deno.env.get("RESEND_API_KEY") || "",
    from: Deno.env.get("REGULATORY_CALENDAR_FROM_EMAIL") || "",
    dashboard: Deno.env.get("REGULATORY_CALENDAR_DASHBOARD_URL") || "https://gauravdarwesh.github.io/ChangeSentinel/#cadence"
  };
}
function cors(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = ALLOWED_ORIGINS.has(origin) || /^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin);
  const headers: Record<string,string> = {
    "Vary":"Origin", "Access-Control-Allow-Methods":"GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info, x-calendar-cron-token",
    "Access-Control-Expose-Headers":"Retry-After", "Access-Control-Max-Age":"86400"
  };
  if (allowed) headers["Access-Control-Allow-Origin"] = origin;
  return {allowed, headers};
}
function respond(req: Request, data: unknown, status=200, extra: Record<string,string>={}) {
  return new Response(JSON.stringify(data), {status, headers:{...cors(req).headers, "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store", ...extra}});
}
class PublicError extends Error { status:number; constructor(message:string,status=400){super(message);this.status=status;} }
function serviceHeaders(extra: Record<string,string>={}) {
  const key=config().service;
  if(!key) throw new Error("Calendar service database key is not configured.");
  const h=new Headers({apikey:key,"Content-Type":"application/json",...extra});
  if(!key.startsWith("sb_secret_")) h.set("Authorization","Bearer "+key);
  return h;
}
async function checkedFetch(url:string,init:RequestInit={},timeout=12000) {
  return await fetch(url,{...init,signal:AbortSignal.timeout(timeout)});
}
async function rest(path:string,init:RequestInit={},timeout=12000) {
  return await checkedFetch(config().url+"/rest/v1/"+path,{...init,headers:serviceHeaders(Object.fromEntries(new Headers(init.headers||{}).entries()))},timeout);
}
async function restJson(path:string,init:RequestInit={},timeout=12000):Promise<any>{
  const response=await rest(path,init,timeout),raw=await response.text();
  if(!response.ok) throw new Error("Calendar database request failed ("+response.status+"): "+raw.slice(0,180));
  return raw?JSON.parse(raw):null;
}
function isIsoDate(v:unknown):v is string {
  if(typeof v!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y,m,d]=v.split("-").map(Number), date=new Date(Date.UTC(y,m-1,d));
  return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d;
}
function addDays(date:string,count:number):string { const d=new Date(date+"T00:00:00Z");d.setUTCDate(d.getUTCDate()+count);return d.toISOString().slice(0,10); }
function monthDays(year:number,month:number):number{return new Date(Date.UTC(year,month+1,0)).getUTCDate();}
function occurrenceAt(entry:Record<string,any>,index:number):string{
  const [year,month,day]=String(entry.start_date).split("-").map(Number);
  if(index===0||entry.recurrence==="none")return entry.start_date;
  if(entry.recurrence==="weekly")return addDays(entry.start_date,index*7);
  const step=entry.recurrence==="quarterly"?3:entry.recurrence==="yearly"?12:1;
  const absolute=month-1+index*step, y=year+Math.floor(absolute/12),m=absolute%12;
  return String(y).padStart(4,"0")+"-"+String(m+1).padStart(2,"0")+"-"+String(Math.min(day,monthDays(y,m))).padStart(2,"0");
}
export function occurrenceDates(entry:Record<string,any>,from:string,to:string):string[]{
  if(!isIsoDate(entry.start_date)||!isIsoDate(from)||!isIsoDate(to)||from>to)return [];
  const recur=RECURRENCES.has(String(entry.recurrence||"none"))?String(entry.recurrence||"none"):"none";
  const fixed={...entry,recurrence:recur};
  if(recur==="none")return entry.start_date>=from&&entry.start_date<=to?[entry.start_date]:[];
  let index=0;
  if(recur==="weekly"){
    index=Math.max(0,Math.floor((Date.parse(from+"T00:00:00Z")-Date.parse(entry.start_date+"T00:00:00Z"))/604800000)-1);
  }else{
    const [fy,fm]=from.split("-").map(Number),[sy,sm]=String(entry.start_date).split("-").map(Number);
    const step=recur==="quarterly"?3:recur==="yearly"?12:1;
    index=Math.max(0,Math.floor(((fy-sy)*12+fm-sm)/step)-1);
  }
  const result:string[]=[];
  for(let n=0;n<1200;n++,index++){
    const date=occurrenceAt(fixed,index);
    if(date>to)break;
    if(date>=from)result.push(date);
  }
  return result;
}
export function normalizeEntry(input:any):Record<string,any>{
  if(!input||typeof input!=="object"||Array.isArray(input))throw new PublicError("Calendar entry must be an object.");
  const title=String(input.title||"").trim(),description=String(input.description||"").trim();
  const category=String(input.category||"expected_update"),recurrence=String(input.recurrence||"none");
  const start=String(input.start_date||""),end=input.end_date?String(input.end_date):null;
  const regulator=String(input.regulator||"").trim(),owner=String(input.owner_name||"").trim(),source=String(input.source_url||"").trim();
  const days=Number(input.reminder_days_before??1);
  const emails: string[]=[...new Set<string>((Array.isArray(input.reminder_emails)?input.reminder_emails:[]).map((x:any)=>String(x||"").trim().toLowerCase()).filter((x:any): x is string => Boolean(x)))];
  const completed: string[]=[...new Set<string>((Array.isArray(input.completed_dates)?input.completed_dates:[]).map((x:any)=>String(x||"")).filter((x:any): x is string => isIsoDate(x)))].sort();
  if(!title||title.length>160)throw new PublicError("Give the entry a title (up to 160 characters).");
  if(description.length>4000)throw new PublicError("Description is too long (maximum 4,000 characters).");
  if(!CATEGORIES.has(category))throw new PublicError("Choose a valid calendar category.");
  if(!RECURRENCES.has(recurrence))throw new PublicError("Choose a valid repeat schedule.");
  if(!isIsoDate(start))throw new PublicError("Choose a valid start date.");
  if(end&&(!isIsoDate(end)||end<start))throw new PublicError("The end date must be on or after the start date.");
  if(regulator.length>160||owner.length>120)throw new PublicError("Regulator or owner name is too long.");
  if(source){let u:URL;try{u=new URL(source);}catch(_){throw new PublicError("Source link must be a valid HTTP or HTTPS URL.");}
    if(!["http:","https:"].includes(u.protocol)||u.username||u.password)throw new PublicError("Source link must be a public HTTP or HTTPS URL.");}
  if(!Number.isInteger(days)||days<0||days>90)throw new PublicError("Reminder lead time must be from 0 to 90 days.");
  if(emails.length>10||emails.some((e:string)=>!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)||e.length>320))throw new PublicError("Enter up to 10 valid reminder email addresses.");
  const enabled=input.reminder_enabled===true;
  if(enabled&&!emails.length)throw new PublicError("Add at least one email recipient or switch reminders off.");
  if(recurrence==="none"&&completed.some((d:string)=>d!==start))throw new PublicError("Completed dates for a one-off entry must match its start date.");
  return {title,description,category,start_date:start,end_date:end,regulator,source_url:source,owner_name:owner,recurrence,
    reminder_enabled:enabled,reminder_days_before:days,reminder_emails:emails,completed_dates:completed};
}
function publicCalendarEntry(entry:Record<string,any>){
  const visible={...entry};
  delete visible.reminder_emails;
  visible.reminder_configured=entry.reminder_enabled===true&&Array.isArray(entry.reminder_emails)&&entry.reminder_emails.length>0;
  return visible;
}
export function dueReminderJobs(entries:Record<string,any>[],today:string){
  if(!isIsoDate(today))return [] as Array<{entry:Record<string,any>;occurrence_date:string;recipient_email:string}>;
  const jobs:Array<{entry:Record<string,any>;occurrence_date:string;recipient_email:string}>=[];
  for(const entry of entries){
    if(!entry||entry.archived||entry.reminder_enabled!==true||!isIsoDate(entry.start_date))continue;
    const days=Number(entry.reminder_days_before??1);
    if(!Number.isInteger(days)||days<0||days>90)continue;
    const recipients=Array.isArray(entry.reminder_emails)?[...new Set(entry.reminder_emails.map((x:any)=>String(x||"").trim().toLowerCase()).filter((e:string)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))]:[];
    if(!recipients.length)continue;
    const from=addDays(today,-7),completed=new Set(Array.isArray(entry.completed_dates)?entry.completed_dates.map(String):[]);
    for(const occurrence of occurrenceDates(entry,from,addDays(today,days))){
      if(occurrence<today||completed.has(occurrence))continue;
      const due=addDays(occurrence,-days);
      if(due>today||due<from)continue;
      for(const recipient of recipients)jobs.push({entry,occurrence_date:occurrence,recipient_email:recipient});
    }
  }
  return jobs;
}
async function authenticatedMember(req:Request){
  const cfg=config(),auth=req.headers.get("authorization")||"";
  if(!/^Bearer\s+\S+/i.test(auth))throw new PublicError("Sign in with your team email to use Cadence.",401);
  if(!cfg.publishable)throw new Error("Supabase publishable key is not configured.");
  const res=await checkedFetch(cfg.url+"/auth/v1/user",{headers:{apikey:cfg.publishable,Authorization:auth}},8000);
  if(!res.ok)throw new PublicError("Your Cadence session has expired. Sign in again.",401);
  const user=await res.json(),email=String(user?.email||"").trim().toLowerCase();
  if(!/^[0-9a-f-]{36}$/i.test(String(user?.id||""))||user?.is_anonymous === true||!email)throw new PublicError("Cadence requires a team email account, not a visitor session.",403);
  if(!(user.email_confirmed_at||user.confirmed_at))throw new PublicError("Confirm your team email address before using Cadence.",403);
  const params=new URLSearchParams({select:"email,role,active",email:"eq."+email,limit:"1"});
  const rows=await restJson("regulatory_calendar_members?"+params.toString()),member=Array.isArray(rows)?rows[0]:null;
  if(!member||member.active!==true)throw new PublicError("This email is not on the Cadence team list yet. Ask a calendar admin to add it.",403);
  return {user,email,role:String(member.role||"viewer")};
}
function requireEditor(member:{role:string}){if(member.role!=="admin"&&member.role!=="editor")throw new PublicError("Your Cadence role is read-only.",403);}
function validId(value:unknown){const id=String(value||"");if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new PublicError("Calendar entry ID is invalid.");return id;}
async function getEntry(id:string){const rows=await restJson("regulatory_calendar_entries?"+new URLSearchParams({select:"*",id:"eq."+id,limit:"1"}));const entry=Array.isArray(rows)?rows[0]:null;if(!entry)throw new PublicError("This calendar entry no longer exists.",404);return entry;}
async function saveEntry(member:any,body:any){
  requireEditor(member);
  let rawEntry=body.entry;
  if(body.id){
    const id=validId(body.id),old=await getEntry(id);
    if(old.archived)throw new PublicError("Archived entries cannot be edited.",409);
    // Existing reminder addresses are private and omitted from list responses.
    // A client can preserve them by omitting reminder_emails on an ordinary edit.
    if(rawEntry&&typeof rawEntry==="object"&&!Array.isArray(rawEntry)&&!Object.prototype.hasOwnProperty.call(rawEntry,"reminder_emails")){
      rawEntry={...rawEntry,reminder_emails:Array.isArray(old.reminder_emails)?old.reminder_emails:[]};
    }
    const input=normalizeEntry(rawEntry);
    const rows=await restJson("regulatory_calendar_entries?"+new URLSearchParams({id:"eq."+id}),{method:"PATCH",headers:{Prefer:"return=representation"},body:JSON.stringify({...input,updated_by:member.user.id,updated_at:new Date().toISOString()})});
    const saved=Array.isArray(rows)?rows[0]:null;if(!saved)throw new PublicError("The calendar entry could not be updated.",404);return saved;
  }
  const input=normalizeEntry(rawEntry);
  const rows=await restJson("regulatory_calendar_entries",{method:"POST",headers:{Prefer:"return=representation"},body:JSON.stringify({...input,created_by:member.user.id,updated_by:member.user.id})});
  const saved=Array.isArray(rows)?rows[0]:null;if(!saved)throw new Error("Calendar entry creation returned no saved record.");return saved;
}
async function archiveEntry(member:any,rawId:unknown){
  requireEditor(member);const id=validId(rawId);await getEntry(id);
  await restJson("regulatory_calendar_entries?"+new URLSearchParams({id:"eq."+id}),{method:"PATCH",headers:{Prefer:"return=minimal"},body:JSON.stringify({archived:true,updated_by:member.user.id,updated_at:new Date().toISOString()})});
  return {id,archived:true};
}
async function completeOccurrence(member:any,body:any){
  requireEditor(member);const id=validId(body.id),day=String(body.occurrence_date||"");
  if(!isIsoDate(day))throw new PublicError("Choose a valid occurrence date.");
  const entry=await getEntry(id);
  if(!occurrenceDates(entry,day,day).includes(day))throw new PublicError("That date is not an occurrence of this calendar entry.");
  const completed=new Set<string>(Array.isArray(entry.completed_dates)?entry.completed_dates.map(String):[]);
  if(body.completed===true)completed.add(day);else completed.delete(day);
  const rows=await restJson("regulatory_calendar_entries?"+new URLSearchParams({id:"eq."+id}),{method:"PATCH",headers:{Prefer:"return=representation"},body:JSON.stringify({completed_dates:[...completed].sort(),updated_by:member.user.id,updated_at:new Date().toISOString()})});
  const saved=Array.isArray(rows)?rows[0]:null;if(!saved)throw new PublicError("The occurrence could not be updated.",404);return saved;
}
function escapeHtml(v:string){return v.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
async function sendEmail(entry:Record<string,any>,day:string,to:string){
  const cfg=config();if(!cfg.resend||!cfg.from)throw new Error("Email reminders are not configured.");
  const source=entry.source_url?'<p><a href="'+escapeHtml(String(entry.source_url))+'">Open source</a></p>':"";
  const html='<div style="font-family:Arial,sans-serif;line-height:1.6;color:#24180f"><p style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#a95b12">ChangeSentinel · Cadence</p><h2>'+
    escapeHtml(String(entry.title||"Regulatory calendar reminder"))+'</h2><p><strong>Date:</strong> '+escapeHtml(day)+'</p>'+
    (entry.regulator?'<p><strong>Regulator / form:</strong> '+escapeHtml(String(entry.regulator))+'</p>':"")+
    (entry.owner_name?'<p><strong>Owner:</strong> '+escapeHtml(String(entry.owner_name))+'</p>':"")+
    (entry.description?'<p>'+escapeHtml(String(entry.description))+'</p>':"")+source+
    '<p><a href="'+escapeHtml(cfg.dashboard)+'">Open Cadence calendar</a></p><hr><p style="font-size:12px;color:#786b5e">Automated reminder from your team regulatory calendar.</p></div>';
  const response=await checkedFetch("https://api.resend.com/emails",{method:"POST",headers:{Authorization:"Bearer "+cfg.resend,"Content-Type":"application/json"},
    body:JSON.stringify({from:cfg.from,to:[to],subject:"[Cadence] "+String(entry.title||"Regulatory reminder")+" · "+day,html})},12000);
  const raw=await response.text();if(!response.ok)throw new Error("Email provider returned HTTP "+response.status+": "+raw.slice(0,140));
  const result=raw?JSON.parse(raw):{};return String(result.id||"");
}
async function alreadySent(entryId:string,day:string,to:string){
  const params=new URLSearchParams({select:"id",entry_id:"eq."+entryId,occurrence_date:"eq."+day,recipient_email:"eq."+to,limit:"1"});
  const rows=await restJson("regulatory_calendar_reminder_deliveries?"+params.toString());return Array.isArray(rows)&&rows.length>0;
}
async function runReminders(){
  const cfg=config();if(!cfg.cron||!cfg.resend||!cfg.from)throw new Error("Reminder scheduler secrets are not configured.");
  const rows=await restJson("regulatory_calendar_entries?"+new URLSearchParams({select:"*",archived:"eq.false",reminder_enabled:"eq.true"}));
  const today=new Date().toISOString().slice(0,10),jobs=dueReminderJobs(Array.isArray(rows)?rows:[],today);
  let sent=0,skipped=0,failures=0;
  for(const job of jobs){
    const id=String(job.entry.id||"");
    try{
      if(!id||await alreadySent(id,job.occurrence_date,job.recipient_email)){skipped++;continue;}
      const provider=await sendEmail(job.entry,job.occurrence_date,job.recipient_email);
      await restJson("regulatory_calendar_reminder_deliveries",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({entry_id:id,occurrence_date:job.occurrence_date,recipient_email:job.recipient_email,provider_id:provider})});
      sent++;
    }catch(error){failures++;console.error(JSON.stringify({event:"cadence_reminder_failed",entry_id:id,occurrence_date:job.occurrence_date,error:String((error as Error)?.message||error).slice(0,180)}));}
  }
  return {sent,skipped,failures};
}
Deno.serve(async(req:Request)=>{
  const c=cors(req);
  if(req.method==="OPTIONS")return new Response(null,{status:c.allowed?204:403,headers:c.headers});
  if(req.headers.get("origin")&&!c.allowed)return respond(req,{error:"Origin not allowed."},403);
  if(!["GET","POST"].includes(req.method))return respond(req,{error:"Method not allowed."},405);
  const url=new URL(req.url);
  try{
    if(req.method==="POST"){
      const raw=await req.text();if(raw.length>50000)throw new PublicError("Request body is too large.",413);
      let body:any={};try{body=raw?JSON.parse(raw):{};}catch(_){throw new PublicError("Request body must be valid JSON.");}
      if(body.action==="send-reminders"){
        const expected=config().cron,supplied=req.headers.get("x-calendar-cron-token")||"";
        if(!expected||supplied.length<24||supplied!==expected)throw new PublicError("Scheduler authorization failed.",401);
        const result=await runReminders();if(result.failures)return respond(req,{ok:false,...result},503);return respond(req,{ok:true,...result});
      }
      const member=await authenticatedMember(req);
      if(body.action==="save")return respond(req,{ok:true,entry:publicCalendarEntry(await saveEntry(member,body))});
      if(body.action==="delete")return respond(req,{ok:true,entry:await archiveEntry(member,body.id)});
      if(body.action==="complete")return respond(req,{ok:true,entry:publicCalendarEntry(await completeOccurrence(member,body))});
      if(body.action==="send-test"){
        requireEditor(member);const cfg=config();if(!cfg.resend||!cfg.from)throw new PublicError("Email reminders are not configured yet.",503);
        const id=await sendEmail({title:"Cadence reminder test",description:"This is a test email from ChangeSentinel Cadence."},new Date().toISOString().slice(0,10),member.email);
        return respond(req,{ok:true,provider_id:id,message:"Test email sent."});
      }
      throw new PublicError("Unknown calendar action.");
    }
    const member=await authenticatedMember(req);
    if(url.searchParams.get("action")!=="list")throw new PublicError("Use ?action=list to read entries.");
    // Reminder recipients are operationally private. Do not return them to the
    // dashboard's general list response; writes continue to pass through the
    // role-checked endpoint and the scheduler reads them server-side.
    const params=new URLSearchParams({select:"*",archived:"eq.false",order:"start_date.asc"});
    const entries=await restJson("regulatory_calendar_entries?"+params.toString());
    const publicEntries=Array.isArray(entries)?entries.map((entry:Record<string,any>)=>publicCalendarEntry(entry)):[];
    return respond(req,{ok:true,member:{email:member.email,role:member.role},entries:publicEntries});
  }catch(error){
    const status=error instanceof PublicError?error.status:503;
    if(!(error instanceof PublicError))console.error(JSON.stringify({event:"cadence_calendar_error",error:String((error as Error)?.message||error).slice(0,220)}));
    return respond(req,{error:error instanceof PublicError?error.message:"Cadence is temporarily unavailable. Please retry."},status);
  }
});
