// Gemini Enterprise Workflow Builder chat agent, via the documented StreamAssist API.
// This is deliberately separate from the Gemini Developer API (lib/gemini.js).
// Status: implemented and tested against mocked responses only; no live Enterprise agent has answered yet.
import { GoogleAuth } from 'google-auth-library';
export const enterpriseConfigured = () => Boolean(process.env.GOOGLE_CLOUD_PROJECT && process.env.ENTERPRISE_APP_ID && process.env.ENTERPRISE_AGENT_ID);
export function enterpriseEndpoint() {
  const location=process.env.ENTERPRISE_LOCATION || 'global';
  if (!['global','us','eu'].includes(location)) throw new Error('Invalid Enterprise location');
  const ids=[process.env.GOOGLE_CLOUD_PROJECT,process.env.ENTERPRISE_APP_ID];
  if (!enterpriseConfigured() || ids.some(x=>!x || !/^[a-zA-Z0-9_-]+$/.test(x))) throw new Error('Enterprise configuration incomplete');
  if(!/^[a-zA-Z0-9-]{1,63}$/.test(process.env.ENTERPRISE_AGENT_ID)) throw new Error('Invalid Enterprise agent ID');
  return `https://${location==='global'?'':location+'-'}discoveryengine.googleapis.com/v1/projects/${ids[0]}/locations/${location}/collections/default_collection/engines/${ids[1]}/assistants/default_assistant:streamAssist`;
}

const isChatAnswer = (data) => typeof data.reply === 'string' && Array.isArray(data.dishIds);
export const isLunchAnswer = (data) => Array.isArray(data.options);

// Streaming replies are incremental. Try a complete final part, then the assembled parts.
// isValid decides which JSON shape is accepted (chat answer by default, lunch sets for the lunch finder).
export function parseEnterpriseResponse(body, isValid = isChatAnswer) {
  const events=Array.isArray(body)?body:[body];
  const texts=events.flatMap(e=>(e.answer?.replies??[]).map(r=>r.groundedContent?.content).filter(c=>c && !c.thought).map(c=>c.text??''));
  for (const text of [...texts].reverse().concat(texts.join(''))) {
    try {
      const clean=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
      const data=JSON.parse(clean);
      if (data && typeof data==='object' && isValid(data)) return {...data,model:'Enterprise chat agent'};
    } catch { /* Wait for a complete structured reply. */ }
  }
  throw new Error('Enterprise returned no valid structured answer');
}

// Sends one query to the configured agent and returns the parsed JSON answer.
export async function askEnterpriseJson({query,isValid=isChatAnswer,fetcher=fetch,tokenProvider}) {
  const endpoint=enterpriseEndpoint();
  const token=tokenProvider ? await tokenProvider() : (await (await new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']}).getClient()).getAccessToken()).token;
  if (!token) throw new Error('Enterprise credentials unavailable');
  const r=await fetcher(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Goog-User-Project':process.env.GOOGLE_CLOUD_PROJECT},body:JSON.stringify({query:{text:query},agentsSpec:{agentSpecs:[{agentId:process.env.ENTERPRISE_AGENT_ID}]}}),signal:AbortSignal.timeout(25000)});
  if (!r.ok) throw new Error(`Enterprise HTTP ${r.status}`);
  return parseEnterpriseResponse(await r.json(),isValid);
}

export async function askEnterprise({message,context,history=[],fetcher=fetch,tokenProvider}) {
  const query=`Use your connected APEats menu source. Return ONLY JSON {"reply":"short answer","dishIds":["exact menu id"]}. Do not perform write actions. Only select IDs in the eligible menu below. If source data disagrees, return no IDs and explain.\n${context}\nRECENT USER REQUESTS: ${JSON.stringify(history.filter(x=>x.role==='user').slice(-4))}\nSTUDENT: ${message}`;
  return askEnterpriseJson({query,fetcher,tokenProvider});
}
